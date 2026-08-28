#!/usr/bin/env node
/* Momentum Algo Trader — autonomous PAPER-trading ENSEMBLE driven by the
   Momentum Scanner's discovery gates. Five strategy pods (Gap-and-Go,
   VWAP Reclaim, First Pullback, Volume Igniter, Red-to-Green) trade the
   same account side by side — each symbol is claimed by one pod, each pod
   has its own tuned params and position slots. Nightly, all five re-tune
   on the SAME shared library of recorded days, cross-pollinating champion
   params, and the validated scores re-split the risk allocation between
   them — five models teaching one book.

   Commands:
     node engine.js trade                live paper-trading loop (needs keys)
     node engine.js scan                 print the current scanner universe
     node engine.js backtest [--synth N] backtest every pod on recorded days
     node engine.js tune [--synth N] [--iters N]   run the ensemble tune now
     node engine.js report               journal + per-pod + tuning summary
     node engine.js test                 run the unit tests

   Keys (Alpaca PAPER account) via env:
     APCA_API_KEY_ID=...  APCA_API_SECRET_KEY=...

   The trade loop, every day (4:00 AM - 8:00 PM ET, premarket + after hours):
   - RTH entries go in with a broker-held protective stop; extended-hours
     entries use marketable limit orders (Alpaca's off-RTH rules) with the
     stop managed by the engine off the live tape.
   - At the planned exit (targetR x risk) the engine SCALES OUT scaleOutPct
     (default 90%) and lets the runner ride a trailing stop floored at
     break-even; vwap/time/trailing exits are engine-managed throughout.
   - 19:55 ET: flatten everything. No overnight positions, ever.
   - after the close: record the day's bars into state/days/, then run the
     walk-forward tuner over ALL recorded days and write improved params to
     state/params/<pod>.json — the models get better as the library grows.

   PAPER ONLY. lib/broker.js refuses any non-paper trading URL. */

const fs = require("fs");
const path = require("path");
const D = require("./lib/data");
const BF = require("./lib/backfill");
const { startDashboard } = require("./lib/dashboard");
const { PaperBroker } = require("./lib/broker");
const { prepSeries, exitCheck, entryViable } = require("./lib/strategy");
const { STRATS } = require("./lib/strategies");
const { runBacktest } = require("./lib/backtest");
const { tune } = require("./lib/tune");
const { makeLibrary } = require("./lib/synth");

const ROOT = __dirname;
const STATE = D.STATE;
const JOURNAL = path.join(STATE, "journal.jsonl");
const TUNE_LOG = path.join(STATE, "tune-log.jsonl");
const ALLOC_FILE = path.join(STATE, "alloc.json");
const PDIR = path.join(STATE, "params"); /* tuned pod params persist on the Render disk */

const GLOBAL_MAX_POS = 8;   /* account-wide cap across all pods */
const DAY_LOSS_PCT = 3;     /* account-wide daily halt */
const FLATTEN_MIN = 1195;   /* 19:55 ET */

/* per-pod params: DEFAULTS <- tuned state (persisted on the Render disk) */
const loadStratParams = (st) => {
  let P = { ...st.DEFAULTS };
  try { P = { ...P, ...JSON.parse(fs.readFileSync(path.join(PDIR, st.key + ".json"), "utf8")) }; } catch {}
  return P;
};
const loadAllParams = () => {
  const out = {};
  for (const st of STRATS) out[st.key] = loadStratParams(st);
  return out;
};
const saveStratParams = (key, P) => {
  fs.mkdirSync(PDIR, { recursive: true });
  fs.writeFileSync(path.join(PDIR, key + ".json"), JSON.stringify(P, null, 2) + "\n");
};
const loadAlloc = () => {
  try { return JSON.parse(fs.readFileSync(ALLOC_FILE, "utf8")); } catch { return {}; }
};

/* THE ENSEMBLE TUNE: every pod re-tunes on the SAME shared library of
   recorded real days, and each pod's random search is cross-pollinated with
   the other four champions' params — a management setting proven by one
   model seeds the others. Afterwards the validated scores set each pod's
   risk-allocation weight, so capital drifts toward what is working. */
