#!/usr/bin/env node
/* Momentum Algo Trader — autonomous PAPER-trading engine driven by the
   Momentum Scanner's discovery gates.

   Commands:
     node engine.js trade                live paper-trading loop (needs keys)
     node engine.js scan                 print the current scanner universe
     node engine.js backtest [--synth N] backtest recorded days (or N synthetic)
     node engine.js tune [--synth N] [--iters N]   improve params.json
     node engine.js report               journal + tuning summary
     node engine.js test                 run the unit tests

   Keys (Alpaca PAPER account) via env:
     APCA_API_KEY_ID=...  APCA_API_SECRET_KEY=...

   The trade loop, every day (4:00 AM - 8:00 PM ET, premarket + after hours):
   - RTH entries go in with a broker-held protective stop; extended-hours
     entries use marketable limit orders (Alpaca's off-RTH rules) with the
     stop managed by the engine off the live tape.
   - At the planned exit (targetR x risk) the engine SCALES OUT scaleOutPct
     (default 85%) and lets the runner ride a trailing stop floored at
     break-even; vwap/time/trailing exits are engine-managed throughout.
   - 19:55 ET: flatten everything. No overnight positions, ever.
   - after the close: record the day's bars into state/days/, then run the
     walk-forward tuner over ALL recorded days and write improved params to
     params.json — the model gets better as the library of real days grows.

   PAPER ONLY. lib/broker.js refuses any non-paper trading URL. */

const fs = require("fs");
const path = require("path");
const D = require("./lib/data");
const { startDashboard } = require("./lib/dashboard");
const { PaperBroker } = require("./lib/broker");
const { DEFAULTS, prepSeries, signalAt, exitCheck } = require("./lib/strategy");
const { runBacktest } = require("./lib/backtest");
const { tune } = require("./lib/tune");
const { makeLibrary } = require("./lib/synth");

const ROOT = __dirname;
const PARAMS_FILE = path.join(ROOT, "params.json");
const STATE = D.STATE;
const JOURNAL = path.join(STATE, "journal.jsonl");
const TUNE_LOG = path.join(STATE, "tune-log.jsonl");

