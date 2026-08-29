/* Portfolio backtester. Replays day files minute by minute across all of a
   day's symbols on a shared timeline, so position caps, the daily loss halt
   and the 15:55 flatten behave exactly like the live loop.

   Day file shape: { date: "YYYY-MM-DD", symbols: { SYM: [bars...] } }
   Bars: {t,o,h,l,c,v,m} with m = ET minute-of-day (see lib/data.js).

   Fill model (deliberately pessimistic):
   - entries fill at the NEXT bar's open, paying the slippage tier for that price
   - stops fill at the stop price minus that tier
   - targets are resting limits: filled at the limit, no slippage
   - signal/time/flatten exits fill at the bar close minus that tier
   - slippage is priced per fill, not per day: a $1 name pays 100 bps and a
     $20 name pays 20, so a pod's cost now depends on what it actually trades
   - if a bar could hit both stop and target, the STOP is assumed first
   - entries are capped at MAX_BAR_PARTICIPATION of the entry bar's volume;
     an order bigger than the tape does not fill at that price */

const { prepSeries, signalAt, exitCheck, entryViable, MAX_BAR_PARTICIPATION, MAX_FORCED_SLIP_BPS, slipBpsFor } = require("./strategy");

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
  const open = {};                  // sym -> position
  const trades = [];
  const entries = {};               // sym -> count today
  const cooldownUntil = {};         // sym -> minute
  const pending = {};               // sym -> signal to fill next bar
  const dayStartEq = equity;
  let halted = false;

  /* SELL INTO THE TAPE (HYP-005). The participation cap used to apply to
     entries only, so an exit sold the whole position at the bar's close however
     thin the bar was -- 38% of one pod's flatten exits asked for more shares
     than traded in that minute, and one asked for 23x.

     An exit is now capped at the same share of the bar an entry is. What does
     not fit stays OPEN and goes back through exitCheck on the next bar, so a
     carried remainder is a live position: it can stop out, ratchet, hit a
     target, or exit for a different reason entirely. That is what a real
     multi-bar unwind does, and it is deliberately two-sided -- the remainder
     can get a worse price OR a better one, and suppressing the better half
     would just be a differently-signed thumb on the scale. How often it
     improves is recorded rather than assumed (see `carried` below).

     `forced` is the single exception: the end-of-day residue, which cannot
     carry because there is no overnight. It fills at any size and pays
     slippage scaled by how many times the cap it demands, clamped by
     MAX_FORCED_SLIP_BPS. Every such fill is tagged so it can be reported
     apart from the rest -- it is the one place the model still fills something
     the tape may not support.

     Returns true if the position is now flat. */
  const sellInto = (sym, pos, price, reason, m, bar, forced) => {
    const barVol = bar && bar.v > 0 ? bar.v : 0;
    const capacity = Math.floor(barVol * MAX_BAR_PARTICIPATION);
    const baseBps = slipBpsFor(price, P);

    let qty, effBps, capped = false;
    if (forced) {
      qty = pos.qty;
      /* sweeping N times the available capacity costs N times the spread */
      const mult = capacity > 0 ? Math.max(1, qty / capacity) : Infinity;
      effBps = Math.min(baseBps * mult, MAX_FORCED_SLIP_BPS);
      capped = qty > capacity;
    } else {
      qty = Math.min(pos.qty, capacity);
      if (qty < 1) return false;   /* the tape could not absorb one share here */
      capped = qty < pos.qty;
      effBps = baseBps;
    }

    /* a target is a resting limit: it pays no spread, but it still cannot fill
       more shares than traded */
    const px = reason === "target" ? price : price * (1 - effBps / 1e4);
    const pnl = (px - pos.fill) * qty;
    equity += pnl;
    if (pos.exitStartM == null) { pos.exitStartM = m; pos.firstPx = px; }
    trades.push({
      date: day.date, sym, entryM: pos.entryM, exitM: m, reason,
      entry: pos.fill, exit: px, qty, pnl,
      r: pos.risk ? (px - pos.fill) / pos.risk : 0,
      capped, forced: !!forced,
      /* set only on a fill that is the remainder of an earlier attempt, with
         the price that first attempt got, so "did carrying help or hurt" is a
         measurement rather than an argument */
      carried: pos.exitStartM !== m ? m - pos.exitStartM : 0,
      firstPx: pos.exitStartM !== m ? pos.firstPx : null,
    });
    pos.qty -= qty;
    if (pos.qty < 1) {
      delete open[sym];
      cooldownUntil[sym] = m + P.cooldownMin;
      return true;
    }
    return false;
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
        /* SCALE-OUT: bank scaleOutPct at the target; the runner keeps riding
           the trail with its stop floored at break-even. The scale is a sell
           like any other and is capped by the tape, so it is measured against
           the ORIGINAL position size and banked across bars until complete —
           a resting limit that could not fill in one minute is still resting. */
        const intended = Math.max(1, Math.round(pos.qty0 * P.scaleOutPct / 100));
        const want = Math.min(pos.qty, intended - pos.scaledQty);
        if (want >= pos.qty) { sellInto(sym, pos, ex.price, "target", m, d.bars[i], false); continue; }
        const capacity = Math.floor((d.bars[i].v > 0 ? d.bars[i].v : 0) * MAX_BAR_PARTICIPATION);
        const sellQty = Math.min(want, capacity);
        if (sellQty < 1) continue;   /* no tape for it this bar; the limit rests */
        const pnl = (ex.price - pos.fill) * sellQty;
        equity += pnl;
        trades.push({
          date: day.date, sym, entryM: pos.entryM, exitM: m, reason: "scale",
          entry: pos.fill, exit: ex.price, qty: sellQty, pnl,
          r: pos.risk ? (ex.price - pos.fill) / pos.risk : 0,
          capped: sellQty < want, forced: false, carried: 0, firstPx: null,
        });
        pos.qty -= sellQty;
        pos.scaledQty += sellQty;
        if (pos.scaledQty >= intended) {
          pos.scaled = true;
          pos.stop = Math.max(pos.stop, pos.fill);
        }
        continue;
      }
      sellInto(sym, pos, ex.price != null ? ex.price : d.bars[i].c, ex.reason, m, d.bars[i], false);
    }
    /* 2) daily loss halt: stop trading and work out of everything. The unwind
       now takes as many bars as the tape allows rather than teleporting flat,
       so this keeps pushing while halted. A position with no bar at this minute
       cannot be sold at all — it used to "fill" at its own entry price. */
    if (!halted && equity <= dayStartEq * (1 - P.maxDailyLossPct / 100)) halted = true;
    if (halted) {
      for (const sym of Object.keys(open)) {
        const d = data[sym];
        const i = d.idx.get(m);
        if (i == null) continue;
        sellInto(sym, open[sym], d.bars[i].c, "dayhalt", m, d.bars[i], false);
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
      const fill = d.bars[i].o * (1 + slipBpsFor(d.bars[i].o, P) / 1e4);
      const risk = fill - sig.stop;
      if (!(risk > 0)) continue;
      let qty = Math.floor((equity * P.riskPct / 100) / risk);
      qty = Math.min(qty, Math.floor((equity * P.maxNotionalPct / 100) / fill));
      /* both caps above are fractions of EQUITY, which compounds without
         bound — this one is a fraction of the shares that actually traded */
      qty = Math.min(qty, Math.floor(d.bars[i].v * MAX_BAR_PARTICIPATION));
      if (qty < 1) continue; /* thin tape: the fill could not have happened */
      open[sym] = { fill, stop: sig.stop, risk, qty, qty0: qty, scaledQty: 0, hwm: fill,
                    barsHeld: 0, entryM: m, entry: fill, scaled: false, exitStartM: null, firstPx: null };
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
  /* THE TERMINATING BOUNDARY. Everything above can carry to the next bar; this
     cannot, because there is no next bar and no overnight. Whatever is left is
     FORCED at the last bar's close, paying slippage scaled by how far past the
     tape's capacity it reaches. These are the only fills in the model that are
     not backed by volume, they are tagged `forced`, and they are reported
     separately for exactly that reason. */
  for (const sym of Object.keys(open)) {
    const d = data[sym];
    const last = d.bars[d.bars.length - 1];
    sellInto(sym, open[sym], last.c, "eod", 20 * 60, last, true);
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