function ensembleTune(days, iters, seedBase) {
  const champs = loadAllParams();
  const scores = {};
  for (const st of STRATS) {
    const siblings = STRATS.filter((o) => o.key !== st.key).map((o) => champs[o.key]);
    const res = tune(days, champs[st.key], iters, (seedBase + st.key.length * 7919) % 100000,
      { ranges: st.RANGES, signalFn: st.signalAt, seeds: siblings });
    const improved = res.bestScore.valid != null && res.baseScore.valid != null
      ? res.bestScore.valid > res.baseScore.valid
      : res.bestScore.train > res.baseScore.train;
    if (improved) {
      champs[st.key] = res.params;
      saveStratParams(st.key, res.params);
      fs.mkdirSync(STATE, { recursive: true });
      fs.appendFileSync(TUNE_LOG, JSON.stringify({ t: new Date().toISOString(), strat: st.key, days: days.length, base: res.baseScore, best: res.bestScore, params: res.params }) + "\n");
    }
    scores[st.key] = res.bestScore.valid != null ? res.bestScore.valid : res.bestScore.train;
    log(`tune ${st.key}: base ${JSON.stringify(res.baseScore)} best ${JSON.stringify(res.bestScore)}${improved ? "  → saved" : ""}`);
  }
  /* validated scores -> risk weights in [0.4, 1.6], mean ~1 — losers keep a
     floor so they can still explore and recover */
  const vals = Object.values(scores);
  const min = Math.min(...vals);
  const shifted = STRATS.map((st) => scores[st.key] - min + 1);
  const mean = shifted.reduce((a, b) => a + b, 0) / shifted.length;
  const alloc = {};
  STRATS.forEach((st, i2) => { alloc[st.key] = +Math.min(1.6, Math.max(0.4, shifted[i2] / mean)).toFixed(2); });
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(ALLOC_FILE, JSON.stringify(alloc, null, 2) + "\n");
  log("risk allocation:", JSON.stringify(alloc));
  return { champs, scores, alloc };
}
const journal = (obj) => {
  fs.mkdirSync(STATE, { recursive: true });
  fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const argStr = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadDaysOrSynth() {
  const synthN = arg("synth", 0);
  if (synthN > 0) {
    log(`using ${synthN} SYNTHETIC days (mechanics/relative comparison only)`);
    return makeLibrary(synthN, arg("libseed", 42)); /* --seed steers only the tuner's search */
  }
  const days = D.loadRecordedDays();
  if (days.length === 0) {
    log("no recorded days yet — falling back to 60 synthetic days (run `trade` to start recording real ones)");
    return makeLibrary(60, 42);
  }
  log(`using ${days.length} recorded real days`);
  return days;
}

async function cmdScan() {
  const keys = D.keysFromEnv();
  if (!keys) return log("set APCA_API_KEY_ID / APCA_API_SECRET_KEY first");
  const list = await D.discover(keys);
  log(`session: ${D.inPremarket() ? "PREMARKET" : D.inRTH() ? "RTH" : "closed"} — ${list.length} qualifiers`);
  for (const c of list) console.log(`  ${c.symbol.padEnd(6)} $${c.price.toFixed(2).padStart(8)}  +${c.pct.toFixed(1)}%`);
}

/* Rebuild the recorded-day library from history, so the nightly tuner has
   more than a working week to search over. Skips dates already on disk, so
   it is safe to re-run and safe to interrupt. */
async function cmdBackfill() {
  const keys = D.keysFromEnv();
  if (!keys) return log("set APCA_API_KEY_ID / APCA_API_SECRET_KEY first");
  const end = argStr("end", D.etDayISO(Date.now() - 864e5));
  const start = argStr("start", new Date(Date.parse(end) - 180 * 864e5).toISOString().slice(0, 10));
  const dates = BF.tradingDates(start, end);
  const dir = path.join(D.STATE, "days");
  const have = new Set((() => { try { return fs.readdirSync(dir).map((f) => f.replace(/\.json$/, "")); } catch { return []; } })());
  const todo = dates.filter((d) => !have.has(d));

  log(`backfill ${start} -> ${end}: ${dates.length} weekdays, ${have.size} already on disk, ${todo.length} to fetch`);
  log(`survivorship note: the universe is TODAY's active assets, so anything`);
  log(`delisted since is absent. Backfilled days are training material, not evidence.`);
  if (!todo.length) return;

  const uni = await D.universe(keys);
  log(`universe: ${uni.length} Robinhood-tradable symbols`);

  let made = 0, empty = 0;
  for (const date of todo) {
    try {
      const r = await BF.backfillDay(keys, date, uni, log);
      if (r) made++; else empty++;
    } catch (e) { log(`  ${date}  FAILED: ${String(e.message).slice(0, 120)}`); empty++; }
  }
  const total = (() => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length; } catch { return 0; } })();
  log(`backfill done: ${made} days written, ${empty} skipped. Library now ${total} days.`);
  if (total >= 5) {
    const cut = Math.max(1, Math.floor(total * 0.7));
    log(`tuner split is now train=${cut} / validate=${total - cut}.`);
  } else log(`still under the 5-day tune gate.`);
}

function cmdBacktest() {
  const days = loadDaysOrSynth();
  const Ps = loadAllParams();
  for (const st of STRATS) {
    const { metrics } = runBacktest(days, Ps[st.key], 100000, st.signalAt);
    console.log(`\n[${st.key}] ${st.name}`);
    console.log("  metrics:", JSON.stringify(metrics));
  }
}

function cmdTune() {
  const days = loadDaysOrSynth();
  const iters = arg("iters", 120);
  log(`ensemble tune: ${STRATS.length} pods × ${iters} iterations, walk-forward 70/30 over ${days.length} days…`);
  ensembleTune(days, iters, arg("seed", Date.now() % 100000));
}

