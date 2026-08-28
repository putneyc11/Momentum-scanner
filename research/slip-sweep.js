/* Slippage sensitivity: how much of each pod's result is an artifact of the
   frozen 20bps assumption? Read-only; writes nothing. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { runBacktest } = require("../lib/backtest");
const { DEFAULTS } = require("../lib/strategy");

const days = D.loadRecordedDays();
console.log(`days: ${days.length}`);

// price context: what does the tape we trade actually cost?
const buckets = { "<$1": 0, "$1-2": 0, "$2-5": 0, "$5-10": 0, ">$10": 0 };
let n = 0;
for (const d of days) for (const s of Object.keys(d.symbols)) {
  const bars = d.symbols[s]; if (!bars || !bars.length) continue;
  const p = bars[Math.floor(bars.length / 2)].c; n++;
  if (p < 1) buckets["<$1"]++; else if (p < 2) buckets["$1-2"]++;
  else if (p < 5) buckets["$2-5"]++; else if (p < 10) buckets["$5-10"]++; else buckets[">$10"]++;
}
console.log(`symbol-days by price (n=${n}):`,
  Object.entries(buckets).map(([k, v]) => `${k} ${(100 * v / n).toFixed(1)}%`).join("  "));

const LEVELS = [20, 50, 100];
console.log("\npod        " + LEVELS.map(l => `PF@${l}bps`.padStart(11)).join(""));
for (const st of STRATS) {
  const row = LEVELS.map(bps => {
    const P = { ...DEFAULTS, ...st.DEFAULTS, slipBps: bps };
    const { metrics } = runBacktest(days, P, 100000, st.signalAt);
    return String(metrics.profitFactor).padStart(11);
  });
  console.log(st.key.padEnd(11) + row.join(""));
}
