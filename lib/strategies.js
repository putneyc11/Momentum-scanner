/* The strategy ensemble: seven independent long-only models over the same
   1-minute tape, in two styles. Each pod has its own params file, its own
   tuner search space, and its own live position slots; they share
   prepSeries, the exit engine (exitCheck) and the nightly library.

   RIDERS (style "ride") — no profit target at all: hold as long as price
   stays within hwmTrailPct% of its high-water mark, so a 100%… 800% runner
   is held the whole way and exits on the first too-deep dip. Listed FIRST
   so they get priority claim on the strongest breakouts:
   1. moon     Moonshot Rider — Gap-and-Go entry, ride ratchet exit
   2. surge    Surge Rider — Volume Igniter entry, ride ratchet exit

   QUICK-STRIKE (style "quick") — close targets (~1.2-1.3R), 90% banked,
   dip re-entries:
   3. gapgo    Gap-and-Go Confluence — PMH/ORB breakout + 5-vote confluence
   4. reclaim  VWAP Reclaim — dip under VWAP, then a volume-backed reclaim
   5. flag     First Pullback — leg up, shallow flag, break of the flag high
   6. igniter  Volume Igniter — three green candles + a volume surge burst
   7. redgreen Red-to-Green — first volume-backed cross above the 9:30 open

   Every pod's DEFAULTS carry the FULL management param set because
   exitCheck reads targets/trails/stops from the same object. */

const I = require("./indicators");
const gap = require("./strategy");

/* shared trade-management defaults — pods override what differs.
   QUICK-STRIKE PROFILE: close targets (≈1.3R), 90% banked there, tight
   runner trails, and generous re-entries after a short cooldown — many
   small wins with dip re-entries beat waiting on far targets that vertical
   small-caps rarely reach cleanly. The tuner searches down to 0.75R. */
const MGMT = {
  entryStartMin: 240, entryEndMin: 1170,
  orbMinutes: 15, atrPeriod: 14,
  stopAtrMult: 1.5, minStopPct: 2, maxStopPct: 8,
  targetR: 1.3, trailAfterR: 0.5, trailAtrMult: 1.5,
  timeStopMin: 45, vwapExit: 1, flattenMin: 1195,
  scaleOutPct: 90, riskPct: 1.0, maxNotionalPct: 25,
  maxPositions: 2, maxDailyLossPct: 3,
  reentryLimit: 4, cooldownMin: 5, slipBps: 20,
};
const MGMT_RANGES = {
  volSurgeMult: [1.25, 5, 0.25],
  stopAtrMult: [0.8, 3, 0.1],
  minStopPct: [1, 4, 0.5],
  maxStopPct: [4, 12, 1],
  targetR: [0.75, 3, 0.25],
  trailAfterR: [0.25, 2, 0.25],
  trailAtrMult: [1, 4, 0.25],
  timeStopMin: [15, 90, 5],
  scaleOutPct: [50, 100, 5],
  riskPct: [0.25, 2, 0.25],
  maxPositions: [1, 3, 1],
  cooldownMin: [0, 20, 5],
  vwapExit: [0, 1, 1],
};
/* the quick-strike keys every pod shares, including gapgo whose base
   DEFAULTS/RANGES come from lib/strategy.js */
const QUICK = { targetR: 1.3, trailAfterR: 0.5, trailAtrMult: 1.5, scaleOutPct: 90, reentryLimit: 4, cooldownMin: 5 };
const QUICK_RANGES = { targetR: [0.75, 3, 0.25], trailAfterR: [0.25, 2, 0.25], cooldownMin: [0, 20, 5] };

/* RIDE profile: no target ever (targetR 0 disables the scale-out), the
   hwm ratchet is the exit, VWAP/time exits off so mid-run consolidation
   doesn't shake the position out, smaller size for the wider swings */
const RIDE = {
  ...MGMT,
  targetR: 0, scaleOutPct: 100, hwmTrailPct: 15,
  trailAfterR: 99, trailAtrMult: 4, /* ATR trail parked — the ratchet rules */
  vwapExit: 0, timeStopMin: 999,
  riskPct: 0.75, maxStopPct: 10,
  reentryLimit: 3, cooldownMin: 10,
};
/* riders tune the ratchet and risk, never a target or scale-out — those
   are pinned by exclusion from the search space */
