/* Is ANY pod stable across both halves of the tape? A pod that only works in
   one regime is not an edge, it is a coincidence with good timing. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
const mid = Math.floor(days.length / 2);
const H1 = days.slice(0, mid), H2 = days.slice(mid);
console.log(`H1 ${days[0].date}..${days[mid-1].date} (${H1.length}d)   H2 ${days[mid].date}..${days[days.length-1].date} (${H2.length}d)`);
console.log("default params, cap on, 20bps\n");
console.log("pod            H1 PF    H2 PF     spread   both>1?");
for (const st of STRATS) {
  const P = { ...DEFAULTS, ...st.DEFAULTS };
  const a = runBacktest(H1, P, 100000, st.signalAt).metrics.profitFactor;
  const b = runBacktest(H2, P, 100000, st.signalAt).metrics.profitFactor;
  console.log(st.key.padEnd(12) + String(a).padStart(7) + String(b).padStart(9)
    + Math.abs(b - a).toFixed(2).padStart(11) + (a > 1 && b > 1 ? "     yes" : "      no"));
}
