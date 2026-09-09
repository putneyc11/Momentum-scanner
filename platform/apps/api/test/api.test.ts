import { afterEach, describe, it, expect } from "vitest";
import { sessionDate } from "@momentum/engine";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { seedDemo } from "../src/demo.js";
import { MarketFeed, aggregateBars } from "../src/market.js";
import { streamLifetime } from "../src/auth.js";
const paths: string[] = [];
afterEach(async () => {
  for (const p of paths.splice(0))
    await rm(p, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "momentum-test-"));
  paths.push(dir);
  const store = new Store("", path.join(dir, "state.json"));
  await store.init();
  const c = loadConfig({
    APP_MODE: "paper",
    ADMIN_TOKEN: "a".repeat(40),
    VIEWER_TOKEN: "v".repeat(40),
    SESSION_SECRET: "s".repeat(40),
    PUBLIC_ORIGIN: "https://test.example",
  });
  return { store, c, app: createApp(c, store) };
}
describe("API boundary", () => {
  it("requires operator identity for private account data and never exposes legacy keys", async () => {
    const { app } = await setup();
    await request(app).get("/api/v1/overview").expect(401);
    await request(app)
      .get("/api/v1/overview")
      .set("Authorization", "Bearer " + "v".repeat(40))
      .expect(403);
    const r = await request(app).get("/settings").expect(410);
    expect(r.text).not.toContain("APCA_API_SECRET_KEY");
  });
  it("supports native viewer bearer without leaking operator endpoints", async () => {
    const { store, app } = await setup();
    await store.put("scanner", {
      asOf: null,
      feed: { state: "unconfigured" },
      stocks: [],
    });
    const r = await request(app)
      .get("/api/v1/scanner")
      .set("Authorization", "Bearer " + "v".repeat(40))
      .expect(200);
    expect(r.body.stocks).toEqual([]);
  });
  it("uses HttpOnly cookie login and blocks cross-origin mutations", async () => {
    const { app } = await setup();
    await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "https://evil.example")
      .send({ token: "a".repeat(40) })
      .expect(403);
    const r = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "https://test.example")
      .send({ token: "a".repeat(40) })
      .expect(200);
    expect(r.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(r.body).not.toHaveProperty("token");
    await request(app)
      .post("/api/v1/engine/pause")
      .set("Cookie", r.headers["set-cookie"])
      .set("Origin", "https://evil.example")
      .send({})
      .expect(403);
  });
  it("persists daily loss halt and cannot override it through Resume", async () => {
    const { app, store } = await setup();
    const date = sessionDate(new Date().toISOString());
    await store.put("dayHalt", { sessionDate: date, halted: true });
    await request(app)
      .post("/api/v1/engine/resume")
      .set("Authorization", "Bearer " + "a".repeat(40))
      .send({})
      .expect(409);
  });
  it("edits a bounded candidate without replacing the active version", async () => {
    const { app, store } = await setup();
    const r = await request(app)
      .post("/api/v1/strategies/moon/candidates")
      .set("Authorization", "Bearer " + "a".repeat(40))
      .send({ parameters: {}, notes: "Shadow only" })
      .expect(201);
    expect(r.body.status).toBe("shadow");
    expect(await store.get("approved:moon", null)).toBeNull();
    await request(app)
      .post("/api/v1/strategies/moon/candidates")
      .set("Authorization", "Bearer " + "a".repeat(40))
      .send({ parameters: { arbitraryRisk: 100 } })
      .expect(400);
  });
  it("cannot approve an unproven candidate or borrow a cookie with an invalid bearer", async () => {
    const { app, store } = await setup();
    const created = await request(app)
      .post("/api/v1/strategies/moon/candidates")
      .set("Authorization", "Bearer " + "a".repeat(40))
      .send({ parameters: {}, notes: "Test candidate" })
      .expect(201);
    const url = `/api/v1/strategies/moon/candidates/${created.body.id}`;
    const evidence = await request(app)
      .get(url)
      .set("Authorization", "Bearer " + "a".repeat(40))
      .expect(200);
    expect(evidence.body.promotion.eligible).toBe(false);
    await request(app)
      .post(url + "/approve")
      .set("Authorization", "Bearer " + "a".repeat(40))
      .send({ version: created.body.version, acknowledgePaperRisk: true })
      .expect(409);
    expect(await store.get("approved:moon", null)).toBeNull();
    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "https://test.example")
      .send({ token: "a".repeat(40) })
      .expect(200);
    await request(app)
      .get("/api/v1/overview")
      .set("Cookie", login.headers["set-cookie"])
      .set("Authorization", "Bearer invalid")
      .expect(401);
  });
  it("does not mix paper records into baseline simulation performance or account markers", async () => {
    const { app, store } = await setup();
    await seedDemo(store);
    const fixture = (await store.get<any[]>("demoTrades", []))[0];
    await store.put("trade:paper", {
      ...fixture,
      id: "paper",
      source: "paper",
      pnl: -25,
    });
    await store.put("shadow:day:moon:symbol", [
      { ...fixture, id: "shadow", pnl: 50 },
    ]);
    const shadow = await request(app)
      .get("/api/v1/strategies/moon")
      .set("Authorization", "Bearer " + "a".repeat(40))
      .expect(200);
    const paper = await request(app)
      .get("/api/v1/strategies/moon?source=paper")
      .set("Authorization", "Bearer " + "a".repeat(40))
      .expect(200);
    expect(shadow.body.metrics.netPnl).toBe(50);
    expect(paper.body.metrics.netPnl).toBe(-25);
    expect(
      shadow.body.trades.every((t: any) => t.source === "simulation"),
    ).toBe(true);
  });
  it("terminates streaming at the actual identity expiry or at the 30-minute cap", () => {
    expect(
      streamLifetime({ role: "viewer", sub: "x", expiresAt: 1500 }, 1000),
    ).toBe(500);
    expect(
      streamLifetime({ role: "viewer", sub: "x", expiresAt: 500 }, 1000),
    ).toBe(0);
    expect(streamLifetime({ role: "admin", sub: "operator" }, 1000)).toBe(
      1800000,
    );
  });
  it("serves honest demo fixtures and consistent detail schemas", async () => {
    const { store, c } = await setup();
    c.APP_MODE = "demo";
    await seedDemo(store);
    const app = createApp(c, store);
    const r = await request(app).get("/api/v1/overview").expect(200);
    expect(r.body.mode).toBe("demo");
    expect(r.body.engine.state).toBe("halted");
    const detail = await request(app)
      .get("/api/v1/scanner/BIAF?timeframe=5Min")
      .expect(200);
    expect(detail.body.bars.length).toBeGreaterThan(50);
    expect(detail.body.bars[0]).toHaveProperty("time");
    expect(detail.body.feed.state).toBe("demo");
  });
});
describe("market integrity", () => {
  it("deduplicates REST fallback trades and does not overwrite latest close with late ticks", async () => {
    const { store, c } = await setup();
    const feed = new MarketFeed(c, store);
    const base = Math.floor(Date.now() / 60000) * 60000;
    feed.ingest({
      id: "1",
      symbol: "ABC",
      time: new Date(base + 2000).toISOString(),
      price: 10,
      size: 100,
    });
    feed.ingest({
      id: "1",
      symbol: "ABC",
      time: new Date(base + 2000).toISOString(),
      price: 10,
      size: 100,
    });
    feed.ingest({
      id: "2",
      symbol: "ABC",
      time: new Date(base + 1000).toISOString(),
      price: 9,
      size: 50,
    });
    expect(feed.trades.get("ABC")).toHaveLength(2);
    expect(feed.barsBySymbol.get("ABC")?.[0].close).toBe(10);
    expect(feed.barsBySymbol.get("ABC")?.[0].volume).toBe(150);
  });
  it("aggregates OHLC without averaging away extrema or volume", () => {
    const bars = aggregateBars(
      [
        {
          timestamp: "2026-09-09T14:00:00Z",
          open: 10,
          high: 12,
          low: 9,
          close: 11,
          volume: 100,
        },
        {
          timestamp: "2026-09-09T14:01:00Z",
          open: 11,
          high: 13,
          low: 10,
          close: 12,
          volume: 200,
        },
      ],
      "5Min",
    );
    expect(bars).toEqual([
      { time: 1788962400, open: 10, high: 13, low: 9, close: 12, volume: 300 },
    ]);
  });
  it("rejects invalid quotes and preserves the newer quote", async () => {
    const { store, c } = await setup();
    const feed = new MarketFeed(c, store);
    feed.ingestQuote("ABC", 10, 10.01, "2026-01-01T14:30:02Z");
    feed.ingestQuote("ABC", 11, 10, "2026-01-01T14:30:03Z");
    feed.ingestQuote("ABC", 9, 9.01, "2026-01-01T14:30:01Z");
    expect(feed.quotes.get("ABC")?.bid).toBe(10);
  });
  it("rejects production configurations that could silently lose state or trade live", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", APP_MODE: "paper" }),
    ).toThrow("DATABASE_URL");
    expect(() => loadConfig({ APP_MODE: "live" })).toThrow();
    expect(() =>
      loadConfig({ APP_MODE: "demo", PAPER_TRADING_ENABLED: "true" }),
    ).toThrow();
  });
  it("requires long distinct production preview tokens and a complete identity configuration", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        APP_MODE: "demo",
        SERVICE_ROLE: "api",
        ADMIN_TOKEN: "a".repeat(40),
        SESSION_SECRET: "s".repeat(40),
        VIEWER_TOKEN: "x",
        PUBLIC_ORIGIN: "https://test.example",
      }),
    ).toThrow("VIEWER_TOKEN");
    expect(() => loadConfig({ OIDC_ISSUER: "https://id.example" })).toThrow(
      "together",
    );
    expect(() =>
      loadConfig({ ADMIN_TOKEN: "same", VIEWER_TOKEN: "same" }),
    ).toThrow("different");
  });
});