const RIDE_RANGES = {
  hwmTrailPct: [8, 25, 1],
  stopAtrMult: [0.8, 3, 0.1],
  minStopPct: [1, 4, 0.5],
  maxStopPct: [6, 14, 1],
  riskPct: [0.25, 1.5, 0.25],
  maxPositions: [1, 3, 1],
  cooldownMin: [0, 30, 5],
  vwapExit: [0, 1, 1],
};

/* ATR/pct-clamped stop distance below close c; wider floors (like a dip low)
   are respected up to the max-stop clamp */
function stopDist(c, atr, P, floorDist) {
  let dist = Math.max(atr * P.stopAtrMult, c * P.minStopPct / 100, floorDist || 0);
  dist = Math.min(dist, c * P.maxStopPct / 100);
  return dist > 0 ? dist : null;
}
const inWindow = (b, P) => b.m >= P.entryStartMin && b.m <= P.entryEndMin;

/* ---- 2. VWAP Reclaim ---- */
function reclaimSignal(S, bars, i, P) {
  const b = bars[i];
  if (!inWindow(b, P) || i < P.dipBars + 1 || S.atr[i] == null) return null;
  const c = b.c;
  if (!(c > S.vwap[i])) return null;                      // reclaimed
  if (!(bars[i - 1].c <= S.vwap[i - 1])) return null;     // ...on THIS bar
  let below = 0, dipLow = b.l;
  for (let k = Math.max(0, i - 6); k < i; k++) {
    if (bars[k].c <= S.vwap[k]) { below++; dipLow = Math.min(dipLow, bars[k].l); }
  }
  if (below < P.dipBars) return null;                     // a real dip, not one tick
  if (!(S.avg10[i] && b.v >= P.volSurgeMult * S.avg10[i])) return null;
  if (S.rsi[i] != null && S.rsi[i] >= P.rsiMax) return null;
  const dist = stopDist(c, S.atr[i], P, c - dipLow);
  return dist ? { stop: c - dist, risk: dist } : null;
}

/* ---- 3. First Pullback (flag) ---- */
function flagSignal(S, bars, i, P) {
  const b = bars[i];
  if (!inWindow(b, P) || S.atr[i] == null) return null;
  const pb = P.pbBars, leg = P.legBars;
  if (i < pb + leg + 1) return null;
  const c = b.c;
  /* the impulse leg: [i-pb-leg, i-pb) must rise legPct trough->peak */
  let legHi = -Infinity, legLo = Infinity;
  for (let k = i - pb - leg; k < i - pb; k++) {
    legLo = Math.min(legLo, bars[k].l);
    legHi = Math.max(legHi, bars[k].h);
  }
  if (!(legLo > 0) || ((legHi - legLo) / legLo) * 100 < P.legPct) return null;
  /* the pullback: highs below the leg high, entry breaks the pullback high */
  let pbHi = -Infinity, pbLo = Infinity;
  for (let k = i - pb; k < i; k++) {
    pbHi = Math.max(pbHi, bars[k].h);
    pbLo = Math.min(pbLo, bars[k].l);
  }
  if (pbHi >= legHi) return null;                         // never pulled back
  if (!(c > pbHi)) return null;                           // break of the flag
  if (!(c > S.vwap[i]) || !(S.e8[i] > S.e21[i])) return null;
  const dist = stopDist(c, S.atr[i], P, c - pbLo);
  return dist ? { stop: c - dist, risk: dist } : null;
}

/* ---- 4. Volume Igniter ---- */
function igniterSignal(S, bars, i, P) {
  const b = bars[i];
  if (!inWindow(b, P) || i < 3 || S.atr[i] == null) return null;
  const c = b.c;
  let runLo = Infinity;
  for (let k = i - 2; k <= i; k++) {
    if (!(bars[k].c > bars[k].o)) return null;            // 3 straight green
    runLo = Math.min(runLo, bars[k].l);
  }
  const runPct = ((c - bars[i - 2].o) / bars[i - 2].o) * 100;
  if (runPct < P.burstPct) return null;
  if (!(S.avg10[i] && b.v >= P.volSurgeMult * S.avg10[i])) return null;
  if (!(c > S.vwap[i])) return null;
  if (S.rsi[i] != null && S.rsi[i] >= P.rsiMax) return null;
  const dist = stopDist(c, S.atr[i], P, c - runLo);
  return dist ? { stop: c - dist, risk: dist } : null;
}

