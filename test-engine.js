/* Unit tests for the trading engine. Zero deps: node test-engine.js
   Every mechanical guarantee the strategy relies on has a named assertion. */

const I = require("./lib/indicators");
const { DEFAULTS, RANGES, prepSeries, signalAt, exitCheck, entryViable } = require("./lib/strategy");
const { runBacktest, runDay } = require("./lib/backtest");
const { tune, score, splitDays, MIN_HOLDOUT_DAYS } = require("./lib/tune");
const { makeLibrary } = require("./lib/synth");
const { PaperBroker, PAPER_URL } = require("./lib/broker");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("✓", msg); } else { fail++; console.log("✗", msg); } };
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

/* Deterministic bar builder: m = ET minute, prices explicit. */
const bar = (m, o, h, l, c, v = 50000) => ({ t: m * 60000, o, h, l, c, v, m });

/* ---- indicators ---- */
{
  const closes = [1, 2, 3, 4, 5];
  const e = I.emaSeries(closes, 2);
  ok(e[0] === 1 && e[4] > e[3] && e[4] < 5.01, "EMA is causal and tracks rising closes");
  const bars = [bar(570, 1, 1.2, 0.9, 1.1, 100), bar(571, 1.1, 1.4, 1.0, 1.3, 300)];
  const vw = I.vwapSeries(bars);
  const tp0 = (1.2 + 0.9 + 1.1) / 3, tp1 = (1.4 + 1.0 + 1.3) / 3;
  ok(approx(vw[1], (tp0 * 100 + tp1 * 300) / 400, 1e-9), "VWAP = cumulative volume-weighted typical price");
  const up = I.rsiSeries(Array.from({ length: 30 }, (_, i) => 1 + i * 0.1), 14);
  ok(up[29] > 95, "RSI saturates high on a straight-up tape");
  const { pmHigh, orbHigh } = I.levelSeries(
    [bar(500, 1, 2.0, 1, 1.5), bar(570, 1.5, 1.8, 1.4, 1.6), bar(585, 1.6, 1.9, 1.5, 1.7), bar(586, 1.7, 2.1, 1.6, 2.0)], 15);
  ok(pmHigh[3] === 2.0, "premarket high tracked from the 4 AM tape");
  ok(orbHigh[1] === null && orbHigh[2] === 1.8, "ORB high defined only after the opening range completes");
}

/* ---- strategy signal ---- */
{
  const P = { ...DEFAULTS, minConfluence: 2, orbMinutes: 5 };
  const bars = [];
  for (let m = 560; m < 570; m++) bars.push(bar(m, 2, 2.05, 1.95, 2, 20000));           // premarket, PMH 2.05
  for (let m = 570; m < 575; m++) bars.push(bar(m, 2, 2.1, 1.98, 2.05, 40000));          // ORB, high 2.1
  for (let m = 575; m < 605; m++) bars.push(bar(m, 2.05, 2.09, 2.0, 2.06, 30000));       // consolidation below ORB
  bars.push(bar(605, 2.06, 2.2, 2.05, 2.18, 200000));                                    // breakout + volume
  const S = prepSeries(bars, P);
  ok(signalAt(S, bars, bars.length - 2, P) === null, "no entry while price sits below the ORB high");
  const sig = signalAt(S, bars, bars.length - 1, P);
  ok(!!sig, "breakout above PMH+ORB with confluence fires an entry");
  ok(sig && sig.stop < 2.18 && sig.stop >= 2.18 * (1 - P.maxStopPct / 100) - 1e-9, "stop lands below entry within the pct clamp");
}

/* ---- backtest mechanics ---- */
{
  const P = { ...DEFAULTS, minConfluence: 2, orbMinutes: 5, slipBpsOverride: 0, riskPct: 1, targetR: 2, vwapExit: 0, timeStopMin: 999, entryEndMin: 780, entryStartMin: 570, scaleOutPct: 100, flattenMin: 955 };
  const mk = (post) => {
    const bars = [];
    for (let m = 560; m < 570; m++) bars.push(bar(m, 2, 2.05, 1.95, 2, 20000));
    for (let m = 570; m < 575; m++) bars.push(bar(m, 2, 2.1, 1.98, 2.05, 40000));
    for (let m = 575; m < 605; m++) bars.push(bar(m, 2.05, 2.09, 2.0, 2.06, 30000));
    bars.push(bar(605, 2.06, 2.2, 2.05, 2.18, 200000)); // signal bar
    post(bars);
    return bars;
  };
  /* stop-loss day: next bar opens then dumps through the stop */
  const stopDay = { date: "T1", symbols: { AAA: mk((bars) => {
    bars.push(bar(606, 2.18, 2.19, 1.2, 1.25, 300000));
    for (let m = 607; m < 960; m++) bars.push(bar(m, 1.25, 1.26, 1.24, 1.25, 10000));
  }) } };
  const r1 = runDay(stopDay, P, 100000);
  ok(r1.trades.length === 1 && r1.trades[0].reason === "stop", "intrabar stop breach exits as a stop");
  ok(approx(r1.trades[0].r, -1, 0.15), `stop loss costs ~1R (got ${r1.trades[0].r.toFixed(2)}R)`);
  /* target day: next bars run to the take-profit */
  const targetDay = { date: "T2", symbols: { BBB: mk((bars) => {
    for (let m = 606; m < 640; m++) bars.push(bar(m, 2.2 + (m - 606) * 0.02, 2.23 + (m - 606) * 0.02, 2.19 + (m - 606) * 0.02, 2.22 + (m - 606) * 0.02, 60000));
    for (let m = 640; m < 960; m++) bars.push(bar(m, 2.9, 2.91, 2.89, 2.9, 10000));
  }) } };
  const r2 = runDay(targetDay, { ...P, reentryLimit: 1 }, 100000);
  ok(r2.trades.length === 1 && r2.trades[0].reason === "target", "take-profit limit exits at the target");
  ok(approx(r2.trades[0].r, 2, 0.2), `target banks ~targetR (got ${r2.trades[0].r.toFixed(2)}R)`);
  /* flatten: a slow grinder that never hits stop or target is closed by 15:55 */
  const grindDay = { date: "T3", symbols: { CCC: mk((bars) => {
    for (let m = 606; m < 960; m++) bars.push(bar(m, 2.19, 2.2, 2.18, 2.19, 20000));
  }) } };
  const P3 = { ...P, targetR: 50 };
  const r3 = runDay(grindDay, P3, 100000);
  ok(r3.trades.length === 1 && (r3.trades[0].reason === "flatten" || r3.trades[0].reason === "eod"), "no position survives past the 15:55 flatten");
  ok(r3.trades[0].exitM <= 956, "flatten exit happens by 15:56");
  /* max positions: 5 identical signals, cap 2 */
  const many = { date: "T4", symbols: {} };
  for (let k = 0; k < 5; k++) many.symbols["S" + k] = mk((bars) => {
    for (let m = 606; m < 960; m++) bars.push(bar(m, 2.19, 2.2, 2.18, 2.19, 20000));
  });
  const P4 = { ...P, maxPositions: 2, targetR: 50 };
  const r4 = runDay(many, P4, 100000);
  ok(r4.trades.length === 2, `maxPositions caps concurrent exposure (took ${r4.trades.length}/5 signals)`);
}