const loadParams = () => {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(PARAMS_FILE, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
};
const saveParams = (P) => fs.writeFileSync(PARAMS_FILE, JSON.stringify(P, null, 2) + "\n");
const journal = (obj) => {
  fs.mkdirSync(STATE, { recursive: true });
  fs.appendFileSync(JOURNAL, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
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

function cmdBacktest() {
  const P = loadParams();
  const days = loadDaysOrSynth();
  const { metrics } = runBacktest(days, P);
  console.log("params:", JSON.stringify(P));
  console.log("metrics:", JSON.stringify(metrics, null, 2));
}

function cmdTune() {
  const P = loadParams();
  const days = loadDaysOrSynth();
  const iters = arg("iters", 150);
  log(`tuning: ${iters} iterations, walk-forward 70/30 over ${days.length} days…`);
  const res = tune(days, P, iters, arg("seed", Date.now() % 100000));
  console.log("score  base:", JSON.stringify(res.baseScore), " best:", JSON.stringify(res.bestScore));
  const before = runBacktest(days, P).metrics;
  const after = runBacktest(days, res.params).metrics;
  console.log("full-set before:", JSON.stringify(before));
  console.log("full-set after: ", JSON.stringify(after));
  if (res.bestScore.valid > res.baseScore.valid || (res.baseScore.valid === null && res.bestScore.train > res.baseScore.train)) {
    saveParams(res.params);
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(TUNE_LOG, JSON.stringify({ t: new Date().toISOString(), days: days.length, base: res.baseScore, best: res.bestScore, params: res.params }) + "\n");
    log("improved -> params.json updated");
  } else log("no validated improvement — params.json unchanged");
}

function cmdReport() {
  let trades = [];
  try { trades = fs.readFileSync(JOURNAL, "utf8").trim().split("\n").map(JSON.parse).filter((j) => j.kind === "exit"); } catch {}
  const pnl = trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  console.log(`journal: ${trades.length} closed trades, ${wins} wins (${trades.length ? Math.round((wins / trades.length) * 100) : 0}%), net PnL $${pnl.toFixed(2)}`);
  try {
    const tl = fs.readFileSync(TUNE_LOG, "utf8").trim().split("\n").map(JSON.parse);
    console.log(`tuning: ${tl.length} accepted improvement(s); latest validate score ${tl[tl.length - 1].best.valid}`);
  } catch { console.log("tuning: no accepted improvements logged yet"); }
  console.log(`recorded days: ${D.loadRecordedDays().length}`);
}

/* ------------------------- live paper-trade loop ------------------------- */
async function cmdTrade() {
  const keys = D.keysFromEnv();
  if (!keys) return log("set APCA_API_KEY_ID / APCA_API_SECRET_KEY (PAPER keys) first");
  const broker = new PaperBroker(keys);
  const acct = await broker.account();
  log(`connected to PAPER account ${acct.account_number} — equity $${acct.equity}`);
  journal({ kind: "start", equity: acct.equity });

  /* live dashboard: real-time equity line chart + trade markers */
  const dashStatus = { session: "starting", positions: [], universe: 0 };
  const dashPort = process.env.PORT || 8788;
  startDashboard({ port: dashPort, stateDir: STATE, status: dashStatus });
  log(`dashboard listening on :${dashPort}${process.env.DASH_TOKEN ? " (token-protected)" : ""}`);
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

  let P = loadParams();
  let universe = [];               // [{symbol, pct, prevClose}]
  let lastDiscover = 0;
  const posMeta = {};              // sym -> {entry, stop, risk, hwm, barsHeld, qty}
  const entriesToday = {};
  const cooldownUntil = {};
  let dayStartEq = Number(acct.equity);
  let halted = false;
  let day = D.etDay(Date.now());
  let recorded = false;
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });

  while (running) {
    try {
      const nowMin = D.etMinute(Date.now());
      const today = D.etDay(Date.now());
      if (today !== day) { // new ET day: fresh slate, reload possibly-tuned params
        day = today; halted = false; recorded = false;
        for (const k of Object.keys(entriesToday)) delete entriesToday[k];
        for (const k of Object.keys(cooldownUntil)) delete cooldownUntil[k];
        P = loadParams();
        const a = await broker.account().catch(() => null);
        if (a) dayStartEq = Number(a.equity);
        journal({ kind: "day", day, params: P });
      }
      const inSession = nowMin >= 240 && nowMin < 1200; /* full extended tape 4:00-20:00 */
      const ext = nowMin < 570 || nowMin >= 960; /* Alpaca ext-hours order rules apply */
      dashStatus.session = !inSession ? "closed" : nowMin >= P.flattenMin ? "flatten" : nowMin < 570 ? "premarket" : nowMin >= 960 ? "after-hours" : "regular";
      if (!inSession) {
        /* after the extended close: record + tune exactly once */
        if (nowMin >= 1205 && nowMin < 1435 && !recorded) {
          recorded = true;
          const syms = [...new Set([...universe.map((u) => u.symbol), ...Object.keys(posMeta)])];
          if (syms.length) {
            const bars = await D.fetchBars1Min(keys, syms);
            const f = D.recordDay(bars);
            if (f) log("recorded day ->", f);
          }
          const days = D.loadRecordedDays();
          if (days.length >= 5) {
            log(`nightly tune over ${days.length} recorded days…`);
            const res = tune(days, P, 200, Date.now() % 100000);
            if (res.bestScore.valid > res.baseScore.valid) {
              saveParams(res.params);
              fs.appendFileSync(TUNE_LOG, JSON.stringify({ t: new Date().toISOString(), days: days.length, base: res.baseScore, best: res.bestScore, params: res.params }) + "\n");
              log("nightly tune improved params.json");
              journal({ kind: "tune", base: res.baseScore, best: res.bestScore });
            } else log("nightly tune: no validated improvement");
          } else log(`nightly tune skipped — only ${days.length} recorded day(s), need 5`);
        }
        await sleep(60000);
        continue;
      }

      /* refresh the scanner universe every 5 minutes */
      if (Date.now() - lastDiscover > 5 * 60000) {
        lastDiscover = Date.now();
        universe = await D.discover(keys).catch((e) => { log("discover error:", e.message); return universe; });
        dashStatus.universe = universe.length;
        log(`universe: ${universe.length} — ${universe.slice(0, 8).map((u) => u.symbol).join(",")}`);
      }

      /* session-aware flatten: market orders during RTH, marketable ext-hours
         limits otherwise (Alpaca rejects market orders off-RTH) */
      const flattenAll = async (poss, reason) => {
        for (const p of poss) {
          await broker.cancelOrders(p.symbol).catch(() => {});
          const q = Math.abs(Number(p.qty));
          const px = Number(p.current_price) || Number(p.avg_entry_price);
          try {
            if (ext) await broker.sellLimitExt(p.symbol, q, Math.max(0.01, px * 0.99));
            else await broker.sellMarket(p.symbol, q);
            journal({ kind: "exit", sym: p.symbol, reason, pnl: Number(p.unrealized_pl) });
          } catch (e) { log("flatten sell:", p.symbol, e.message); }
          cooldownUntil[p.symbol] = nowMin + P.cooldownMin;
          delete posMeta[p.symbol];
        }
      };

      /* 19:55+: flatten and stand down for the day */
      if (nowMin >= P.flattenMin) {
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

      const positions = await broker.positions().catch(() => []);
      const held = new Set(positions.map((p) => p.symbol));
      dashStatus.positions = positions.map((p) => {
        const m = posMeta[p.symbol];
        return {
          sym: p.symbol, qty: Math.abs(Number(p.qty)),
          entry: Number(p.avg_entry_price),
          price: Number(p.current_price) || Number(p.avg_entry_price),
          target: m && !m.scaled ? m.target : null,
          stop: m ? m.stop : null,
          scaled: !!(m && m.scaled), scaleOutPct: P.scaleOutPct,
          value: Number(p.market_value),
          plUsd: Number(p.unrealized_pl), plPct: Number(p.unrealized_plpc) * 100,
        };
      });
      for (const k of Object.keys(posMeta)) {
        if (!held.has(k)) { // broker closed it (stop/target hit server-side)
          journal({ kind: "exit", sym: k, reason: "bracket" });
          cooldownUntil[k] = nowMin + P.cooldownMin;
          delete posMeta[k];
        }
      }

      /* daily loss halt */
      const a = await broker.account().catch(() => null);
      if (a) sampleEquity(a.equity);
      if (a && !halted && Number(a.equity) <= dayStartEq * (1 - P.maxDailyLossPct / 100)) {
        halted = true;
        log(`daily loss limit hit (${P.maxDailyLossPct}%) — flattening, no more entries today`);
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
          const bars = barsMap[p.symbol] || [];
          if (bars.length < 5) continue;
          const qtyNow = Math.abs(Number(p.qty));
          const meta = posMeta[p.symbol] || (posMeta[p.symbol] = {
            entry: Number(p.avg_entry_price), stop: Number(p.avg_entry_price) * (1 - P.maxStopPct / 100),
            brokerStop: null, risk: Number(p.avg_entry_price) * P.minStopPct / 100,
            target: Number(p.avg_entry_price) * (1 + P.targetR * P.minStopPct / 100),
            hwm: Number(p.avg_entry_price), barsHeld: 0, qty: qtyNow, scaled: false,
          });
          meta.qty = qtyNow;
          const price = bars[bars.length - 1].c;
          const sellSome = async (q, kind, reason) => {
            await broker.cancelOrders(p.symbol).catch(() => {});
            if (ext) await broker.sellLimitExt(p.symbol, q, Math.max(0.01, price * 0.995));
            else await broker.sellMarket(p.symbol, q);
            journal({ kind, sym: p.symbol, reason, qty: q, pnl: +(((price - meta.entry) * q).toFixed(2)) });
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
          const S = prepSeries(bars, P);
          const ex = exitCheck(S, bars, bars.length - 1, meta, P);
          if (!ex) continue;
          /* a plain RTH stop at the broker's resting level fills server-side —
             everything else (trailed stops, all ext-hours exits, full targets
             when scaleOutPct=100, vwap/time) is the engine's to execute */
          if (ex.reason === "stop" && !ext && meta.brokerStop != null && meta.stop <= meta.brokerStop + 1e-9) continue;
          log(`exit ${p.symbol}: ${ex.reason}${ext ? " (ext)" : ""}`);
          try {
            await sellSome(meta.qty || qtyNow, "exit", ex.reason);
            cooldownUntil[p.symbol] = nowMin + P.cooldownMin;
            delete posMeta[p.symbol];
          } catch (e) { log("sell failed:", p.symbol, e.message); }
        }
        /* entries */
        if (!halted && nowMin >= P.entryStartMin && nowMin <= P.entryEndMin && held.size < P.maxPositions) {
          for (const u of universe) {
            if (held.has(u.symbol) || posMeta[u.symbol]) continue;
            if ((entriesToday[u.symbol] || 0) >= P.reentryLimit) continue;
            if (cooldownUntil[u.symbol] != null && nowMin < cooldownUntil[u.symbol]) continue;
            const bars = barsMap[u.symbol] || [];
            if (bars.length < 30) continue;
            const S = prepSeries(bars, P);
            const sig = signalAt(S, bars, bars.length - 1, P);
            if (!sig) continue;
            const px = bars[bars.length - 1].c;
            const eq = a ? Number(a.equity) : dayStartEq;
            let qty = Math.floor((eq * P.riskPct / 100) / sig.risk);
            qty = Math.min(qty, Math.floor((eq * P.maxNotionalPct / 100) / px));
            if (qty < 1) continue;
            const target = P.targetR > 0 ? px + P.targetR * sig.risk : null;
            log(`ENTRY${ext ? " (ext)" : ""} ${u.symbol} x${qty} @~${px.toFixed(2)} stop ${sig.stop.toFixed(2)}${target ? " target " + target.toFixed(2) : ""}`);
            try {
              if (ext) await broker.buyLimitExt(u.symbol, qty, px * 1.01); /* marketable limit; stop engine-managed off-RTH */
              else await broker.buyBracket(u.symbol, qty, sig.stop, null); /* OTO stop; the scale-out is engine-managed */
              posMeta[u.symbol] = { entry: px, stop: sig.stop, brokerStop: ext ? null : sig.stop, risk: sig.risk, target, hwm: px, barsHeld: 0, qty, scaled: false };
              entriesToday[u.symbol] = (entriesToday[u.symbol] || 0) + 1;
              journal({ kind: "entry", sym: u.symbol, qty, px, stop: sig.stop, target });
              if (Object.keys(posMeta).length >= P.maxPositions) break;
            } catch (e) { log("order rejected:", e.message); }
          }
        }
      }
    } catch (e) { log("loop error:", e.message); }
    await sleep(30000);
  }
  log("shutting down — flattening any open positions");
  await new PaperBroker(keys).closeAll().catch(() => {});
  journal({ kind: "stop" });
}

const cmd = process.argv[2] || "report";
({
  scan: cmdScan, trade: cmdTrade, backtest: cmdBacktest, tune: cmdTune, report: cmdReport,
  test: () => require("./test-engine.js"),
}[cmd] || (() => console.log("commands: trade | scan | backtest | tune | report | test")))();
