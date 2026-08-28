/* Unit tests for the trading engine. Zero deps: node test-engine.js
   Every mechanical guarantee the strategy relies on has a named assertion. */

const I = require("./lib/indicators");
const { DEFAULTS, RANGES, prepSeries, signalAt, exitCheck, entryViable } = require("./lib/strategy");
const { runBacktest, runDay } = require("./lib/backtest");
const { tune, score } = require("./lib/tune");
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
  const P = { ...DEFAULTS, minConfluence: 2, orbMinutes: 5, slipBps: 0, riskPct: 1, targetR: 2, vwapExit: 0, timeStopMin: 999, entryEndMin: 780, entryStartMin: 570, scaleOutPct: 100, flattenMin: 955 };
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
  const P = { ...DEFAULTS, minConfluence: 2, orbMinutes: 5, slipBps: 0, riskPct: 1, targetR: 2, vwapExit: 0, timeStopMin: 999, entryEndMin: 780, entryStartMin: 570, scaleOutPct: 85, reentryLimit: 1, flattenMin: 955 };
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
