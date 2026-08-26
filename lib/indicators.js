/* Causal technical indicators over 1-min bars {t,o,h,l,c,v,m}.
   Every series is computed left-to-right, so series[i] only ever depends on
   bars[0..i] — the backtester can precompute full arrays and index them
   without look-ahead bias. */

function emaSeries(vals, n) {
  const k = 2 / (n + 1);
  let e = null;
  return vals.map((v) => { e = e === null ? v : v * k + e * (1 - k); return e; });
}

function vwapSeries(bars) {
  let pv = 0, vv = 0;
  return bars.map((b) => {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    return vv ? pv / vv : b.c;
  });
}

function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) {
      g += up; l += dn;
      if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = 100 - 100 / (1 + g / (l || 1e-9));
    }
  }
  return out;
}

function atrSeries(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let prevC = bars.length ? bars[0].c : 0;
  const trs = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)));
    prevC = b.c;
    if (i === n - 1) out[i] = trs.reduce((a, x) => a + x, 0) / n;
    else if (i >= n) out[i] = (out[i - 1] * (n - 1) + trs[i]) / n;
  }
  return out;
}

/* Supertrend direction series: +1 bull / -1 bear / null while warming. */
function supertrendDirs(bars, period = 10, mult = 3) {
  const dirs = new Array(bars.length).fill(null);
  if (bars.length < period + 2) return dirs;
  const atr = atrSeries(bars, period);
  let upper = Infinity, lower = -Infinity, dir = 1, started = false;
  for (let i = 0; i < bars.length; i++) {
    if (atr[i] == null) continue;
    const b = bars[i];
    const mid = (b.h + b.l) / 2;
    let bu = mid + mult * atr[i], bl = mid - mult * atr[i];
    if (started) {
      const pc = bars[i - 1].c;
      if (!(bl > lower || pc < lower)) bl = lower;
      if (!(bu < upper || pc > upper)) bu = upper;
      dir = b.c > upper ? 1 : b.c < lower ? -1 : dir;
    }
    upper = bu; lower = bl; started = true;
    dirs[i] = dir;
  }
  return dirs;
}

/* Rolling mean of the prior n volumes (excludes the current bar). */
function avgVolSeries(bars, n = 10) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= 1) sum += bars[i - 1].v;
    if (i > n) sum -= bars[i - n - 1].v;
    if (i >= n) out[i] = sum / n;
  }
  return out;
}

const OPEN_MIN = 9 * 60 + 30;   // 9:30 ET
const CLOSE_MIN = 16 * 60;      // 16:00 ET

/* Premarket high and opening-range high, both causal:
   pmHigh[i]  = high of bars with m < 9:30 seen so far
   orbHigh[i] = high of the first `orbMinutes` RTH bars, defined only once
                that window has fully elapsed. */
function levelSeries(bars, orbMinutes) {
  const pmHigh = new Array(bars.length).fill(null);
  const orbHigh = new Array(bars.length).fill(null);
  let pm = null, orb = null, orbDone = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.m < OPEN_MIN) pm = pm == null ? b.h : Math.max(pm, b.h);
    else if (b.m < OPEN_MIN + orbMinutes) orb = orb == null ? b.h : Math.max(orb, b.h);
    else orbDone = true;
    pmHigh[i] = pm;
    orbHigh[i] = orbDone ? orb : null;
  }
  return { pmHigh, orbHigh };
}

module.exports = { emaSeries, vwapSeries, rsiSeries, atrSeries, supertrendDirs, avgVolSeries, levelSeries, OPEN_MIN, CLOSE_MIN };
