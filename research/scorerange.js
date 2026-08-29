/* Fizz's remaining live objection, measured: "the entire dynamic range of the
   objective, across meaningfully different strategies, is roughly one point in
   a hundred and fifty."

   lib/tune.js:27  score(m) = m.netPct - 0.5 * m.maxDDPct + thin
   and the search accepts on a strict `tScore > champTrain` over the TRAIN
   split. So the question is not the objective's magnitude (-148 vs -148.8) but
   its SPREAD relative to the differences the search must resolve, plus how
   much of the candidate cloud is stuck on one of the two cliffs (-100 for
   zero trades, -5 for thin trading).

   `score` and `splitDays` are imported from lib/tune.js, not reimplemented --
   the referee is not edited or copied. Candidates are drawn UNIFORMLY from
   each pod's own RANGES, which is the literal reading of "across meaningfully
   different strategies"; the annealed cloud the tuner actually walks is
   NARROWER than this, so this is an upper bound on the available range.

   Usage: node research/scorerange.js <podKey> [n]  -> one JSON line
*/
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS, RANGES } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");
const { score, splitDays } = require("../lib/tune");
const { mulberry32 } = require("../lib/synth");

const podKey = process.argv[2];
const N = +(process.argv[3] || 60);
const st = STRATS.find((s) => s.key === podKey);
if (!st) { console.error("unknown pod " + podKey); process.exit(1); }

const ranges = st.RANGES || RANGES;
const base = { ...DEFAULTS, ...st.DEFAULTS };
const days = D.loadRecordedDays();
const { train, valid, test } = splitDays(days);

/* same snapping the tuner uses, so a drawn candidate is one the search could
   actually hold */
const clampStep = (v, [lo, hi, step]) => {
  const snapped = Math.round((v - lo) / step) * step + lo;
  return +Math.min(hi, Math.max(lo, snapped)).toFixed(4);
};

const rng = mulberry32(4242);
const rows = [];
for (let i = 0; i < N; i++) {
  const P = { ...base };
  if (i > 0) {                        /* row 0 is DEFAULTS itself, as the anchor */
    for (const k of Object.keys(ranges)) {
      const [lo, hi] = ranges[k];
      P[k] = clampStep(lo + rng() * (hi - lo), ranges[k]);
    }
  }
  const m = runBacktest(train, P, 100000, st.signalAt).metrics;
  rows.push({ s: score(m), netPct: m.netPct, dd: m.maxDDPct, trades: m.trades,
              thin: m.trades === 0 ? "zero" : (m.trades < m.days * 0.3 ? "thin" : "ok") });
}

const scores = rows.map((r) => r.s);
const live = rows.filter((r) => r.thin === "ok").map((r) => r.s);   /* neither cliff */
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(p * (s.length - 1))].toFixed(3) : null; };
const sd = (a) => { if (a.length < 2) return null; const m = a.reduce((x, y) => x + y, 0) / a.length;
  return +Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)).toFixed(3); };

console.log(JSON.stringify({
  pod: podKey, n: N, knobs: Object.keys(ranges).length,
  split: { train: train.length, valid: valid.length, test: test.length },
  baseScore: +rows[0].s.toFixed(3), baseNetPct: rows[0].netPct, baseDD: rows[0].dd,
  /* whole cloud, cliffs included */
  min: q(scores, 0), p25: q(scores, 0.25), med: q(scores, 0.5), p75: q(scores, 0.75), max: q(scores, 1),
  range: +(Math.max(...scores) - Math.min(...scores)).toFixed(3), sd: sd(scores),
  /* cloud with both cliffs excluded -- the range the search actually works in */
  liveN: live.length,
  liveRange: live.length > 1 ? +(Math.max(...live) - Math.min(...live)).toFixed(3) : null,
  liveIQR: live.length > 1 ? +(q(live, 0.75) - q(live, 0.25)).toFixed(3) : null,
  liveSd: sd(live),
  /* how much of the cloud is parked on a cliff rather than on the surface */
  zeroTrade: rows.filter((r) => r.thin === "zero").length,
  thinPenalty: rows.filter((r) => r.thin === "thin").length,
  /* can the search tell candidates apart at all? */
  distinct: new Set(scores.map((x) => x.toFixed(4))).size,
  beatBase: rows.slice(1).filter((r) => r.s > rows[0].s).length,
  /* is the objective actually driven by netPct, or is the dd term doing work? */
  netRange: +(Math.max(...rows.map((r) => r.netPct)) - Math.min(...rows.map((r) => r.netPct))).toFixed(2),
  ddRange: +(Math.max(...rows.map((r) => r.dd)) - Math.min(...rows.map((r) => r.dd))).toFixed(2),
}));
