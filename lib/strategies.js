/* The strategy ensemble: five independent long-only models over the same
   1-minute tape. Each pod has its own params file, its own tuner search
   space, and its own live position slots; they share prepSeries, the exit
   engine (exitCheck) and the nightly recorded-day library.

   1. gapgo    Gap-and-Go Confluence — PMH/ORB breakout + 5-vote confluence
               (the original model, lib/strategy.js)
   2. reclaim  VWAP Reclaim — dip under VWAP, then a volume-backed reclaim;
               stop under the dip low
   3. flag     First Pullback — a strong leg up, a shallow 1-3 bar pullback,
               entry on the break of the pullback high
   4. igniter  Volume Igniter — three green candles + a volume surge burst;
               stop under the run
   5. redgreen Red-to-Green — first cross back above the 9:30 open after
               trading below it, with volume

   Every pod's DEFAULTS carry the FULL management param set because
   exitCheck reads targets/trails/stops from the same object. */

const I = require("./indicators");
const gap = require("./strategy");

/* shared trade-management defaults — pods override what differs */
const MGMT = {
  entryStartMin: 240, entryEndMin: 1170,
  orbMinutes: 15, atrPeriod: 14,
  stopAtrMult: 1.5, minStopPct: 2, maxStopPct: 8,
  targetR: 2.5, trailAfterR: 1.0, trailAtrMult: 2.0,
  timeStopMin: 45, vwapExit: 1, flattenMin: 1195,
  scaleOutPct: 85, riskPct: 1.0, maxNotionalPct: 25,
  maxPositions: 2, maxDailyLossPct: 3,
  reentryLimit: 2, cooldownMin: 10, slipBps: 20,
};
const MGMT_RANGES = {
  volSurgeMult: [1.25, 5, 0.25],
  stopAtrMult: [0.8, 3, 0.1],
  minStopPct: [1, 4, 0.5],
  maxStopPct: [4, 12, 1],
  targetR: [1.5, 4, 0.25],
  trailAfterR: [0.5, 2, 0.25],
  trailAtrMult: [1, 4, 0.25],
  timeStopMin: [15, 90, 5],
  scaleOutPct: [50, 100, 5],
  riskPct: [0.25, 2, 0.25],
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
  {
    key: "gapgo", name: "Gap-and-Go",
    DEFAULTS: { ...gap.DEFAULTS, maxPositions: 2 },
    RANGES: { ...gap.RANGES, maxPositions: [1, 3, 1] },
    signalAt: gap.signalAt,
  },
  {
    key: "reclaim", name: "VWAP Reclaim",
    DEFAULTS: { ...MGMT, dipBars: 2, volSurgeMult: 1.5, rsiMax: 75, targetR: 2.0 },
    RANGES: { ...MGMT_RANGES, dipBars: [1, 4, 1], rsiMax: [60, 85, 5] },
    signalAt: reclaimSignal,
  },
  {
    key: "flag", name: "First Pullback",
    DEFAULTS: { ...MGMT, legBars: 10, legPct: 6, pbBars: 2, volSurgeMult: 1.25 },
    RANGES: { ...MGMT_RANGES, legBars: [6, 20, 2], legPct: [3, 15, 1], pbBars: [1, 3, 1] },
    signalAt: flagSignal,
  },
  {
    key: "igniter", name: "Volume Igniter",
    DEFAULTS: { ...MGMT, burstPct: 2, volSurgeMult: 3, rsiMax: 85, targetR: 2.0, timeStopMin: 30 },
    RANGES: { ...MGMT_RANGES, burstPct: [1, 5, 0.5], rsiMax: [70, 90, 5], volSurgeMult: [2, 5, 0.25] },
    signalAt: igniterSignal,
  },
  {
    key: "redgreen", name: "Red-to-Green",
    DEFAULTS: { ...MGMT, entryStartMin: 570, volSurgeMult: 1.5, rsiMax: 80 },
    RANGES: { ...MGMT_RANGES, entryStartMin: [570, 660, 15], rsiMax: [60, 90, 5] },
    signalAt: redGreenSignal,
  },
];

module.exports = { STRATS, MGMT, MGMT_RANGES };
