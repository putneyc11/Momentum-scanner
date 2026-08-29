/* Red Team's FATAL #8 against research/scorelocal.js, fixed.

   scorelocal.js perturbed DEFAULTS at a hand-set temperature and called the
   result "the late champion's neighbourhood". It never walked, so it never had
   a late champion -- by iteration 170 the real tuner's champion can be hundreds
   of points from DEFAULTS. The reported late range and tie rate therefore did
   not describe the end of a tuning run. That objection is correct.

   This runs the ACTUAL adaptive trajectory: perturb the CURRENT champion,
   accept on strict `>`, same anneal, same rng, and instrument every candidate.

   It also answers Red Team's #9, which said equal scores are not yet identified
   as wasted compute. Four causes are separated, and only (a) is skippable:
     (a) paramDup   -- identical parameter object after snapping (hash BEFORE
                       the backtest, which is the only way to skip the work)
     (b) inert      -- params differ, trade path identical
     (c) rounding   -- trade paths differ, raw objective differs, but the
                       toFixed(2) in metrics() collides them
     (d) genuine    -- raw objective genuinely equal

   FIDELITY: this replicates lib/tune.js's loop rather than importing it, because
   tune() does not expose per-candidate params and lib/tune.js is not mine to
   edit. The replication is VALIDATED against the real tune() -- --validate runs
   both and compares bestScore.train and accepted. If those do not match, the
   walk is not the walk and every number here is void. seeds=[] (no cross-
   pollination) in both, so the comparison is like-for-like.

   Usage: node research/walk.js <pod> <iters> <seed> [--validate]
*/
const crypto = require("crypto");
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS, RANGES } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");
const { score, splitDays, tune } = require("../lib/tune");
const { mulberry32 } = require("../lib/synth");

const podKey = process.argv[2];
const ITERS = +(process.argv[3] || 200);
const SEED = +(process.argv[4] || 11);
const VALIDATE = process.argv.includes("--validate");
const st = STRATS.find((s) => s.key === podKey);
if (!st) { console.error("unknown pod " + podKey); process.exit(1); }

const ranges = st.RANGES || RANGES;
const base = { ...DEFAULTS, ...st.DEFAULTS };
const days = D.loadRecordedDays();
const { train, valid } = splitDays(days);

/* verbatim from lib/tune.js:32-57, cross-pollination branch unreachable at seeds=[] */
const clampStep = (v, [lo, hi, step]) => {
  const snapped = Math.round((v - lo) / step) * step + lo;
  return +Math.min(hi, Math.max(lo, snapped)).toFixed(4);
};
const perturb = (P, rng, temp) => {
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

const h = (x) => crypto.createHash("sha1").update(x).digest("hex").slice(0, 12);
const paramHash = (P) => h(Object.keys(ranges).sort().map((k) => k + "=" + P[k]).join("|"));
const pathHash = (trades) => h(trades.map((t) => `${t.date}|${t.sym}|${t.entryM}|${t.exitM}|${t.qty}|${t.pnl}`).join("\n"));

/* raw, UNROUNDED objective, so a toFixed(2) collision is visible as such */
const evalFull = (P) => {
  const r = runBacktest(train, P, 100000, st.signalAt);
  const c = r.curve, endEq = c[c.length - 1];
  let peak = -Infinity, dd = 0;
  for (const e of c) { peak = Math.max(peak, e); dd = Math.max(dd, (peak - e) / peak); }
  const rawNet = ((endEq - 100000) / 100000) * 100;
  const rawDD = dd * 100;
  const thin = r.metrics.trades === 0 ? null : (r.metrics.trades < r.metrics.days * 0.3 ? -5 : 0);
  return { s: score(r.metrics), raw: thin === null ? -100 : rawNet - 0.5 * rawDD + thin,
           path: pathHash(r.trades), trades: r.metrics.trades };
};

const rng = mulberry32(SEED);
/* tune.js updates champ only when the candidate ALSO clears the frozen validate
   bar, so the walk must too or it diverges from the real trajectory */
const evalValid = (P) => score(runBacktest(valid, P, 100000, st.signalAt).metrics);
let champ = { ...base };
let champEv = evalFull(champ);
let champH = paramHash(champ);
let champTrain = champEv.s;
const validBar = valid.length ? evalValid(champ) : champEv.s;
const BASE_TRAIN = champEv.s;   /* champEv is reassigned by the walk; capture first */
let accepted = 0;
const rows = [];
const seenParams = new Map([[champH, champEv]]);

for (let i = 1; i <= ITERS; i++) {
  const temp = 1 - (i / ITERS) * 0.85;
  const cand = perturb(champ, rng, temp);
  const cH = paramHash(cand);                 /* BEFORE the backtest */
  const paramDup = cH === champH;
  const seenBefore = seenParams.has(cH);
  const ev = evalFull(cand);
  if (!seenParams.has(cH)) seenParams.set(cH, ev);
  const tie = ev.s === champTrain;
  const beatsTrain = ev.s > champTrain;
  const ok = beatsTrain && (valid.length ? evalValid(cand) >= validBar : true);
  rows.push({ i, temp: +temp.toFixed(3), paramDup, seenBefore, tie,
    inert: !paramDup && ev.path === champEv.path,
    rounding: !paramDup && ev.path !== champEv.path && tie && ev.raw !== champEv.raw,
    genuine: !paramDup && ev.path !== champEv.path && tie && ev.raw === champEv.raw,
    delta: +(ev.s - champTrain).toFixed(4), accepted: ok });
  if (ok) { champ = cand; champEv = ev; champH = cH; champTrain = ev.s; accepted++; }
}

const late = rows.filter((r) => r.temp < 0.36);     /* last ~25% of the schedule */
const early = rows.filter((r) => r.temp >= 0.36);
const summ = (a) => {
  const acc = a.filter((r) => r.accepted).map((r) => r.delta).sort((x, y) => x - y);
  return { n: a.length,
    paramDupPct: +(100 * a.filter((r) => r.paramDup).length / a.length).toFixed(1),
    seenBeforePct: +(100 * a.filter((r) => r.seenBefore).length / a.length).toFixed(1),
    tiePct: +(100 * a.filter((r) => r.tie).length / a.length).toFixed(1),
    inert: a.filter((r) => r.inert).length, rounding: a.filter((r) => r.rounding).length,
    genuine: a.filter((r) => r.genuine).length,
    accepts: acc.length, medDelta: acc.length ? +acc[Math.floor(acc.length / 2)].toFixed(3) : null };
};

const out = { pod: podKey, iters: ITERS, seed: SEED,
  baseTrain: +BASE_TRAIN.toFixed(2), bestTrain: +champTrain.toFixed(2), accepted,
  early: summ(early), late: summ(late) };

if (VALIDATE) {
  const real = tune(days, base, ITERS, SEED, { ranges, signalFn: st.signalAt });
  out.validation = { realBestTrain: real.bestScore.train, mineBestTrain: +champTrain.toFixed(2),
    realAccepted: real.accepted, mineAccepted: accepted,
    MATCH: real.bestScore.train === +champTrain.toFixed(2) };
}
console.log(JSON.stringify(out));
