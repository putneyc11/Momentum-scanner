/* Could an exit actually have been filled at the modelled price?

   MAX_BAR_PARTICIPATION is applied at ENTRY only: lib/backtest.js sizes qty
   against the entry bar's volume, and closeOut sells the whole position at the
   bar close with no size constraint at all. This measures the gap.

   RECONCILED from two independent implementations (2026-08-28), which is why
   two different sets of numbers for "surge flatten/eod" are in the channel.
   Both were right about the defect; they differed in two ways:

   1. POD SELECTION. The first version had
          STRATS.find(s => s.key === process.argv[2] || "surge")
      which parses as `(s.key === argv[2]) || "surge"`. The right-hand side is a
      non-empty string, so the predicate is truthy for EVERY pod and find()
      always returned STRATS[0] -- moon -- whatever you asked for. Verified by
      running it: `node research/exitfill.js surge` printed moon's 153 exits.
      The surge figures published alongside it came from a scratch copy, so the
      committed instrument did not reproduce them.

   2. EXITS WITH NO BAR AT THEIR EXIT MINUTE. `eod` closes at
      bars[bars.length-1].c but stamps a synthetic minute 1200, so no bar is
      ever found at that minute and every eod exit was skipped. For surge that
      silently dropped all 54 eod exits and reported the remaining 125 flatten
      exits as "179 flatten/eod" -- the source of the "102 of 125" denominator.
      Since closeOut genuinely prices eod at the LAST bar, the faithful
      denominator is that bar's volume, not exclusion.

   Both denominators are printed below so the two published tables reconcile.
   (The pod-selection bug was independently fixed in a380bc5; this file
   supersedes that fix rather than duplicating it.)

   WHEN READING THE OUTPUT, CHECK WHICH SURGE YOU HAVE. On feat/regression-gate
   surge is still the 3-bar climax entry and has 35 flatten/eod exits. The 179
   quoted in HYP-005 is first-expansion surge, which exists only on hyp/003.
   Same script, different strategy, not a discrepancy.

     node research/exitfill.js surge
     node research/exitfill.js redgreen state/params/redgreen.json

   Read-only: loads state/days, prints tables, writes nothing. */
const fs = require("fs");
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const [key, pfile] = process.argv.slice(2);
const st = STRATS.find((s) => s.key === key);
if (!st) {
  console.log(`usage: node research/exitfill.js <pod> [params.json]\n  pods: ${STRATS.map((s) => s.key).join(", ")}`);
  process.exit(1);
}
const P = { ...DEFAULTS, ...st.DEFAULTS, ...(pfile ? JSON.parse(fs.readFileSync(pfile, "utf8")) : {}) };
const days = D.loadRecordedDays();
if (!days.length) { console.log("no recorded days in state/days"); process.exit(1); }
const byDate = new Map(days.map((d) => [d.date, d]));

const trades = runBacktest(days, P, 100000, st.signalAt).trades || [];
const rows = [];
for (const t of trades) {
  const bars = (byDate.get(t.date) || { symbols: {} }).symbols[t.sym] || [];
  const atMinute = bars.find((b) => b.m === t.exitM);
  /* closeOut prices eod at the last bar, so that bar's volume is the honest
     denominator for an exit stamped with the synthetic minute 1200 */
  const bar = atMinute || bars[bars.length - 1];
  if (!bar || !bar.v) continue;
  rows.push({ ...t, share: t.qty / bar.v, hadBar: !!atMinute });
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] || 0; };
function report(label, sel) {
  const s = rows.filter(sel);
  if (!s.length) return;
  const sh = s.map((r) => r.share);
  const over = (x) => s.filter((r) => r.share > x).length;
  console.log(`\n${label}: ${s.length} exits, PnL ${s.reduce((a, r) => a + r.pnl, 0).toFixed(0)}`);
  console.log(`  share of the exit minute's volume — median ${(pct(sh,.5)*100).toFixed(1)}%  p75 ${(pct(sh,.75)*100).toFixed(1)}%  p90 ${(pct(sh,.9)*100).toFixed(1)}%  p95 ${(pct(sh,.95)*100).toFixed(1)}%  max ${(Math.max(...sh)*100).toFixed(0)}%`);
  for (const th of [0.10, 0.50, 1.00])
    console.log(`  demanding >${(th*100).toFixed(0)}% of the bar: ${over(th)} (${(100*over(th)/s.length).toFixed(1)}%)`);
}

const noBar = rows.filter((r) => !r.hadBar).length;
console.log(`[${st.key}] ${pfile || "DEFAULTS"} — ${trades.length} exits over ${days.length} days`);
console.log(`${noBar} exit at a minute with NO bar (priced at the last bar instead)`);
report("ALL exits", () => true);
report("flatten + eod  [faithful: eod priced at the last bar]", (r) => r.reason === "flatten" || r.reason === "eod");
report("flatten + eod  [with-bar-only: the older denominator]", (r) => (r.reason === "flatten" || r.reason === "eod") && r.hadBar);
for (const reason of [...new Set(rows.map((r) => r.reason))].sort())
  report(`reason=${reason}`, (r) => r.reason === reason);

/* how much of the result rides on a handful of prints */
const pf = (ts) => {
  const w = ts.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const l = Math.abs(ts.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return l ? w / l : Infinity;
};
const desc = [...trades].sort((a, b) => b.pnl - a.pnl);
console.log("\nprofit factor with the top N winners removed");
for (const n of [0, 5, 25, 100]) console.log(`  drop top ${String(n).padStart(3)}:  ${pf(desc.slice(n)).toFixed(3)}`);
