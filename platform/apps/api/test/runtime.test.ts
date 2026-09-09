import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../src/runtime.js";
import { loadConfig } from "../src/config.js";
import type { Store } from "../src/store.js";

class MemoryStore {
  values = new Map<string, any>();
  events = new EventEmitter();
  async get<T>(key: string, fallback: T): Promise<T> {
    return structuredClone(
      this.values.has(key) ? this.values.get(key) : fallback,
    );
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async insertOnce(key: string, value: unknown) {
    if (this.values.has(key)) return false;
    await this.put(key, value);
    return true;
  }
  async list<T>(prefix: string): Promise<T[]> {
    return [...this.values]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => structuredClone(v))
      .reverse();
  }
  async audit() {}
  async publish() {}
  async saveDay(day: any) {
    await this.put(`day:${day.date}:${day.symbol}`, day);
  }
}
const now = "2026-09-08T14:00:10.000Z";
const intent = (extra: any = {}) => ({
  id: "m2-test",
  strategyId: "moon",
  version: "1.0.0",
  symbol: "TEST",
  entryTime: "2026-09-08T13:45:00Z",
  submittedAt: "2026-09-08T13:45:00Z",
  quantity: 100,
  entryPrice: 10,
  stop: 9,
  target: 12,
  entryReason: "breakout",
  state: "open",
  orderId: "parent",
  entryStatus: "filled",
  filledQty: 100,
  filledPrice: 10,
  ...extra,
});
const order = (extra: any = {}) => ({
  id: "parent",
  symbol: "TEST",
  side: "buy",
  status: "filled",
  filled_qty: "100",
  filled_avg_price: "10",
  filled_at: "2026-09-08T13:45:00Z",
  legs: [],
  ...extra,
});
const sell = (extra: any = {}) => ({
  id: "stop",
  symbol: "TEST",
  side: "sell",
  status: "new",
  filled_qty: "0",
  filled_avg_price: null,
  filled_at: null,
  type: "stop",
  ...extra,
});
function setup() {
  const store = new MemoryStore();
  const config = loadConfig({
    NODE_ENV: "test",
    APP_MODE: "paper",
    PAPER_TRADING_ENABLED: "true",
    APCA_API_KEY_ID: "unit-test-only",
    APCA_API_SECRET_KEY: "unit-test-only",
    MAX_OPEN_POSITIONS: "10",
  });
  const runtime = new Runtime(config, store as unknown as Store);
  (runtime as any).leaseHeld = true;
  const broker = vi
    .spyOn(runtime.market.alpaca, "request")
    .mockImplementation(async () => {
      throw new Error("Unmocked broker operation prohibited in test");
    });
  return { runtime, store, broker };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("paper execution reconciliation", () => {
  it("deduplicates a bracket leg returned through both nested and direct order reads", async () => {
    const { runtime, store, broker } = setup();
    await store.put("intent:m2-test", intent({ exitOrderId: "stop" }));
    const exit = sell({
      status: "filled",
      filled_qty: "100",
      filled_avg_price: "9",
      filled_at: "2026-09-08T13:50:00Z",
    });
    broker.mockImplementation(async (path: any) =>
      path === "/v2/orders:by_client_order_id" ? order({ legs: [exit] }) : exit,
    );
    await (runtime as any).reconcile();
    const trade = await store.get<any>("trade:m2-test", null);
    expect(trade.quantity).toBe(100);
    expect(trade.pnl).toBe(-100);
    expect(trade.mfe).toBeNull();
    expect(trade.feeStatus).toBe("pending broker statement");
    expect((await store.get<any>("intent:m2-test", null)).state).toBe("closed");
    await (runtime as any).reconcile();
    expect(await store.list("trade:")).toHaveLength(1);
  });
  it("waits for terminal bracket cancellation before submitting a manual sell", async () => {
    const { runtime, store, broker } = setup();
    await store.put("intent:m2-test", intent());
    let cancelled = false;
    broker.mockImplementation(
      async (path: any, _params: any, _trading: any, method: any) => {
        if (path === "/v2/orders:by_client_order_id")
          return order({
            legs: [sell({ status: cancelled ? "canceled" : "new" })],
          });
        if (method === "DELETE") {
          cancelled = true;
          return undefined;
        }
        if (path === "/v2/positions") return [{ symbol: "TEST", qty: "100" }];
        if (path === "/v2/orders" && method === "POST")
          return sell({ id: "manual", client_order_id: "m2-test-x1" });
        if (path === "/v2/orders") return [];
        throw new Error(`Unexpected ${path}`);
      },
    );
    await (runtime as any).closeOwnedPositions("dayhalt", true);
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(0);
    await (runtime as any).closeOwnedPositions("dayhalt", true);
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(1);
    expect(
      (await store.get<any>("intent:m2-test", null)).exitClientOrderId,
    ).toBe("m2-test-x1");
  });
  it("never reopens or repeats a sell after an uncertain exit response", async () => {
    const { runtime, store, broker } = setup();
    await store.put("intent:m2-test", intent());
    let recovered = false;
    broker.mockImplementation(
      async (path: any, params: any, _trading: any, method: any) => {
        if (path === "/v2/orders:by_client_order_id") {
          if (params.client_order_id === "m2-test") return order();
          if (recovered)
            return sell({ id: "manual", client_order_id: "m2-test-x1" });
          throw new Error("Lost response / lookup not yet visible");
        }
        if (path === "/v2/orders/manual")
          return sell({ id: "manual", client_order_id: "m2-test-x1" });
        if (path === "/v2/positions") return [{ symbol: "TEST", qty: "100" }];
        if (path === "/v2/orders" && method === "POST")
          throw new Error("Response lost after broker accepted");
        if (path === "/v2/orders") return [];
        throw new Error(`Unexpected ${path}`);
      },
    );
    await (runtime as any).closeOwnedPositions("session_close", true);
    expect((await store.get<any>("intent:m2-test", null)).state).toBe(
      "uncertain",
    );
    await (runtime as any).closeOwnedPositions("session_close", true);
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(1);
    recovered = true;
    await (runtime as any).reconcile();
    expect((await store.get<any>("intent:m2-test", null)).state).toBe(
      "closing",
    );
    await (runtime as any).closeOwnedPositions("session_close", true);
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(1);
  });
  it("uses only remaining actual shares after partial entry and partial protective fills", async () => {
    const { runtime, store, broker } = setup();
    await store.put(
      "intent:m2-test",
      intent({ filledQty: 40, entryStatus: "canceled" }),
    );
    const protective = sell({
      status: "canceled",
      filled_qty: "10",
      filled_avg_price: "11",
      filled_at: "2026-09-08T13:48:00Z",
    });
    broker.mockImplementation(
      async (path: any, _params: any, _trading: any, method: any) => {
        if (path === "/v2/orders:by_client_order_id")
          return order({
            status: "canceled",
            filled_qty: "40",
            legs: [protective],
          });
        if (path === "/v2/positions") return [{ symbol: "TEST", qty: "30" }];
        if (path === "/v2/orders" && method === "POST")
          return sell({ id: "manual" });
        if (path === "/v2/orders") return [];
        throw new Error(`Unexpected ${path}`);
      },
    );
    await (runtime as any).closeOwnedPositions("dayhalt", true);
    const post = broker.mock.calls.find((c) => c[3] === "POST");
    expect(post?.[4]).toMatchObject({ qty: "30", side: "sell" });
    expect(await store.list("trade:")).toHaveLength(0);
  });
  it("blocks sells when fresh inventory disagrees and after the leader lease is lost", async () => {
    const { runtime, store, broker } = setup();
    await store.put("intent:m2-test", intent());
    broker.mockImplementation(async (path: any) => {
      if (path === "/v2/orders:by_client_order_id") return order();
      if (path === "/v2/positions") return [{ symbol: "TEST", qty: "99" }];
      if (path === "/v2/orders") return [];
      throw new Error(`Unexpected ${path}`);
    });
    await (runtime as any).closeOwnedPositions("dayhalt", true);
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(0);
    expect(
      (await store.get<any>("intent:m2-test", null)).reconciliationError,
    ).toContain("inventory differs");
    broker.mockImplementation(async (path: any) =>
      path === "/v2/orders:by_client_order_id"
        ? order()
        : path === "/v2/positions"
          ? [{ symbol: "TEST", qty: "100" }]
          : [],
    );
    runtime.stop();
    await (runtime as any).closeOwnedPositions("dayhalt", true);
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(0);
  });
  it("routes a completed-bar time exit through cancellation confirmation", async () => {
    const { runtime, store, broker } = setup();
    await store.put(
      "intent:m2-test",
      intent({
        entryTime: "2026-09-08T13:30:00Z",
        parameters: { trailAtr: 5, maxHoldBars: 10 },
      }),
    );
    runtime.market.barsBySymbol.set("TEST", signalBars());
    broker.mockImplementation(
      async (path: any, _params: any, _trading: any, method: any) => {
        if (path === "/v2/orders:by_client_order_id")
          return order({ filled_at: "2026-09-08T13:30:00Z", legs: [sell()] });
        if (method === "DELETE") return undefined;
        throw new Error(`Unexpected ${path}`);
      },
    );
    await (runtime as any).manageExits(now);
    expect(broker.mock.calls.filter((c) => c[3] === "DELETE")).toHaveLength(1);
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(0);
    expect((await store.get<any>("intent:m2-test", null)).exitReason).toBe(
      "time_stop",
    );
  });
  it("blocks stale data using the actual risk-engine code", async () => {
    const { runtime, store, broker } = setup();
    runtime.market.feed.lastEventAt = "2026-09-08T13:00:00Z";
    (runtime as any).lastShadow = Date.now();
    (runtime as any).lastRecord = Date.now();
    broker.mockImplementation(async (path: any) => {
      if (path === "/v2/account")
        return {
          equity: "100000",
          last_equity: "100000",
          buying_power: "100000",
        };
      if (path === "/v2/positions") return [];
      if (path === "/v2/clock")
        return { is_open: true, next_close: "2026-09-08T20:00:00Z" };
      throw new Error(`Unexpected ${path}`);
    });
    await runtime.tick();
    expect((await store.get<any>("engine", null)).state).toBe("data_stale");
    expect(broker.mock.calls.filter((c) => c[3] === "POST")).toHaveLength(0);
  });
});

function signalBars() {
  return Array.from({ length: 30 }, (_, index) => {
    const open = 10 + index * 0.005;
    return {
      timestamp: new Date(
        Date.parse("2026-09-08T13:30:00Z") + index * 60_000,
      ).toISOString(),
      open,
      close: index === 29 ? 10.7 : open + 0.003,
      high: index === 29 ? 10.72 : open + 0.02,
      low: index === 29 ? 10.1 : open - 0.02,
      volume: index === 29 ? 6000 : 1000,
    };
  });
}
describe("shared risk and independent shadow versions", () => {
  it("reserves every submitted order against the same tick account exposure cap", async () => {
    const { runtime, store, broker } = setup();
    await store.put("approved:moon", {
      version: "approved-1",
      parameters: {},
      strategyId: "moon",
    });
    const stocks = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"];
    runtime.market.stocks = stocks.map((symbol) => ({
      symbol,
      price: 10.7,
      changePct: 7,
      volume: 50000,
      relativeVolume: 2,
      score: 90,
      spreadBps: 20,
      updatedAt: now,
    }));
    for (const symbol of stocks) {
      runtime.market.barsBySymbol.set(symbol, signalBars());
      runtime.market.quotes.set(symbol, {
        bid: 10.7,
        ask: 10.72,
        spreadBps: 20,
        time: now,
      });
    }
    broker.mockImplementation(
      async (
        path: any,
        _params: any,
        _trading: any,
        method: any,
        body: any,
      ) => {
        if (path.startsWith("/v2/assets/"))
          return {
            tradable: true,
            status: "active",
            class: "us_equity",
            exchange: "NASDAQ",
          };
        if (path === "/v2/orders" && method === "POST")
          return { id: body.client_order_id, status: "new" };
        throw new Error(`Unexpected ${path}`);
      },
    );
    await (runtime as any).entries({
      now,
      equity: 100000,
      buyingPower: 100000,
      positions: [],
      baseline: { date: "2026-09-08", equity: 100000 },
      clock: { is_open: true },
    });
    const posted = broker.mock.calls
      .filter((c) => c[3] === "POST")
      .map((c) => c[4] as any);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.length).toBeLessThan(stocks.length);
    expect(
      posted.reduce((sum, b) => sum + Number(b.qty) * Number(b.limit_price), 0),
    ).toBeLessThanOrEqual(40000);
  });
  it("keeps candidate trades and version IDs out of the baseline shadow ledger", async () => {
    const { runtime, store } = setup();
    vi.setSystemTime(new Date("2026-09-08T14:02:00Z"));
    const bars = signalBars();
    bars.push({
      timestamp: "2026-09-08T14:00:00Z",
      open: 10.72,
      high: 11.7,
      low: 10.1,
      close: 10.7,
      volume: 6000,
    });
    runtime.market.barsBySymbol.set("TEST", bars);
    runtime.market.stocks = [
      {
        symbol: "TEST",
        price: 10.7,
        changePct: 7,
        volume: 50000,
        relativeVolume: 2,
        score: 90,
        spreadBps: 20,
        updatedAt: now,
      },
    ];
    await store.put("discovery:2026-09-08:TEST", {
      discoveredAt: "2026-09-08T13:30:00Z",
      universeSnapshotId: "test",
    });
    await store.put("candidate:moon:variant-1", {
      id: "variant-1",
      strategyId: "moon",
      version: "challenger-1",
      parameters: { targetR: 2 },
      createdAt: "2026-09-07T21:00:00Z",
      status: "shadow",
    });
    await (runtime as any).shadow("2026-09-08");
    const base = await store.get<any[]>("shadow:2026-09-08:moon:TEST", []);
    const candidate = await store.get<any[]>(
      "shadowCandidate:2026-09-08:moon:variant-1:TEST",
      [],
    );
    expect(base).toHaveLength(1);
    expect(candidate).toHaveLength(1);
    expect(candidate[0].version).toBe("challenger-1");
    expect(candidate[0].id).not.toBe(base[0].id);
    expect(base.every((t) => t.reason !== "data_end")).toBe(true);
  });
});