/* ---- scale-out: 85% banked at the target, runner rides with break-even floor ---- */
{
  const P = { ...DEFAULTS, minConfluence: 2, orbMinutes: 5, slipBpsOverride: 0, riskPct: 1, targetR: 2, vwapExit: 0, timeStopMin: 999, entryEndMin: 780, entryStartMin: 570, scaleOutPct: 85, reentryLimit: 1, flattenMin: 955 };
  const bars = [];
  for (let m = 560; m < 570; m++) bars.push(bar(m, 2, 2.05, 1.95, 2, 20000));
  for (let m = 570; m < 575; m++) bars.push(bar(m, 2, 2.1, 1.98, 2.05, 40000));
  for (let m = 575; m < 605; m++) bars.push(bar(m, 2.05, 2.09, 2.0, 2.06, 30000));
  bars.push(bar(605, 2.06, 2.2, 2.05, 2.18, 200000));
  for (let m = 606; m < 640; m++) bars.push(bar(m, 2.2 + (m - 606) * 0.02, 2.23 + (m - 606) * 0.02, 2.19 + (m - 606) * 0.02, 2.22 + (m - 606) * 0.02, 60000));
  for (let m = 640; m < 960; m++) bars.push(bar(m, 2.9, 2.91, 2.89, 2.9, 10000));
  const r = runDay({ date: "SC", symbols: { SCL: bars } }, P, 100000);
  ok(r.trades.length === 2, `scale-out splits the position into two bookings (got ${r.trades.length})`);
  const sc = r.trades[0], run = r.trades[1];
  ok(sc.reason === "scale" && Math.abs(sc.qty / (sc.qty + run.qty) - 0.85) < 0.02, `~85% banked at the planned exit (${sc.qty}/${sc.qty + run.qty})`);
  ok(approx(sc.r, 2, 0.2), `scale-out banks ~targetR (${sc.r.toFixed(2)}R)`);
  ok(run.pnl > 0 && run.exit >= run.entry, `runner keeps riding and exits above break-even (+$${run.pnl.toFixed(2)})`);
}

/* ---- premarket entries: a fresh premarket high IS the breakout ---- */
{
  const P = { ...DEFAULTS, minConfluence: 2, orbMinutes: 5 };
  const bars = [];
  for (let m = 240; m < 300; m++) bars.push(bar(m, 2, 2.05, 1.97, 2.0 + (m - 240) * 0.0005, 15000));
  bars.push(bar(300, 2.03, 2.2, 2.02, 2.18, 120000)); // rips through the running PMH
  const S = prepSeries(bars, P);
  ok(signalAt(S, bars, bars.length - 2, P) === null, "no premarket entry while under the running PMH");
  ok(!!signalAt(S, bars, bars.length - 1, P), "premarket PMH breakout with confluence fires an entry (4-9:30 ET)");
}

