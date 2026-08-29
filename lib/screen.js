/* HYP-008 — the screen census and its stratified reject sample.

   Every recorded day file is downstream of discover(): the names the screen
   threw away were never fetched, so there is no negative class and the screen
   layer cannot be measured. That gap CANNOT be backfilled -- those symbols were
   never requested for those days -- so the only fix is to start recording, and
   every session this is not running is a session permanently missing from the
   first legal read.

   Two things are recorded, and they are deliberately different in cost:

   1. A CENSUS of every symbol discover() looked at, carrying the value that
      failed and which gate failed it. Snapshots and daily bars are already in
      memory every 90s, so this persists what is being discarded rather than
      fetching anything.
   2. A STRATIFIED SAMPLE of near-miss and sham names that get real 1-minute
      tape, fetched once in the existing end-of-day pass.

   Far rejects are NOT a control. A name at pct 0 on no volume is a different
   market, not a counterfactual, and sampling them would make any screen look
   good -- the same error as grading an entry against a whole-day average, which
   is how HYP-001 died. Hence fixed strata with fixed caps, and if a stratum is
   short that day it stays short: a biased sample is worse than a small one.

   ISOLATION. The sidecar goes to state/screen/, never state/days/.
   loadRecordedDays() ingests every *.json in state/days, so a sidecar sitting
   next to the day files would be parsed as a day and would silently corrupt
   every pod's backtest. There is a test for this.

   Nothing here may change what discover() returns. It is instrumentation, and
   every entry point is wrapped so a recorder bug cannot break live trading. */

const fs = require("fs");
const path = require("path");

const STATE = path.join(__dirname, "..", "state");
const SCREEN_DIR = path.join(STATE, "screen");

/* Per-session tape caps, HYP-008 §2. Fixed, and never topped up from another
   stratum when one is short. */
const STRATA = [
  { id: "near_pct_pm",  n: 4 },
  { id: "near_pct_rth", n: 6 },
  { id: "near_pct_ah",  n: 2 },
  { id: "near_vol_pm",  n: 2 },
  { id: "near_vol_rth", n: 2 },
  { id: "rank_41_60",   n: 4 },
  { id: "price_hi",     n: 1 },
  { id: "sham",         n: 6 },
];
/* N1, the pooled near-miss class in falsifier #2, is ONLY the pct near-misses.
   Mixing "didn't go up enough" with "went up on no volume" and "went up and we
   ranked it 45th" is how an empty screen hides. */
const N1_STRATA = new Set(["near_pct_pm", "near_pct_rth", "near_pct_ah"]);

/* in-memory census for the current session; flushed once at EOD */
let cur = { day: null, rows: new Map() };

function reset(day) { cur = { day, rows: new Map() }; }
function rowsFor(day) { return cur.day === day ? cur.rows : new Map(); }

/* Merge an observation. First-touch fields are written once; max-pct fields
   ratchet. `admit` outranks every reject reason, because a name that fails at
   09:35 and admits at 10:10 is admitted and leaves the reject sample. */
function observe(day, sym, o) {
  try {
    if (cur.day !== day) reset(day);
    let r = cur.rows.get(sym);
    if (!r) {
      r = {
        symbol: sym, prevClose: null, sessionAtFirst: null, firstSeenMin: null,
        priceAtFirst: null, pctAtFirst: null, volAtFirst: null, volSource: null,
        maxPct: null, priceAtMaxPct: null, volAtMaxPct: null, minAtMaxPct: null,
        maxAhPct: null, priceAtMaxAhPct: null, minAtMaxAhPct: null,
        failOrAdmit: "none", reasonAdmit: null,
        causalRankAtFirstPoll: null, bestCausalRank: null, eodRank: null,
        firstSeenPollMin: null, firstCrossMin: null,
        sampledTape: false, stratum: null,
      };
      cur.rows.set(sym, r);
    }
    if (r.firstSeenMin == null && o.min != null) {
      r.firstSeenMin = o.min;
      r.sessionAtFirst = o.session || null;
      r.priceAtFirst = o.price != null ? o.price : null;
      r.pctAtFirst = o.pct != null ? o.pct : null;
      r.volAtFirst = o.vol != null ? o.vol : null;
      r.volSource = o.volSource || null;
    }
    /* prevClose is the reference discover() ACTUALLY used, split-guard applied.
       Reconstructing it later from a daily bar is wrong: the daily bar moves
       during RTH, so a reconstruction is not the number the gate saw. */
    if (o.prevClose != null) r.prevClose = o.prevClose;
    if (o.pct != null && (r.maxPct == null || o.pct > r.maxPct)) {
      r.maxPct = o.pct;
      r.priceAtMaxPct = o.price != null ? o.price : null;
      r.volAtMaxPct = o.vol != null ? o.vol : null;
      r.minAtMaxPct = o.min != null ? o.min : null;
    }
    if (o.ahPct != null && (r.maxAhPct == null || o.ahPct > r.maxAhPct)) {
      r.maxAhPct = o.ahPct;
      r.priceAtMaxAhPct = o.price != null ? o.price : null;
      r.minAtMaxAhPct = o.min != null ? o.min : null;
    }
    if (o.reason) {
      if (o.reason === "admit") {
        r.failOrAdmit = "admit";
        if (o.reasonAdmit) r.reasonAdmit = o.reasonAdmit;
      } else if (r.failOrAdmit !== "admit") {
        r.failOrAdmit = o.reason;
      }
    }
    if (o.causalRank != null) {
      if (r.causalRankAtFirstPoll == null) r.causalRankAtFirstPoll = o.causalRank;
      if (r.bestCausalRank == null || o.causalRank < r.bestCausalRank) r.bestCausalRank = o.causalRank;
    }
    /* P0's clock. The first poll at which the name was in the RETURNED
       universe -- what the live engine actually knew. NOT the first 1-minute
       cross, which is up to 90 seconds of hindsight the engine never had. */
    if (o.returnedAtMin != null && r.firstSeenPollMin == null) r.firstSeenPollMin = o.returnedAtMin;
  } catch { /* instrumentation must never break discovery */ }
}

