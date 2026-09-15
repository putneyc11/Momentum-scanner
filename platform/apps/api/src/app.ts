import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  strategyCatalog,
  sessionDate,
  type Trade,
  type Bar,
} from "@momentum/engine";
import { Store, type StoreEvent } from "./store.js";
import { auth, streamLifetime, type AuthedRequest } from "./auth.js";
import { safeError, type Config } from "./config.js";
import { publicTrade, publicMetrics, strategyView } from "./demo.js";
import { analyze, aggregateBars, type Stock } from "./market.js";
import {
  qualifiesMover,
  withPreviousClose,
  SCANNER_MIN_CHANGE_PCT,
} from "./scanner.js";
import { queueResearch, executeResearch } from "./research.js";
import { candidateEvidence, type Candidate } from "./promotion.js";

export async function allTrades(store: Store, mode: string): Promise<Trade[]> {
  if (mode === "demo") return store.get("demoTrades", []);
  const paper = await store.list<Trade>("trade:");
  const shadow = await store.list<Trade[]>("shadow:");
  return [...paper, ...shadow.flat()].sort(
    (a, b) => Date.parse(b.exitTime) - Date.parse(a.exitTime),
  );
}
function rangeTrades(trades: Trade[], query: any) {
  return trades.filter(
    (t) =>
      (!query.strategy || t.strategyId === query.strategy) &&
      (!query.symbol || t.symbol === query.symbol) &&
      (!query.source || t.source === query.source) &&
      (!query.from || t.entryTime >= query.from) &&
      (!query.to || t.entryTime <= query.to),
  );
}
export function createApp(c: Config, store: Store) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: c.NODE_ENV === "production" ? [] : null,
        },
      },
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/health", (_req, res) =>
    res.json({ ok: true, service: "momentum-api", mode: c.APP_MODE }),
  );
  app.get("/ready", async (_req, res) => {
    try {
      await store.get("ready", true);
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });
  const security = auth(c);
  app.use("/api", security.csrf);
  app.post(
    "/api/v1/auth/login",
    rateLimit({
      windowMs: 15 * 60000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    security.login,
  );
  app.get("/api/v1/session", async (req, res) => {
    const identity = await security.identity(req);
    res.json({
      authenticated: !!identity,
      mode: c.APP_MODE,
      product: c.WEB_PRODUCT,
      role: identity?.role ?? null,
    });
  });
  app.post("/api/v1/auth/logout", (_req, res) => {
    res.clearCookie("momentum_session", { path: "/" });
    res.json({ ok: true });
  });
  app.use(
    "/api/v1",
    security.requireAuth,
    rateLimit({
      windowMs: 60000,
      limit: 400,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  // Both browser cookie sessions and native bearer tokens access the same versioned market API.
  app.get("/api/v1/scanner", async (req, res) => {
    const scope = z
      .enum(["movers", "tracked"])
      .default("movers")
      .parse(req.query.scope);
    const snapshot = await store.get("scanner", {
      asOf: null,
      feed: await store.get("feed", {
        state: "unconfigured",
        feed: c.ALPACA_DATA_FEED,
        lastEventAt: null,
        error: "Waiting for market worker",
      }),
      stocks: [] as Stock[],
    });
    // The web keeps an explicit tracked cache so live ticks can move symbols
    // into/out of the visible list without deleting research or position data.
    const stocks = snapshot.stocks.map(withPreviousClose);
    res.json({
      ...snapshot,
      stocks: scope === "tracked" ? stocks : stocks.filter(qualifiesMover),
      scope,
      criteria: {
        minimumChangePct: SCANNER_MIN_CHANGE_PCT,
        comparison: "gt",
        basis: "previousClose",
      },
    });
  });
  app.get("/api/v1/scanner/:symbol", async (req, res) => {
    const symbol = z
      .string()
      .regex(/^[A-Z][A-Z0-9.\-]{0,9}$/)
      .parse(req.params.symbol.toUpperCase());
    const timeframe = z
      .enum(["1Min", "5Min", "15Min", "1Hour", "1Day"])
      .default("1Min")
      .parse(req.query.timeframe);
    const market = await store.get<any>(`market:${symbol}`, null);
    if (!market) {
      res
        .status(404)
        .json({ error: "Symbol is not currently in the scanner universe" });
      return;
    }
    const bars = aggregateBars(market.bars || [], timeframe);
    const indicatorBars: Bar[] = bars.map((b) => ({
      timestamp: new Date(b.time * 1000).toISOString(),
      ...b,
    }));
    res.json({ ...market, bars, analysis: analyze(indicatorBars) });
  });
  const perIdentity = new Map<string, number>();
  app.get("/api/v1/events", async (req: AuthedRequest, res) => {
    const subject = req.identity!.sub;
    if ((perIdentity.get(subject) || 0) >= 5) {
      res.status(429).json({ error: "Too many live connections" });
      return;
    }
    perIdentity.set(subject, (perIdentity.get(subject) || 0) + 1);
    res.status(200).set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event: StoreEvent) => {
      if (req.identity!.role === "viewer" && event.type === "research") return;
      if (
        !res.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        )
      )
        res.end();
    };
    send({ type: "feed", data: await store.get("feed", {}) });
    store.events.on("event", send);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    // Rotate finite-lived sessions through reauthentication; no infinite stream after cookie expiry.
    const expiry = setTimeout(() => res.end(), streamLifetime(req.identity!));
    req.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      store.events.off("event", send);
      const n = (perIdentity.get(subject) || 1) - 1;
      n ? perIdentity.set(subject, n) : perIdentity.delete(subject);
    });
  });
  app.use("/api/v1", security.requireAdmin);
  app.get("/api/v1/overview", async (req, res) => {
    const trades = rangeTrades(await allTrades(store, c.APP_MODE), req.query);
    const today =
      c.APP_MODE === "demo"
        ? "2026-09-09"
        : sessionDate(new Date().toISOString());
    const dayTrades = trades.filter((t) => sessionDate(t.entryTime) === today);
    const account = await store.get("account", {
      equity: 0,
      dayPnl: 0,
      dayPnlPct: 0,
      buyingPower: 0,
      openPositions: 0,
    });
    const engine = await store.get("engine", {
      state: "unconfigured",
      reason: "Waiting for market worker",
      session: "closed",
      lastHeartbeat: null,
      shadowActive: false,
    });
    const paper = dayTrades.filter((t) => t.source === "paper"),
      shadow = dayTrades.filter((t) => t.source === "simulation");
    res.json({
      mode: c.APP_MODE,
      asOf:
        c.APP_MODE === "demo"
          ? "2026-09-09T18:30:00Z"
          : new Date().toISOString(),
      account,
      engine,
      feed: await store.get("feed", {}),
      equity: await store.get("equity", []),
      strategyBook: "simulation",
      accountBook: c.APP_MODE === "demo" ? "demo" : "paper",
      strategies: strategyCatalog.map((s) => strategyView(s.id, shadow)),
      recentTrades: paper.slice(0, 50).map(publicTrade),
      risk: {
        dailyLossLimitPct: c.DAILY_LOSS_LIMIT_PCT,
        lossUsedPct: Math.max(0, -account.dayPnlPct),
        maxPositions: c.MAX_OPEN_POSITIONS,
        riskPerTradePct: c.RISK_PER_TRADE_PCT,
      },
    });
  });
  app.get("/api/v1/strategies", async (req, res) => {
    const book = req.query.source === "paper" ? "paper" : "simulation";
    const trades = rangeTrades(await allTrades(store, c.APP_MODE), {
      ...req.query,
      source: book,
    });
    res.json(
      await Promise.all(
        strategyCatalog.map(async (s) => ({
          ...strategyView(s.id, trades, await store.list(`candidate:${s.id}:`)),
          book,
        })),
      ),
    );
  });
  app.get("/api/v1/strategies/:id", async (req, res) => {
    const s = strategyCatalog.find((s) => s.id === req.params.id);
    if (!s) {
      res.status(404).json({ error: "Unknown strategy" });
      return;
    }
    const approved = await store.get<any>(`approved:${s.id}`, null);
    const trades = rangeTrades(await allTrades(store, c.APP_MODE), {
      ...req.query,
      strategy: s.id,
    });
    const book = req.query.source === "paper" ? "paper" : "simulation";
    const v = strategyView(
      s.id,
      trades.filter((t) => t.source === book),
      await store.list(`candidate:${s.id}:`),
      book === "paper" ? approved?.parameters : undefined,
    );
    res.json({
      ...v,
      status: approved ? "paper" : "shadow",
      book,
      approvedVersion: approved?.version ?? null,
      paperMetrics: publicMetrics(trades.filter((t) => t.source === "paper")),
      shadowMetrics: publicMetrics(
        trades.filter((t) => t.source === "simulation"),
      ),
      decisions: await store.list(`decision:${s.id}:`),
    });
  });
  app.post(
    "/api/v1/strategies/:id/candidates",
    async (req: AuthedRequest, res) => {
      const strategy = strategyCatalog.find((s) => s.id === req.params.id);
      if (!strategy) {
        res.status(404).json({ error: "Unknown strategy" });
        return;
      }
      const body = z
        .object({
          parameters: z.record(z.string(), z.number().finite()),
          notes: z.string().max(2000).default(""),
        })
        .strict()
        .parse(req.body);
      const params = { ...strategy.defaults };
      for (const [k, v] of Object.entries(body.parameters)) {
        const lever = strategy.parameters.find((p) => p.key === k);
        if (!lever || v < lever.min || v > lever.max) {
          res
            .status(400)
            .json({ error: `Parameter ${k} is outside its allowed range` });
          return;
        }
        const steps = (v - lever.min) / lever.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) {
          res
            .status(400)
            .json({ error: `Parameter ${k} must follow its step size` });
          return;
        }
        params[k] = v;
      }
      const id = crypto.randomUUID();
      const candidate = {
        id,
        strategyId: strategy.id,
        version: `candidate-${id.slice(0, 8)}`,
        createdAt: new Date().toISOString(),
        status: "shadow",
        parameters: params,
        notes: body.notes,
      };
      await store.put(`candidate:${strategy.id}:${id}`, candidate);
      await store.audit(req.identity!.sub, "candidate-created", {
        id,
        strategyId: strategy.id,
        parameters: params,
      });
      res.status(201).json(candidate);
    },
  );
  app.get(
    "/api/v1/strategies/:id/candidates/:candidateId",
    async (req, res) => {
      const candidate = await store.get<Candidate | null>(
        `candidate:${req.params.id}:${req.params.candidateId}`,
        null,
      );
      if (!candidate) {
        res.status(404).json({ error: "Unknown candidate" });
        return;
      }
      const evidence = await candidateEvidence(store, candidate, c.APP_MODE);
      res.json({
        ...candidate,
        ...evidence,
        trades: evidence.trades.map(publicTrade),
      });
    },
  );
  app.post(
    "/api/v1/strategies/:id/candidates/:candidateId/approve",
    async (req: AuthedRequest, res) => {
      const body = z
        .object({
          version: z.string().min(1).max(120),
          acknowledgePaperRisk: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const candidate = await store.get<Candidate | null>(
        `candidate:${req.params.id}:${req.params.candidateId}`,
        null,
      );
      if (!candidate) {
        res.status(404).json({ error: "Unknown candidate" });
        return;
      }
      const evidence = await candidateEvidence(store, candidate, c.APP_MODE);
      if (body.version !== candidate.version || !evidence.promotion.eligible) {
        res.status(409).json({
          error: "This version is not eligible for paper execution",
          ...evidence.promotion,
        });
        return;
      }
      const approved = {
        strategyId: candidate.strategyId,
        candidateId: candidate.id,
        version: candidate.version,
        parameters: candidate.parameters,
        approvedAt: new Date().toISOString(),
        approvedBy: req.identity!.sub,
      };
      await store.put(`approved:${candidate.strategyId}`, approved);
      await store.audit(req.identity!.sub, "paper-version-approved", {
        ...approved,
        evidence: {
          trades: evidence.metrics.trades,
          sessions: evidence.sessions,
        },
      });
      res.json({ ...approved, paperExecutionEnabled: c.PAPER_TRADING_ENABLED });
    },
  );
  app.post(
    "/api/v1/strategies/:id/disable",
    async (req: AuthedRequest, res) => {
      if (!strategyCatalog.some((s) => s.id === req.params.id)) {
        res.status(404).json({ error: "Unknown strategy" });
        return;
      }
      await store.put(`approved:${req.params.id}`, null);
      await store.audit(req.identity!.sub, "paper-version-disabled", {
        strategyId: req.params.id,
      });
      res.json({
        ok: true,
        detail:
          "New entries disabled. Existing protective exits remain managed.",
      });
    },
  );
  app.get("/api/v1/trades", async (req, res) =>
    res.json(
      rangeTrades(await allTrades(store, c.APP_MODE), req.query).map(
        publicTrade,
      ),
    ),
  );
  app.get("/api/v1/research", async (_req, res) =>
    res.json({
      runs: await store.list("research:"),
      schedule: `Nightly at ${c.RESEARCH_HOUR_ET}:00 America/New_York (DST aware)`,
      policy:
        "Train on chronological real sessions, validate with embargo, report untouched holdout, observe challengers in shadow. No automatic funded promotion.",
    }),
  );
  app.post(
    "/api/v1/research/run",
    rateLimit({ windowMs: 60000, limit: 2 }),
    async (req: AuthedRequest, res) => {
      const existing = (await store.list<any>("research:")).find((r) =>
        ["queued", "running"].includes(r.status),
      );
      if (existing) {
        res.status(202).json(existing);
        return;
      }
      const id = await queueResearch(store, req.identity!.sub);
      res.status(202).json({ id, status: "queued" });
      if (c.APP_MODE === "demo") void executeResearch(store, id);
    },
  );
  app.post("/api/v1/engine/pause", async (req: AuthedRequest, res) => {
    await store.put("paused", true);
    await store.audit(req.identity!.sub, "entries-paused", {});
    res.json({ ok: true });
  });
  app.post("/api/v1/engine/resume", async (req: AuthedRequest, res) => {
    const halt = await store.get<any>("dayHalt", null);
    if (
      halt?.halted &&
      halt.sessionDate === sessionDate(new Date().toISOString())
    ) {
      res.status(409).json({
        error: "Daily loss protection cannot be overridden through Resume",
      });
      return;
    }
    await store.put("paused", false);
    await store.audit(req.identity!.sub, "manual-pause-cleared", {});
    res.json({ ok: true });
  });
  app.get("/api/v1/system", async (_req, res) => {
    const worker = await store.get("workerConfiguration", {
      dataFeed: c.ALPACA_DATA_FEED,
      keysConfigured: !!c.APCA_API_KEY_ID && !!c.APCA_API_SECRET_KEY,
      paperEnabled: c.PAPER_TRADING_ENABLED,
    });
    res.json({
      mode: c.APP_MODE,
      asOf: new Date().toISOString(),
      engine: await store.get("engine", {}),
      feed: await store.get("feed", {}),
      services: [
        {
          name: "API",
          status: "healthy",
          detail: "Authenticated, versioned endpoints",
        },
        {
          name: "Market gateway",
          status: (await store.get<any>("feed", {})).state || "unconfigured",
          detail: "One upstream stream; shared to web and iOS",
        },
        {
          name: "Database",
          status: store.pool ? "postgres" : "development",
          detail: store.pool
            ? "Durable PostgreSQL ledger and leader lease"
            : "Local development persistence",
        },
        {
          name: "Paper execution",
          status: worker.paperEnabled ? "enabled" : "disabled",
          detail:
            "Only paper-api.alpaca.markets; per-strategy approval required",
        },
      ],
      configuration: { ...worker, oidcConfigured: !!c.OIDC_ISSUER },
      orders: await store.list("intent:"),
      audit: await store.auditLog(),
    });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found" }),
  );
  app.all(["/settings", "/alpaca/{*path}", "/trading/{*path}"], (_req, res) =>
    res.status(410).json({
      error: "Legacy credential and proxy endpoints have been removed",
    }),
  );
  const web = path.resolve(
    fileURLToPath(new URL("../../web/dist", import.meta.url)),
  );
  app.use(
    express.static(web, {
      index: false,
      maxAge: c.NODE_ENV === "production" ? "1h" : 0,
    }),
  );
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(web, "index.html")),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return;
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: "Invalid request",
          details: err.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        });
        return;
      }
      console.error(safeError(err));
      res.status(500).json({
        error: "Request failed. Check server health.",
        code: "INTERNAL_ERROR",
      });
    },
  );
  return app;
}
