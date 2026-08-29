/* Builder: "PF is computed over raw dollars, so for a pod compounding to ruin
   it is dominated by the trades before the account died."

   That is worse than it sounds. runBacktest compounds -- qty is sized off
   equity -- so a pod that loses 99% sizes its last trades at ~1% of its first.
   Dollar PF is then mostly a measure of the opening stretch.

   R-multiples are size-independent: every trade contributes its risk-normalised
   result regardless of the account balance at the time. If dollar PF and R-PF
   disagree, dollar PF is telling us about compounding, not edge. */
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const days = D.loadRecordedDays();
/* R MUST BE QTY-WEIGHTED. Builder caught this before it was published.
   `pnl` is (px - fill) * qty and carries a qty term; `r` is
   (px - fill) / risk and does NOT. So every fill of a split exit holds the
   WHOLE position's R, and reading `t.r` straight counts a five-bar unwind as
   five trades. Dollar PF is granularity-safe for exactly the reason R is not.

   Measured on hyp/005: naive 0.373 vs weighted 0.440 for reclaim -- a 0.067
   artefact against a gate threshold of 0.03. It runs AGAINST split-heavy runs
   rather than for them, so it would have penalised the exit cap, not flattered
   it. Weighting each fill by its share of the position collapses it back. */
const rpf = (trades) => {
  const posQty = new Map();
  for (const t of trades || []) {
    const k = `${t.date}|${t.sym}|${t.entryM}`;
    posQty.set(k, (posQty.get(k) || 0) + (t.qty || 0));
  }
  let w = 0, l = 0;
  for (const t of trades || []) {
    const k = `${t.date}|${t.sym}|${t.entryM}`;
    const tot = posQty.get(k) || 0;
    if (!tot) continue;
    const r = (t.r || 0) * ((t.qty || 0) / tot);
    if (r > 0) w += r; else l -= r;
  }
  return l ? +(w / l).toFixed(3) : (w > 0 ? Infinity : 0);
};
/* first vs second half of each pod's own trade sequence, to show the dominance */
console.log("dollar PF is computed on a compounding curve; R-PF is size-independent\n");
console.log("pod        $PF     R-PF    $PF 1st half  $PF 2nd half     netPct");
for (const st of STRATS) {
  const r = runBacktest(days, { ...DEFAULTS, ...st.DEFAULTS }, 100000, st.signalAt);
  const t = r.trades || [];
  const mid = Math.floor(t.length / 2);
  const dpf = (arr) => {
    let w = 0, l = 0;
    for (const x of arr) { if (x.pnl > 0) w += x.pnl; else l -= x.pnl; }
    return l ? +(w / l).toFixed(3) : (w > 0 ? Infinity : 0);
  };
  console.log(st.key.padEnd(9) + String(r.metrics.profitFactor).padStart(7)
    + String(rpf(t)).padStart(9) + String(dpf(t.slice(0, mid))).padStart(14)
    + String(dpf(t.slice(mid))).padStart(14) + String(r.metrics.netPct).padStart(11));
}
console.log("\nIf $PF 1st half and 2nd half diverge widely, the headline $PF is an average");
console.log("of two different regimes of position size, not a property of the strategy.");
