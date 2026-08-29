/* Alpaca market-data access + scanner-equivalent discovery.

   Mirrors the Momentum Scanner app's session-aware gates:
   - PREMARKET (4:00-9:30 ET): batched snapshots; gap = latestTrade vs the
     last COMPLETED daily bar (today's daily bar doesn't exist before the
     open); candidates >= PM_PCT_FLOOR with premarket volume evidence.
   - RTH: 1Day bars, >= RTH_PCT_FLOOR day change, >= minDayVol.
   - Split-guard: premarket prior closes re-checked against split-adjusted
     daily bars (snapshots are raw; a reverse split reads as a phantom gap).

   Keys come from env: APCA_API_KEY_ID / APCA_API_SECRET_KEY. */

const fs = require("fs");
const path = require("path");

const DATA = "https://data.alpaca.markets";
const TRADING = "https://paper-api.alpaca.markets";
const STATE = path.join(__dirname, "..", "state");
const screen = require("./screen"); /* HYP-008 census — instrumentation only */
const PM_PCT_FLOOR = 10, RTH_PCT_FLOOR = 25, PM_MIN_VOL = 25000, MIN_DAY_VOL = 5e6;
/* FAST LANE: the classic 25%/5M gate is LATE for vertical movers (EPOW/RYET
   class) — by the time both bars clear, the run is half over. Anything up
   fastPct on real volume enters the universe immediately; the ranking still
   favors the biggest movers and the models still decide the entry. */
const FAST_PCT_FLOOR = 12, FAST_VOL_FLOOR = 3e5;
const MAX_PRICE = 100, MIN_PRICE = 0.03, MAX_UNIVERSE = 20;

/* every symbol that EVER ranked in discovery today — the nightly recorder
   saves their tape whether or not we traded them, so missed movers become
   training data instead of invisible regrets */
const seenMovers = { day: null, syms: new Set() };
function noteMovers(day, symbols) {
  if (seenMovers.day !== day) { seenMovers.day = day; seenMovers.syms = new Set(); }
  for (const s of symbols) seenMovers.syms.add(s);
}
const moversSeenToday = (day) => (seenMovers.day === day ? [...seenMovers.syms] : []);

