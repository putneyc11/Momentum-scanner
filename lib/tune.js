/* Self-improvement loop: walk-forward random search over strategy.RANGES.

   - Days are split chronologically into 60% TRAIN / 20% VALIDATE / 20% TEST
     (70/30 with no TEST below MIN_HOLDOUT_DAYS, where there is nothing left
     to hold out).
   - Candidates are perturbations of the current champion (simulated-
     annealing style: wide early, narrow late).
   - A candidate must beat the champion on TRAIN and then clear a FROZEN
     VALIDATE bar — the base champion's validate score, set once and never
     raised. Ratcheting that bar on every acceptance made the reported
     validate score the maximum of hundreds of draws rather than an estimate,
     which is selection on the validation split by another name.
   - TEST is scored exactly twice, after the search ends: once for the base
     champion and once for the final one. It never gates anything, so it is
     the only score in this file that is unbiased. Judge the loop by the TEST
     delta; if validate climbs while test does not, the search is overfitting.
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
/* Below this many days a three-way split leaves a holdout too small to read,
   so the tuner stays on the old 70/30 and reports test: null. */
const MIN_HOLDOUT_DAYS = 10;

/* Chronological 60/20/20 (or 70/30/-). Exported so tests and callers can
   reason about the split without re-deriving the cut points. */
function splitDays(days) {
  const n = days.length;
  if (n < MIN_HOLDOUT_DAYS) {
    const cut = Math.max(1, Math.floor(n * 0.7));
    return { train: days.slice(0, cut), valid: days.slice(cut), test: [] };
  }
  const trainCut = Math.max(1, Math.floor(n * 0.6));
  const validCut = Math.max(trainCut + 1, Math.floor(n * 0.8));
  return {
    train: days.slice(0, trainCut),
    valid: days.slice(trainCut, validCut),
    test: days.slice(validCut),
  };
}

function tune(days, base = DEFAULTS, iters = 150, seed = 7, opts = {}) {
  const ranges = opts.ranges || RANGES;
  const signalFn = opts.signalFn;
  const seeds = opts.seeds || [];
  const rng = mulberry32(seed);
  const { train, valid, test } = splitDays(days);
  const evalOn = (set, P) => score(runBacktest(set, P, 100000, signalFn).metrics);

  let champ = { ...base };
  let champTrain = evalOn(train, champ);
  /* THE FROZEN BAR. Set once from the base champion, never raised. The old
     loop did `champValid = vScore` on every acceptance, so after ~840
     perturbations bestScore.valid was the max of hundreds of draws against
     the same 30% of days. Freezing it means a candidate has to clear the
     original bar, not one the search has already walked upward. */
  const validBar = valid.length ? evalOn(valid, champ) : champTrain;
  let champValid = validBar;
  let accepted = 0;
  const history = [{ iter: 0, train: champTrain, valid: champValid, accepted: true }];

  for (let i = 1; i <= iters; i++) {
    const temp = 1 - (i / iters) * 0.85; // anneal 1.0 -> 0.15
    const cand = perturb(champ, rng, temp, ranges, seeds);
    const tScore = evalOn(train, cand);
    if (tScore <= champTrain) continue;
    const vScore = valid.length ? evalOn(valid, cand) : tScore;
    const ok = vScore >= validBar; // must clear the FROZEN bar, not a moving one
    history.push({ iter: i, train: +tScore.toFixed(2), valid: +vScore.toFixed(2), accepted: ok });
    /* champValid tracks the accepted champion for reporting only; it is never
       fed back into `validBar`, which is what made the old gate leak. */
    if (ok) { champ = cand; champTrain = tScore; champValid = vScore; accepted++; }
  }

  /* TEST is touched here and nowhere else: two evaluations, after the search
     is over, neither of which can change `champ`. */
  const baseTest = test.length ? +evalOn(test, base).toFixed(2) : null;
  const bestTest = test.length ? (accepted ? +evalOn(test, champ).toFixed(2) : baseTest) : null;

  return {
    params: champ,
    split: { train: train.length, valid: valid.length, test: test.length },
    validBar: valid.length ? +validBar.toFixed(2) : null,
    accepted,
    candidates: history.length - 1,
    baseScore: { train: +evalOn(train, base).toFixed(2), valid: valid.length ? +evalOn(valid, base).toFixed(2) : null, test: baseTest },
    bestScore: { train: +champTrain.toFixed(2), valid: valid.length ? +champValid.toFixed(2) : null, test: bestTest },
    history,
  };
}

module.exports = { tune, score, splitDays, MIN_HOLDOUT_DAYS };
