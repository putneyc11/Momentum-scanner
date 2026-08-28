/* Portfolio backtester. Replays day files minute by minute across all of a
   day's symbols on a shared timeline, so position caps, the daily loss halt
   and the 15:55 flatten behave exactly like the live loop.

   Day file shape: { date: "YYYY-MM-DD", symbols: { SYM: [bars...] } }
   Bars: {t,o,h,l,c,v,m} with m = ET minute-of-day (see lib/data.js).

   Fill model (deliberately pessimistic):
   - entries fill at the NEXT bar's open, paying slipBps
   - stops fill at the stop price minus slipBps
   - targets are resting limits: filled at the limit, no slippage
   - signal/time/flatten exits fill at the bar close minus slipBps
   - if a bar could hit both stop and target, the STOP is assumed first
   - entries are capped at MAX_BAR_PARTICIPATION of the entry bar's volume;
     an order bigger than the tape does not fill at that price */

const { prepSeries, signalAt, exitCheck, entryViable, MAX_BAR_PARTICIPATION } = require("./strategy");

/* signalFn defaults to the original Gap-and-Go signal; the ensemble passes
   each pod's own entry logic while sharing this execution model */
function runDay(day, P, equity, signalFn = signalAt) {
  const syms = Object.keys(day.symbols);
  const data = {};
  for (const s of syms) {
    const bars = day.symbols[s];
    if (!bars || bars.length < 30) continue;
    data[s] = { bars, S: prepSeries(bars, P), idx: new Map(bars.map((b, i) => [b.m, i])) };
  }
  const slip = P.slipBps / 1e4;
  const open = {};                  // sym -> position
  const trades = [];
  const entries = {};               // sym -> count today
  const cooldownUntil = {};         // sym -> minute
  const pending = {};               // sym -> signal to fill next bar
  const dayStartEq = equity;
  let halted = false;

  const closeOut = (sym, pos, price, reason, m) => {
    const px = reason === "target" ? price : price * (1 - slip);
    const pnl = (px - pos.fill) * pos.qty;
    equity += pnl;
    trades.push({
      date: day.date, sym, entryM: pos.entryM, exitM: m, reason,
      entry: pos.fill, exit: px, qty: pos.qty, pnl,
      r: pos.risk ? (px - pos.fill) / pos.risk : 0,
    });
    delete open[sym];
    cooldownUntil[sym] = m + P.cooldownMin;
  };

  for (let m = 4 * 60; m < 20 * 60; m++) { /* full extended tape 4:00-20:00 */
    /* 1) manage open positions */
    for (const sym of Object.keys(open)) {
      const d = data[sym];
      const i = d.idx.get(m);
      if (i == null) continue;
      const pos = open[sym];
      const ex = exitCheck(d.S, d.bars, i, pos, P);
      if (!ex) continue;
      if (ex.reason === "target" && P.scaleOutPct < 100 && !pos.scaled) {
        /* SCALE-OUT: bank scaleOutPct at the target; the runner keeps
           riding the trail with its stop floored at break-even */
        const sellQty = Math.min(pos.qty, Math.max(1, Math.round(pos.qty * P.scaleOutPct / 100)));
        if (sellQty >= pos.qty) { closeOut(sym, pos, ex.price, "target", m); continue; }
        const pnl = (ex.price - pos.fill) * sellQty;
        equity += pnl;
        trades.push({
          date: day.date, sym, entryM: pos.entryM, exitM: m, reason: "scale",
          entry: pos.fill, exit: ex.price, qty: sellQty, pnl,
          r: pos.risk ? (ex.price - pos.fill) / pos.risk : 0,
        });
        pos.qty -= sellQty;
        pos.scaled = true;
        pos.stop = Math.max(pos.stop, pos.fill);
        continue;
      }
      closeOut(sym, pos, ex.price != null ? ex.price : d.bars[i].c, ex.reason, m);
    }
    /* 2) daily loss halt: flatten and stop trading for the day */
    if (!halted && equity <= dayStartEq * (1 - P.maxDailyLossPct / 100)) {
      halted = true;
      for (const sym of Object.keys(open)) {
        const d = data[sym];
        const i = d.idx.get(m);
        const px = i != null ? d.bars[i].c : open[sym].fill;
        closeOut(sym, open[sym], px, "dayhalt", m);
      }
    }
    /* 3) fill entries signalled on the previous bar */
    for (const sym of Object.keys(pending)) {
      const sig = pending[sym];
      delete pending[sym];
      if (halted || open[sym] || Object.keys(open).length >= P.maxPositions) continue;
      const d = data[sym];
      const i = d.idx.get(m);
      if (i == null) continue;
      const fill = d.bars[i].o * (1 + slip);
      const risk = fill - sig.stop;
      if (!(risk > 0)) continue;
      let qty = Math.floor((equity * P.riskPct / 100) / risk);
      qty = Math.min(qty, Math.floor((equity * P.maxNotionalPct / 100) / fill));
      /* both caps above are fractions of EQUITY, which compounds without
         bound — this one is a fraction of the shares that actually traded */
      qty = Math.min(qty, Math.floor(d.bars[i].v * MAX_BAR_PARTICIPATION));
      if (qty < 1) continue; /* thin tape: the fill could not have happened */
      open[sym] = { fill, stop: sig.stop, risk, qty, hwm: fill, barsHeld: 0, entryM: m, entry: fill, scaled: false };
      entries[sym] = (entries[sym] || 0) + 1;
    }
    /* 4) scan for new signals at this bar's close */
    if (!halted && m < P.flattenMin) {
      for (const sym of Object.keys(data)) {
        if (open[sym] || pending[sym]) continue;
        if ((entries[sym] || 0) >= P.reentryLimit) continue;
        if (cooldownUntil[sym] != null && m < cooldownUntil[sym]) continue;
        const d = data[sym];
        const i = d.idx.get(m);
        if (i == null) continue;
        const sig = signalFn(d.S, d.bars, i, P);
        if (sig && entryViable(d.S, d.bars, i, P)) pending[sym] = sig;
      }
    }
  }
  /* safety net: anything not flattened by exitCheck closes on the last bar */
  for (const sym of Object.keys(open)) {
    const d = data[sym];
    closeOut(sym, open[sym], d.bars[d.bars.length - 1].c, "eod", 20 * 60);
  }
  return { equity, trades };
}

function runBacktest(days, P, startEq = 100000, signalFn = signalAt) {
  let equity = startEq;
  const trades = [];
  const curve = [equity];
  for (const day of days) {
    const r = runDay(day, P, equity, signalFn);
    equity = r.equity;
    trades.push(...r.trades);
    curve.push(equity);
  }
  return { metrics: metrics(trades, curve, startEq), trades, curve };
}

function metrics(trades, curve, startEq) {
  const end = curve[curve.length - 1];
  const netPct = ((end - startEq) / startEq) * 100;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  let peak = -Infinity, maxDD = 0;
  for (const e of curve) {
    peak = Math.max(peak, e);
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  return {
    days: curve.length - 1,
    trades: trades.length,
    netPct: +netPct.toFixed(2),
    winRate: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : 0,
    avgR: trades.length ? +(trades.reduce((a, t) => a + t.r, 0) / trades.length).toFixed(3) : 0,
    profitFactor: grossL ? +(grossW / grossL).toFixed(2) : (grossW > 0 ? Infinity : 0),
    maxDDPct: +(maxDD * 100).toFixed(2),
    endEquity: +end.toFixed(2),
  };
}

module.exports = { runDay, runBacktest, metrics };
