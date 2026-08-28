/* What closes a TUNED CHAMPION's trades, and what each exit reason is worth.

   exits.js answers this for a pod's DEFAULTS. This answers it for a params file
   the tuner produced, which is the version that matters when reading a tune
   result -- because a stop-width change may not be a stop-width change at all.

   Raising maxStopPct lifts only a CAP; the minStopPct floor and the ATR
   distance still set the stop. Red Team's SERIOUS #6 on HYP-001: at
   12 / 30 / 90 redgreen exits 87.5% on VWAP or time rather than on the stop, so
   the configuration is "redgreen with signal-based exits", not "redgreen with
   more noise tolerance". A score reported without this mix invites the wrong
   story about what produced it.

     node research/exitmix.js redgreen                       # DEFAULTS
     node research/exitmix.js redgreen state/params/redgreen.json

   Read-only: loads state/days, prints a table, writes nothing. */
const fs = require("fs");
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const [key, pfile] = process.argv.slice(2);
const st = STRATS.find((s) => s.key === key);
if (!st) {
  console.log(`usage: node research/exitmix.js <pod> [params.json]\n  pods: ${STRATS.map((s) => s.key).join(", ")}`);
  process.exit(1);
}
const P = { ...DEFAULTS, ...st.DEFAULTS, ...(pfile ? JSON.parse(fs.readFileSync(pfile, "utf8")) : {}) };
const days = D.loadRecordedDays();
if (!days.length) { console.log("no recorded days in state/days"); process.exit(1); }

const res = runBacktest(days, P, 100000, st.signalAt);
const trades = res.trades || [];
console.log(`\n[${key}] ${pfile || "DEFAULTS"} over ${days.length} days`);
console.log(`  stop ${P.stopAtrMult}×ATR / ${P.minStopPct}% floor / ${P.maxStopPct}% cap`
  + `   targetR ${P.targetR}  vwapExit ${P.vwapExit}  timeStopMin ${P.timeStopMin}`);
console.log(`  ${JSON.stringify(res.metrics)}`);
if (!trades.length) { console.log("  no trades"); process.exit(0); }

const by = {};
for (const t of trades) {
  const b = (by[t.reason] = by[t.reason] || { n: 0, pnl: 0, r: 0 });
  b.n++; b.pnl += t.pnl; b.r += t.r || 0;
}
console.log(`  ${trades.length} trades`);
console.log("  reason        n     share      total PnL      avg R");
for (const [r, b] of Object.entries(by).sort((a, c) => c[1].n - a[1].n))
  console.log("  " + r.padEnd(10) + String(b.n).padStart(7)
    + (100 * b.n / trades.length).toFixed(1).padStart(8) + "%"
    + b.pnl.toFixed(0).padStart(14) + (b.r / b.n).toFixed(3).padStart(11));

/* The one line that decides how the result gets described. */
const stopShare = 100 * ((by.stop || { n: 0 }).n) / trades.length;
console.log(`\n  stop exits ${stopShare.toFixed(1)}% — `
  + (stopShare < 50
    ? "the stop is NOT what closes these trades. Report this as an exit-policy result."
    : "the stop is what closes these trades."));
