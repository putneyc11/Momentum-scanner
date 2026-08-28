/* Rebuild state/days/ from Alpaca history.

   The nightly tuner is gated on recorded days (engine.js: `days.length >= 5`)
   and splits them 70/30. At five days that is three to train on and two to
   validate against, while seven pods run 120 iterations each. The search is
   not short of compute, it is short of tape. This module fixes that by
   manufacturing the past instead of waiting for it.

   The hard part is that discovery is SESSION-AWARE and CUMULATIVE. `discover`
   runs every 90 seconds and unions everything that ever ranked
   (`noteMovers`), so a recorded day contains symbols that qualified at 07:12
   and were dead by noon. Screening historical CLOSES would miss exactly those
   — the ones that ran and faded, which are most of them.

   So this replays the day minute by minute and applies the same session gates
   at each step:

     stage 1  daily bars for the whole universe. One pass, cheap. Keeps any
              (symbol, day) that COULD have qualified — judged on the day's
              high and total volume, which bound every intraday gate from
              above. A generous superset, deliberately.
     stage 2  1-minute tape for the survivors, walked 4:00 -> 20:00 ET,
              applying the premarket / RTH / after-hours gates against
              running price and cumulative volume.

   Every threshold is imported from lib/data.js. None are re-declared here —
   a second copy of `FAST_PCT_FLOOR` that drifts from the live one is the same
   class of bug the churn-guard invariant exists to prevent.

   KNOWN BIASES, both of which make backfilled days OPTIMISTIC:

   1. SURVIVORSHIP. The universe comes from Alpaca's currently-active assets,
      so anything delisted between then and now is absent. Small-cap momentum
      names delist more than most. The library will under-represent the ones
      that went to zero.
   2. POLLING CADENCE. Live discovery polls every 90s; this replays every
      minute, so it catches a few movers the live engine would have been
      looking the other way for.

   Neither is fixable from this data. Both are the reason a backfilled day is
   training material and not evidence. */

const D = require("./data");

const PM_END = 570, AH_START = 960, AH_END = 1200, SESSION_START = 240;

/* Weekday dates in [start, end]. Holidays fall out naturally in stage 1 —
   a market holiday simply returns no bars for anyone. */
