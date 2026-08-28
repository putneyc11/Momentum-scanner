/* Two questions the first sweep raised:
   1. Does the gradient keep going, or does it turn over? A monotonic climb
      that never stops usually means "stop being removed entirely", not an edge.
   2. Does it replicate on reclaim — the other pod whose entry beats random?
      A principle replicates; a coincidence does not. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
const mid = Math.floor(days.length / 2);
const H1 = days.slice(0, mid), H2 = days.slice(mid);
const GRID = [[1.5, 1, 4], [3, 2, 8], [6, 8, 30], [8, 12, 40], [10, 20, 60], [12, 30, 90]];

for (const key of ["redgreen", "reclaim", "moon", "gapgo"]) {
  const st = STRATS.find((s) => s.key === key);
  console.log(`\n[${key}]  stopAtr/min%/max%      all       H1       H2   trades   stop%   avgR`);
  for (const [stopAtrMult, minStopPct, maxStopPct] of GRID) {
    const P = { ...DEFAULTS, ...st.DEFAULTS, stopAtrMult, minStopPct, maxStopPct };
    const r = runBacktest(days, P, 100000, st.signalAt);
    const a = r.metrics;
    const b = runBacktest(H1, P, 100000, st.signalAt).metrics.profitFactor;
    const c = runBacktest(H2, P, 100000, st.signalAt).metrics.profitFactor;
    const stops = (r.trades || []).filter((t) => t.reason === "stop").length;
    const star = (a.profitFactor > 1 && b > 1 && c > 1) ? "  <== both halves > 1" : "";
    console.log(`  ${stopAtrMult}/${minStopPct}/${maxStopPct}`.padEnd(23)
      + String(a.profitFactor).padStart(9) + String(b).padStart(9) + String(c).padStart(9)
      + String(a.trades).padStart(9)
      + (a.trades ? (100 * stops / a.trades).toFixed(0) + "%" : "-").padStart(8)
      + String(a.avgR).padStart(8) + star);
  }
}
console.log("\ntuner RANGES: stopAtrMult [0.8-3], minStopPct [1-4], maxStopPct [4-12]");