const dist = (a, b) => Math.abs(a - b);

/* Deterministic stratified draw: closest to the relevant threshold first, ties
   broken by symbol. No arrival order and no "last poll wins" -- both are
   time-of-day biases, and arrival order is also a batch-offset bias. */
function stratify(day, gates) {
  const rows = [...rowsFor(day).values()];
  const taken = new Set();
  const out = {};
  const eligible = (r) => r.failOrAdmit !== "admit" && r.firstSeenMin != null && !taken.has(r.symbol);

  const pick = (id, n, filter, distance) => {
    const c = rows.filter((r) => eligible(r) && filter(r))
      .sort((a, b) => (distance(a) - distance(b)) || (a.symbol < b.symbol ? -1 : 1))
      .slice(0, n);
    for (const r of c) { taken.add(r.symbol); r.stratum = id; r.sampledTape = true; }
    out[id] = c.map((r) => r.symbol);
    return c;
  };

  const g = gates;
  pick("near_pct_pm", 4,
    (r) => r.sessionAtFirst === "pm" && r.maxPct != null && r.maxPct >= 5 && r.maxPct < g.PM_PCT_FLOOR,
    (r) => dist(r.maxPct, g.PM_PCT_FLOOR));
  pick("near_pct_rth", 6,
    (r) => r.sessionAtFirst === "rth" && r.maxPct != null && r.maxPct >= 15 && r.maxPct < g.RTH_PCT_FLOOR
           && (r.volAtMaxPct || 0) >= g.FAST_VOL_FLOOR,
    (r) => dist(r.maxPct, g.RTH_PCT_FLOOR));
  pick("near_pct_ah", 2,
    (r) => r.maxAhPct != null && r.maxAhPct >= 5 && r.maxAhPct < 10,
    (r) => dist(r.maxAhPct, 10));
  pick("near_vol_pm", 2,
    (r) => r.sessionAtFirst === "pm" && r.maxPct != null && r.maxPct >= g.PM_PCT_FLOOR
           && (r.volAtMaxPct || 0) < g.PM_MIN_VOL,
    (r) => dist(r.volAtMaxPct || 0, g.PM_MIN_VOL));
  pick("near_vol_rth", 2,
    (r) => r.sessionAtFirst === "rth" && r.maxPct != null && r.maxPct >= g.RTH_PCT_FLOOR
           && (r.volAtMaxPct || 0) >= g.FAST_VOL_FLOOR && (r.volAtMaxPct || 0) < g.MIN_DAY_VOL,
    (r) => dist(r.volAtMaxPct || 0, g.MIN_DAY_VOL));
  /* 21-40 already get day-file tapes via moversSeenToday -- they are N2
     overflow and are tagged there, not re-fetched here. */
  pick("rank_41_60", 4,
    (r) => r.bestCausalRank != null && r.bestCausalRank >= 41 && r.bestCausalRank <= 60,
    (r) => r.bestCausalRank);
  pick("price_hi", 1,
    (r) => r.failOrAdmit === "price_hi",
    (r) => dist(r.priceAtFirst || 0, g.MAX_PRICE));
  /* the sham class has no threshold to be near, so it is ordered by how quiet
     it was, then by symbol -- deterministic, and stated rather than implied */
  pick("sham", 6,
    (r) => r.maxPct != null && r.maxPct >= 0 && r.maxPct < 2
           && (r.priceAtFirst || 0) >= g.MIN_PRICE && (r.priceAtFirst || 0) <= g.MAX_PRICE,
    (r) => r.maxPct);

  return out;
}

function sidecarPath(date) { return path.join(SCREEN_DIR, `${date}.json`); }

/* One sidecar per session. Written to state/screen/, NEVER state/days/. */
function writeSidecar(date, extra = {}) {
  const rows = [...rowsFor(date).values()];
  if (!rows.length) return null;
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
  const counts = {};
  for (const r of rows) counts[r.failOrAdmit] = (counts[r.failOrAdmit] || 0) + 1;
  const body = {
    date, schema: 1, rows, counts,
    strata: extra.strata || {},
    tapes: extra.tapes || {},
    n1Strata: [...N1_STRATA],
    /* a session only counts toward N=40 if the census exists and carries the
       two fields P0 is undefined without */
    usable: rows.some((r) => r.failOrAdmit === "admit" && r.firstSeenPollMin != null && r.prevClose != null),
  };
  fs.writeFileSync(sidecarPath(date), JSON.stringify(body));
  return sidecarPath(date);
}

function loadSidecar(date) {
  try { return JSON.parse(fs.readFileSync(sidecarPath(date), "utf8")); } catch { return null; }
}
function loadAllSidecars() {
  try {
    return fs.readdirSync(SCREEN_DIR).filter((f) => f.endsWith(".json")).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(SCREEN_DIR, f), "utf8")));
  } catch { return []; }
}

module.exports = {
  SCREEN_DIR, STRATA, N1_STRATA,
  reset, observe, rowsFor, stratify, writeSidecar, loadSidecar, loadAllSidecars, sidecarPath,
};