function tradingDates(start, end) {
  const out = [];
  for (let t = Date.parse(start + "T12:00:00Z"); t <= Date.parse(end + "T12:00:00Z"); t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/* 04:00 and 20:00 ET on an ET calendar date, as instants. Built by probing
   the formatter rather than assuming an offset, so DST is handled. */
function etWindow(date) {
  const at = (min) => {
    let t = Date.parse(date + "T00:00:00Z");
    for (let i = 0; i < 48; i++) {
      if (D.etDayISO(t) === date && D.etMinute(t) === min) return t;
      t += 60000 * 30;
    }
    /* minute-accurate second pass */
    t = Date.parse(date + "T00:00:00Z");
    for (let i = 0; i < 24 * 60 * 2; i++, t += 60000)
      if (D.etDayISO(t) === date && D.etMinute(t) === min) return t;
    throw new Error(`could not locate ${min} ET on ${date}`);
  };
  return { start: new Date(at(SESSION_START)).toISOString(), end: new Date(at(AH_END - 1) + 60000).toISOString() };
}

/* Could this symbol have qualified on this day, judged from the daily bar?
   Uses the day's HIGH against the loosest gain floor and total volume against
   the loosest volume floor, so it bounds every session gate from above and
   can only ever be too generous. */
function couldQualify(today, prevClose) {
  if (!today || !prevClose || prevClose < 0.05) return false;
  if (today.l > D.MAX_PRICE) return false;
  if (today.h < D.MIN_PRICE) return false;
  if (today.v < Math.min(D.FAST_VOL_FLOOR, D.PM_MIN_VOL)) return false;
  const bestPct = ((today.h - prevClose) / prevClose) * 100;
  return bestPct >= Math.min(D.PM_PCT_FLOOR, D.FAST_PCT_FLOOR);
}

/* Walk one day's tape and return every symbol that would have ranked at any
   point — the union `noteMovers` accumulates live. */
function replayDiscovery(barsBySym, prevCloses) {
  const state = {};
  for (const [sym, bars] of Object.entries(barsBySym)) {
    if (!bars || !bars.length) continue;
    const prev = prevCloses[sym];
    if (!prev || prev < 0.05) continue;
    state[sym] = { bars, i: 0, cumVol: 0, prev, todayClose: null, pmVol: 0, ahVol: 0, last: null };
  }

  const seen = new Set();

  for (let m = SESSION_START; m < AH_END; m++) {
    const ranked = [];
    for (const [sym, s] of Object.entries(state)) {
      while (s.i < s.bars.length && s.bars[s.i].m <= m) {
        const b = s.bars[s.i++];
        s.cumVol += b.v;
        s.last = b.c;
        if (b.m < PM_END) s.pmVol += b.v;
        if (b.m >= AH_START) s.ahVol += b.v;
        /* the 16:00 official close is the after-hours reference */
        if (b.m === AH_START - 1) s.todayClose = b.c;
      }
      const p = s.last;
      if (p == null || p < D.MIN_PRICE || p > D.MAX_PRICE) continue;

      if (m < PM_END) {
        const pct = ((p - s.prev) / s.prev) * 100;
        if (pct >= D.PM_PCT_FLOOR && s.pmVol >= D.PM_MIN_VOL) ranked.push([sym, pct]);
      } else if (m < AH_START) {
        const pct = ((p - s.prev) / s.prev) * 100;
        const classic = s.cumVol >= D.MIN_DAY_VOL && pct >= D.RTH_PCT_FLOOR;
        const fast = s.cumVol >= D.FAST_VOL_FLOOR && pct >= D.FAST_PCT_FLOOR;
        if (classic || fast) ranked.push([sym, pct]);
      } else {
        const ref = s.todayClose;
        if (!ref || ref < 0.05) continue;
        const pct = ((p - ref) / ref) * 100;
        if (pct >= D.PM_PCT_FLOOR && s.ahVol >= D.PM_MIN_VOL) ranked.push([sym, pct]);
      }
    }
    /* live ranks and keeps the top MAX_UNIVERSE*2 before the volume screen */
    ranked.sort((a, b) => b[1] - a[1]);
    for (const [sym] of ranked.slice(0, D.MAX_UNIVERSE * 2)) seen.add(sym);
  }
  return [...seen];
}

/* One day, end to end. Returns { date, symbols } or null. */
async function backfillDay(keys, date, uni, log = () => {}) {
  const win = etWindow(date);

  /* Prior close and the day's own daily bar, for the stage-1 screen. */
  const daily = {};
  const from = new Date(Date.parse(date + "T00:00:00Z") - 8 * 864e5).toISOString();
  for (let off = 0; off < uni.length; off += 1000) {
    const batch = uni.slice(off, off + 1000);
    let token = null;
    try {
      do {
        const params = { symbols: batch.join(","), timeframe: "1Day", start: from, end: win.end, limit: 10000, adjustment: "split", feed: "sip" };
        if (token) params.page_token = token;
        const j = await D.md("/v2/stocks/bars", params, keys);
        for (const [s, arr] of Object.entries(j.bars || {})) (daily[s] ||= []).push(...arr);
        token = j.next_page_token;
      } while (token);
    } catch { /* a bad batch drops those symbols from this day */ }
  }

  const candidates = [], prevCloses = {};
  for (const [sym, arr] of Object.entries(daily)) {
    arr.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const iToday = arr.findIndex((b) => D.etDayISO(Date.parse(b.t)) === date);
    if (iToday < 1) continue;                       // no bar for the day, or no prior close
    const today = arr[iToday], prev = arr[iToday - 1].c;
    if (!couldQualify(today, prev)) continue;
    candidates.push(sym);
    prevCloses[sym] = prev;
  }
  if (!candidates.length) { log(`  ${date}  market closed or no candidates`); return null; }

  const bars = await D.fetchBars1MinFrom(keys, candidates, win.start, win.end);
  const movers = replayDiscovery(bars, prevCloses);
  if (!movers.length) { log(`  ${date}  ${candidates.length} candidates, none ever ranked`); return null; }

  const keep = {};
  for (const s of movers) if (bars[s] && bars[s].length >= 30) keep[s] = bars[s];
  if (!Object.keys(keep).length) { log(`  ${date}  ${movers.length} movers, none with a usable tape`); return null; }

  const file = D.recordDayFor(date, keep);
  log(`  ${date}  ${candidates.length} screened -> ${movers.length} ranked -> ${Object.keys(keep).length} recorded`);
  return { date, file, symbols: Object.keys(keep).length, screened: candidates.length };
}

module.exports = { backfillDay, replayDiscovery, couldQualify, tradingDates, etWindow };