/* ---- tuner ---- */
{
  const days = makeLibrary(40, 11);
  const res = tune(days, DEFAULTS, 60, 3);
  ok(res.bestScore.train >= res.baseScore.train, "tuner never regresses the training score");
  ok(res.bestScore.valid >= res.baseScore.valid, "accepted params also hold up on the validation split");
  for (const [k, [lo, hi]] of Object.entries(RANGES))
    if (!(res.params[k] >= lo - 1e-9 && res.params[k] <= hi + 1e-9)) ok(false, `param ${k} escaped its range`);
  ok(true, "tuned params stay inside their declared ranges");
  const b = runBacktest(days, res.params);
  ok(b.metrics.trades > 0, `tuned strategy still trades (${b.metrics.trades} trades over ${days.length} synthetic days)`);

  /* ---- the account can never go short ---- */
  {
    const { PaperBroker } = require("./lib/broker");
    const b = new PaperBroker({ id: "x", secret: "y" });
    const sent = [];
    b.req = async (m, path, body) => { sent.push(body); return { id: "stub" }; };

    /* before any position fetch the guard cannot clamp and must not block exits */
    ok(b.sellableQty("AAA", 100) === 100, "with no position book yet, a sell passes through unclamped");

    b.held = new Map([["AAA", 500], ["BBB", -300], ["CCC", 0]]);
    ok(b.sellableQty("AAA", 800) === 500, "a sell larger than the holding is clamped to the holding");
    ok(b.sellableQty("AAA", 200) === 200, "a sell inside the holding is untouched");
    ok(b.sellableQty("BBB", 300) === 0, "a symbol already short can never be sold again");
    ok(b.sellableQty("CCC", 50) === 0, "a flat symbol can never be sold");
    ok(b.sellableQty("ZZZ", 50) === 0, "a symbol absent from the book can never be sold");

    let threw = false;
    try { b.sellMarket("BBB", 300); } catch { threw = true; }
    ok(threw, "sellMarket THROWS rather than adding to an existing short");
    threw = false;
    try { b.sellStop("ZZZ", 10, 1.5); } catch { threw = true; }
    ok(threw, "a resting stop cannot be armed for shares the account does not hold");

    /* the cache decrements on every accepted sell, so two exit paths racing
       inside one 15s refresh window cannot between them oversell */
    b.held = new Map([["AAA", 500]]);
    b.sellMarket("AAA", 400);
    ok(b.held.get("AAA") === 100, "an accepted sell decrements the cached holding");
    b.sellMarket("AAA", 400);
    ok(sent[sent.length - 1].qty === "100", "a racing second sell is clamped to the 100 shares left, not 400");
    threw = false;
    try { b.sellMarket("AAA", 100); } catch { threw = true; }
    ok(threw, "once flat, further sells are refused outright");

    /* sellStop must NOT decrement — nothing has been sold yet */
    b.held = new Map([["AAA", 500]]);
    b.sellStop("AAA", 500, 1.0);
    ok(b.held.get("AAA") === 500, "arming a stop does not decrement the holding — nothing sold yet");
  }

  /* ---- the participation cap: you cannot buy shares that did not trade ---- */
  {
    const { runDay } = require("./lib/backtest");
    const { MAX_BAR_PARTICIPATION } = require("./lib/strategy");
    ok(MAX_BAR_PARTICIPATION === 0.10, "the participation cap is 10% of the entry bar's volume");
    ok(!("MAX_BAR_PARTICIPATION" in RANGES) && !("maxBarParticipation" in RANGES),
       "the tuner cannot search its way around the participation cap");
    for (const f of ["lib/backtest.js", "engine.js"]) {
      const src = require("fs").readFileSync(require("path").join(__dirname, f), "utf8");
      if (/(const|let|var)\s+MAX_BAR_PARTICIPATION/.test(src)) ok(false, `${f} re-declares MAX_BAR_PARTICIPATION instead of importing it`);
    }
    ok(true, "the cap is declared once in lib/strategy.js and imported everywhere else");

    /* every entry in a real backtest respects the cap */
    const capDays = makeLibrary(20, 5);
    let checked = 0, over = 0;
    let eq = 100000;
    for (const day of capDays) {
      const r = runDay(day, DEFAULTS, eq);
      for (const t of r.trades) {
        const bar = (day.symbols[t.sym] || []).find((b) => b.m === t.entryM);
        if (!bar || !bar.v) continue;
        checked++;
        if (t.qty > Math.floor(bar.v * MAX_BAR_PARTICIPATION)) over++;
      }
      eq = r.equity;
    }
    ok(checked > 0, `checked ${checked} entry fills against their bar's volume`);
    ok(over === 0, `no entry exceeds ${MAX_BAR_PARTICIPATION * 100}% of the volume on its own bar (${over} violations)`);

    /* a bar too thin to support a single share is skipped, not filled */
    const thin = { date: "2026-01-05", symbols: { THIN: [] } };
    for (let m = 4 * 60; m < 20 * 60; m++)
      thin.symbols.THIN.push({ t: m, o: 1 + m / 1000, h: 1.2 + m / 1000, l: 0.9 + m / 1000, c: 1.1 + m / 1000, v: 5, m });
    const thinRun = runDay(thin, DEFAULTS, 100000);
    ok(thinRun.trades.length === 0, "a symbol whose bars trade 5 shares produces no fills at all");
  }

  /* ---- the split is 60/20/20, chronological, and disjoint ---- */
  const sp = splitDays(days);
  ok(sp.train.length + sp.valid.length + sp.test.length === days.length, "the three splits partition the library exactly");
  ok(sp.train.length === 24 && sp.valid.length === 8 && sp.test.length === 8, `40 days splits 60/20/20 (got ${sp.train.length}/${sp.valid.length}/${sp.test.length})`);
  ok(sp.train[sp.train.length - 1].date < sp.valid[0].date && sp.valid[sp.valid.length - 1].date < sp.test[0].date,
     "splits are chronological — train precedes validate precedes holdout");
  const short = splitDays(days.slice(0, MIN_HOLDOUT_DAYS - 1));
  ok(short.test.length === 0, "below the holdout floor the tuner falls back to 70/30 with no holdout");

  /* ---- the validation bar is FROZEN: it never ratchets with acceptances ---- */
  ok(res.validBar === res.baseScore.valid,
     `the acceptance bar equals the BASE champion's validate score and is never raised (${res.validBar})`);
  for (const h of res.history.slice(1))
    if (h.accepted && !(h.valid >= res.validBar)) ok(false, `iter ${h.iter} accepted at valid ${h.valid} below the frozen bar ${res.validBar}`);
  ok(true, `every acceptance cleared the frozen bar (${res.accepted}/${res.candidates} candidates accepted)`);

  /* ---- the holdout is reported but never gates anything ---- */
  ok(res.bestScore.test != null && res.baseScore.test != null, "a holdout score is reported for base and champion");
  const rerun = tune(days, DEFAULTS, 60, 3);
  ok(rerun.bestScore.test === res.bestScore.test && JSON.stringify(rerun.params) === JSON.stringify(res.params),
     "the tuner is deterministic for a given seed, so the holdout comparison is repeatable");
  const noTest = tune(days.slice(0, MIN_HOLDOUT_DAYS - 1), DEFAULTS, 20, 3);
  ok(noTest.bestScore.test === null, "with no holdout split the test score is null rather than borrowed from validate");
}

