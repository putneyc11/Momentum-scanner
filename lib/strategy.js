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
   2. the PLANNED EXIT at targetR x initial risk: scaleOutPct (default 85%)
      is banked there; the runner rides on with its stop floored at
      break-even and no further target
   3. trailing stop once the high-water mark clears trailAfterR x risk
   4. VWAP loss (close under VWAP) when vwapExit is on
   5. time stop: flat after timeStopMin minutes without reaching +0.5R
   6. flatten everything at flattenMin (19:55 default) — no overnights

   All parameters live in params.json; the tuner searches RANGES. */

const I = require("./indicators");

const DEFAULTS = {
  entryStartMin: 240,   // 4:00 AM ET — premarket entries ON
  entryEndMin: 1170,    // 7:30 PM ET — trades into after hours
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
  flattenMin: 1195,     // 19:55 ET — flat before the extended tape closes at 20:00
  scaleOutPct: 85,      // sell this % at the target; the runner rides a break-even-floored trail
  riskPct: 1.0,         // % of equity risked per trade
  maxNotionalPct: 25,   // position value cap as % of equity
  maxPositions: 5,
  maxDailyLossPct: 3,   // halt for the day when down this much
  reentryLimit: 2,      // entries per symbol per day
  cooldownMin: 10,      // wait after an exit before re-entering the symbol
  hwmTrailPct: 0,       // >0: ride ratchet — exit only on a dip this % off the high
};

/* Tuner search space: [min, max, step]. Anything not listed is fixed.

   THE STOP BOUNDS HERE ARE DELIBERATELY NOT THE WIDE ONES (HYP-002). The wide
   stop box lives in lib/strategies.js#WIDE_STOP_RANGES and is applied to the
   two pods it was measured on, redgreen and reclaim, and to nothing else.

   Widening it here would reach gapgo, whose wide-stop gain is a cost artefact:
   +0.14 profit factor with costs, -0.16 with costs removed (research/
   falsifier2.js). Its entry is worse than random, so a wider box buys it fewer
   round trips and a flattering number with nothing underneath. The box gets
   widened per pod, on a clean measurement of that pod, one pod at a time. */
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
  entryStartMin: [240, 570, 30],
  entryEndMin: [600, 1170, 30],
  scaleOutPct: [50, 100, 5],
  riskPct: [0.25, 2, 0.25],
  maxPositions: [1, 6, 1],
  cooldownMin: [0, 30, 5],
  vwapExit: [0, 1, 1],
};

/* Precompute every causal series a day's bars need. */
function prepSeries(bars, P) {
  const closes = bars.map((b) => b.c);
  const { pmHigh, pmPrev, orbHigh } = I.levelSeries(bars, P.orbMinutes);
  return {
    closes,
    vwap: I.vwapSeries(bars),
    e8: I.emaSeries(closes, 8),
    e21: I.emaSeries(closes, 21),
    rsi: I.rsiSeries(closes, 14),
    atr: I.atrSeries(bars, P.atrPeriod),
    st: I.supertrendDirs(bars, 10, 3),
    avg10: I.avgVolSeries(bars, 10),
    pmHigh, pmPrev, orbHigh,
  };
}

