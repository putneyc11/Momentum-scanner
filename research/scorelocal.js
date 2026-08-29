/* !! VOID -- DO NOT USE THE temp 0.15 NUMBERS FROM THIS SCRIPT !!
   Red Team FATAL #8 (REVIEWS/HYP-009.md, 2026-08-29), confirmed correct.

   Line ~60 perturbs `base` on every row. lib/tune.js:105 perturbs `champ`,
   which updates on every acceptance -- so setting temp to 0.15 here does NOT
   model the end of a tuning run. There is no walk, therefore no late champion.
   The late range, late IQR, median-improving-step and tie-rate figures this
   produced are void and were retracted in channel.

   The temp 1.00 numbers ARE still valid: at iteration 1 `champ` is still
   `base` and temp is 0.996, so perturbing DEFAULTS at temp 1.0 is exactly
   iteration 1. That is the only cloud this script models faithfully, and it
   is the one HYP-009's falsifier #1 asks about.

   Superseded by research/walk.js, which runs the real adaptive trajectory and
   validates itself against tune() before reporting.
*/
/* Companion to scorerange.js. That one draws uniformly from RANGES, which is
   the literal reading of "across meaningfully different strategies" -- but it
   is NOT the cloud the tuner walks. lib/tune.js anneals from the CHAMPION,
   temp 1.0 -> 0.15, mutating 1..ceil(knobs*temp*0.5) knobs by +/-(hi-lo)*temp.
   A globally wide objective can still be locally flat, and locally is where
   `tScore > champTrain` gets decided.

   So this measures the spread of score() in the champion's own neighbourhood
   at both ends of the anneal, temp 1.0 (iteration 1) and temp 0.15 (the last
   iteration, where the search is narrowest and most likely to be blind).

   DISCLOSURE: the step rule below is a REIMPLEMENTATION of tune.js's private
   `perturb`, not an import -- perturb is not exported and lib/tune.js is not
   mine to edit. Cross-pollination from sibling champions is omitted (no
   sibling params here), which makes this cloud slightly narrower than the real
   one. `score` and `splitDays` are the real imports.

   Usage: node research/scorelocal.js <podKey> <temp> [n] -> one JSON line
*/
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS, RANGES } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");
const { score, splitDays } = require("../lib/tune");
const { mulberry32 } = require("../lib/synth");

const podKey = process.argv[2];
const temp = +process.argv[3];
const N = +(process.argv[4] || 40);
const st = STRATS.find((s) => s.key === podKey);
if (!st) { console.error("unknown pod " + podKey); process.exit(1); }

const ranges = st.RANGES || RANGES;
const base = { ...DEFAULTS, ...st.DEFAULTS };
const { train } = splitDays(D.loadRecordedDays());

const clampStep = (v, [lo, hi, step]) => {
  const snapped = Math.round((v - lo) / step) * step + lo;
  return +Math.min(hi, Math.max(lo, snapped)).toFixed(4);
};
/* verbatim step rule from tune.js:38-57, cross-pollination branch removed */
const perturb = (P, rng) => {
  const next = { ...P };
  const keys = Object.keys(ranges);
  const nMut = 1 + Math.floor(rng() * Math.max(1, Math.round(keys.length * temp * 0.5)));
  for (let k = 0; k < nMut; k++) {
    const key = keys[Math.floor(rng() * keys.length)];
    const [lo, hi, step] = ranges[key];
    const span = (hi - lo) * temp;
    next[key] = clampStep(P[key] + (rng() - 0.5) * 2 * span, ranges[key]);
  }
  return next;
};

const rng = mulberry32(4242);
const ev = (P) => { const m = runBacktest(train, P, 100000, st.signalAt).metrics;
  return { s: score(m), trades: m.trades, days: m.days }; };

const champ = ev(base);
const rows = [];
for (let i = 0; i < N; i++) rows.push(ev(perturb(base, rng)));

const scores = rows.map((r) => r.s);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(p * (s.length - 1))].toFixed(3); };
console.log(JSON.stringify({
  pod: podKey, temp, n: N,
  champScore: +champ.s.toFixed(3),
  min: q(scores, 0), med: q(scores, 0.5), max: q(scores, 1),
  range: +(Math.max(...scores) - Math.min(...scores)).toFixed(3),
  iqr: +(q(scores, 0.75) - q(scores, 0.25)).toFixed(3),
  distinct: new Set(scores.map((x) => x.toFixed(4))).size,
  /* the only thing the accept test actually asks */
  beatChamp: scores.filter((s) => s > champ.s).length,
  /* how big is the median improving step, when there is one */
  medStepUp: (() => { const up = scores.filter((s) => s > champ.s).map((s) => s - champ.s).sort((a, b) => a - b);
    return up.length ? +up[Math.floor(up.length / 2)].toFixed(3) : null; })(),
  tiesWithChamp: scores.filter((s) => Math.abs(s - champ.s) < 1e-9).length,
  zeroTrade: rows.filter((r) => r.trades === 0).length,
  thinPenalty: rows.filter((r) => r.trades > 0 && r.trades < r.days * 0.3).length,
}));
