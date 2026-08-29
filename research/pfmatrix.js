/* Four-column PF matrix (Fizz's ask, momentum-trading thread).

   Same trades, four metrics:
     recPF   dollar profit factor over FILL records  (what metrics.profitFactor reports)
     posPF   dollar profit factor after aggregating fills back to positions
     rNaive  R profit factor reading t.r straight off each record
     rWtd    R profit factor with each fill weighted by qty/positionQty
   plus rPos (position-level R) as the cross-check on the weighting, and a
   split-count-by-fill-sign column for "do losers split more than winners".

   pnl carries a qty term and r does not, so recPF/posPF and rNaive/rWtd
   are two DIFFERENT artefacts over the same records. This runs both.

   Usage: node research/pfmatrix.js <podKey>   -> one JSON line on stdout
*/
const D = require("../lib/data");
const { STRATS } = require("../lib/strategies");
const { DEFAULTS } = require("../lib/strategy");
const { runBacktest } = require("../lib/backtest");

const pf = (pairs) => {                     /* pairs: array of numbers */
  let w = 0, l = 0;
  for (const x of pairs) { if (x > 0) w += x; else l -= x; }
  return l ? +(w / l).toFixed(3) : (w > 0 ? Infinity : 0);
};
const key = (t) => `${t.date}|${t.sym}|${t.entryM}`;

const podKey = process.argv[2];
const st = STRATS.find((s) => s.key === podKey);
if (!st) { console.error("unknown pod " + podKey); process.exit(1); }

const t0 = Date.now();
const days = D.loadRecordedDays();
const loadMs = Date.now() - t0;
const t1 = Date.now();
const res = runBacktest(days, { ...DEFAULTS, ...st.DEFAULTS }, 100000, st.signalAt);
const runMs = Date.now() - t1;
const trades = res.trades || [];

/* group fills into positions */
const pos = new Map();
for (const t of trades) {
  const k = key(t);
  let p = pos.get(k);
  if (!p) { p = { qty: 0, pnl: 0, r: 0, fills: 0, pos: 0, neg: 0 }; pos.set(k, p); }
  p.qty += t.qty || 0;
  p.pnl += t.pnl || 0;
  p.fills += 1;
  if ((t.pnl || 0) > 0) p.pos += 1; else if ((t.pnl || 0) < 0) p.neg += 1;
}
/* qty-weighted R, accumulated per position */
for (const t of trades) {
  const p = pos.get(key(t));
  if (!p || !p.qty) continue;
  p.r += (t.r || 0) * ((t.qty || 0) / p.qty);
}


/* --- split-half, to separate instrument noise from real change ---
   pre/post-cap is NOT a clean stability test: the cap changes the traded set
   (positions move by up to 10%), so a metric that moves may be reporting a
   real difference. Splitting each arm's OWN days 72/72 gives a within-arm
   noise floor for each metric, against the same fill model. */
const dates = [...new Set(trades.map((t) => t.date))].sort();
const mid = Math.floor(dates.length / 2);
const firstHalf = new Set(dates.slice(0, mid));
const half = (want) => {
  const sub = trades.filter((t) => firstHalf.has(t.date) === want);
  const q = new Map();
  for (const t of sub) q.set(key(t), (q.get(key(t)) || 0) + (t.qty || 0));
  const byPos = new Map();
  for (const t of sub) byPos.set(key(t), (byPos.get(key(t)) || 0) + (t.pnl || 0));
  return {
    recPF: pf(sub.map((t) => t.pnl || 0)),
    posPF: pf([...byPos.values()]),
    rNaive: pf(sub.map((t) => t.r || 0)),
    rWtd: pf(sub.map((t) => (t.r || 0) * ((t.qty || 0) / (q.get(key(t)) || 1)))),
    n: sub.length,
  };
};

/* --- where do the extra fills come from, by position sign? ---
   pre-cap the ONLY source of a split is a scale-out at a target, which by
   construction happens on a winner. post-cap the exit cap adds a second
   source that has no such bias. */
const bySign = { win: { scale: 0, carried: 0, forced: 0 }, lose: { scale: 0, carried: 0, forced: 0 } };
for (const t of trades) {
  const p = pos.get(key(t));
  const b = p.pnl > 0 ? bySign.win : p.pnl < 0 ? bySign.lose : null;
  if (!b) continue;
  if (t.reason === "scale") b.scale += 1;
  if (t.carried > 0) b.carried += 1;
  if (t.forced) b.forced += 1;
}

const positions = [...pos.values()];
const winners = positions.filter((p) => p.pnl > 0);
const losers = positions.filter((p) => p.pnl < 0);
const avg = (a, f) => (a.length ? +(a.reduce((s, x) => s + f(x), 0) / a.length).toFixed(3) : 0);
const splitPct = (a) => (a.length ? +(100 * a.filter((p) => p.fills > 1).length / a.length).toFixed(1) : 0);

console.log(JSON.stringify({
  pod: podKey,
  fills: trades.length,
  positions: positions.length,
  netPct: res.metrics.netPct,
  maxDDPct: res.metrics.maxDDPct,
  recPF: pf(trades.map((t) => t.pnl || 0)),
  recPFmetric: res.metrics.profitFactor,
  posPF: pf(positions.map((p) => p.pnl)),
  rNaive: pf(trades.map((t) => t.r || 0)),
  rWtd: pf(trades.map((t) => (t.r || 0) * ((t.qty || 0) / (pos.get(key(t)).qty || 1)))),
  rPos: pf(positions.map((p) => p.r)),
  mixedSign: positions.filter((p) => p.pos > 0 && p.neg > 0).length,
  winPositions: winners.length,
  losePositions: losers.length,
  winFillsAvg: avg(winners, (p) => p.fills),
  loseFillsAvg: avg(losers, (p) => p.fills),
  winSplitPct: splitPct(winners),
  loseSplitPct: splitPct(losers),
  forcedFills: trades.filter((t) => t.forced).length,
  carriedFills: trades.filter((t) => t.carried > 0).length,
  h1: half(true), h2: half(false),
  bySign,
  loadMs, runMs,
}));
