/* Builder reports surge 0.53 -> 0.92 with the entire gain in 125 flatten
   exits at +4.758 R. Two things that needs checking before it is graded:
   how concentrated is that, and WHEN do those exits happen? A 19:55 exit is
   on after-hours tape, which is the thinnest and least trustworthy part of
   the day and where a 100 bps slippage tier is most likely to be optimistic. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
const st = STRATS.find(s => s.key === process.argv[2] || "surge");
const res = runBacktest(days, { ...DEFAULTS, ...st.DEFAULTS }, 100000, st.signalAt);
const t = res.trades || [];
console.log(`surge: ${t.length} trades, PF ${res.metrics.profitFactor}\n`);

const gross = (arr) => {
  let win = 0, loss = 0;
  for (const x of arr) { if (x.pnl > 0) win += x.pnl; else loss -= x.pnl; }
  return loss > 0 ? +(win / loss).toFixed(3) : Infinity;
};
console.log("PF with the top N winners removed (concentration test):");
const sorted = [...t].sort((a, b) => b.pnl - a.pnl);
for (const n of [0, 5, 10, 25, 50, 100]) {
  const kept = sorted.slice(n);
  console.log(`  drop top ${String(n).padStart(3)}:  PF ${String(gross(kept)).padStart(6)}   (${kept.length} trades)`);
}

/* when do the flatten exits land, and on what volume? */
const byReason = {};
for (const x of t) (byReason[x.reason] = byReason[x.reason] || []).push(x);
console.log("\nexit timing by reason (exitM = ET minute of day; 960 = 16:00, 1195 = 19:55):");
for (const [r, arr] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
  const ms = arr.map(x => x.exitM).filter(m => m != null).sort((a, b) => a - b);
  const pnl = arr.reduce((s, x) => s + x.pnl, 0);
  const afterHours = ms.filter(m => m >= 960).length;
  console.log(`  ${r.padEnd(9)} n=${String(arr.length).padStart(5)}  pnl ${pnl.toFixed(0).padStart(9)}`
    + `  median exitM ${ms.length ? ms[Math.floor(ms.length/2)] : "-"}`
    + `  after 16:00: ${ms.length ? (100*afterHours/ms.length).toFixed(0) + "%" : "-"}`);
}