/* ---- 5. Red-to-Green ---- */
function redGreenSignal(S, bars, i, P) {
  const b = bars[i];
  if (!inWindow(b, P) || i < 1 || S.atr[i] == null) return null;
  if (b.m < I.OPEN_MIN) return null;                      // needs a 9:30 open
  if (S._rgOpen === undefined) {
    S._rgOpen = null;
    for (const x of bars) if (x.m >= I.OPEN_MIN) { S._rgOpen = x.o; break; }
  }
  const dayOpen = S._rgOpen;
  if (dayOpen == null) return null;
  const c = b.c;
  if (!(bars[i - 1].c < dayOpen && c > dayOpen)) return null; // the R/G cross
  if (!(S.avg10[i] && b.v >= P.volSurgeMult * S.avg10[i])) return null;
  if (S.rsi[i] != null && S.rsi[i] >= P.rsiMax) return null;
  const dist = stopDist(c, S.atr[i], P, c - Math.min(bars[i - 1].l, b.l));
  return dist ? { stop: c - dist, risk: dist } : null;
}

const STRATS = [
  /* riders first: priority claim on the strongest breakouts */
  {
    key: "moon", name: "Moonshot Rider", style: "ride",
    DEFAULTS: { ...gap.DEFAULTS, ...RIDE, minConfluence: 4 }, /* extra-picky entries — these positions are held for the whole run */
    RANGES: { ...RIDE_RANGES, minConfluence: [3, 5, 1], volSurgeMult: [1.5, 4, 0.25] },
    signalAt: gap.signalAt,
  },
  {
    key: "surge", name: "Surge Rider", style: "ride",
    DEFAULTS: { ...RIDE, burstPct: 3, volSurgeMult: 3.5, rsiMax: 90, hwmTrailPct: 12 },
    RANGES: { ...RIDE_RANGES, burstPct: [1.5, 6, 0.5], rsiMax: [75, 95, 5], volSurgeMult: [2, 5, 0.25] },
    signalAt: igniterSignal,
  },
  {
    key: "gapgo", name: "Gap-and-Go", style: "quick",
    /* retuned after live churn: wider noise floor (3% min / ATR×1.8 stops)
       so ordinary small-cap wiggle can't clip the stop seconds after entry */
    DEFAULTS: { ...gap.DEFAULTS, ...QUICK, maxPositions: 2, minStopPct: 3, stopAtrMult: 1.8 },
    RANGES: { ...gap.RANGES, ...QUICK_RANGES, maxPositions: [1, 3, 1], minStopPct: [2, 5, 0.5] },
    signalAt: gap.signalAt,
  },
  {
    key: "reclaim", name: "VWAP Reclaim", style: "quick",
    DEFAULTS: { ...MGMT, dipBars: 2, volSurgeMult: 1.5, rsiMax: 75, targetR: 1.2 },
    RANGES: { ...MGMT_RANGES, dipBars: [1, 4, 1], rsiMax: [60, 85, 5] },
    signalAt: reclaimSignal,
  },
  {
    key: "flag", name: "First Pullback", style: "quick",
    DEFAULTS: { ...MGMT, legBars: 10, legPct: 6, pbBars: 2, volSurgeMult: 1.25 },
    RANGES: { ...MGMT_RANGES, legBars: [6, 20, 2], legPct: [3, 15, 1], pbBars: [1, 3, 1] },
    signalAt: flagSignal,
  },
  {
    key: "igniter", name: "Volume Igniter", style: "quick",
    DEFAULTS: { ...MGMT, burstPct: 2, volSurgeMult: 3, rsiMax: 85, targetR: 1.2, timeStopMin: 30 },
    RANGES: { ...MGMT_RANGES, burstPct: [1, 5, 0.5], rsiMax: [70, 90, 5], volSurgeMult: [2, 5, 0.25] },
    signalAt: igniterSignal,
  },
  {
    key: "redgreen", name: "Red-to-Green", style: "quick",
    DEFAULTS: { ...MGMT, entryStartMin: 570, volSurgeMult: 1.5, rsiMax: 80 },
    RANGES: { ...MGMT_RANGES, entryStartMin: [570, 660, 15], rsiMax: [60, 90, 5] },
    signalAt: redGreenSignal,
  },
];

module.exports = { STRATS, MGMT, MGMT_RANGES };