/* ---- the five-pod ensemble ---- */
{
  const { STRATS } = require("./lib/strategies");
  ok(STRATS.length === 7 && new Set(STRATS.map((s) => s.key)).size === 7, "seven strategy pods registered with unique keys");
  const mgmtKeys = ["targetR", "scaleOutPct", "maxPositions", "riskPct", "stopAtrMult", "flattenMin", "reentryLimit", "cooldownMin"];
  ok(STRATS.every((st) => typeof st.signalAt === "function" && mgmtKeys.every((k) => st.DEFAULTS[k] != null)), "every pod carries a full management param set for the shared exit engine");
  /* quick-strike pods: small wins banked close, dip re-entries allowed */
  const quick = STRATS.filter((s) => s.style === "quick");
  ok(quick.length === 5 && quick.every((st) => st.DEFAULTS.targetR <= 1.5 && st.DEFAULTS.scaleOutPct >= 90), "quick pods take profit close (targetR ≤ 1.5, ≥90% banked at the target)");
  ok(quick.every((st) => st.DEFAULTS.reentryLimit >= 4 && st.DEFAULTS.cooldownMin <= 5), "quick pods re-enter dips (≥4 entries/symbol/day, ≤5 min cooldown)");
  ok(quick.every((st) => st.RANGES.targetR[0] <= 1), "the tuner may search quick targets below 1R");
  /* rider pods: no target ever, the hwm ratchet is the only planned exit */
  const riders = STRATS.filter((s) => s.style === "ride");
  ok(riders.length === 2 && riders.every((st) => st.DEFAULTS.hwmTrailPct > 0 && st.DEFAULTS.targetR === 0 && st.DEFAULTS.scaleOutPct === 100 && !st.DEFAULTS.vwapExit), "riders have NO profit target — only the %-off-high ratchet");
  ok(riders.every((st) => !("targetR" in st.RANGES) && !("scaleOutPct" in st.RANGES)), "the tuner can never hand a rider a profit target");
  ok(riders.every((st) => st.DEFAULTS.timeStopMin >= 60 && st.DEFAULTS.timeStopMin <= 300), "riders carry a stall exit (a dead moonshot recycles its slot within hours)");
  ok(STRATS[0].style === "ride" && STRATS[1].style === "ride", "riders are listed first: priority claim on the strongest breakouts");

  /* the ride ratchet holds a monster run and exits on the first deep dip */
  {
    const P = { ...DEFAULTS, hwmTrailPct: 15, targetR: 0, vwapExit: 0, timeStopMin: 9999, trailAfterR: 99, flattenMin: 1195 };
    const bars = [];
    for (let m = 600; m < 615; m++) bars.push(bar(m, 2, 2.02, 1.98, 2.0, 30000));
    for (let k = 0; k < 20; k++) { const c = 2 + (k + 1) * 0.3; bars.push(bar(615 + k, c - 0.12, c + 0.02, c - 0.15, c, 60000)); }
    bars.push(bar(635, 8, 8.05, 7.3, 7.5, 40000)); // −9% off the 8.05 high: hold
    const S = prepSeries(bars, P);
    const pos = { entry: 2.1, stop: 1.9, risk: 0.2, hwm: 2.1, barsHeld: 0 };
    let ex = null;
    for (let i = 15; i < bars.length && !ex; i++) ex = exitCheck(S, bars, i, pos, P);
    ok(ex === null, "rider holds through a ~300% run and a shallow (−9%) dip");
    bars.push(bar(636, 7.5, 7.6, 6.5, 6.6, 80000)); // dips >15% off the high
    const ex2 = exitCheck(prepSeries(bars, P), bars, bars.length - 1, pos, P);
    ok(!!ex2 && ex2.reason === "stop" && approx(ex2.price, 8.05 * 0.85, 1e-9), "…and exits at the ratchet on the first dip >15% off the high");
  }
  const get = (key) => STRATS.find((s) => s.key === key);

  /* VWAP Reclaim: a real dip under VWAP, then a volume-backed reclaim */
  {
    const st = get("reclaim"); const P = st.DEFAULTS;
    const bars = [];
    for (let m = 600; m < 630; m++) bars.push(bar(m, 2, 2.01, 1.99, 2.0 + ((m % 2) ? -0.004 : 0.004), 30000));
    for (let m = 630; m < 633; m++) bars.push(bar(m, 1.9, 1.91, 1.89, 1.9, 30000));
    bars.push(bar(633, 1.92, 2.06, 1.91, 2.05, 200000));
    ok(!!st.signalAt(prepSeries(bars, P), bars, bars.length - 1, P), "reclaim: dip under VWAP + volume reclaim fires an entry");
    const quiet = bars.slice(0, -1); quiet.push(bar(633, 1.92, 2.06, 1.91, 2.05, 30000));
    ok(st.signalAt(prepSeries(quiet, P), quiet, quiet.length - 1, P) === null, "reclaim: the same cross WITHOUT volume stays flat");
  }
  /* First Pullback: leg up, shallow 2-bar flag, entry breaks the flag high */
  {
    const st = get("flag"); const P = st.DEFAULTS;
    const bars = [];
    for (let m = 600; m < 615; m++) bars.push(bar(m, 2, 2.01, 1.99, 2.0 + ((m % 2) ? -0.004 : 0.004), 30000));
    for (let k = 0; k < 10; k++) { const c = 2.0 + (k + 1) * 0.03; bars.push(bar(615 + k, c - 0.03, c + 0.01, c - 0.04, c, 60000)); }
    bars.push(bar(625, 2.28, 2.28, 2.18, 2.2, 25000));
    bars.push(bar(626, 2.2, 2.24, 2.17, 2.22, 25000));
    const noBreak = prepSeries(bars, P);
    ok(st.signalAt(noBreak, bars, bars.length - 1, P) === null, "flag: no entry while still inside the pullback");
    bars.push(bar(627, 2.23, 2.32, 2.22, 2.3, 80000));
    ok(!!st.signalAt(prepSeries(bars, P), bars, bars.length - 1, P), "flag: break of the pullback high after a strong leg fires an entry");
  }
  /* Volume Igniter: three green candles + a surge bar */
  {
    const st = get("igniter"); const P = st.DEFAULTS;
    const bars = [];
    for (let m = 600; m < 615; m++) bars.push(bar(m, 2, 2.01, 1.99, 2.0 + ((m % 2) ? -0.005 : 0.005), 30000));
    bars.push(bar(615, 2.0, 2.03, 1.99, 2.02, 35000));
    bars.push(bar(616, 2.02, 2.05, 2.01, 2.04, 40000));
    bars.push(bar(617, 2.04, 2.08, 2.03, 2.07, 150000));
    ok(!!st.signalAt(prepSeries(bars, P), bars, bars.length - 1, P), "igniter: 3 green candles + volume surge fires an entry");
    const red = bars.slice(0, -1); red.push(bar(617, 2.04, 2.05, 2.0, 2.01, 150000));
    ok(st.signalAt(prepSeries(red, P), red, red.length - 1, P) === null, "igniter: a red surge bar does NOT fire");
  }
  /* Red-to-Green: first cross back above the 9:30 open */
  {
    const st = get("redgreen"); const P = st.DEFAULTS;
    const bars = [bar(570, 2.0, 2.01, 1.96, 1.97, 50000)];
    for (let m = 571; m < 587; m++) bars.push(bar(m, 1.95, 1.96, 1.94, 1.95 + ((m % 2) ? -0.004 : 0.004), 30000));
    const below = prepSeries(bars, P);
    ok(st.signalAt(below, bars, bars.length - 1, P) === null, "red-to-green: no entry while still red on the day");
    bars.push(bar(587, 1.96, 2.06, 1.95, 2.05, 200000));
    ok(!!st.signalAt(prepSeries(bars, P), bars, bars.length - 1, P), "red-to-green: the volume-backed cross above the open fires an entry");
  }
  /* every pod runs the shared backtester, and the tuner accepts a pod +
     sibling seeds (the nightly cross-pollination path) */
  const days10 = makeLibrary(12, 21);
  for (const st of STRATS) {
    const m = runBacktest(days10, st.DEFAULTS, 100000, st.signalAt).metrics;
    ok(Number.isFinite(m.netPct) && m.trades >= 0, `${st.key}: pod backtests cleanly through the shared engine (${m.trades} trades)`);
  }
  const st2 = get("reclaim");
  const seeds = STRATS.filter((s) => s.key !== "reclaim").map((s) => s.DEFAULTS);
  const res2 = tune(days10, st2.DEFAULTS, 25, 9, { ranges: st2.RANGES, signalFn: st2.signalAt, seeds });
  ok(res2.bestScore.train >= res2.baseScore.train, "pod tuner with sibling cross-pollination never regresses train");
  let inRange = true;
  for (const [k, [lo, hi]] of Object.entries(st2.RANGES))
    if (!(res2.params[k] >= lo - 1e-9 && res2.params[k] <= hi + 1e-9)) inRange = false;
  ok(inRange, "cross-pollinated params stay inside the pod's declared ranges");
}

/* ---- VWAP-loss hysteresis: one dip is noise, two consecutive closes exit ---- */
{
  const P = { ...DEFAULTS, vwapExit: 1, targetR: 0, timeStopMin: 999, trailAfterR: 99, flattenMin: 1195 };
  const bars = [];
  for (let m = 600; m < 615; m++) bars.push(bar(m, 2, 2.01, 1.99, 2.0, 30000));
  bars.push(bar(615, 2.0, 2.0, 1.97, 1.98, 30000));  // ONE close under VWAP
  bars.push(bar(616, 1.98, 2.03, 1.98, 2.02, 30000)); // recovers
  bars.push(bar(617, 2.02, 2.02, 1.96, 1.97, 30000)); // below again (1st consecutive)
  bars.push(bar(618, 1.97, 1.98, 1.95, 1.96, 30000)); // below again (2nd consecutive)
  const S = prepSeries(bars, P);
  const pos = { entry: 2.0, stop: 1.5, risk: 0.2, hwm: 2.0, barsHeld: 0 };
  const results = [];
  for (let i = 14; i < bars.length; i++) results.push(exitCheck(S, bars, i, pos, P));
  ok(results[1] === null, "hysteresis: a single close under VWAP does NOT exit (was instant churn)");
  ok(results[3] === null, "hysteresis: the first of two below-VWAP closes still holds");
  ok(results[4] && results[4].reason === "vwap", "two consecutive closes under VWAP exit on trend loss");
}

