/* Self-improvement loop: walk-forward random search over strategy.RANGES.

   - Days are split chronologically: first 70% train, last 30% validate.
   - Candidates are perturbations of the current champion (simulated-
     annealing style: wide early, narrow late).
   - A candidate must beat the champion on TRAIN and then also score at
     least as well on VALIDATE — that gate is what keeps the loop from
     curve-fitting itself into a corner on a lucky stretch of days.
   - Score = net% minus half the max drawdown, with a penalty when the
     system barely trades (an algorithm that never trades can't improve).

   The engine calls this nightly after recording the day; more recorded
   days -> more meaningful tuning. */

const { DEFAULTS, RANGES } = require("./strategy");
const { runBacktest } = require("./backtest");
const { mulberry32 } = require("./synth");

function score(m) {
  if (m.trades === 0) return -100;
  const thin = m.trades < m.days * 0.3 ? -5 : 0; // trading way too rarely
  return m.netPct - 0.5 * m.maxDDPct + thin;
}

function clampStep(v, [lo, hi, step]) {
  const snapped = Math.round((v - lo) / step) * step + lo;
  return +Math.min(hi, Math.max(lo, snapped)).toFixed(4);
}

function perturb(P, rng, temp, ranges, seeds) {
  const next = { ...P };
  const keys = Object.keys(ranges);
  const nMut = 1 + Math.floor(rng() * Math.max(1, Math.round(keys.length * temp * 0.5)));
  for (let k = 0; k < nMut; k++) {
    const key = keys[Math.floor(rng() * keys.length)];
    /* CROSS-POLLINATION: sometimes lift this knob's value straight from a
       sibling pod's champion instead of a random step — good management
       settings (stops, trails, scale-outs) discovered by one model seed
       the others' searches */
    if (seeds && seeds.length && rng() < 0.25) {
      const donor = seeds[Math.floor(rng() * seeds.length)];
      if (donor[key] != null) { next[key] = clampStep(donor[key], ranges[key]); continue; }
    }
    const [lo, hi, step] = ranges[key];
    const span = (hi - lo) * temp;
    next[key] = clampStep(P[key] + (rng() - 0.5) * 2 * span, ranges[key]);
  }
  return next;
}

/* opts: { ranges, signalFn, seeds } — ranges/signalFn select the strategy
   pod being tuned (defaults keep the original single-model behavior);
   seeds are the OTHER pods' champion params for cross-pollination. */
function tune(days, base = DEFAULTS, iters = 150, seed = 7, opts = {}) {
  const ranges = opts.ranges || RANGES;
  const signalFn = opts.signalFn;
  const seeds = opts.seeds || [];
  const rng = mulberry32(seed);
  const cut = Math.max(1, Math.floor(days.length * 0.7));
  const train = days.slice(0, cut);
  const valid = days.slice(cut);
  const evalOn = (set, P) => score(runBacktest(set, P, 100000, signalFn).metrics);

  let champ = { ...base };
  let champTrain = evalOn(train, champ);
  let champValid = valid.length ? evalOn(valid, champ) : champTrain;
  const history = [{ iter: 0, train: champTrain, valid: champValid, accepted: true }];

  for (let i = 1; i <= iters; i++) {
    const temp = 1 - (i / iters) * 0.85; // anneal 1.0 -> 0.15
    const cand = perturb(champ, rng, temp, ranges, seeds);
    const tScore = evalOn(train, cand);
    if (tScore <= champTrain) continue;
    const vScore = valid.length ? evalOn(valid, cand) : tScore;
    const ok = vScore >= champValid; // must generalize, not just fit
    history.push({ iter: i, train: +tScore.toFixed(2), valid: +vScore.toFixed(2), accepted: ok });
    if (ok) { champ = cand; champTrain = tScore; champValid = vScore; }
  }
  return {
    params: champ,
    baseScore: { train: +evalOn(train, base).toFixed(2), valid: valid.length ? +evalOn(valid, base).toFixed(2) : null },
    bestScore: { train: +champTrain.toFixed(2), valid: valid.length ? +champValid.toFixed(2) : null },
    history,
  };
}

module.exports = { tune, score };
