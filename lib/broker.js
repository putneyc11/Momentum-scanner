/* Alpaca PAPER broker adapter.

   HARD SAFETY RAIL: the trading host is pinned to paper-api.alpaca.markets.
   The constructor throws on any other URL and there is no config knob for
   it — this codebase cannot place live-money orders. Promote to live only
   by a deliberate human decision in a different codebase. */

const PAPER_URL = "https://paper-api.alpaca.markets";

class PaperBroker {
  constructor(keys, baseUrl = PAPER_URL) {
    if (baseUrl !== PAPER_URL)
      throw new Error("PaperBroker is paper-only: refusing non-paper trading URL " + baseUrl);
    this.keys = keys;
    this.base = baseUrl;
    /* symbol -> shares actually held, refreshed by positions() and decremented
       optimistically on every accepted sell. null until the first fetch. */
    this.held = null;
  }
  async req(method, p, body) {
    const r = await fetch(this.base + p, {
      method,
      headers: {
        "APCA-API-KEY-ID": this.keys.id,
        "APCA-API-SECRET-KEY": this.keys.secret,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${r.status} ${method} ${p}: ${(await r.text()).slice(0, 160)}`);
    return r.status === 204 ? null : r.json();
  }
  account() { return this.req("GET", "/v2/account"); }
  async positions() {
    const ps = await this.req("GET", "/v2/positions");
    this.held = new Map((ps || []).map((p) => [p.symbol, Number(p.qty)]));
    return ps;
  }

  /* NEVER GO SHORT — the chokepoint.

     Eleven call sites in engine.js compute a sell quantity from their own
     bookkeeping: posMeta.qty, a scale-out fraction, Math.abs() of a broker
     row. Any one of them going stale sells shares the account does not hold,
     and Alpaca happily opens a short. On 2026-08-28 that left an 11,072-share
     APPX short at 1.7x account equity, and the 19:55 flatten would have
     DOUBLED it — flattenAll took Math.abs(qty) and sold.

     Nothing in this codebase knows how to manage a short: no stop means
     anything, the exit engine reasons about highs and trails, and the loss is
     unbounded. So the only safe short size is zero, and this is enforced here
     rather than at eleven call sites that each have to stay correct forever.

     The cache is decremented on every accepted sell, so between the 15s
     position refreshes it can only ever UNDER-report what is held. Clamping
     against a low number is safe; clamping against a high one is the bug. */
  sellableQty(sym, qty) {
    const want = Math.floor(Math.abs(Number(qty) || 0));
    if (!this.held) return want; /* no book yet — cannot clamp, and refusing every exit is worse */
    const have = this.held.get(sym);
    if (have == null || have <= 0) return 0;
    return Math.min(want, Math.floor(have));
  }
  noteSold(sym, qty) {
    if (this.held && this.held.has(sym)) this.held.set(sym, Math.max(0, this.held.get(sym) - qty));
  }
  /* every sell path funnels through here */
  guardSell(sym, qty) {
    const q = this.sellableQty(sym, qty);
    if (q < 1) throw new Error(`refusing to sell ${qty} ${sym}: holding ${this.held ? (this.held.get(sym) || 0) : "?"} — this would open a short`);
    return q;
  }
  orders() { return this.req("GET", "/v2/orders?status=open"); }
  /* Market entry + attached stop (one-cancels-other style protection). */
  buyBracket(sym, qty, stopPrice, limitPrice) {
    const order = {
      symbol: sym, qty: String(qty), side: "buy", type: "market", time_in_force: "day",
      order_class: "oto",
      stop_loss: { stop_price: stopPrice.toFixed(2) },
    };
    if (limitPrice) { order.order_class = "bracket"; order.take_profit = { limit_price: limitPrice.toFixed(2) }; }
    return this.req("POST", "/v2/orders", order);
  }
  sellMarket(sym, qty) {
    const q = this.guardSell(sym, qty);
    this.noteSold(sym, q);
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(q), side: "sell", type: "market", time_in_force: "day" });
  }
  /* Extended hours (4:00-9:30 / 16:00-20:00 ET): Alpaca only accepts LIMIT
     DAY orders with extended_hours=true — no market orders, and stop orders
     do not trigger. So the engine enters with marketable limits and manages
     stops itself off the live tape during those sessions. */
  buyLimitExt(sym, qty, limit) {
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(qty), side: "buy", type: "limit", limit_price: limit.toFixed(2), time_in_force: "day", extended_hours: true });
  }
  sellLimitExt(sym, qty, limit) {
    const q = this.guardSell(sym, qty);
    this.noteSold(sym, q);
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(q), side: "sell", type: "limit", limit_price: limit.toFixed(2), time_in_force: "day", extended_hours: true });
  }
  /* Re-armed protective stop for a runner after a scale-out (RTH only). */
  sellStop(sym, qty, stopPrice) {
    /* a resting stop sized above the holding shorts the account the moment it
       triggers, so it is clamped like any other sell — but it does NOT call
       noteSold: nothing has been sold yet, and decrementing here would make
       the cache under-report a position that is still fully open. */
    const q = this.guardSell(sym, qty);
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(q), side: "sell", type: "stop", stop_price: stopPrice.toFixed(2), time_in_force: "day" });
  }
  async closeAll() {
    return this.req("DELETE", "/v2/positions?cancel_orders=true");
  }
  /* Broker-side full close of one position (market order during RTH). */
  async closePosition(sym) {
    return this.req("DELETE", `/v2/positions/${encodeURIComponent(sym)}?cancel_orders=true`);
  }
  async cancelOrders(sym) {
    const open = await this.orders();
    for (const o of open) if (o.symbol === sym) await this.req("DELETE", `/v2/orders/${o.id}`).catch(() => {});
  }
}

module.exports = { PaperBroker, PAPER_URL };