const etFmt = new Intl.DateTimeFormat("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
const etDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" });
const etMinute = (t) => {
  const [h, m] = etFmt.format(new Date(t)).split(":").map(Number);
  return h * 60 + m;
};
const etDay = (t) => etDayFmt.format(new Date(t));
const etDayISO = (t) => {
  const [mo, d, y] = etDay(t).split("/");
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
};
function todayETStartISO(hour) {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const off = now.getTime() - et.getTime();
  const d = new Date(now.getTime() - off);
  d.setHours(hour, 0, 0, 0);
  return new Date(d.getTime() + off).toISOString();
}
const daysAgoISO = (n) => new Date(Date.now() - n * 864e5).toISOString();

function keysFromEnv() {
  const id = process.env.APCA_API_KEY_ID, secret = process.env.APCA_API_SECRET_KEY;
  if (!id || !secret) return null;
  return { id, secret };
}

async function req(base, p, params, keys) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${base}${p}${qs ? "?" + qs : ""}`, {
    headers: { "APCA-API-KEY-ID": keys.id, "APCA-API-SECRET-KEY": keys.secret },
  });
  if (!r.ok) throw new Error(`${r.status} ${p}: ${(await r.text()).slice(0, 120)}`);
  return r.json();
}
const md = (p, params, keys) => req(DATA, p, params, keys);

const normBar = (b) => {
  const t = new Date(b.t).getTime();
  return { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, m: etMinute(t) };
};

/* ROBINHOOD-TRADABILITY SCREEN: every trade the engine makes must be a
   ticker the user can also trade in their own Robinhood account — listed
   common stock/ETFs on the major exchanges. Robinhood does NOT offer
   OTC/pink sheets, warrants, rights, SPAC units, or preferred shares, so
   none of those may enter the universe. Robinhood has no public reference
   API to query, so this screens on the Alpaca asset record: exchange plus
   security-name and symbol-suffix rules. */
const RH_NAME_BAD = /\bwarrants?\b|\brights?\b|\bunits?\b|preferred|preference|depositary/i;
const RH_SUFFIX_BAD = /[.\-](WS|WSA|WT|WI|W|U|R|RT|PR[A-Z]?)$/i;
function rhTradable(a) {
  if (!a || !a.symbol) return false;
  if (a.exchange === "OTC") return false;               // no pink sheets on Robinhood
  if (RH_SUFFIX_BAD.test(a.symbol)) return false;       // NYSE-style .WS/.U/.R/.PR suffixes
  if (a.name && RH_NAME_BAD.test(a.name)) return false; // "… Warrant", "… Units", preferreds
  if (a.symbol.length === 5 && /W$/.test(a.symbol) && !a.name) return false; // unnamed 5-letter W = warrant
  return true;
}

async function universe(keys) {
  const cache = path.join(STATE, "universe.json");
  try {
    const v = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (v.ver === 2 && Date.now() - v.t < 24 * 3600e3 && v.symbols.length > 1000) return v.symbols;
  } catch {}
  const assets = await req(TRADING, "/v2/assets", { status: "active", asset_class: "us_equity" }, keys);
  const syms = assets.filter((a) => a.tradable && a.status === "active" && rhTradable(a)).map((a) => a.symbol);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ t: Date.now(), ver: 2, symbols: syms }));
  return syms;
}

const inPremarket = () => { const m = etMinute(Date.now()); return m >= 240 && m < 570; };
const inRTH = () => { const m = etMinute(Date.now()); return m >= 570 && m < 960; };
const inAfterHours = () => { const m = etMinute(Date.now()); return m >= 960 && m < 1200; };

/* Full-market discovery -> ranked candidate symbols (top MAX_UNIVERSE by %). */
async function discover(keys) {
  const uni = await universe(keys);
  const today = etDay(Date.now());
  const cands = {};
  const B = 1000;
  /* HYP-008: which poll this is, and which session's gates apply. Recorded
     against every symbol we look at, including the ones we discard. */
  const pollMin = etMinute(Date.now());
  const sess = inPremarket() ? "pm" : inAfterHours() ? "ah" : "rth";
  const note = (sym, o) => screen.observe(today, sym, { min: pollMin, session: sess, ...o });
  if (inPremarket()) {
    for (let off = 0; off < uni.length; off += B) {
      const batch = uni.slice(off, off + B);
      let j;
      try { j = await md("/v2/stocks/snapshots", { symbols: batch.join(","), feed: "sip" }, keys); }
      catch { continue; }
      for (const s of batch) {
        const sn = j && j[s];
        if (!sn || !sn.latestTrade || !sn.latestTrade.p) continue;
        if (etDay(sn.latestTrade.t) !== today) continue;
        const db = sn.dailyBar, pdb = sn.prevDailyBar;
        const dbToday = db && etDay(db.t) === today;
        const ref = dbToday ? pdb && pdb.c : db && db.c;
        if (!ref || ref < 0.05) continue;
        const p = sn.latestTrade.p;
        const pct = ((p - ref) / ref) * 100;
        const dv = dbToday && db && db.v != null ? db.v : null;
        if (p < MIN_PRICE || p > MAX_PRICE) {
          note(s, { price: p, pct, prevClose: ref, vol: dv, volSource: "snapshot",
                    reason: p < MIN_PRICE ? "price_lo" : "price_hi" });
          continue;
        }
        if (pct < PM_PCT_FLOOR) {
          note(s, { price: p, pct, prevClose: ref, vol: dv, volSource: "snapshot", reason: "pm_pct" });
          continue;
        }
        note(s, { price: p, pct, prevClose: ref, vol: dv, volSource: "snapshot" });
        cands[s] = { price: p, pct, prevClose: ref };
      }
    }
    /* split-guard against adjusted daily closes */
    const syms = Object.keys(cands);
    for (let off = 0; off < syms.length; off += B) {
      const batch = syms.slice(off, off + B);
      try {
        const bj = await md("/v2/stocks/bars", { symbols: batch.join(","), timeframe: "1Day", start: daysAgoISO(6), limit: 10000, adjustment: "split", feed: "sip" }, keys);
        for (const s of batch) {
          const arr = (bj.bars && bj.bars[s]) || [];
          let adj = null;
          for (let i = arr.length - 1; i >= 0; i--)
            if (etDay(arr[i].t) !== today) { adj = arr[i].c; break; }
          const c = cands[s];
          if (!c || !adj) continue;
          if (Math.abs(adj - c.prevClose) / c.prevClose > 0.005) {
            const pct = ((c.price - adj) / adj) * 100;
            if (pct < PM_PCT_FLOOR) {
              note(s, { price: c.price, pct, prevClose: adj, reason: "pm_pct" });
              delete cands[s];
            } else {
              note(s, { price: c.price, pct, prevClose: adj });
              c.prevClose = adj; c.pct = pct;
            }
          }
        }
      } catch {}
    }
  } else {
    for (let off = 0; off < uni.length; off += B) {
      const batch = uni.slice(off, off + B);
      try {
        const bj = await md("/v2/stocks/bars", { symbols: batch.join(","), timeframe: "1Day", start: daysAgoISO(6), limit: 10000, adjustment: "split", feed: "sip" }, keys);
        for (const s of batch) {
          const arr = (bj.bars && bj.bars[s]) || [];
          if (arr.length < 2) continue;
          const lastB = arr[arr.length - 1], prevB = arr[arr.length - 2];
          if (etDay(lastB.t) !== today) continue;
          const prev = prevB.c, p = lastB.c;
          if (!prev || prev < 0.05) continue;
          const pct = ((p - prev) / prev) * 100;
          if (p < MIN_PRICE || p > MAX_PRICE) {
            note(s, { price: p, pct, prevClose: prev, vol: lastB.v, volSource: "daily",
                      reason: p < MIN_PRICE ? "price_lo" : "price_hi" });
            continue;
          }
          /* classic qualifier OR fast-lane early mover */
          const classic = lastB.v >= MIN_DAY_VOL && pct >= RTH_PCT_FLOOR;
          const fast = lastB.v >= FAST_VOL_FLOOR && pct >= FAST_PCT_FLOOR;
          if (!classic && !fast) {
            /* which gate actually turned it away — "not enough move", "moved
               but on dead tape", and "cleared the fast pct but not its volume"
               are three different populations and must not be pooled */
            const reason = pct >= RTH_PCT_FLOOR ? "rth_vol"
              : pct >= FAST_PCT_FLOOR ? "fast_miss" : "rth_pct";
            note(s, { price: p, pct, prevClose: prev, vol: lastB.v, volSource: "daily", reason });
            continue;
          }
          note(s, { price: p, pct, prevClose: prev, vol: lastB.v, volSource: "daily" });
          cands[s] = { price: p, pct, prevClose: prev, fast: !classic };
        }
      } catch {}
    }
  }
  if (inAfterHours()) {
    /* FULL-MARKET after-hours discovery: a stock that slept all day and
       gapped on 5 PM news must be tradable too — snapshots give the live
       AH print vs TODAY's official close. Day movers already found above
       keep their entries; fresh AH gappers are added on their AH move. */
    for (let off = 0; off < uni.length; off += B) {
      const batch = uni.slice(off, off + B);
      let j;
      try { j = await md("/v2/stocks/snapshots", { symbols: batch.join(","), feed: "sip" }, keys); }
      catch { continue; }
      for (const s of batch) {
        if (cands[s]) continue;
        const sn = j && j[s];
        if (!sn || !sn.latestTrade || !sn.latestTrade.p || !sn.dailyBar) continue;
        if (etDay(sn.latestTrade.t) !== today || etMinute(new Date(sn.latestTrade.t).getTime()) < 960) continue;
        const db = sn.dailyBar;
        if (etDay(db.t) !== today || !db.c || db.c < 0.05) continue;
        const p = sn.latestTrade.p;
        const pct = ((p - db.c) / db.c) * 100;
        if (p < MIN_PRICE || p > MAX_PRICE) {
          note(s, { price: p, ahPct: pct, prevClose: db.c, vol: db.v != null ? db.v : null,
                    volSource: "snapshot", reason: p < MIN_PRICE ? "price_lo" : "price_hi" });
          continue;
        }
        if (pct < PM_PCT_FLOOR) {
          note(s, { price: p, ahPct: pct, prevClose: db.c, vol: db.v != null ? db.v : null,
                    volSource: "snapshot", reason: "ah_pct" });
          continue;
        }
        note(s, { price: p, ahPct: pct, prevClose: db.c, vol: db.v != null ? db.v : null, volSource: "snapshot" });
        cands[s] = { price: p, pct, prevClose: db.c };
      }
    }
  }
  /* CAUSAL rank: position among the names that passed the gates AT THIS POLL,
     which is all the live engine could know. eodRank needs the close and is a
     diagnostic, never a benchmark. Sorted list computed once and then sliced
     exactly as before, so the returned universe is unchanged. */
  const sortedAll = Object.entries(cands).sort((a, b) => b[1].pct - a[1].pct);
  sortedAll.forEach(([s], i) => screen.observe(today, s, { causalRank: i + 1 }));
  let ranked = sortedAll.slice(0, MAX_UNIVERSE * 2);
  noteMovers(today, ranked.map(([s]) => s)); /* missed-mover audit trail */
  /* session volume evidence for the finalists: premarket volume before the
     open, after-hours volume after the close — dead tape can't be traded */
  if ((inPremarket() || inAfterHours()) && ranked.length) {
    const pm = inPremarket();
    const bars = await fetchBars1Min(keys, ranked.map(([s]) => s));
    ranked = ranked.filter(([s]) => {
      const arr = bars[s] || [];
      const sv = arr.reduce((a, b) => a + ((pm ? b.m < 570 : b.m >= 960) ? b.v : 0), 0);
      /* real session volume from the tape for these finalists — the only place
         a 1-minute cumulative genuinely exists, so it is tagged as such */
      screen.observe(today, s, { vol: sv, volSource: "tape" });
      if (sv >= PM_MIN_VOL) return true;
      note(s, { reason: pm ? "pm_vol" : "ah_vol" });
      return false;
    });
  }
  const returned = ranked.slice(0, MAX_UNIVERSE);
  const inUniverse = new Set(returned.map(([s]) => s));
  /* P0's clock starts HERE: the first poll at which the name was in the list
     the engine actually received. Anything ranked but past the cutoff failed
     on rank, not on a threshold. */
  for (const [s, c] of ranked) {
    if (inUniverse.has(s)) {
      screen.observe(today, s, {
        reason: "admit", returnedAtMin: pollMin,
        reasonAdmit: sess === "pm" ? "pm" : sess === "ah" ? "ah" : (c.fast ? "rth_fast" : "rth_classic"),
      });
    } else {
      note(s, { reason: "rank" });
    }
  }
  return returned.map(([s, c]) => ({ symbol: s, ...c }));
}

/* Latest live prints for a symbol list — ONE batched call, cheap enough to
   poll every second for the fast exit tick. Returns {SYM: {p, t}}. */
async function latestTrades(keys, symbols) {
  const j = await md("/v2/stocks/trades/latest", { symbols: symbols.join(","), feed: "sip" }, keys);
  const out = {};
  for (const [s, tr] of Object.entries(j.trades || {}))
    if (tr && tr.p) out[s] = { p: tr.p, t: new Date(tr.t).getTime() };
  return out;
}

/* Full-session 1-min bars (from 4:00 ET) for a symbol list. */
async function fetchBars1Min(keys, symbols) {
  return fetchBars1MinFrom(keys, symbols, todayETStartISO(4));
}

/* Same fetch, any start instant. The live path passes 4:00 AM ET today; the
   backfill passes 4:00 AM ET of a historical day. One implementation, so a
   recorded day and a backfilled day cannot drift apart. Pages on
   next_page_token — a full 4:00-20:00 tape for 15 symbols exceeds the 10000
   row cap on busy days, and silently truncating it would clip the afternoon
   off every backfilled session. */
async function fetchBars1MinFrom(keys, symbols, startISO, endISO) {
  const out = {};
  for (let off = 0; off < symbols.length; off += 15) {
    const batch = symbols.slice(off, off + 15);
    for (const s of batch) out[s] = [];
    let token = null;
    try {
      do {
        const params = {
          symbols: batch.join(","), timeframe: "1Min", start: startISO,
          limit: 10000, adjustment: "split", feed: "sip",
        };
        if (endISO) params.end = endISO;
        if (token) params.page_token = token;
        const j = await md("/v2/stocks/bars", params, keys);
        for (const s of batch) out[s].push(...(((j.bars && j.bars[s]) || []).map(normBar)));
        token = j.next_page_token;
      } while (token);
    } catch { /* a bad batch leaves those symbols empty, as before */ }
  }
  return out;
}

/* Persist today's bars for every traded/tracked symbol -> a backtest day
   file. This is how the backtest library grows with REAL scanner days. */
function recordDay(symbolsBars) {
  return recordDayFor(etDayISO(Date.now()), symbolsBars);
}

/* Write a day file for an explicit date. Same shape, same >=30-bar filter as
   the live recorder — a backfilled day must be indistinguishable from a
   recorded one or the tuner is training on two different things. */
function recordDayFor(date, symbolsBars) {
  const dir = path.join(STATE, "days");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.json`);
  const symbols = {};
  for (const [s, bars] of Object.entries(symbolsBars))
    if (bars && bars.length >= 30) symbols[s] = bars;
  if (Object.keys(symbols).length === 0) return null;
  fs.writeFileSync(file, JSON.stringify({ date, symbols }));
  return file;
}

function loadRecordedDays() {
  const dir = path.join(STATE, "days");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  } catch { return []; }
}

module.exports = {
  keysFromEnv, discover, fetchBars1Min, fetchBars1MinFrom, latestTrades,
  recordDay, recordDayFor, loadRecordedDays, universe, rhTradable, normBar, md,
  PM_PCT_FLOOR, RTH_PCT_FLOOR, PM_MIN_VOL, MIN_DAY_VOL,
  FAST_PCT_FLOOR, FAST_VOL_FLOOR, MAX_PRICE, MIN_PRICE, MAX_UNIVERSE,
  etMinute, etDay, etDayISO, inPremarket, inRTH, STATE,
  noteMovers, moversSeenToday,
};