/* Entry decision at the close of bar i. Returns null or {stop, risk}. */
function signalAt(S, bars, i, P) {
  const b = bars[i];
  if (b.m < P.entryStartMin || b.m > P.entryEndMin) return null;
  if (S.atr[i] == null) return null;
  const c = b.c;
  /* breakout level by session: after the opening range forms it's
     max(ORB high, premarket high); DURING premarket it's the running
     premarket high as of the PRIOR bar (a fresh premarket high IS the
     breakout); between 9:30 and ORB completion we stand aside. */
  let level = null;
  if (S.orbHigh[i] != null) level = Math.max(S.orbHigh[i], S.pmHigh[i] || 0);
  else if (b.m < I.OPEN_MIN) level = S.pmPrev[i];
  if (level == null || c <= level) return null; // mandatory breakout
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
  /* RIDE RATCHET (hwmTrailPct > 0): stay in as long as price holds within
     hwmTrailPct% of its high-water mark — the stop only ever rises with the
     high, so an 800% runner is held the whole way and exits on the first
     too-deep dip from its current level, wherever that is */
  if (P.hwmTrailPct > 0) {
    const ratchet = pos.hwm * (1 - P.hwmTrailPct / 100);
    if (ratchet > pos.stop) pos.stop = ratchet;
  }
  if (b.l <= pos.stop) return { reason: "stop", price: pos.stop };
  /* the target fires once: the caller scales out scaleOutPct there, floors
     the runner's stop at break-even, and sets pos.scaled — after which the
     runner rides the trail with no further target */
  const target = P.targetR > 0 ? pos.entry + P.targetR * pos.risk : null;
  if (!pos.scaled && target != null && b.h >= target) return { reason: "target", price: target };
  /* VWAP loss with HYSTERESIS: one close a hair under VWAP right after
     entry is whipsaw noise (it caused instant enter→exit churn) — demand
     TWO consecutive closes below VWAP and a minimum two-bar hold */
  if (P.vwapExit && pos.barsHeld >= 2 && b.c < S.vwap[i] && i > 0 && bars[i - 1].c < S.vwap[i - 1])
    return { reason: "vwap", price: null };
  pos.barsHeld++;
  if (pos.barsHeld >= P.timeStopMin && b.c < pos.entry + 0.5 * pos.risk)
    return { reason: "time", price: null };
  if (b.m >= P.flattenMin) return { reason: "flatten", price: null };
  return null;
}

/* CHURN GUARD: an entry the exit engine would close on the very next check
   (vwapExit armed and price already below VWAP) must never be taken — it
   guarantees an instant round-trip that burns slippage and journal noise. */
function entryViable(S, bars, i, P) {
  return !(P.vwapExit && S.vwap[i] != null && bars[i].c <= S.vwap[i]);
}

/* PARTICIPATION CAP — the single declaration, imported by lib/backtest.js and
   the live loop in engine.js. You cannot buy shares that did not trade: an
   order for more than a slice of the bar's volume does not get filled at that
   bar's price, it becomes the market for that name and moves it. Without this
   the backtester compounds fills that never could have happened, and the
   tuner optimises straight into the fiction.

   Deliberately a plain constant and NOT a knob in RANGES: the tuner must not
   be able to search its way around a realism constraint. 10% is generous —
   being one share in ten of a minute's tape is already aggressive on these
   names — and it is the loosest number that is still honest. */
const MAX_BAR_PARTICIPATION = 0.10;

/* SLIPPAGE — price-tiered, and like the participation cap, a frozen constant
   that the tuner cannot search.

   The old model was a flat 20 bps everywhere, which is roughly right on a $20
   stock and fantasy on a $1 one. 25% of the symbol-days these pods trade are
   under $2, where a single-cent spread is 50-100 bps before you have crossed
   it. A flat 20 understated the cost on a quarter of the tape by about 5x.

   These are not commissions. cput11's account pays no commission and has no
   trade limit, and none of that is what this models: this is the spread you
   cross to get filled, which you pay whether or not the broker charges you.
   Free trading does not make trading free.

   Tiers are [price ceiling, bps] and are cput11's numbers, set 2026-08-28. */
const SLIP_TIERS = [[2, 100], [5, 50], [Infinity, 20]];

/* P.slipBpsOverride exists for research scripts that need to remove costs to
   see what a result is made of (research/falsifier2.js). It is deliberately
   NOT named slipBps and deliberately NOT in RANGES: a knob the tuner could
   reach would let it optimise its way out of paying the spread. */
function slipBpsFor(price, P) {
  if (P && P.slipBpsOverride != null) return P.slipBpsOverride;
  for (const [ceiling, bps] of SLIP_TIERS) if (price < ceiling) return bps;
  return 20;
}

module.exports = { DEFAULTS, RANGES, MAX_BAR_PARTICIPATION, SLIP_TIERS, slipBpsFor, prepSeries, signalAt, exitCheck, entryViable };