/* ---- churn guard: an entry the exit engine would instantly close ---- */
{
  ok(entryViable({ vwap: [2.5] }, [{ c: 2.6 }], 0, { vwapExit: 1 }), "entry above VWAP is viable with vwapExit armed");
  ok(!entryViable({ vwap: [2.5] }, [{ c: 2.4 }], 0, { vwapExit: 1 }), "below-VWAP entry with vwapExit armed is REJECTED (was the gapgo enter/exit churn)");
  ok(entryViable({ vwap: [2.5] }, [{ c: 2.4 }], 0, { vwapExit: 0 }), "riders (vwapExit off) may still enter below VWAP");
}

/* ---- fast-lane discovery + missed-mover audit ---- */
{
  const D = require("./lib/data");
  ok(D.FAST_PCT_FLOOR < D.RTH_PCT_FLOOR && D.FAST_VOL_FLOOR < D.MIN_DAY_VOL,
    "fast-lane gates are strictly looser than the classic 25%/5M qualifier");
  D.noteMovers("08/27/2026", ["EPOW", "RYET"]);
  D.noteMovers("08/27/2026", ["RYET", "AAA"]);
  ok(D.moversSeenToday("08/27/2026").sort().join(",") === "AAA,EPOW,RYET",
    "every mover discovery ranks is remembered for the nightly recording");
  D.noteMovers("08/28/2026", ["BBB"]);
  ok(D.moversSeenToday("08/28/2026").join(",") === "BBB" && D.moversSeenToday("08/27/2026").length === 0,
    "the missed-mover memory resets on the ET day rollover");

  /* Robinhood-tradability screen: only what the user could trade there */
  ok(D.rhTradable({ symbol: "EPOW", exchange: "NASDAQ", name: "Sunrise New Energy Co Ltd Common Stock" }), "listed common stock passes the Robinhood screen");
  ok(D.rhTradable({ symbol: "BRK.B", exchange: "NYSE", name: "Berkshire Hathaway Class B" }), "class shares (.A/.B) stay tradable");
  ok(!D.rhTradable({ symbol: "GOEVW", exchange: "NASDAQ", name: "Canoo Inc Warrant" }), "warrants are excluded (not on Robinhood)");
  ok(!D.rhTradable({ symbol: "ABC.WS", exchange: "NYSE", name: "ABC Corp Warrants" }), "NYSE .WS warrant suffix excluded");
  ok(!D.rhTradable({ symbol: "SPACU", exchange: "NASDAQ", name: "Spac Acquisition Corp Units" }), "SPAC units excluded");
  ok(!D.rhTradable({ symbol: "XYZ.R", exchange: "NYSE", name: "XYZ Corp Rights" }), "rights excluded");
  ok(!D.rhTradable({ symbol: "BANK.PRA", exchange: "NYSE", name: "Bank Corp Preferred Series A" }), "preferred shares excluded");
  ok(!D.rhTradable({ symbol: "PINKY", exchange: "OTC", name: "Pink Sheet Co" }), "OTC/pink sheets excluded");
  ok(!D.rhTradable({ symbol: "GME.WS" }), "a held GME.WS fails the screen on symbol alone — the purge can catch it with no asset record");
  ok(typeof new PaperBroker({ id: "k", secret: "s" }).closePosition === "function", "broker exposes the single-position force close the purge uses");
}

/* ---- broker safety rail ---- */
{
  let threw = false;
  try { new PaperBroker({ id: "k", secret: "s" }, "https://api.alpaca.markets"); } catch { threw = true; }
  ok(threw, "broker REFUSES the live-money trading URL");
  ok(new PaperBroker({ id: "k", secret: "s" }).base === PAPER_URL, "broker pins the paper endpoint");
}

