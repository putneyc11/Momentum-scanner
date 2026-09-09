import crypto from "node:crypto";
import {
  strategyCatalog,
  evaluateSignal,
  riskDecision,
  sessionDate,
  sessionMinute,
  marketSession,
  simulateDay,
  atr,
  type Trade,
  type Bar,
  type HaltState,
  type ResearchDay,
} from "@momentum/engine";
import { Store } from "./store.js";
import { MarketFeed } from "./market.js";
import { queueResearch, executeResearch } from "./research.js";
import { safeError, type Config } from "./config.js";
import { compactEquity } from "./equity.js";
type ExitOrder = {
  id: string;
  clientOrderId?: string;
  status: string;
  filledQty: number;
  filledPrice?: number;
  filledAt?: string;
  type?: string;
};
type Intent = {
  id: string;
  strategyId: string;
  version: string;
  symbol: string;
  entryTime: string;
  quantity: number;
  entryPrice: number;
  stop: number;
  target: number | null;
  entryReason: string;
  state: string;
  orderId?: string;
  entryStatus?: string;
  filledQty?: number;
  filledPrice?: number;
  exitOrderId?: string;
  exitClientOrderId?: string;
  exitReason?: string;
  exitAttempt?: number;
  exitOrders?: ExitOrder[];
  remainingQty?: number;
  reconciliationError?: string | null;
  exitSubmissionUncertain?: boolean;
  lastReconciledAt?: string;
  parameters?: Record<string, number>;
  submittedAt?: string;
  entryFillTimeKnown?: boolean;
  managedStop?: number;
};
const terminal = new Set(["filled", "canceled", "expired", "rejected"]);
const finished = new Set(["closed", "cancelled", "rejected"]);
const activeIntent = (i: Intent) => !finished.has(i.state);
const finitePositive = (v: unknown) =>
  Number.isFinite(Number(v)) && Number(v) > 0;
const finiteNonnegative = (v: unknown) =>
  Number.isFinite(Number(v)) && Number(v) >= 0;
