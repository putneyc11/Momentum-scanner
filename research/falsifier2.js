/* HYP-001 falsifier #2: is the wide-stop gain the drift thesis, or just fewer
   round trips paying less slippage? At slipBps 0 there is no cost to save. If
   the climb survives with costs removed, it is not a cost artefact. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
const GRID = [[1.5, 1, 4], [6, 8, 30], [8, 12, 40], [12, 30, 90]];
console.log("profit factor by stop width, at 20bps vs 0bps slippage\n");
console.log("pod         stop        PF@20    PF@0     climb@20  climb@0");
for (const key of ["redgreen", "gapgo", "reclaim"]) {
  const st = STRATS.find((s) => s.key === key);
  let base20 = null, base0 = null;
  for (const [stopAtrMult, minStopPct, maxStopPct] of GRID) {
    const mk = (slipBps) => runBacktest(days,
      { ...DEFAULTS, ...st.DEFAULTS, stopAtrMult, minStopPct, maxStopPct, slipBpsOverride: slipBps },
      100000, st.signalAt).metrics.profitFactor;
    const a = mk(20), b = mk(0);
    if (base20 == null) { base20 = a; base0 = b; }
    console.log(key.padEnd(11) + `${stopAtrMult}/${minStopPct}/${maxStopPct}`.padEnd(11)
      + String(a).padStart(8) + String(b).padStart(8)
      + ((a - base20 >= 0 ? "+" : "") + (a - base20).toFixed(2)).padStart(13)
      + ((b - base0 >= 0 ? "+" : "") + (b - base0).toFixed(2)).padStart(9));
  }
  console.log("");
}
console.log("If climb@0 collapses toward zero, the gain was cost, not drift.");