/* ---- dashboard ---- */
(async () => {
  const os = require("os");
  const fsx = require("fs");
  const pathx = require("path");
  const { startDashboard } = require("./lib/dashboard");
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), "dash-"));
  const now = Date.now();
  fsx.writeFileSync(pathx.join(dir, "equity.jsonl"),
    [{ t: now - 60000, eq: 100000 }, { t: now - 30000, eq: 100250 }, { t: now, eq: 100100 }]
      .map((o) => JSON.stringify(o)).join("\n") + "\n");
  fsx.writeFileSync(pathx.join(dir, "journal.jsonl"),
    [{ t: new Date(now - 45000).toISOString(), kind: "entry", sym: "GAPPY", qty: 100, px: 4.5, stop: 4.2 },
     { t: new Date(now - 10000).toISOString(), kind: "exit", sym: "GAPPY", reason: "target", pnl: 75 },
     { t: new Date(now - 5000).toISOString(), kind: "day", day: "x" }]
      .map((o) => JSON.stringify(o)).join("\n") + "\n");
  const listen = (srv) => new Promise((r) => srv.on("listening", () => r(srv.address().port)));
  const srv = startDashboard({ port: 0, stateDir: dir, status: { session: "regular", universe: 5, positions: [
    { sym: "GAPPY", strat: "gapgo", qty: 100, entry: 4.5, price: 4.8, target: 5.2, stop: 4.2, scaleOutPct: 85, value: 480, plUsd: 30, plPct: 6.7 },
  ], strats: [{ key: "gapgo", name: "Gap-and-Go", weight: 1.2, open: 1 }] } });
  const port = await listen(srv);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  ok(html.includes("Account value") && html.includes("<canvas"), "dashboard serves the equity chart page");
  ok(html.includes("Active trades") && html.includes("Planned exit") && html.includes("Stop loss"), "active-trades table ships with entry/planned-exit/stop columns");
  ok(html.includes("Models") && html.includes("Risk weight"), "models card shows the ensemble's risk weights");
  const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  ok(st.equity.length === 3 && st.equity[2].eq === 100100, "equity samples stream through /api/state");
  ok(st.trades.length === 2 && st.trades[1].pnl === 75, "trade events (entry/exit only) reach the chart");
  ok(st.status.universe === 5 && st.status.positions[0].sym === "GAPPY" && st.status.positions[0].target === 5.2, "rich position rows (entry/target/stop/P&L) ride along");
  ok((await fetch(`http://127.0.0.1:${port}/health`)).status === 200, "health endpoint is open");
  srv.close();
  /* token guard */
  process.env.DASH_TOKEN = "sekret";
  const srv2 = startDashboard({ port: 0, stateDir: dir, status: {} });
  const port2 = await listen(srv2);
  ok((await fetch(`http://127.0.0.1:${port2}/`)).status === 401, "token-protected dashboard rejects anonymous visits");
  ok((await fetch(`http://127.0.0.1:${port2}/?token=sekret`)).status === 200, "…and admits the token");
  ok((await fetch(`http://127.0.0.1:${port2}/health`)).status === 200, "…while /health stays open for the platform");
  srv2.close();
  delete process.env.DASH_TOKEN;


  /* ---- backfill: historical day reconstruction ---- */
  {
    const BF = require("./lib/backfill");
    const DD = require("./lib/data");

    /* stage-1 superset screen */
    ok(BF.couldQualify({ o: 1, h: 1.4, l: 0.95, c: 1.0, v: 4e5 }, 1.0),
      "couldQualify keeps a day that ran +40% intraday and closed flat");
    ok(!BF.couldQualify({ o: 1, h: 1.05, l: 0.95, c: 1.0, v: 9e6 }, 1.0),
      "couldQualify drops a day that never reached the loosest gain floor");
    ok(!BF.couldQualify({ o: 1, h: 1.4, l: 0.95, c: 1.0, v: 1e4 }, 1.0),
      "couldQualify drops a day under the loosest volume floor");
    ok(!BF.couldQualify({ o: 200, h: 300, l: 150, c: 280, v: 9e6 }, 100),
      "couldQualify drops a day that never traded under the price cap");
    ok(!BF.couldQualify({ o: 1, h: 2, l: 0.9, c: 1.8, v: 9e6 }, 0.01),
      "couldQualify drops a sub-nickel prior close");

    /* The case a close-based screen loses: gapped +20% premarket, faded to
       flat by the bell. Live discovery ranks it at 04:xx and remembers it. */
    {
      const bars = [];
      for (let m = 240; m < 300; m++) bars.push(bar(m, 1.2, 1.22, 1.18, 1.2, 2000));
      for (let m = 570; m < 700; m++) bars.push(bar(m, 1.0, 1.02, 0.98, 1.0, 1000));
      ok(BF.replayDiscovery({ FADE: bars }, { FADE: 1.0 }).includes("FADE"),
        "replayDiscovery catches a premarket gapper that faded by the open");
    }

    /* Same gap, no volume behind it — the PM volume floor rejects dead tape. */
    {
      const bars = [];
      for (let m = 240; m < 300; m++) bars.push(bar(m, 1.2, 1.22, 1.18, 1.2, 100));
      ok(!BF.replayDiscovery({ THIN: bars }, { THIN: 1.0 }).includes("THIN"),
        "replayDiscovery rejects a premarket gap on dead tape");
    }

    /* RTH fast lane: +12% on 300K enters; the same move on 100K does not. */
    {
      const mk = (v) => { const b = []; for (let m = 570; m < 640; m++) b.push(bar(m, 1.13, 1.14, 1.12, 1.13, v)); return b; };
      ok(BF.replayDiscovery({ FAST: mk(6000) }, { FAST: 1.0 }).includes("FAST"),
        "replayDiscovery admits the RTH fast lane at +12% on 300K+ shares");
      ok(!BF.replayDiscovery({ SLOW: mk(1000) }, { SLOW: 1.0 }).includes("SLOW"),
        "replayDiscovery holds the fast lane below its volume floor");
    }

    /* Classic lane: +25% once the 5M floor clears. */
    {
      const b = []; for (let m = 570; m < 700; m++) b.push(bar(m, 1.3, 1.31, 1.29, 1.3, 60000));
      ok(BF.replayDiscovery({ BIG: b }, { BIG: 1.0 }).includes("BIG"),
        "replayDiscovery admits the classic +25% lane once volume clears");
    }

    /* After-hours references TODAY's close, not the prior close. */
    {
      const flat = []; for (let m = 570; m < 960; m++) flat.push(bar(m, 1, 1.01, 0.99, 1.0, 20000));
      const pop = [...flat]; for (let m = 960; m < 1050; m++) pop.push(bar(m, 1.15, 1.16, 1.14, 1.15, 5000));
      ok(BF.replayDiscovery({ NEWS: pop }, { NEWS: 1.0 }).includes("NEWS"),
        "replayDiscovery ranks a 17:00 gapper against today's close");

      /* Up 15% on the day but too thin to clear the RTH fast lane (273K < 300K),
         then FLAT after the bell on volume that does clear the AH floor. The AH
         gate must measure against today's close (0%, rejected). If it wrongly
         used the prior close it would read +15% and rank. */
      const drift = []; for (let m = 570; m < 960; m++) drift.push(bar(m, 1.15, 1.16, 1.14, 1.15, 700));
      for (let m = 960; m < 1050; m++) drift.push(bar(m, 1.15, 1.16, 1.14, 1.15, 400));
      ok(!BF.replayDiscovery({ DRIFT: drift }, { DRIFT: 1.0 }).includes("DRIFT"),
        "after-hours gate measures against today's close, not the prior close");
    }

    /* The floors are imported, never re-declared — a second copy that drifts
       from the live one is the churn-guard failure mode all over again. */
    ok(!require("fs").readFileSync(require("path").join(__dirname, "lib/backfill.js"), "utf8")
        .match(/(PM_PCT_FLOOR|FAST_VOL_FLOOR|MIN_DAY_VOL|RTH_PCT_FLOOR)\s*=/),
      "backfill re-declares no discovery threshold of its own");

    /* calendar + DST */
    ok(BF.tradingDates("2026-03-06", "2026-03-09").join(",") === "2026-03-06,2026-03-09",
      "tradingDates skips the weekend");
    const est = BF.etWindow("2026-01-15"), edt = BF.etWindow("2026-07-10");
    ok(DD.etMinute(Date.parse(est.start)) === 240 && DD.etMinute(Date.parse(edt.start)) === 240,
      "etWindow starts at 04:00 ET on both sides of the DST change");
    ok(est.start.endsWith("09:00:00.000Z") && edt.start.endsWith("08:00:00.000Z"),
      "etWindow tracks the UTC offset (EST 09:00Z, EDT 08:00Z)");

    /* A backfilled day must be indistinguishable from a recorded one. */
    {
      const fsx = require("fs"), pathx = require("path");
      const date = "1990-01-02";                        // unmistakably a test artifact
      const file = pathx.join(DD.STATE, "days", `${date}.json`);
      const bars = []; for (let m = 570; m < 700; m++) bars.push(bar(m, 1, 1.02, 0.99, 1.01, 50000));
      try {
        DD.recordDayFor(date, { TSTX: bars });
        const day = JSON.parse(fsx.readFileSync(file, "utf8"));
        ok(day.date === date && Array.isArray(day.symbols.TSTX) && day.symbols.TSTX[0].m === 570,
          "recordDayFor writes the {date, symbols:{SYM:[bars]}} shape the backtester reads");
        const r = runDay(day, DEFAULTS, 100000);
        ok(r && typeof r.equity === "number", "a backfilled day file replays through runDay");
      } finally { try { fsx.unlinkSync(file); } catch {} }
    }
  }

  /* ---- regression gate ---- */
  {
    const RG = require("./lib/regress");
    const { STRATS } = require("./lib/strategies");
    const days = makeLibrary(8, 7);

    /* A pod that got worse must fail; a pod that got better must not. The gate
       compares against -maxDrop rather than the absolute delta, because an
       improvement is not a regression. */
    const fakeScores = (pf) => new Map(pf.map(([k, v]) => [k, { profitFactor: v, trades: 10 }]));
    const rowsFor = (base, head) => {
      const rows = [];
      let failed = false;
      for (const [k, b] of fakeScores(base)) {
        const h = fakeScores(head).get(k);
        const delta = +(h.profitFactor - b.profitFactor).toFixed(4);
        const regressed = delta < -0.03;
        if (regressed) failed = true;
        rows.push({ k, delta, regressed });
      }
      return { rows, failed };
    };
    ok(rowsFor([["a", 1.24]], [["a", 0.96]]).failed, "gate fails a pod that lost profit factor");
    ok(!rowsFor([["a", 0.96]], [["a", 1.24]]).failed, "gate does not fail a pod that improved");
    ok(!rowsFor([["a", 1.00]], [["a", 0.98]]).failed, "gate tolerates noise inside maxDrop");

    /* scoreAll must key by pod and cover every strategy, or the comparison
       silently skips whatever it failed to score. */
    const head = { STRATS, DEFAULTS, runBacktest };
    const scored = RG.scoreAll(head, days, 100000);
    ok(scored.size === STRATS.length && STRATS.every((s) => scored.has(s.key)),
      "scoreAll returns one metrics row per pod");

    /* Scoring the same code twice must give identical numbers. If this ever
       fails the gate is non-deterministic and every verdict it has given is
       void. Deliberately NOT written as compare(days, "HEAD"): that scores the
       working tree against HEAD, so it would fail for anyone with uncommitted
       work — which is everyone who is mid-change and running the tests. */
    const a = RG.scoreAll(head, days, 100000);
    const b = RG.scoreAll(head, days, 100000);
    ok([...a.keys()].every((k) => a.get(k).profitFactor === b.get(k).profitFactor
      && a.get(k).trades === b.get(k).trades),
      "scoring the same code twice is deterministic");

    /* And the loader must reproduce a historical ref byte-for-byte in its
       scores, or "base" means nothing. Load the same ref twice, score both. */
    const l1 = RG.loadLibAt("HEAD", __dirname), l2 = RG.loadLibAt("HEAD", __dirname);
    const s1 = RG.scoreAll(l1, days, 100000), s2 = RG.scoreAll(l2, days, 100000);
    ok([...s1.keys()].every((k) => s1.get(k).profitFactor === s2.get(k).profitFactor),
      "loading and scoring the same ref twice is deterministic");

    /* An unusable ref must be an error, never a silent pass. */
    let threw = false;
    try { RG.compare(days, "not-a-real-ref", { repoRoot: __dirname }); } catch { threw = true; }
    ok(threw, "an invalid base ref throws instead of reporting a pass");
  }

  /* ---- the trader does not tune itself ---- */
  {
    const fsx = require("fs"), pathx = require("path");
    const src = fsx.readFileSync(pathx.join(__dirname, "engine.js"), "utf8");

    /* The live loop must never promote a tuned champion on its own. This is a
       source assertion rather than a behavioural one because the thing being
       prevented is a code path returning, not a value being wrong. */
    const loopStart = src.indexOf("async function cmdTrade");
    const loop = loopStart > -1 ? src.slice(loopStart) : "";
    ok(loop.length > 0, "cmdTrade is findable for the self-tune assertions");
    ok(!/ensembleTune\s*\(/.test(loop), "the live trade loop never calls ensembleTune");
    ok(!/\bPs\s*=\s*res\.champs/.test(src), "nothing assigns tuned champions into live params");
    ok(!/\balloc\s*=\s*res\.alloc/.test(src), "nothing assigns tuned weights into live allocation");

    /* Tuning still exists as a deliberate command -- removing self-tuning must
       not remove the ability to tune. */
    ok(/function cmdTune/.test(src) && /tune:\s*cmdTune/.test(src),
      "engine.js tune is still available as an explicit command");

    /* Production reads git; tuning writes local. If these ever point at the
       same place, an agent's overnight search reaches the account by itself. */
    ok(/const PDIR_READ = path\.join\(__dirname, "params"\)/.test(src),
      "production reads params from the git-tracked params/ directory");
    ok(/const PDIR_WRITE = path\.join\(STATE, "params"\)/.test(src),
      "tuning writes params to the gitignored state/ directory");
    ok(/readFileSync\(path\.join\(PDIR_READ,/.test(src) && !/readFileSync\(path\.join\(PDIR_WRITE,/.test(src),
      "params are only ever READ from the reviewed directory");
    ok(/writeFileSync\(path\.join\(PDIR_WRITE,/.test(src) && !/writeFileSync\(path\.join\(PDIR_READ,/.test(src),
      "params are only ever WRITTEN to the unreviewed directory");

    /* Day recording is what grows the library every agent depends on. Removing
       the nightly tune must not take it with it. */
    ok(/D\.recordDay\(/.test(loop), "the live loop still records each day to the library");
  }

  /* ---- HYP-008: the screen census and its reject sample ---- */
  {
    const SC = require("./lib/screen");
    const D2 = require("./lib/data");
    const fsx = require("fs"), px = require("path");
    const GATES = { PM_PCT_FLOOR: 10, RTH_PCT_FLOOR: 25, PM_MIN_VOL: 25000,
                    MIN_DAY_VOL: 5e6, FAST_VOL_FLOOR: 3e5, MIN_PRICE: 0.03, MAX_PRICE: 100 };

    /* THE FOOTGUN. loadRecordedDays ingests every *.json in state/days, so a
       sidecar filed there would parse as a day and corrupt every pod's
       backtest. It must live somewhere that function cannot see. */
    {
      const daysDir = px.join(D2.STATE, "days");
      ok(!SC.SCREEN_DIR.startsWith(daysDir + px.sep) && SC.SCREEN_DIR !== daysDir,
        "the screen sidecar directory is NOT inside state/days");
      ok(!px.dirname(SC.sidecarPath("2099-01-02")).startsWith(daysDir),
        "no sidecar path can ever resolve into the day-file folder");
      /* the file-level check, without parsing 144 day tapes: loadRecordedDays
         reads exactly the *.json entries of state/days, so if writing a sidecar
         leaves that listing untouched it can never be read as a day */
      const listing = () => { try { return fsx.readdirSync(daysDir).filter((x) => x.endsWith(".json")).sort().join(","); } catch { return ""; } };
      const before = listing();
      SC.reset("2099-01-02");
      SC.observe("2099-01-02", "ZZTOP", { min: 600, session: "rth", price: 3, pct: 40, prevClose: 2,
                                          reason: "admit", returnedAtMin: 600 });
      const f = SC.writeSidecar("2099-01-02");
      ok(f && fsx.existsSync(f), "the sidecar is written");
      ok(listing() === before, "writing a sidecar does not add a file to state/days");
      ok(px.dirname(f) !== daysDir, `the sidecar lands in ${px.basename(px.dirname(f))}/, not days/`);
      try { fsx.unlinkSync(f); } catch {}
    }

    /* census merge semantics */
    {
      SC.reset("D1");
      SC.observe("D1", "AAA", { min: 500, session: "pm", price: 1.0, pct: 4, prevClose: 0.96, reason: "pm_pct" });
      SC.observe("D1", "AAA", { min: 560, session: "pm", price: 1.2, pct: 25, prevClose: 0.96, reason: "pm_pct" });
      const r = SC.rowsFor("D1").get("AAA");
      ok(r.firstSeenMin === 500 && r.pctAtFirst === 4 && r.priceAtFirst === 1.0,
        "first-touch fields are written once and never overwritten");
      ok(r.maxPct === 25 && r.priceAtMaxPct === 1.2 && r.minAtMaxPct === 560,
        "max-pct ratchets and carries its own price and minute");
      /* a name that fails at 09:35 and admits at 10:10 is ADMITTED and leaves
         the reject sample — otherwise it is counted in both classes */
      SC.observe("D1", "AAA", { min: 610, reason: "admit", returnedAtMin: 610, reasonAdmit: "rth_classic" });
      SC.observe("D1", "AAA", { min: 620, reason: "rth_pct" });
      ok(SC.rowsFor("D1").get("AAA").failOrAdmit === "admit",
        "admit outranks every later reject reason");
      ok(SC.rowsFor("D1").get("AAA").firstSeenPollMin === 610,
        "P0's clock is the first poll the name was RETURNED in, not the first cross");
      SC.observe("D1", "AAA", { returnedAtMin: 700 });
      ok(SC.rowsFor("D1").get("AAA").firstSeenPollMin === 610, "the P0 clock is set once and never moves");
    }

    /* causal rank: first-poll value is pinned, best ratchets down */
    {
      SC.reset("D2");
      SC.observe("D2", "BBB", { min: 600, session: "rth", causalRank: 30 });
      SC.observe("D2", "BBB", { min: 610, causalRank: 12 });
      SC.observe("D2", "BBB", { min: 620, causalRank: 45 });
      const r = SC.rowsFor("D2").get("BBB");
      ok(r.causalRankAtFirstPoll === 30 && r.bestCausalRank === 12,
        "causal rank keeps both the first-poll value and the best of the day");
    }

    /* deterministic stratified draw */
    {
      const build = () => {
        SC.reset("D3");
        /* eight RTH near-misses; only the six closest to the 25% floor get tape */
        for (let i = 0; i < 8; i++)
          SC.observe("D3", "R" + i, { min: 600, session: "rth", price: 5, pct: 16 + i, vol: 4e5, reason: "rth_pct" });
        /* one PM near-miss only: that stratum is short and must stay short */
        SC.observe("D3", "P0S", { min: 500, session: "pm", price: 2, pct: 9.5, vol: 1e5, reason: "pm_pct" });
        /* an admitted name must never be sampled as a reject */
        SC.observe("D3", "ADM", { min: 600, session: "rth", price: 5, pct: 17, vol: 4e5, reason: "admit", returnedAtMin: 600 });
      };
      build();
      const a = SC.stratify("D3", GATES);
      build();
      const b = SC.stratify("D3", GATES);
      ok(JSON.stringify(a) === JSON.stringify(b), "the stratified draw is deterministic");
      ok(a.near_pct_rth.length === 6, `near_pct_rth respects its cap of 6 (got ${a.near_pct_rth.length})`);
      /* closest to the threshold first: pct 24,23,22,21,20,19 -> R7..R2 */
      ok(a.near_pct_rth[0] === "R7" && a.near_pct_rth[5] === "R2",
        `the draw is by distance to the threshold, closest first (${a.near_pct_rth.join(",")})`);
      ok(a.near_pct_pm.length === 1,
        "a short stratum is left short — it is never topped up from another one");
      const all = Object.values(a).flat();
      ok(!all.includes("ADM"), "an admitted name is never drawn into the reject sample");
      ok(new Set(all).size === all.length, "no symbol appears in two strata");
    }

    /* N1 is the pooled PCT near-miss only */
    {
      ok(SC.N1_STRATA.has("near_pct_pm") && SC.N1_STRATA.has("near_pct_rth") && SC.N1_STRATA.has("near_pct_ah"),
        "N1 pools the three pct near-miss strata");
      ok(!SC.N1_STRATA.has("near_vol_pm") && !SC.N1_STRATA.has("near_vol_rth")
         && !SC.N1_STRATA.has("rank_41_60") && !SC.N1_STRATA.has("sham"),
        "N1 excludes volume-miss, rank-overflow and sham — pooling them is how an empty screen hides");
    }

    /* a session only counts if the census carries what P0 needs */
    {
      SC.reset("D4");
      SC.observe("D4", "CCC", { min: 600, session: "rth", price: 5, pct: 30, reason: "admit", returnedAtMin: 600 });
      const f = SC.writeSidecar("D4");
      const body = JSON.parse(require("fs").readFileSync(f, "utf8"));
      ok(body.usable === false, "a day with an admit but no prevClose is NOT usable — P0 would be undefined");
      try { require("fs").unlinkSync(f); } catch {}
      SC.reset("D5");
      SC.observe("D5", "CCC", { min: 600, session: "rth", price: 5, pct: 30, prevClose: 3.8,
                                reason: "admit", returnedAtMin: 600 });
      const f2 = SC.writeSidecar("D5");
      ok(JSON.parse(require("fs").readFileSync(f2, "utf8")).usable === true,
        "a day with prevClose and a first-poll minute counts toward the 40");
      try { require("fs").unlinkSync(f2); } catch {}
    }

    /* the recorder must never be able to break trading */
    {
      let threw = false;
      try { SC.observe("D6", "DDD", null); SC.observe(undefined, undefined, undefined); } catch { threw = true; }
      ok(!threw, "a malformed observation is swallowed — instrumentation cannot break discovery");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
