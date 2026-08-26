/* Unit tests for the trading engine. Zero deps: node test-engine.js
   Every mechanical guarantee the strategy relies on has a named assertion. */

const I = require("./lib/indicators");
const { DEFAULTS, RANGES, prepSeries, signalAt, exitCheck } = require("./lib/strategy");
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
  const P = { ...DEFAULTS, minConfluence: 2, orbMinutes: 5, slipBps: 0, riskPct: 1, targetR: 2, vwapExit: 0, timeStopMin: 999, entryEndMin: 780 };
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

/* ---- broker safety rail ---- */
{
  let threw = false;
  try { new PaperBroker({ id: "k", secret: "s" }, "https://api.alpaca.markets"); } catch { threw = true; }
  ok(threw, "broker REFUSES the live-money trading URL");
  ok(new PaperBroker({ id: "k", secret: "s" }).base === PAPER_URL, "broker pins the paper endpoint");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
