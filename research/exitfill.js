/* The participation cap is applied at ENTRY only (lib/backtest.js sizes qty
   against the entry bar's volume). Exits have no size constraint at all.
   100% of surge's gain is realised in 19:55 flatten exits on after-hours tape,
   so: could those exits actually have been filled at the modelled price? */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
const POD = process.argv[2] || "surge";
const st = STRATS.find((s) => s.key === POD);
if (!st) { console.error(`no such pod: ${POD}`); process.exit(1); }
const res = runBacktest(days, { ...DEFAULTS, ...st.DEFAULTS }, 100000, st.signalAt);
const t = (res.trades || []).filter(x => x.reason === "flatten" || x.reason === "eod");

/* index bar volume by day+symbol+minute */
const vol = new Map();
for (const d of days) for (const s of Object.keys(d.symbols))
  for (const b of d.symbols[s]) vol.set(`${d.date}|${s}|${b.m}`, b.v);

const ratios = [];
let noBar = 0;
for (const x of t) {
  const v = vol.get(`${x.date}|${x.sym}|${x.exitM}`);
  if (v == null) { noBar++; continue; }
  ratios.push(v > 0 ? x.qty / v : Infinity);
}
ratios.sort((a, b) => a - b);
const pct = (p) => ratios[Math.floor(ratios.length * p)];
console.log(`${t.length} flatten/eod exits, ${ratios.length} with a bar at the exit minute, ${noBar} with none\n`);
console.log(`exit size as a share of that minute's ENTIRE volume:`);
console.log(`  median ${(100*pct(0.5)).toFixed(1)}%   p75 ${(100*pct(0.75)).toFixed(1)}%   p90 ${(100*pct(0.9)).toFixed(1)}%   p95 ${(100*pct(0.95)).toFixed(1)}%   max ${(100*ratios[ratios.length-1]).toFixed(0)}%`);
const over = (x) => ratios.filter(r => r > x).length;
console.log(`\n  exits demanding >10% of the bar: ${over(0.10)} of ${ratios.length} (${(100*over(0.10)/ratios.length).toFixed(1)}%)`);
console.log(`  exits demanding >50% of the bar: ${over(0.50)} (${(100*over(0.50)/ratios.length).toFixed(1)}%)`);
console.log(`  exits demanding >100% of the bar: ${over(1.0)} (${(100*over(1.0)/ratios.length).toFixed(1)}%)`);
