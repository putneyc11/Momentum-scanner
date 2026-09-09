import type { Metrics, Trade } from "./types.js";

/** Rates are percentages (0–100). Drawdown here is realized-trade drawdown, not intraday marked equity. */
export function computeMetrics(
  input: Trade[],
  initialEquity = 100_000,
): Metrics {
  const trades = [...input].sort(
    (a, b) =>
      Date.parse(a.exitTime) - Date.parse(b.exitTime) ||
      a.id.localeCompare(b.id),
  );
  if (initialEquity <= 0 || !Number.isFinite(initialEquity))
    throw new RangeError("Initial equity must be positive");
  if (
    trades.some(
      (t) =>
        ![
          t.pnl,
          t.fees,
          t.rMultiple,
          Date.parse(t.entryTime),
          Date.parse(t.exitTime),
        ].every(Number.isFinite) ||
        (t.mfe !== null && !Number.isFinite(t.mfe)) ||
        (t.mae !== null && !Number.isFinite(t.mae)) ||
        Date.parse(t.exitTime) < Date.parse(t.entryTime),
    )
  )
    throw new RangeError("Invalid trade metric input");
  let wins = 0,
    losses = 0,
    grossProfit = 0,
    grossLoss = 0,
    equity = initialEquity,
    peak = initialEquity;
  let maxDrawdown = 0,
    maxDrawdownPct = 0,
    streak = 0,
    consecutiveLosses = 0;
  for (const t of trades) {
    if (t.pnl > 0) {
      wins++;
      grossProfit += t.pnl;
      streak = 0;
    } else if (t.pnl < 0) {
      losses++;
      grossLoss -= t.pnl;
      streak++;
    } else streak = 0;
    consecutiveLosses = Math.max(consecutiveLosses, streak);
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }
  const n = trades.length,
    average = (f: (t: Trade) => number) =>
      n ? trades.reduce((sum, t) => sum + f(t), 0) / n : 0;
  const excursionAverage = (key: "mfe" | "mae") => {
    const known = trades
      .map((t) => t[key])
      .filter((v): v is number => v !== null);
    return known.length
      ? known.reduce((a, b) => a + b, 0) / known.length
      : null;
  };
  const p = n ? wins / n : 0,
    z = 1.959963984540054;
  const denominator = 1 + (z * z) / Math.max(1, n);
  const center = (p + (z * z) / (2 * Math.max(1, n))) / denominator;
  const margin =
    (z *
      Math.sqrt(
        (p * (1 - p) + (z * z) / (4 * Math.max(1, n))) / Math.max(1, n),
      )) /
    denominator;
  return {
    trades: n,
    wins,
    losses,
    breakeven: n - wins - losses,
    hitRate: p * 100,
    grossProfit,
    grossLoss,
    netPnl: grossProfit - grossLoss,
    fees: trades.reduce((sum, t) => sum + t.fees, 0),
    profitFactor: grossLoss ? grossProfit / grossLoss : null,
    expectancy: average((t) => t.pnl),
    averageR: average((t) => t.rMultiple),
    averageWin: wins ? grossProfit / wins : 0,
    averageLoss: losses ? grossLoss / losses : 0,
    maxDrawdown,
    maxDrawdownPct,
    consecutiveLosses,
    averageHoldMinutes: average(
      (t) => (Date.parse(t.exitTime) - Date.parse(t.entryTime)) / 60_000,
    ),
    averageMfe: excursionAverage("mfe"),
    averageMae: excursionAverage("mae"),
    winRateConfidence95: n
      ? [Math.max(0, center - margin) * 100, Math.min(1, center + margin) * 100]
      : [0, 100],
  };
}