function cmdReport() {
  let trades = [];
  try { trades = fs.readFileSync(JOURNAL, "utf8").trim().split("\n").map(JSON.parse).filter((j) => j.kind === "exit" || j.kind === "scale"); } catch {}
  const pnl = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  console.log(`journal: ${trades.length} closed trades, ${wins} wins (${trades.length ? Math.round((wins / trades.length) * 100) : 0}%), net PnL $${pnl.toFixed(2)}`);
  for (const st of STRATS) {
    const tt = trades.filter((t) => t.strat === st.key);
    const p2 = tt.reduce((a, t) => a + (t.pnl || 0), 0);
    console.log(`  ${st.key.padEnd(9)} ${String(tt.length).padStart(4)} trades  $${p2.toFixed(2)}`);
  }
  console.log("allocation:", JSON.stringify(loadAlloc()));
  try {
    const tl = fs.readFileSync(TUNE_LOG, "utf8").trim().split("\n").map(JSON.parse);
    console.log(`tuning: ${tl.length} accepted improvement(s); latest validate score ${tl[tl.length - 1].best.valid}`);
  } catch { console.log("tuning: no accepted improvements logged yet"); }
  console.log(`recorded days: ${D.loadRecordedDays().length}`);
}

/* ------------------------- live paper-trade loop ------------------------- */
async function cmdTrade() {
  /* the dashboard comes up BEFORE the broker check, so a broken Alpaca
     connection is visible on the page instead of a silent Render crash loop */
  const dashStatus = { session: "starting", positions: [], universe: 0, error: null, beat: Date.now() };
  const dashPort = process.env.PORT || 8788;
  startDashboard({ port: dashPort, stateDir: STATE, status: dashStatus });
  log(`dashboard listening on :${dashPort}${process.env.DASH_TOKEN ? " (token-protected)" : ""}`);

  const keys = D.keysFromEnv();
  if (!keys) {
    dashStatus.error = "APCA_API_KEY_ID / APCA_API_SECRET_KEY are not set — add your Alpaca PAPER keys under Render → momentum-algo-trader → Environment (the service restarts itself after you save).";
    log(dashStatus.error);
  }
  let broker = null, acct = null;
  while (!acct) {
    if (keys) {
      broker = broker || new PaperBroker(keys);
      try { acct = await broker.account(); break; }
      catch (e) {
        dashStatus.error = `Alpaca PAPER account check failed: ${e.message}. If you regenerated your Alpaca keys, the pair stored on this service is stale — update APCA_API_KEY_ID / APCA_API_SECRET_KEY under Render → Environment. Retrying every 60s.`;
        log("broker connect failed:", e.message, "— retrying in 60s");
      }
    }
    dashStatus.beat = Date.now();
    await sleep(60000);
  }
  dashStatus.error = null;
  log(`connected to PAPER account ${acct.account_number} — equity $${acct.equity}`);
  journal({ kind: "start", equity: acct.equity });
  const EQ_FILE = path.join(STATE, "equity.jsonl");
  let lastEqSample = 0;
  const sampleEquity = (eq) => {
    const v = Number(eq);
    if (!isFinite(v) || Date.now() - lastEqSample < 25000) return;
    lastEqSample = Date.now();
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(EQ_FILE, JSON.stringify({ t: Date.now(), eq: +v.toFixed(2) }) + "\n");
  };
  sampleEquity(acct.equity);

  let Ps = loadAllParams();        // strat key -> params
  let alloc = loadAlloc();         // strat key -> risk weight (nightly ensemble)
  let universe = [];               // [{symbol, pct, prevClose}]
  let lastDiscover = 0;
  /* THE POSITION BOOK PERSISTS ACROSS RESTARTS. Deploys used to wipe it,
     so every restart "re-adopted" held positions as generic gapgo trades —
     a moon runner would lose its ride plan and stall clock, and shutdown
     even flattened everything. Now each position's full identity (pod,
     entry, stop, target/ratchet plan, hold clock, exit state) reloads from
     the Render disk. */
  const POS_FILE = path.join(STATE, "positions.json");
  let posMeta = {};                // sym -> {strat, entry, stop, risk, hwm, barsHeld, qty, ...}
  try { posMeta = JSON.parse(fs.readFileSync(POS_FILE, "utf8")) || {}; log(`restored position book: ${Object.keys(posMeta).length} position(s)`); } catch {}
  const savePos = () => { try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(POS_FILE, JSON.stringify(posMeta)); } catch {} };
  const entriesToday = {};         // "strat:sym" -> count
  const cooldownUntil = {};
  const selling = new Set();       // per-symbol guard: fast tick vs slow loop
  const flatTried = {};            // sym -> flatten attempts today (journal once, escalate price)
  let dayStartEq = Number(acct.equity);
  let halted = false;
  let day = D.etDay(Date.now());
  let recorded = false;
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  /* FAST EXIT TICK — every SECOND, one batched latest-trades call for the
     open positions. These moves reverse in seconds: the ride ratchet, stops
     and scale-out targets are enforced on live prints, not on the next
     bar fetch. Entries stay on the bar loop (signals are bar structures). */
  let fastBusy = false;
  const fastTick = async () => {
    if (fastBusy || !running || halted) return;
    const syms = Object.keys(posMeta).filter((s) => !selling.has(s) && posMeta[s].qty > 0 && posMeta[s].filled && !posMeta[s].exiting);
    if (!syms.length) return;
    const nowMin2 = D.etMinute(Date.now());
    if (nowMin2 < 240 || nowMin2 >= FLATTEN_MIN) return; /* the slow loop owns the flatten window */
    const ext2 = nowMin2 < 570 || nowMin2 >= 960;
    fastBusy = true;
    try {
      const tr = await D.latestTrades(keys, syms);
      for (const sym of syms) {
        const meta = posMeta[sym];
        if (!meta || selling.has(sym)) continue;
        const t = tr[sym];
        if (!t || Date.now() - t.t > 120000) continue; /* stale print — let the bar loop decide */
        const p = t.p;
        if (p > meta.hwm) meta.hwm = p;
        const P = Ps[meta.strat] || Ps.gapgo;
        if (P.hwmTrailPct > 0) {
          const ratchet = meta.hwm * (1 - P.hwmTrailPct / 100);
          if (ratchet > meta.stop) meta.stop = ratchet;
        }
        if (p <= meta.stop) {
          /* a resting RTH broker stop at this level fills server-side */
          if (!ext2 && meta.brokerStop != null && meta.stop <= meta.brokerStop + 1e-9) continue;
          /* FLICKER IMMUNITY: one odd-lot print below the stop is noise on
             these names — demand the breach on two consecutive 1s ticks */
          meta.breach = (meta.breach || 0) + 1;
          if (meta.breach < 2) continue;
          selling.add(sym);
          log(`FAST EXIT [${meta.strat}] ${sym}: live ${p} <= stop ${meta.stop.toFixed(4)}`);
          try {
            await broker.cancelOrders(sym).catch(() => {});
            if (ext2) await broker.sellLimitExt(sym, meta.qty, Math.max(0.01, p * 0.995));
            else await broker.sellMarket(sym, meta.qty);
            /* stateful exit: the slow loop journals + frees the slot only
               when the broker confirms the position is gone */
            meta.exiting = { reason: "stop", t: Date.now(), tries: 0, pnl: +(((p - meta.entry) * meta.qty).toFixed(2)) };
          } catch (e) { log("fast exit failed:", sym, e.message); }
          selling.delete(sym);
        } else if (meta.breach) {
          meta.breach = 0; /* the print recovered — it was a flicker */
        } else if (!meta.scaled && meta.target && p >= meta.target && P.scaleOutPct < 100) {
          const q = Math.min(meta.qty, Math.max(1, Math.round(meta.qty * P.scaleOutPct / 100)));
          selling.add(sym);
          log(`FAST SCALE-OUT [${meta.strat}] ${sym}: ${q}/${meta.qty} at live ${p} (target ${meta.target.toFixed(2)})`);
          try {
            await broker.cancelOrders(sym).catch(() => {});
            if (ext2) await broker.sellLimitExt(sym, q, Math.max(0.01, p * 0.995));
            else await broker.sellMarket(sym, q);
            journal({ kind: "scale", sym, strat: meta.strat, reason: "target " + P.scaleOutPct + "%", qty: q, pnl: +(((p - meta.entry) * q).toFixed(2)) });
            meta.scaled = true;
            meta.qty -= q;
            meta.stop = Math.max(meta.stop, meta.entry);
            if (meta.qty > 0 && !ext2) {
              await broker.sellStop(sym, meta.qty, meta.stop).catch(() => {});
              meta.brokerStop = meta.stop;
            } else if (meta.qty <= 0) delete posMeta[sym];
          } catch (e) { log("fast scale-out failed:", sym, e.message); }
          selling.delete(sym);
        }
      }
    } catch (e) {} finally { fastBusy = false; savePos(); }
  };
  const fastId = setInterval(fastTick, 1000);

  while (running) {
    try {
      dashStatus.beat = Date.now(); /* dashboard heartbeat: proves the loop is alive */
      dashStatus.error = null;
      const nowMin = D.etMinute(Date.now());
      const today = D.etDay(Date.now());
      if (today !== day) { // new ET day: fresh slate, reload possibly-tuned params
        day = today; halted = false; recorded = false;
        for (const k of Object.keys(entriesToday)) delete entriesToday[k];
        for (const k of Object.keys(cooldownUntil)) delete cooldownUntil[k];
        for (const k of Object.keys(flatTried)) delete flatTried[k];
        Ps = loadAllParams();
        alloc = loadAlloc();
        const a = await broker.account().catch(() => null);
        if (a) dayStartEq = Number(a.equity);
        journal({ kind: "day", day, alloc });
      }
      const inSession = nowMin >= 240 && nowMin < 1200; /* full extended tape 4:00-20:00 */
      const ext = nowMin < 570 || nowMin >= 960; /* Alpaca ext-hours order rules apply */
      dashStatus.session = !inSession ? "closed" : nowMin >= FLATTEN_MIN ? "flatten" : nowMin < 570 ? "premarket" : nowMin >= 960 ? "after-hours" : "regular";
      if (!inSession) {
        /* after the extended close: record the day once, then run the
           ENSEMBLE tune — all five pods learn from the same shared library,
           cross-pollinate params, and re-split the risk allocation */
        if (nowMin >= 1205 && nowMin < 1435 && !recorded) {
          recorded = true;
          /* record EVERY mover discovery ranked today — traded or not — so
             the nightly tune learns from the EPOW/RYET-class misses too */
          const syms = [...new Set([
            ...universe.map((u) => u.symbol), ...Object.keys(posMeta),
            ...D.moversSeenToday(day),
          ])].slice(0, 80);
          if (syms.length) {
            const bars = await D.fetchBars1Min(keys, syms);
            const f = D.recordDay(bars);
            if (f) log("recorded day ->", f);
          }
          /* missed-mover audit: ranked movers that never got an entry */
          const enteredSyms = new Set(Object.keys(entriesToday).map((k) => k.split(":")[1]));
          const missed = D.moversSeenToday(day).filter((s) => !enteredSyms.has(s));
          if (missed.length) {
            log(`missed movers today (${missed.length}): ${missed.slice(0, 20).join(",")}`);
            journal({ kind: "missed", syms: missed.slice(0, 40) });
          }
          const days = D.loadRecordedDays();
          if (days.length >= 5) {
            log(`nightly ENSEMBLE tune: ${STRATS.length} pods over ${days.length} recorded days…`);
            const res = ensembleTune(days, 120, Date.now() % 100000);
            Ps = res.champs;
            alloc = res.alloc;
            journal({ kind: "tune", scores: res.scores, alloc: res.alloc });
          } else log(`nightly tune skipped — only ${days.length} recorded day(s), need 5`);
        }
        await sleep(60000);
        continue;
      }

      /* refresh the scanner universe every 90s — a vertical mover must be
         seen WHILE it is moving, not five minutes later */
      if (Date.now() - lastDiscover > 90 * 1000) {
        lastDiscover = Date.now();
        const prev = new Set(universe.map((u) => u.symbol));
        universe = await D.discover(keys).catch((e) => { log("discover error:", e.message); return universe; });
        dashStatus.universe = universe.length;
        const fresh = universe.filter((u) => !prev.has(u.symbol));
        if (fresh.length || universe.length !== prev.size)
          log(`universe: ${universe.length} — ${universe.slice(0, 8).map((u) => (u.fast ? u.symbol + "*" : u.symbol)).join(",")}${fresh.length ? "  new: " + fresh.map((u) => u.symbol).join(",") : ""}`);
      }

      /* session-aware flatten: market orders during RTH, marketable ext-hours
         limits otherwise (Alpaca rejects market orders off-RTH) */
      const flattenAll = async (poss, reason) => {
        for (const p of poss) {
          await broker.cancelOrders(p.symbol).catch(() => {});
          const q = Math.abs(Number(p.qty));
          const px = Number(p.current_price) || Number(p.avg_entry_price);
          /* an illiquid name (e.g. a stranded warrant) may not fill the
             first limit: journal the exit ONCE, and price each retry more
             aggressively instead of spamming identical orders + rows */
          const tries = flatTried[p.symbol] || 0;
          flatTried[p.symbol] = tries + 1;
          try {
            if (ext) await broker.sellLimitExt(p.symbol, q, Math.max(0.01, px * (0.99 - 0.03 * Math.min(tries, 15))));
            else await broker.sellMarket(p.symbol, q);
            if (tries === 0) journal({ kind: "exit", sym: p.symbol, strat: (posMeta[p.symbol] || {}).strat, reason, pnl: Number(p.unrealized_pl) || 0 });
          } catch (e) { log("flatten sell:", p.symbol, e.message); }
          cooldownUntil[p.symbol] = nowMin + 10;
          delete posMeta[p.symbol];
        }
      };

      /* 19:55+: flatten and stand down for the day */
      if (nowMin >= FLATTEN_MIN) {
        const positions = await broker.positions().catch(() => []);
        if (positions.length) {
          log("flatten window — closing all positions");
          await flattenAll(positions, "flatten");
        }
        dashStatus.positions = [];
        const af = await broker.account().catch(() => null);
        if (af) sampleEquity(af.equity);
        await sleep(60000);
        continue;
      }

      let positions = await broker.positions().catch(() => []);
      /* PURGE: any held position that fails the tradability screen (e.g. a
         warrant bought before the screen existed) is force-closed on sight —
         broker-side market close during RTH, escalating marketable limit off
         hours — and never re-enters (the screen blocks new buys). */
      const kept = [];
      for (const p of positions) {
        if (D.rhTradable({ symbol: p.symbol, exchange: p.exchange })) { kept.push(p); continue; }
        if (selling.has(p.symbol)) continue;
        selling.add(p.symbol);
        const tries = flatTried[p.symbol] || 0;
        flatTried[p.symbol] = tries + 1;
        log(`PURGE ${p.symbol}: fails the tradability screen — force closing (attempt ${tries + 1})`);
        try {
          await broker.cancelOrders(p.symbol).catch(() => {});
          if (!ext) await broker.closePosition(p.symbol);
          else {
            const q = Math.abs(Number(p.qty));
            const px = Number(p.current_price) || Number(p.avg_entry_price) || 0.02;
            await broker.sellLimitExt(p.symbol, q, Math.max(0.01, px * (0.99 - 0.03 * Math.min(tries, 15))));
          }
          if (tries === 0) journal({ kind: "exit", sym: p.symbol, strat: (posMeta[p.symbol] || {}).strat, reason: "purged", pnl: Number(p.unrealized_pl) || 0 });
          delete posMeta[p.symbol];
        } catch (e) { log("purge failed:", p.symbol, e.message); }
        selling.delete(p.symbol);
      }
      positions = kept;
      const held = new Set(positions.map((p) => p.symbol));
      dashStatus.positions = positions.map((p) => {
        const m = posMeta[p.symbol];
        const mp = m && Ps[m.strat] ? Ps[m.strat] : Ps.gapgo;
        return {
          sym: p.symbol, strat: m ? m.strat : null, qty: Math.abs(Number(p.qty)),
          entry: Number(p.avg_entry_price),
          price: Number(p.current_price) || Number(p.avg_entry_price),
          target: m && !m.scaled ? m.target : null,
          stop: m ? m.stop : null,
          ridePct: mp.hwmTrailPct > 0 ? mp.hwmTrailPct : null, /* riders: exit = dip this % off the high */
          exiting: !!(m && m.exiting), /* a sell is working; waiting on the fill */
          scaled: !!(m && m.scaled), scaleOutPct: mp.scaleOutPct,
          value: Number(p.market_value),
          plUsd: Number(p.unrealized_pl), plPct: Number(p.unrealized_plpc) * 100,
        };
      });
      const openByStrat = {};
      for (const m of Object.values(posMeta)) if (m.strat) openByStrat[m.strat] = (openByStrat[m.strat] || 0) + 1;
      dashStatus.strats = STRATS.map((st) => ({
        key: st.key, name: st.name,
        weight: alloc[st.key] != null ? alloc[st.key] : 1,
        open: openByStrat[st.key] || 0,
      }));
      /* AN EXIT IS DONE ONLY WHEN THE BROKER SAYS THE POSITION IS GONE.
         Submitting a sell no longer journals or frees the slot — that
         caused unfilled ext-hours sells to be re-adopted, re-exited and
         re-journaled every loop (the $0 vwap-exit spam). */
      for (const k of Object.keys(posMeta)) {
        const m = posMeta[k];
        if (held.has(k)) { m.filled = true; continue; }
        if (m.exiting) { /* the working sell finally filled */
          journal({ kind: "exit", sym: k, strat: m.strat, reason: m.exiting.reason, qty: m.qty, pnl: m.exiting.pnl });
          cooldownUntil[k] = nowMin + (Ps[m.strat] || Ps.gapgo).cooldownMin;
          delete posMeta[k];
        } else if (!m.filled) { /* entry order never filled — quietly withdraw */
          if (Date.now() - (m.placedAt || 0) > 90000) {
            log(`entry never filled ${k} — canceling the order, freeing the slot`);
            await broker.cancelOrders(k).catch(() => {});
            delete posMeta[k];
          }
        } else { /* broker-held stop/close filled server-side */
          journal({ kind: "exit", sym: k, strat: m.strat, reason: "bracket" });
          cooldownUntil[k] = nowMin + 10;
          delete posMeta[k];
        }
      }

      /* account-wide daily loss halt */
      const a = await broker.account().catch(() => null);
      if (a) sampleEquity(a.equity);
      if (a && !halted && Number(a.equity) <= dayStartEq * (1 - DAY_LOSS_PCT / 100)) {
        halted = true;
        log(`daily loss limit hit (${DAY_LOSS_PCT}%) — flattening, no more entries today`);
        await flattenAll(positions, "dayhalt");
        journal({ kind: "dayhalt", equity: a.equity });
        await sleep(60000);
        continue;
      }

      const tracked = [...new Set([...universe.map((u) => u.symbol), ...held])];
      if (tracked.length) {
        const barsMap = await D.fetchBars1Min(keys, tracked);
        /* manage positions: scale-outs at the planned exit, trailed/vwap/time
           exits, and — in extended hours — engine-fired stops (Alpaca's own
           stop orders sleep outside 9:30-16:00) */
        for (const p of positions) {
          if (selling.has(p.symbol)) continue; /* fast tick mid-sale */
          const bars = barsMap[p.symbol] || [];
          if (bars.length < 5) {
            /* DEAD TAPE: a held symbol with no bars all session (stranded
               warrant, halted-to-nothing name) can never trigger a normal
               exit — after 3 consecutive dead reads, market-sell it during
               RTH rather than carrying a corpse forever */
            const m0 = posMeta[p.symbol];
            if (m0) {
              m0.deadTicks = (m0.deadTicks || 0) + 1;
              if (m0.deadTicks >= 3 && !ext) {
                log(`DEAD-TAPE LIQUIDATION ${p.symbol}: no prints all session — market sell`);
                try {
                  await broker.cancelOrders(p.symbol).catch(() => {});
                  await broker.sellMarket(p.symbol, Math.abs(Number(p.qty)));
                  journal({ kind: "exit", sym: p.symbol, strat: m0.strat, reason: "deadtape", pnl: Number(p.unrealized_pl) || 0 });
                  delete posMeta[p.symbol];
                } catch (e) { log("dead-tape sell failed:", p.symbol, e.message); }
              }
            }
            continue;
          }
          if (posMeta[p.symbol]) posMeta[p.symbol].deadTicks = 0;
          const qtyNow = Math.abs(Number(p.qty));
          const P0 = Ps.gapgo; /* adoption defaults for positions with no meta (restart) */
          const meta = posMeta[p.symbol] || (posMeta[p.symbol] = {
            strat: "gapgo",
            entry: Number(p.avg_entry_price), stop: Number(p.avg_entry_price) * (1 - P0.maxStopPct / 100),
            brokerStop: null, risk: Number(p.avg_entry_price) * P0.minStopPct / 100,
            target: Number(p.avg_entry_price) * (1 + P0.targetR * P0.minStopPct / 100),
            hwm: Number(p.avg_entry_price), barsHeld: 0, qty: qtyNow, scaled: false,
            filled: true, rebased: true, placedAt: Date.now(), exiting: null,
          });
          const P = Ps[meta.strat] || Ps.gapgo; /* this pod's own management rules */
          meta.qty = qtyNow;
          meta.filled = true;
          /* REBASE ON FILL: the stop was computed off the signal bar's
             close, but the marketable order fills higher — keep the
             INTENDED risk distance from the actual fill, or the effective
             stop is tighter than designed and gets clipped by noise */
          if (!meta.rebased) {
            meta.rebased = true;
            const fillPx = Number(p.avg_entry_price);
            if (fillPx > 0 && Math.abs(fillPx - meta.entry) / meta.entry < 0.2) {
              const shift = fillPx - meta.entry;
              meta.entry = fillPx;
              meta.stop += shift;
              if (meta.target != null) meta.target += shift;
              meta.hwm = Math.max(meta.hwm, fillPx);
            }
          }
          const price = bars[bars.length - 1].c;
          const submitSell = async (q, px2) => {
            await broker.cancelOrders(p.symbol).catch(() => {});
            if (ext) await broker.sellLimitExt(p.symbol, q, Math.max(0.01, px2));
            else await broker.sellMarket(p.symbol, q);
          };
          /* a full exit already working: re-price it harder every 45s until
             the broker confirms the fill — never journal twice */
          if (meta.exiting) {
            if (Date.now() - meta.exiting.t > 45000) {
              meta.exiting.t = Date.now();
              meta.exiting.tries++;
              log(`exit still working [${meta.strat}] ${p.symbol} (${meta.exiting.reason}) — repricing, attempt ${meta.exiting.tries + 1}`);
              try { await submitSell(qtyNow, price * (0.995 - 0.03 * Math.min(meta.exiting.tries, 10))); } catch (e) { log("reprice failed:", p.symbol, e.message); }
            }
            continue;
          }
          const sellSome = async (q, kind, reason) => {
            await submitSell(q, price * 0.995);
            journal({ kind, sym: p.symbol, strat: meta.strat, reason, qty: q, pnl: +(((price - meta.entry) * q).toFixed(2)) });
          };
          /* PLANNED EXIT: bank scaleOutPct at the target; the runner rides
             the trail with its stop floored at break-even */
          if (!meta.scaled && meta.target && price >= meta.target && P.scaleOutPct < 100) {
            const q = Math.min(qtyNow, Math.max(1, Math.round(qtyNow * P.scaleOutPct / 100)));
            log(`SCALE-OUT ${p.symbol}: ${q}/${qtyNow} at ~${price.toFixed(2)} (target ${meta.target.toFixed(2)}) — runner stop -> break-even+`);
            try {
              await sellSome(q, "scale", "target " + P.scaleOutPct + "%");
              meta.scaled = true;
              meta.qty = qtyNow - q;
              meta.stop = Math.max(meta.stop, meta.entry);
              if (meta.qty > 0 && !ext) {
                await broker.sellStop(p.symbol, meta.qty, meta.stop).catch(() => {});
                meta.brokerStop = meta.stop;
              }
            } catch (e) { log("scale-out failed:", p.symbol, e.message); }
            continue;
          }
          /* barsHeld must mean MINUTES: exitCheck runs every 15s live (vs
             once per 1-min bar in backtests), so wall-clock is the truth —
             otherwise time stops fire 4x early for quick pods and rider
             stall exits drift */
          meta.barsHeld = Math.floor((Date.now() - (meta.placedAt || Date.now())) / 60000);
          const S = prepSeries(bars, P);
          const ex = exitCheck(S, bars, bars.length - 1, meta, P);
          if (!ex) continue;
          /* a plain RTH stop at the broker's resting level fills server-side —
             everything else (trailed stops, all ext-hours exits, full targets
             when scaleOutPct=100, vwap/time) is the engine's to execute */
          if (ex.reason === "stop" && !ext && meta.brokerStop != null && meta.stop <= meta.brokerStop + 1e-9) continue;
          log(`exit ${p.symbol}: ${ex.reason}${ext ? " (ext)" : ""}`);
          try {
            await submitSell(meta.qty || qtyNow, price * 0.995);
            meta.exiting = { reason: ex.reason, t: Date.now(), tries: 0, pnl: +(((price - meta.entry) * (meta.qty || qtyNow)).toFixed(2)) };
          } catch (e) { log("sell failed:", p.symbol, e.message); }
        }
        /* entries: each symbol is offered to every pod in turn; the first
           pod whose signal fires CLAIMS it (one owner per symbol), subject
           to that pod's own position/re-entry caps and the account cap */
        if (!halted && Object.keys(posMeta).length < GLOBAL_MAX_POS) {
          entryScan:
          for (const u of universe) {
            if (held.has(u.symbol) || posMeta[u.symbol]) continue;
            if (cooldownUntil[u.symbol] != null && nowMin < cooldownUntil[u.symbol]) continue;
            const bars = barsMap[u.symbol] || [];
            if (bars.length < 30) continue;
            for (const st of STRATS) {
              const P = Ps[st.key];
              if ((openByStrat[st.key] || 0) >= P.maxPositions) continue;
              if ((entriesToday[st.key + ":" + u.symbol] || 0) >= P.reentryLimit) continue;
              const S = prepSeries(bars, P);
              if (!entryViable(S, bars, bars.length - 1, P)) continue; /* churn guard: never buy what the exit engine would instantly sell */
              const sig = st.signalAt(S, bars, bars.length - 1, P);
              if (!sig) continue;
              const px = bars[bars.length - 1].c;
              const eq = a ? Number(a.equity) : dayStartEq;
              const w = alloc[st.key] != null ? alloc[st.key] : 1; /* nightly risk weight */
              let qty = Math.floor((eq * (P.riskPct * w) / 100) / sig.risk);
              qty = Math.min(qty, Math.floor((eq * P.maxNotionalPct / 100) / px));
              if (qty < 1) continue;
              const target = P.targetR > 0 ? px + P.targetR * sig.risk : null;
              log(`ENTRY [${st.key}]${ext ? " (ext)" : ""} ${u.symbol} x${qty} @~${px.toFixed(2)} stop ${sig.stop.toFixed(2)}${target ? " target " + target.toFixed(2) : ""}`);
              try {
                if (ext) await broker.buyLimitExt(u.symbol, qty, px * 1.01); /* marketable limit; stop engine-managed off-RTH */
                else await broker.buyBracket(u.symbol, qty, sig.stop, null); /* OTO stop; the scale-out is engine-managed */
                posMeta[u.symbol] = { strat: st.key, entry: px, stop: sig.stop, brokerStop: ext ? null : sig.stop, risk: sig.risk, target, hwm: px, barsHeld: 0, qty, scaled: false, filled: false, rebased: false, placedAt: Date.now(), exiting: null };
                entriesToday[st.key + ":" + u.symbol] = (entriesToday[st.key + ":" + u.symbol] || 0) + 1;
                openByStrat[st.key] = (openByStrat[st.key] || 0) + 1;
                journal({ kind: "entry", sym: u.symbol, strat: st.key, qty, px, stop: sig.stop, target });
                if (Object.keys(posMeta).length >= GLOBAL_MAX_POS) break entryScan;
              } catch (e) { log("order rejected:", e.message); }
              continue entryScan; /* symbol claimed (or rejected) — next symbol */
            }
          }
        }
      }
    } catch (e) {
      dashStatus.error = "trade-loop error (auto-retrying): " + e.message;
      log("loop error:", e.message);
    }
    savePos();
    await sleep(15000); /* bar loop: entries + management; the 1s fast tick guards exits */
  }
  clearInterval(fastId);
  /* restarts (deploys) HAND OFF instead of flattening: the position book is
     on disk, broker-held RTH stops keep resting server-side, and the next
     boot resumes every position under its own pod's plan. The 19:55
     flatten still guarantees no overnights. */
  savePos();
  log("shutting down — position book persisted, positions carry to the next boot");
  journal({ kind: "stop" });
}

const cmd = process.argv[2] || "report";
({
  scan: cmdScan, trade: cmdTrade, backtest: cmdBacktest, tune: cmdTune, report: cmdReport,
  backfill: cmdBackfill,
  test: () => require("./test-engine.js"),
}[cmd] || (() => console.log("commands: trade | scan | backfill | backtest | tune | report | test")))();
