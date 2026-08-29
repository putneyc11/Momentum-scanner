/* Is profit factor moveable without changing economics?

   PF buckets trade RECORDS by sign, and a record is a fill. scaleOutPct
   decides whether a position exits in one fill or two, and it is IN RANGES
   (`scaleOutPct: [50, 100, 5]`) — so if slicing moves PF, the tuner has had a
   free lever on its own objective this whole time.

   posPF aggregates fills back to positions and should not move. netPct comes
   off the equity curve and cannot move for this reason either. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");
const { positionPF } = require("../lib/regress");

const days = D.loadRecordedDays();
const POD = process.argv[2] || "redgreen";
const st = STRATS.find((s) => s.key === POD);
if (!st) { console.error(`no such pod: ${POD}`); process.exit(1); }

console.log(`[${POD}] varying scaleOutPct only — everything else at DEFAULTS\n`);
console.log("scaleOutPct   records   positions    recPF    posPF     netPct");
for (const scaleOutPct of [100, 95, 90, 85, 75, 60, 50]) {
  const r = runBacktest(days, { ...DEFAULTS, ...st.DEFAULTS, scaleOutPct }, 100000, st.signalAt);
  const p = positionPF(r.trades);
  console.log(String(scaleOutPct).padStart(11) + String(r.metrics.trades).padStart(10)
    + String(p.positions).padStart(12) + String(r.metrics.profitFactor).padStart(9)
    + String(p.pf).padStart(9) + String(r.metrics.netPct).padStart(11));
}
console.log("\nIf recPF moves while posPF and netPct hold, PF was moveable without economics.");
