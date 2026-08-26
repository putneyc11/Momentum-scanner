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
    { sym: "GAPPY", qty: 100, entry: 4.5, price: 4.8, target: 5.2, stop: 4.2, scaleOutPct: 85, value: 480, plUsd: 30, plPct: 6.7 },
  ] } });
  const port = await listen(srv);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  ok(html.includes("Account value") && html.includes("<canvas"), "dashboard serves the equity chart page");
  ok(html.includes("Active trades") && html.includes("Planned exit") && html.includes("Stop loss"), "active-trades table ships with entry/planned-exit/stop columns");
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
