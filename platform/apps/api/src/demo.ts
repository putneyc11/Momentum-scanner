import {
  strategyCatalog,
  computeMetrics,
  sessionDate,
  type Bar,
  type Trade,
} from "@momentum/engine";
import { Store } from "./store.js";
import { analyze } from "./market.js";
export function publicMetrics(trades: Trade[]) {
  const m = computeMetrics(trades);
  return {
    ...m,
    winRate: m.hitRate,
    avgWin: m.averageWin,
    avgLoss: m.averageLoss,
    avgR: m.averageR,
  };
}
export function publicTrade(t: Trade) {
  return {
    ...t,
    netPnl: t.pnl,
    pnlPct: (t.exitPrice / t.entryPrice - 1) * 100,
    status: "closed",
    strategyName:
      strategyCatalog.find((s) => s.id === t.strategyId)?.name ?? t.strategyId,
    exitReason: t.reason,
  };
}
export function strategyView(
  id: string,
  trades: Trade[],
  versions: any[] = [],
  parameters?: Record<string, number>,
) {
  const s = strategyCatalog.find((s) => s.id === id)!;
  const selected = trades.filter((t) => t.strategyId === id);
  let balance = 0,
    peak = 0;
  const equity = selected
    .sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime))
    .map((t) => {
      balance += t.pnl;
      peak = Math.max(peak, balance);
      return {
        time: t.exitTime,
        equity: balance,
        drawdown: ((balance - peak) / (100000 + peak)) * 100,
      };
    });
  return {
    ...s,
    status: "shadow",
    allocationPct: 0,
    metrics: publicMetrics(selected),
    parameters: Object.fromEntries(
      s.parameters.map((p) => [
        p.key,
        { ...p, value: parameters?.[p.key] ?? s.defaults[p.key] },
      ]),
    ),
    trades: selected.map(publicTrade),
    versions,
    equity,
  };
}
/** Explicit, reproducible fixtures. No demo fixture is promoted into broker history or training. */
export async function seedDemo(store: Store) {
  const now = new Date("2026-09-09T18:30:00.000Z");
  const symbols = [
    "BIAF",
    "GPRO",
    "NVDA",
    "AMD",
    "TSLA",
    "CDTG",
    "IMRN",
    "AAPL",
  ];
  const trades: Trade[] = [];
  const stocks: any[] = [];
  for (let s = 0; s < symbols.length; s++) {
    let price = [17.33, 1.76, 171.2, 181.8, 337.9, 1.31, 1.78, 232.4][s];
    const bars: Bar[] = [];
    for (let i = 0; i < 570; i++) {
      const open = price;
      price = Math.max(
        0.1,
        price *
          (1 + Math.sin(i * 0.31 + s) * 0.002 + Math.cos(i * 0.079) * 0.0008),
      );
      bars.push({
        timestamp: new Date(
          Date.parse("2026-09-09T08:00:00Z") + i * 60000,
        ).toISOString(),
        open,
        high: Math.max(open, price) * 1.002,
        low: Math.min(open, price) * 0.998,
        close: price,
        volume: Math.round(22000 + Math.abs(Math.sin(i * 0.21 + s)) * 90000),
      });
    }
    const quote = {
      bid: price - 0.01,
      ask: price + 0.01,
      spreadBps: (0.02 / price) * 10000,
      time: now.toISOString(),
    };
    const tape = Array.from({ length: 30 }, (_, i) => ({
      id: `demo-${s}-${i}`,
      symbol: symbols[s],
      time: new Date(now.getTime() - i * 1300).toISOString(),
      price: price * (1 + Math.sin(i) * 0.0005),
      size: 100 + (i % 6) * 200,
    }));
    const feed = {
      state: "demo",
      feed: "offline fixture",
      lastEventAt: now.toISOString(),
      error: null,
    };
    await store.put(`market:${symbols[s]}`, {
      symbol: symbols[s],
      bars,
      trades: tape,
      quote,
      feed,
    });
    stocks.push({
      symbol: symbols[s],
      price,
      changePct: [35.6, 26.62, 3.9, 4.2, 2.8, 45.49, 60.36, 1.3][s],
      volume: bars.reduce((n, b) => n + b.volume, 0),
      relativeVolume: 2.2 + s * 0.8,
      score: 94 - s * 5,
      spreadBps: quote.spreadBps,
      updatedAt: now.toISOString(),
    });
  }
  for (let s = 0; s < strategyCatalog.length; s++)
    for (let i = 0; i < 9; i++) {
      const entry = 10 + s * 1.9 + i * 0.12;
      const pnl =
        [142, -81, 238, 74, -126, 102, -57, 168, 43][i] *
        (s === 3 ? -1 : 1) *
        (1 + s * 0.07);
      const qty = 200;
      const entryTime = new Date(
        Date.parse("2026-09-09T13:35:00Z") + (i * 28 + s * 3) * 60000,
      ).toISOString();
      trades.push({
        id: `demo:${s}:${i}`,
        strategyId: strategyCatalog[s].id,
        version: "1.0.0",
        symbol: symbols[(s + i) % symbols.length],
        side: "long",
        entryTime,
        exitTime: new Date(Date.parse(entryTime) + 12 * 60000).toISOString(),
        entryPrice: entry,
        exitPrice: entry + pnl / qty,
        quantity: qty,
        fees: 1.2,
        grossPnl: pnl + 1.2,
        pnl,
        rMultiple: pnl / 100,
        mfe: Math.max(pnl, 0) + 25,
        mae: -Math.max(-pnl, 0) - 10,
        reason: pnl > 0 ? "target" : "stop",
        entryReason: strategyCatalog[s].rules[0],
        initialStop: entry - 0.5,
        source: "simulation",
      });
    }
  const equity = Array.from({ length: 360 }, (_, i) => ({
    time: new Date(
      Date.parse("2026-09-09T08:00:00Z") + i * 105000,
    ).toISOString(),
    equity: i < 180 ? 67500 - i * 11 + Math.sin(i * 0.17) * 380 : 65379.72,
    drawdown: i < 180 ? -i * 0.017 : -3.12,
  }));
  await store.put("demoTrades", trades);
  await store.put("equity", equity);
  await store.put("account", {
    equity: 65379.72,
    dayPnl: -2102.64,
    dayPnlPct: -3.12,
    buyingPower: 130759.44,
    openPositions: 0,
  });
  await store.put("engine", {
    state: "halted",
    reason:
      "Demo scenario: 3% daily loss limit reached. Paper entries are blocked until the next trading session. Shadow research continues.",
    session: "regular",
    lastHeartbeat: now.toISOString(),
    shadowActive: true,
  });
  const feed = {
    state: "demo",
    feed: "offline fixture",
    lastEventAt: now.toISOString(),
    error: null,
  };
  await store.put("feed", feed);
  await store.put("scanner", { asOf: now.toISOString(), feed, stocks });
  if (!(await store.list("research:")).length)
    await store.put("research:demo", {
      id: "demo-research",
      startedAt: "2026-09-09T01:00:00Z",
      completedAt: "2026-09-09T01:03:24Z",
      status: "completed",
      candidates: 32,
      accepted: 0,
      rejected: 32,
      summary:
        "Illustrative research report. All candidates remain shadow-only; no promotion evidence is claimed.",
      stages: [
        {
          name: "Discover",
          status: "complete",
          detail: "8 registered strategy families",
        },
        {
          name: "Train",
          status: "complete",
          detail: "Bounded parameter search, execution costs included",
        },
        {
          name: "Validate",
          status: "complete",
          detail: "Chronological validation and embargo",
        },
        {
          name: "Holdout",
          status: "complete",
          detail: "Unseen final sessions",
        },
        {
          name: "Promote",
          status: "blocked",
          detail: "Demo data cannot qualify a strategy",
        },
      ],
      results: strategyCatalog.map((s, i) => ({
        strategyId: s.id,
        name: s.name,
        decision: "REJECTED",
        reason:
          i % 2
            ? "Insufficient independent holdout trades"
            : "Demo data is excluded from promotion",
        trainScore: 1.4 + i * 0.13,
        validationScore: 1.1 + i * 0.07,
        holdoutScore: null,
        sampleSize: 18 + i * 3,
        parameters: s.defaults,
      })),
    });
}