export class Runtime {
  market: MarketFeed;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private leaseHeld = false;
  private researching = false;
  private lastShadow = 0;
  private lastRecord = 0;
  private calendarClose = new Map<string, number | null>();
  constructor(
    readonly c: Config,
    readonly store: Store,
  ) {
    this.market = new MarketFeed(c, store);
  }
  async start() {
    if (!(await this.store.acquireLeader()))
      throw new Error("Another market/engine worker owns the lease");
    this.leaseHeld = true;
    await this.store.put("workerConfiguration", {
      keysConfigured: !!this.c.APCA_API_KEY_ID && !!this.c.APCA_API_SECRET_KEY,
      paperEnabled: this.c.PAPER_TRADING_ENABLED,
      dataFeed: this.c.ALPACA_DATA_FEED,
    });
    this.store.events.on("lease-lost", () => {
      this.leaseHeld = false;
      this.stop();
      process.exitCode = 1;
    });
    // A research process interrupted by a deploy is visible and retryable, never silently "running" forever.
    for (const run of await this.store.list<any>("research:"))
      if (run.status === "running")
        await this.store.put(`research:${run.id}`, {
          ...run,
          status: "failed",
          summary:
            "Interrupted by worker restart; run again to resume research",
        });
    await this.market.start();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), 15000);
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const now = new Date().toISOString();
      const day = sessionDate(now);
      const session = marketSession(now);
      const paused = await this.store.get("paused", false);
      let engine = {
        state: this.c.PAPER_TRADING_ENABLED ? "running" : "observe",
        reason: this.c.PAPER_TRADING_ENABLED
          ? "Evaluating completed bars; paper orders only"
          : "Paper execution is disabled. Market recording and shadow research remain active.",
        session,
        lastHeartbeat: now,
        shadowActive: true,
      };
      if (paused)
        engine = {
          ...engine,
          state: "paused",
          reason:
            "Operator paused new paper entries; protective orders and shadow research remain active.",
        };
      if (this.c.APCA_API_KEY_ID && this.c.APCA_API_SECRET_KEY) {
        try {
          const [account, positions, clock] = await Promise.all([
            this.market.alpaca.request<any>("/v2/account", {}, true),
            this.market.alpaca.request<any[]>("/v2/positions", {}, true),
            this.market.alpaca.request<any>("/v2/clock", {}, true),
          ]);
          const equity = Number(account.equity),
            buyingPower = Number(account.buying_power);
          if (
            !finitePositive(equity) ||
            !finiteNonnegative(buyingPower) ||
            !Array.isArray(positions) ||
            positions.some(
              (p) =>
                !Number.isFinite(Number(p.qty)) ||
                !Number.isFinite(Number(p.market_value)),
            ) ||
            typeof clock.is_open !== "boolean" ||
            !Number.isFinite(Date.parse(clock.next_close))
          )
            throw new Error(
              "Broker account, inventory or calendar snapshot invalid; no orders submitted",
            );
          let baseline = await this.store.get<any>("dayBaseline", null);
          if (baseline?.date !== day) {
            baseline = {
              date: day,
              equity: Number(account.last_equity) || equity,
              source: "broker previous close",
              createdAt: now,
            };
            await this.store.put("dayBaseline", baseline);
            await this.store.put("dayHalt", {
              sessionDate: day,
              halted: false,
              reason: null,
              triggeredAt: null,
            });
          }
          if (!finitePositive(baseline.equity))
            throw new Error(
              "Persisted session equity baseline is invalid; operator reconciliation required",
            );
          const dayPnl = equity - baseline.equity;
          await this.store.put("account", {
            equity,
            dayPnl,
            dayPnlPct: (dayPnl / baseline.equity) * 100,
            buyingPower,
            openPositions: positions.length,
          });
          const eq = await this.store.get<any[]>("equity", []);
          const high = Math.max(
            equity,
            ...eq
              .filter((e) => sessionDate(e.time) === day)
              .map((e) => e.equity),
          );
          await this.store.put(
            "equity",
            compactEquity([
              ...eq,
              { time: now, equity, drawdown: (equity / high - 1) * 100 },
            ]),
          );
          const lastEvent = this.market.feed.lastEventAt;
          const check = riskDecision({
            now,
            equity,
            dayStartEquity: baseline.equity,
            dayStartSessionDate: baseline.date,
            buyingPower,
            entry: 100,
            stop: 99,
            openPositions: positions.length,
            haltState: await this.store.get<HaltState | undefined>(
              "dayHalt",
              undefined,
            ),
            dataAgeMs: lastEvent
              ? Date.now() - Date.parse(lastEvent)
              : Infinity,
            maxDailyLossPct: this.c.DAILY_LOSS_LIMIT_PCT,
            maxPositions: this.c.MAX_OPEN_POSITIONS,
            riskPerTradePct: this.c.RISK_PER_TRADE_PCT,
            marketOpen: clock.is_open,
            killSwitch: paused,
          });
          await this.store.put("dayHalt", check.haltState);
          await this.reconcile();
          if (check.haltState.halted) {
            engine = {
              ...engine,
              state: "halted",
              reason: `Daily loss limit ${this.c.DAILY_LOSS_LIMIT_PCT}% reached. Entries remain blocked through ${day}; shadow testing continues.`,
            };
            if (this.c.PAPER_TRADING_ENABLED)
              await this.closeOwnedPositions("dayhalt", clock.is_open);
          } else if (!clock.is_open)
            engine = {
              ...engine,
              state: "session_closed",
              reason:
                "Paper entries use the official broker calendar and regular hours. Extended-hours data collection continues.",
            };
          else if (account.trading_blocked || account.account_blocked)
            engine = {
              ...engine,
              state: "blocked",
              reason: "Alpaca reports the account is blocked for trading.",
            };
          else if (this.c.PAPER_TRADING_ENABLED && !paused) {
            const owned = (await this.store.list<Intent>("intent:")).filter(
              activeIntent,
            );
            const unknown = positions.filter(
              (p) =>
                Number(p.qty) <= 0 ||
                !owned.some(
                  (i) =>
                    i.symbol === p.symbol && Number(p.qty) <= i.quantity + 1e-8,
                ),
            );
            if (unknown.length)
              engine = {
                ...engine,
                state: "blocked",
                reason:
                  "Existing positions were not opened by this engine. Reconcile them before enabling new entries.",
              };
            else if (
              owned.some(
                (i) =>
                  i.reconciliationError ||
                  i.state === "uncertain" ||
                  i.exitSubmissionUncertain,
              )
            )
              engine = {
                ...engine,
                state: "blocked",
                reason:
                  "An order or exit has an uncertain broker state. New entries are blocked until reconciled.",
              };
            else if (Date.parse(clock.next_close) - Date.now() < 5 * 60000) {
              await this.closeOwnedPositions("session_close", true);
              engine = {
                ...engine,
                state: "closing",
                reason:
                  "Closing owned positions before the regular session ends.",
              };
            } else if (check.codes.includes("STALE_OR_UNKNOWN_DATA"))
              engine = {
                ...engine,
                state: "data_stale",
                reason: "New entries blocked: market data is stale.",
              };
            else
              await this.entries({
                now,
                equity,
                buyingPower,
                positions,
                baseline,
                clock,
              });
          }
          if (
            this.c.PAPER_TRADING_ENABLED &&
            clock.is_open &&
            !check.haltState.halted
          )
            await this.manageExits(now);
        } catch (e) {
          engine = {
            ...engine,
            state: "error",
            reason: `Paper account unavailable; entries blocked. ${safeError(e)}`,
          };
          console.error(safeError(e));
        }
      } else
        engine = {
          ...engine,
          state: "unconfigured",
          reason:
            "Add replacement Alpaca keys in Render Environment to start live data collection.",
        };
      await this.store.put("engine", engine);
      await this.store.publish("snapshot", { kind: "overview", asOf: now });
      if (Date.now() - this.lastShadow > 60000) {
        this.lastShadow = Date.now();
        await this.shadow(day);
      }
      if (Date.now() - this.lastRecord > 5 * 60000) {
        this.lastRecord = Date.now();
        await this.record();
      }
      const hour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(new Date()),
      );
      if (hour >= this.c.RESEARCH_HOUR_ET) {
        await this.record();
        await queueResearch(this.store, "nightly-scheduler", `nightly-${day}`);
      }
      if (!this.researching) {
        const queued = (await this.store.list<any>("research:")).find(
          (r) => r.status === "queued",
        );
        if (queued) {
          this.researching = true;
          void executeResearch(this.store, queued.id).finally(() => {
            this.researching = false;
          });
        }
      }
    } catch (e) {
      await this.store.put("engine", {
        state: "error",
        reason: safeError(e),
        session: marketSession(new Date().toISOString()),
        lastHeartbeat: new Date().toISOString(),
        shadowActive: false,
      });
      console.error(safeError(e));
    } finally {
      this.busy = false;
    }
  }
  private async entries(ctx: any) {
    const active = (await this.store.list<Intent>("intent:")).filter(
      activeIntent,
    );
    if (
      active.some(
        (i) =>
          i.state === "uncertain" ||
          i.reconciliationError ||
          i.exitSubmissionUncertain,
      )
    )
      return;
    const activeSymbols = new Set(active.map((i) => i.symbol));
    for (const stock of this.market.stocks.slice(0, 35)) {
      const reservedSymbols = new Set([
        ...ctx.positions.map((p: any) => p.symbol),
        ...activeSymbols,
      ]);
      if (reservedSymbols.size >= this.c.MAX_OPEN_POSITIONS) break;
      if (activeSymbols.has(stock.symbol)) continue;
      const bars = (this.market.barsBySymbol.get(stock.symbol) || []).filter(
        (b) =>
          sessionDate(b.timestamp) === sessionDate(ctx.now) &&
          Date.parse(b.timestamp) + 60000 <= Date.now(),
      );
      if (
        bars.length < 30 ||
        Date.now() - Date.parse(bars.at(-1)!.timestamp) > 120_000
      )
        continue;
      const quote = this.market.quotes.get(stock.symbol);
      const quoteAge = quote ? Date.now() - Date.parse(quote.time) : Infinity;
      if (
        !quote ||
        !finitePositive(quote.bid) ||
        !finitePositive(quote.ask) ||
        quote.ask < quote.bid ||
        !Number.isFinite(quoteAge) ||
        quoteAge < 0 ||
        quoteAge > 10000 ||
        !Number.isFinite(quote.spreadBps) ||
        quote.spreadBps < 0 ||
        quote.spreadBps > 40
      )
        continue;
      for (const strategy of strategyCatalog) {
        const approved = await this.store.get<any>(
          `approved:${strategy.id}`,
          null,
        );
        // Every funded strategy must be explicitly approved after reviewing its shadow evidence.
        if (
          !approved ||
          !approved.version ||
          (approved.strategyId && approved.strategyId !== strategy.id)
        )
          continue;
        const signal = evaluateSignal(strategy, bars, {
          symbol: stock.symbol,
          asOf: ctx.now,
          parameters: approved.parameters,
          version: approved.version,
          spreadBps: quote.spreadBps,
          previousClose: stock.price / (1 + stock.changePct / 100),
        });
        if (!signal) continue;
        const all = await this.store.list<Intent>("intent:");
        if (
          all.filter(
            (i) =>
              i.symbol === stock.symbol &&
              i.strategyId === strategy.id &&
              sessionDate(i.entryTime) === sessionDate(ctx.now),
          ).length >= 3
        )
          continue;
        // Broker buying power can already reserve open orders. Reserving them again is conservative;
        // failing to reserve freshly submitted intents would oversubscribe a single loop's snapshot.
        const unfilled = (i: Intent) =>
          terminal.has(i.entryStatus || "")
            ? 0
            : Math.max(0, i.quantity - (i.filledQty || 0));
        const pendingNotional = active.reduce(
          (n, i) => n + unfilled(i) * i.entryPrice,
          0,
        );
        const notYetInSnapshot = active.reduce((n, i) => {
          const held =
            Number(
              ctx.positions.find((p: any) => p.symbol === i.symbol)?.qty,
            ) || 0;
          return (
            n +
            Math.max(0, (i.remainingQty ?? i.filledQty ?? 0) - held) *
              (i.filledPrice ?? i.entryPrice)
          );
        }, 0);
        const openRisk = active.reduce(
          (n, i) =>
            n +
            Math.max(0, (i.filledPrice ?? i.entryPrice) - i.stop) *
              (i.remainingQty ?? i.filledQty ?? 0) +
            Math.max(0, i.entryPrice - i.stop) * unfilled(i),
          0,
        );
        const roundUp = (v: number) =>
            Math.ceil(v * (v >= 1 ? 100 : 10000)) / (v >= 1 ? 100 : 10000),
          roundDown = (v: number) =>
            Math.floor(v * (v >= 1 ? 100 : 10000)) / (v >= 1 ? 100 : 10000);
        const entry = roundUp(quote.ask),
          stop = roundDown(signal.stop);
        if (entry - stop < 0.01 || stop <= 0) continue;
        const target =
          signal.parameters.targetR > 0
            ? roundUp(entry + (entry - stop) * signal.parameters.targetR)
            : null;
        const risk = riskDecision({
          now: ctx.now,
          equity: ctx.equity,
          dayStartEquity: ctx.baseline.equity,
          dayStartSessionDate: ctx.baseline.date,
          buyingPower: Math.max(
            0,
            ctx.buyingPower - pendingNotional - notYetInSnapshot,
          ),
          entry,
          stop,
          openPositions: reservedSymbols.size,
          grossExposure:
            ctx.positions.reduce(
              (n: number, p: any) => n + Math.abs(Number(p.market_value)),
              0,
            ) +
            pendingNotional +
            notYetInSnapshot,
          openRisk,
          dataAgeMs: Date.now() - Date.parse(stock.updatedAt),
          riskPerTradePct: this.c.RISK_PER_TRADE_PCT,
          maxPositions: this.c.MAX_OPEN_POSITIONS,
          maxDailyLossPct: this.c.DAILY_LOSS_LIMIT_PCT,
          haltState: await this.store.get("dayHalt", undefined),
          marketOpen: ctx.clock.is_open,
          killSwitch: await this.store.get("paused", false),
        });
        if (!risk.allowed) {
          await this.store.put(`decision:${strategy.id}:${stock.symbol}`, {
            at: ctx.now,
            symbol: stock.symbol,
            strategyId: strategy.id,
            reason: risk.reason,
            codes: risk.codes,
          });
          continue;
        }
        const asset = await this.market.alpaca.request<any>(
          `/v2/assets/${encodeURIComponent(stock.symbol)}`,
          {},
          true,
        );
        if (
          !asset.tradable ||
          asset.status !== "active" ||
          asset.class !== "us_equity" ||
          asset.exchange === "OTC"
        )
          continue;
        const id =
          "m2-" +
          crypto
            .createHash("sha256")
            .update(
              [
                strategy.id,
                approved.version,
                stock.symbol,
                signal.timestamp,
              ].join(":"),
            )
            .digest("hex")
            .slice(0, 32);
        const intent: Intent = {
          id,
          strategyId: strategy.id,
          version: approved.version,
          symbol: stock.symbol,
          entryTime: ctx.now,
          submittedAt: ctx.now,
          quantity: risk.quantity,
          entryPrice: entry,
          stop,
          target,
          entryReason: signal.reason,
          parameters: signal.parameters,
          state: "prepared",
        };
        if (!(await this.store.insertOnce(`intent:${id}`, intent))) continue;
        // Journal before sending; uncertain network outcomes are reconciled by client_order_id, never retried as a new order.
        let attempted = false;
        try {
          this.assertTradingLease();
          if (await this.store.get("paused", false))
            throw new Error("Paused before submission");
          this.assertTradingLease();
          attempted = true;
          const order = await this.market.alpaca.request<any>(
            "/v2/orders",
            {},
            true,
            "POST",
            {
              symbol: stock.symbol,
              qty: String(risk.quantity),
              side: "buy",
              type: "limit",
              limit_price: String(entry),
              time_in_force: "day",
              client_order_id: id,
              order_class: target ? "bracket" : "oto",
              stop_loss: { stop_price: String(stop) },
              ...(target
                ? { take_profit: { limit_price: String(target) } }
                : {}),
            },
          );
          if (!order?.id)
            throw new Error("Order acknowledgement did not contain an ID");
          intent.state = "submitted";
          intent.orderId = order.id;
          intent.entryStatus = order.status;
        } catch (e) {
          intent.state = attempted ? "uncertain" : "cancelled";
          await this.store.audit(
            "paper-engine",
            attempted ? "order-uncertain" : "order-withdrawn-before-submission",
            { id, error: safeError(e) },
          );
        }
        await this.store.put(`intent:${id}`, intent);
        await this.store.audit("paper-engine", "order-intent", {
          id,
          symbol: stock.symbol,
          strategy: strategy.id,
        });
        active.push(intent);
        activeSymbols.add(stock.symbol);
        if (intent.state === "uncertain") return;
        break;
      }
    }
  }
  private async reconcile() {
    for (const i of await this.store.list<Intent>("intent:")) {
      if (!activeIntent(i)) continue;
      const order = await this.market.alpaca
        .request<any>(
          "/v2/orders:by_client_order_id",
          { client_order_id: i.id, nested: "true" },
          true,
        )
        .catch(() => null);
      if (!order) {
        i.reconciliationError =
          "Entry order status unavailable; execution is blocked until reconciled";
        if (!i.orderId) i.state = "uncertain";
        await this.store.put(`intent:${i.id}`, i);
        continue;
      }
      try {
        if (
          !order.id ||
          order.symbol !== i.symbol ||
          order.side !== "buy" ||
          !finiteNonnegative(order.filled_qty) ||
          Number(order.filled_qty) > i.quantity + 1e-8 ||
          order.replaced_by
        )
          throw new Error(
            "Entry identity, replacement or fill quantity requires operator reconciliation",
          );
        const filledQty = Number(order.filled_qty);
        if (filledQty < (i.filledQty || 0) - 1e-8)
          throw new Error(
            "Broker cumulative entry fill quantity moved backwards",
          );
        if (filledQty > 0 && !finitePositive(order.filled_avg_price))
          throw new Error("Filled entry has no valid execution price");
        i.orderId = order.id;
        i.entryStatus = order.status;
        i.filledQty = filledQty;
        i.filledPrice = filledQty ? Number(order.filled_avg_price) : undefined;
        if (order.filled_at && Number.isFinite(Date.parse(order.filled_at))) {
          i.entryTime = order.filled_at;
          i.entryFillTimeKnown = true;
        }
        const exits = new Map(
          (i.exitOrders || []).map((exit) => [exit.id, exit]),
        );
        const absorb = (exit: any) => {
          if (
            !exit?.id ||
            exit.side !== "sell" ||
            exit.symbol !== i.symbol ||
            !finiteNonnegative(exit.filled_qty) ||
            exit.replaced_by
          )
            throw new Error(
              "Exit identity, replacement or fill quantity is not verifiable",
            );
          const qty = Number(exit.filled_qty),
            previous = exits.get(exit.id);
          if (
            qty < (previous?.filledQty || 0) - 1e-8 ||
            (qty > 0 && !finitePositive(exit.filled_avg_price))
          )
            throw new Error("Exit cumulative fill accounting is inconsistent");
          exits.set(exit.id, {
            id: exit.id,
            clientOrderId: exit.client_order_id,
            status: exit.status,
            filledQty: qty,
            filledPrice: qty ? Number(exit.filled_avg_price) : undefined,
            filledAt: exit.filled_at || previous?.filledAt,
            type: exit.type,
          });
        };
        for (const leg of order.legs || []) absorb(leg);
        // Preserve completed partial-exit orders across retries; their fills still belong to this trade.
        for (const old of i.exitOrders || []) {
          if (
            terminal.has(old.status) ||
            (order.legs || []).some((leg: any) => leg.id === old.id)
          )
            continue;
          const current = await this.market.alpaca.request<any>(
            `/v2/orders/${old.id}`,
            {},
            true,
          );
          absorb(current);
        }
        if (i.exitClientOrderId || i.exitOrderId) {
          const exit = i.exitOrderId
            ? await this.market.alpaca.request<any>(
                `/v2/orders/${i.exitOrderId}`,
                {},
                true,
              )
            : await this.market.alpaca.request<any>(
                "/v2/orders:by_client_order_id",
                { client_order_id: i.exitClientOrderId! },
                true,
              );
          absorb(exit);
          i.exitOrderId = exit.id;
          i.exitSubmissionUncertain = false;
        }
        i.exitOrders = [...exits.values()];
        const exitQty = i.exitOrders.reduce(
          (sum, exit) => sum + exit.filledQty,
          0,
        );
        if (exitQty > filledQty + 1e-8)
          throw new Error(
            "Confirmed sells exceed confirmed long fills; stop automation and reconcile the broker account",
          );
        i.remainingQty = Math.max(0, filledQty - exitQty);
        i.lastReconciledAt = new Date().toISOString();
        i.reconciliationError = null;
        const entryTerminal = terminal.has(order.status);
        if (filledQty === 0 && entryTerminal)
          i.state = order.status === "rejected" ? "rejected" : "cancelled";
        else if (
          filledQty > 0 &&
          i.remainingQty < 1e-8 &&
          entryTerminal &&
          i.exitOrders.every((exit) => terminal.has(exit.status))
        ) {
          const filledExits = i.exitOrders.filter((exit) => exit.filledQty > 0);
          if (
            !filledExits.every(
              (exit) =>
                exit.filledAt && Number.isFinite(Date.parse(exit.filledAt)),
            )
          )
            throw new Error("A closed exit has no broker fill timestamp");
          const value = filledExits.reduce(
              (sum, exit) => sum + exit.filledQty * exit.filledPrice!,
              0,
            ),
            price = value / exitQty;
          const pnl = value - i.filledPrice! * filledQty,
            exitTime = filledExits
              .map((exit) => exit.filledAt!)
              .sort((a, b) => Date.parse(a) - Date.parse(b))
              .at(-1)!;
          if (i.filledPrice! <= i.stop)
            throw new Error(
              "Actual entry fill violates initial stop risk; attribution requires review",
            );
          const t: Trade = {
            id: i.id,
            strategyId: i.strategyId,
            version: i.version,
            symbol: i.symbol,
            side: "long",
            entryTime: i.entryTime,
            exitTime,
            entryPrice: i.filledPrice!,
            exitPrice: price,
            quantity: filledQty,
            fees: 0,
            grossPnl: pnl,
            pnl,
            rMultiple: pnl / ((i.filledPrice! - i.stop) * filledQty),
            mfe: null,
            mae: null,
            reason: i.exitReason || filledExits.at(-1)?.type || "broker_exit",
            entryReason: i.entryReason,
            initialStop: i.stop,
            source: "paper",
          };
          await this.store.put(`trade:${i.id}`, {
            ...t,
            feeStatus: "pending broker statement",
            excursionStatus: "not recorded",
            pnlStatus: "gross until broker fees reconciled",
            entryTimeStatus: i.entryFillTimeKnown
              ? "broker filled timestamp"
              : "order submission proxy; exact partial-fill timestamp unavailable",
          });
          i.state = "closed";
        } else if (
          i.exitReason ||
          i.exitClientOrderId ||
          i.exitSubmissionUncertain
        )
          i.state = "closing";
        else i.state = filledQty > 0 ? "open" : "submitted";
      } catch (e) {
        i.reconciliationError = safeError(e);
        i.state = "uncertain";
      }
      await this.store.put(`intent:${i.id}`, i);
    }
  }
  private async closeOwnedPositions(
    reason: string,
    marketOpen: boolean,
    symbols?: Set<string>,
  ) {
    if (!marketOpen) return;
    // Each pass first re-reads terminal cancellations/fills. Cancellation acknowledgement is not terminal confirmation.
    await this.reconcile();
    const owned = (await this.store.list<Intent>("intent:")).filter(
      activeIntent,
    );
    for (const i of owned) {
      if (symbols && !symbols.has(i.symbol)) continue;
      if (
        i.reconciliationError ||
        i.exitSubmissionUncertain ||
        i.state === "uncertain" ||
        !i.orderId
      )
        continue;
      if (owned.filter((other) => other.symbol === i.symbol).length > 1) {
        i.reconciliationError = "Multiple active owners for one symbol";
        await this.store.put(`intent:${i.id}`, i);
        continue;
      }
      i.exitReason ??= reason;
      i.state = "closing";
      await this.store.put(`intent:${i.id}`, i);
      try {
        if (!terminal.has(i.entryStatus || "")) {
          this.assertTradingLease();
          await this.market.alpaca.request(
            `/v2/orders/${i.orderId}`,
            {},
            true,
            "DELETE",
          );
          continue;
        }
        const activeExits = (i.exitOrders || []).filter(
          (exit) => !terminal.has(exit.status),
        );
        // Our flatten order is already working. Never cancel it and simultaneously start a second sell.
        if (activeExits.some((exit) => exit.id === i.exitOrderId)) continue;
        if (activeExits.length) {
          for (const exit of activeExits) {
            this.assertTradingLease();
            await this.market.alpaca.request(
              `/v2/orders/${exit.id}`,
              {},
              true,
              "DELETE",
            );
          }
          continue;
        }
        const remaining = i.remainingQty ?? i.filledQty ?? 0;
        if (remaining <= 0) continue;
        const [positions, openOrders] = await Promise.all([
          this.market.alpaca.request<any[]>("/v2/positions", {}, true),
          this.market.alpaca.request<any[]>(
            "/v2/orders",
            { status: "open", symbols: i.symbol, nested: "true" },
            true,
          ),
        ]);
        const position = positions.find((p) => p.symbol === i.symbol),
          held = Number(position?.qty);
        if (
          !Number.isFinite(held) ||
          held <= 0 ||
          Math.abs(held - remaining) > 1e-8
        )
          throw new Error(
            "Fresh broker inventory differs from the reconciled long position; no sell submitted",
          );
        if (openOrders.some((order) => order.symbol === i.symbol))
          throw new Error(
            "Broker still reports working orders for this symbol; no second sell submitted",
          );
        const attempt = (i.exitAttempt || 0) + 1;
        if (attempt > 3)
          throw new Error(
            "Repeated terminal close attempts need operator review",
          );
        const exitId = `${i.id}-x${attempt}`;
        // Persist the CLIENT id before POST. A lost response can only be recovered by this same id.
        i.exitAttempt = attempt;
        i.exitClientOrderId = exitId;
        i.exitOrderId = undefined;
        i.exitSubmissionUncertain = true;
        await this.store.put(`intent:${i.id}`, i);
        this.assertTradingLease();
        const exit = await this.market.alpaca.request<any>(
          "/v2/orders",
          {},
          true,
          "POST",
          {
            symbol: i.symbol,
            qty: String(remaining),
            side: "sell",
            type: "market",
            time_in_force: "day",
            client_order_id: exitId,
          },
        );
        if (!exit?.id) throw new Error("Exit response missing order ID");
        i.exitOrderId = exit.id;
        i.exitSubmissionUncertain = false;
        i.reconciliationError = null;
      } catch (e) {
        i.reconciliationError = safeError(e);
        if (i.exitSubmissionUncertain) i.state = "uncertain";
      }
      await this.store.put(`intent:${i.id}`, i);
    }
  }
  private async manageExits(now: string) {
    for (const i of (await this.store.list<Intent>("intent:")).filter(
      activeIntent,
    )) {
      if (
        i.reconciliationError ||
        i.exitSubmissionUncertain ||
        i.state === "uncertain"
      )
        continue;
      if (i.exitReason) {
        await this.closeOwnedPositions(i.exitReason, true, new Set([i.symbol]));
        continue;
      }
      if (
        !terminal.has(i.entryStatus || "") &&
        Date.parse(now) - Date.parse(i.submittedAt || i.entryTime) > 90_000
      ) {
        await this.closeOwnedPositions(
          "entry_timeout",
          true,
          new Set([i.symbol]),
        );
        continue;
      }
      if (!i.filledQty || !i.filledPrice) continue;
      const strategy = strategyCatalog.find((s) => s.id === i.strategyId);
      if (!strategy) continue;
      const parameters = i.parameters ?? strategy.defaults;
      const all = (this.market.barsBySymbol.get(i.symbol) || []).filter(
        (b) =>
          sessionDate(b.timestamp) === sessionDate(now) &&
          Date.parse(b.timestamp) + 60_000 <= Date.parse(now),
      );
      const firstFullBar = Math.ceil(Date.parse(i.entryTime) / 60_000) * 60_000;
      const heldBars = all.filter(
        (b) => Date.parse(b.timestamp) >= firstFullBar,
      );
      let trail = i.managedStop ?? i.stop;
      for (const bar of heldBars) {
        const index = all.indexOf(bar);
        trail = Math.max(
          trail,
          bar.high - atr(all.slice(0, index + 1)) * parameters.trailAtr,
        );
      }
      i.managedStop = trail;
      await this.store.put(`intent:${i.id}`, i);
      const quote = this.market.quotes.get(i.symbol),
        age = quote ? Date.parse(now) - Date.parse(quote.time) : Infinity;
      const trigger =
        heldBars.length >= parameters.maxHoldBars
          ? "time_stop"
          : quote &&
              finitePositive(quote.bid) &&
              Number.isFinite(age) &&
              age >= 0 &&
              age <= 10_000 &&
              quote.bid <= trail
            ? "trailing_stop"
            : null;
      if (trigger)
        await this.closeOwnedPositions(trigger, true, new Set([i.symbol]));
    }
  }
  private assertTradingLease() {
    if (
      this.stopped ||
      !this.leaseHeld ||
      !this.c.PAPER_TRADING_ENABLED ||
      this.c.APP_MODE !== "paper"
    )
      throw new Error(
        "Paper order authority or worker lease is no longer active",
      );
  }
  private async shadow(day: string) {
    for (const stock of this.market.stocks.slice(0, 30)) {
      const bars = (this.market.barsBySymbol.get(stock.symbol) || []).filter(
        (b) =>
          sessionDate(b.timestamp) === day &&
          Date.parse(b.timestamp) + 60000 <= Date.now(),
      );
      if (bars.length < 30) continue;
      const discovery = await this.store.get<any>(
        `discovery:${day}:${stock.symbol}`,
        null,
      );
      // Without contemporaneous admission, do not replay today's winners as though known from the open.
      if (!discovery?.discoveredAt) continue;
      const observed: ResearchDay = {
        date: day,
        symbol: stock.symbol,
        bars,
        source: "alpaca",
        previousClose: stock.price / (1 + stock.changePct / 100),
        discoveredAt: discovery.discoveredAt,
        universeSnapshotId: discovery.universeSnapshotId,
      };
      for (const strategy of strategyCatalog) {
        const result = simulateDay(
          observed,
          strategy,
          {},
          { closeAtDataEnd: false },
        );
        await this.store.put(
          `shadow:${day}:${strategy.id}:${stock.symbol}`,
          result,
        );
        // Alternate parameter worlds have separate ledgers. Never add overlapping candidate P&L to the baseline account.
        const candidates = (
          await this.store.list<any>(`candidate:${strategy.id}:`)
        )
          .filter((c) => c.status === "shadow")
          .slice(0, 3);
        for (const candidate of candidates) {
          const activation =
            Date.parse(candidate.createdAt) > Date.parse(observed.discoveredAt!)
              ? candidate.createdAt
              : observed.discoveredAt;
          if (sessionDate(activation) > day) continue;
          const result = simulateDay(
            { ...observed, discoveredAt: activation },
            { ...strategy, version: candidate.version },
            candidate.parameters,
            { closeAtDataEnd: false },
          ).map((trade) => ({
            ...trade,
            id: `${trade.id}:${candidate.id}`,
            candidateId: candidate.id,
          }));
          await this.store.put(
            `shadowCandidate:${day}:${strategy.id}:${candidate.id}:${stock.symbol}`,
            result,
          );
        }
        // Yield between models so stream ingestion and lease-loss callbacks are not starved by replay.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.stopped) return;
      }
    }
  }
  private async record() {
    const now = new Date().toISOString();
    for (const [symbol, bars] of this.market.barsBySymbol) {
      const groups = new Map<string, Bar[]>();
      for (const b of bars) {
        if (Date.parse(b.timestamp) + 60000 > Date.now()) continue;
        const date = sessionDate(b.timestamp);
        groups.set(date, [...(groups.get(date) || []), b]);
      }
      for (const [date, dayBars] of groups) {
        const discovery = await this.store.get<any>(
          `discovery:${date}:${symbol}`,
          null,
        );
        if (!this.calendarClose.has(date)) {
          const calendar = await this.market.alpaca
            .request<any[]>("/v2/calendar", { start: date, end: date }, true)
            .catch(() => null);
          if (calendar) {
            const close = calendar[0]?.close;
            this.calendarClose.set(
              date,
              typeof close === "string" && /^\d\d:\d\d$/.test(close)
                ? Number(close.slice(0, 2)) * 60 + Number(close.slice(3))
                : null,
            );
          }
        }
        const close = this.calendarClose.get(date);
        const complete =
          typeof close === "number" &&
          (date < sessionDate(now) || sessionMinute(now) >= close) &&
          dayBars.some((b) => sessionMinute(b.timestamp) >= close - 1);
        const stock = this.market.stocks.find((s) => s.symbol === symbol);
        await this.store.saveDay({
          date,
          symbol,
          bars: dayBars,
          source: "alpaca",
          discoveredAt: discovery?.discoveredAt,
          universeSnapshotId: discovery?.universeSnapshotId,
          previousClose:
            stock && date === sessionDate(now)
              ? stock.price / (1 + stock.changePct / 100)
              : discovery?.previousClose,
          sessionComplete: complete,
        });
      }
    }
  }
  stop() {
    this.stopped = true;
    this.leaseHeld = false;
    clearInterval(this.timer);
    this.market.stop();
  }
}
