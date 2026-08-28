/* The exit-parameter grid is flat at PF 0.81, so the trades are not being
   decided by targets or time stops. Find out what is actually closing them,
   and what each exit reason is worth. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
for (const key of ["redgreen", "reclaim", "moon"]) {
  const st = STRATS.find((s) => s.key === key);
  const res = runBacktest(days, { ...DEFAULTS, ...st.DEFAULTS }, 100000, st.signalAt);
  const trades = res.trades || [];
  if (!trades.length) { console.log(`${key}: runBacktest returned no trade list`); continue; }
  const by = {};
  for (const t of trades) {
    const b = (by[t.reason] = by[t.reason] || { n: 0, pnl: 0, r: 0 });
    b.n++; b.pnl += t.pnl; b.r += t.r || 0;
  }
  console.log(`\n[${key}] ${trades.length} trades`);
  console.log("  reason        n     share      total PnL      avg R");
  for (const [r, b] of Object.entries(by).sort((a, c) => c[1].n - a[1].n))
    console.log("  " + r.padEnd(10) + String(b.n).padStart(7)
      + (100 * b.n / trades.length).toFixed(1).padStart(8) + "%"
      + b.pnl.toFixed(0).padStart(14) + (b.r / b.n).toFixed(3).padStart(11));
}
