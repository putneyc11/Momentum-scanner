/* "Gap-and-Go Confluence" — long-only momentum strategy for the scanner's
   small-cap gappers, on 1-minute bars.

   ENTRY (decided at a bar's close, executed at the next bar's open):
   - Mandatory: price breaks the day's structure — close above BOTH the
     premarket high (if one exists) and the opening-range high.
   - Plus at least `minConfluence` of these five confirmations:
       aboveVWAP   close > session VWAP
       emaBull     EMA8 > EMA21
       volSurge    bar volume >= volSurgeMult x 10-bar average
       rsiOK       RSI14 below rsiMax (not a blow-off top)
       stBull      Supertrend(10,3) pointing up
   - Only inside the entry window (entryStartMin..entryEndMin, ET minutes).

   EXITS (checked every bar, in this priority):
   1. hard stop hit intrabar (ATR-based, pct-clamped)
   2. take-profit at targetR x initial risk (limit)
   3. trailing stop once the high-water mark clears trailAfterR x risk
   4. VWAP loss (close under VWAP) when vwapExit is on
   5. time stop: flat after timeStopMin minutes without reaching +0.5R
   6. flatten everything at flattenMin (15:55 default) — no overnights

   All parameters live in params.json; the tuner searches RANGES. */

const I = require("./indicators");

const DEFAULTS = {
  entryStartMin: 570,   // 9:30 ET — RTH entries only by default
  entryEndMin: 690,     // 11:30 ET
  minConfluence: 3,     // of the 5 confirmations
  volSurgeMult: 2.5,
  rsiMax: 80,
  orbMinutes: 15,
  atrPeriod: 14,
  stopAtrMult: 1.5,
  minStopPct: 2,
  maxStopPct: 8,
  targetR: 2.5,
  trailAfterR: 1.0,
  trailAtrMult: 2.0,
  timeStopMin: 45,
  vwapExit: 1,
  flattenMin: 955,      // 15:55 ET
  riskPct: 1.0,         // % of equity risked per trade
  maxNotionalPct: 25,   // position value cap as % of equity
  maxPositions: 3,
  maxDailyLossPct: 3,   // halt for the day when down this much
  reentryLimit: 2,      // entries per symbol per day
  cooldownMin: 10,      // wait after an exit before re-entering the symbol
  slipBps: 20,          // fill slippage assumption, basis points
};

/* Tuner search space: [min, max, step]. Anything not listed is fixed. */
const RANGES = {
  minConfluence: [2, 5, 1],
  volSurgeMult: [1.5, 4, 0.25],
  rsiMax: [60, 90, 5],
  orbMinutes: [5, 30, 5],
  stopAtrMult: [0.8, 3, 0.1],
  minStopPct: [1, 4, 0.5],
  maxStopPct: [4, 12, 1],
  targetR: [1.5, 4, 0.25],
  trailAfterR: [0.5, 2, 0.25],
  trailAtrMult: [1, 4, 0.25],
  timeStopMin: [15, 90, 5],
  entryEndMin: [600, 780, 15],
  riskPct: [0.25, 2, 0.25],
  maxPositions: [1, 5, 1],
  cooldownMin: [0, 30, 5],
  vwapExit: [0, 1, 1],
};

/* Precompute every causal series a day's bars need. */
function prepSeries(bars, P) {
  const closes = bars.map((b) => b.c);
  const { pmHigh, orbHigh } = I.levelSeries(bars, P.orbMinutes);
  return {
    closes,
    vwap: I.vwapSeries(bars),
    e8: I.emaSeries(closes, 8),
    e21: I.emaSeries(closes, 21),
    rsi: I.rsiSeries(closes, 14),
    atr: I.atrSeries(bars, P.atrPeriod),
    st: I.supertrendDirs(bars, 10, 3),
    avg10: I.avgVolSeries(bars, 10),
    pmHigh, orbHigh,
  };
}

/* Entry decision at the close of bar i. Returns null or {stop, risk}. */
function signalAt(S, bars, i, P) {
  const b = bars[i];
  if (b.m < P.entryStartMin || b.m > P.entryEndMin) return null;
  if (S.orbHigh[i] == null || S.atr[i] == null) return null; // structure not formed yet
  const c = b.c;
  const level = Math.max(S.orbHigh[i], S.pmHigh[i] || 0);
  if (c <= level) return null; // mandatory breakout
  let conf = 0;
  if (c > S.vwap[i]) conf++;
  if (S.e8[i] > S.e21[i]) conf++;
  if (S.avg10[i] && b.v >= P.volSurgeMult * S.avg10[i]) conf++;
  if (S.rsi[i] != null && S.rsi[i] < P.rsiMax) conf++;
  if (S.st[i] === 1) conf++;
  if (conf < P.minConfluence) return null;
  let dist = Math.max(S.atr[i] * P.stopAtrMult, c * P.minStopPct / 100);
  dist = Math.min(dist, c * P.maxStopPct / 100);
  if (!(dist > 0)) return null;
  return { stop: c - dist, risk: dist };
}

/* Exit decision for an open position on bar i.
   pos: {entry, stop, risk, hwm, barsHeld}
   Mutates pos.stop / pos.hwm (trailing). Returns null or
   {reason, price} — price null means "exit at this bar's close". */
function exitCheck(S, bars, i, pos, P) {
  const b = bars[i];
  pos.hwm = Math.max(pos.hwm, b.h);
  /* trailing engages once the trade has run trailAfterR x risk */
  if (S.atr[i] != null && pos.hwm >= pos.entry + P.trailAfterR * pos.risk) {
    const trail = pos.hwm - P.trailAtrMult * S.atr[i];
    if (trail > pos.stop) pos.stop = trail;
  }
  if (b.l <= pos.stop) return { reason: "stop", price: pos.stop };
  const target = P.targetR > 0 ? pos.entry + P.targetR * pos.risk : null;
  if (target != null && b.h >= target) return { reason: "target", price: target };
  if (P.vwapExit && b.c < S.vwap[i]) return { reason: "vwap", price: null };
  pos.barsHeld++;
  if (pos.barsHeld >= P.timeStopMin && b.c < pos.entry + 0.5 * pos.risk)
    return { reason: "time", price: null };
  if (b.m >= P.flattenMin) return { reason: "flatten", price: null };
  return null;
}

module.exports = { DEFAULTS, RANGES, prepSeries, signalAt, exitCheck };
