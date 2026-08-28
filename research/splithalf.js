/* Does timeStopMin:300 beat 120 in BOTH halves of the tape, or only overall?
   A fix that only works in one regime is a coincidence. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
const mid = Math.floor(days.length / 2);
const halves = [
  ["first  " + days[0].date + ".." + days[mid - 1].date, days.slice(0, mid)],
  ["second " + days[mid].date + ".." + days[days.length - 1].date, days.slice(mid)],
  ["all    " + days[0].date + ".." + days[days.length - 1].date, days],
];
const st = STRATS.find((s) => s.key === "moon");
console.log("moon — profit factor by rider stall window (cap on, 20bps)\n");
console.log("window".padEnd(34) + "  120m    300m    delta");
for (const [label, sub] of halves) {
  const a = runBacktest(sub, { ...DEFAULTS, ...st.DEFAULTS, timeStopMin: 120 }, 100000, st.signalAt).metrics;
  const b = runBacktest(sub, { ...DEFAULTS, ...st.DEFAULTS, timeStopMin: 300 }, 100000, st.signalAt).metrics;
  const d = (b.profitFactor - a.profitFactor);
  console.log(label.padEnd(34) + String(a.profitFactor).padStart(6) + String(b.profitFactor).padStart(8)
    + ((d >= 0 ? "+" : "") + d.toFixed(2)).padStart(9) + `   (${a.trades} -> ${b.trades} trades)`);
}
