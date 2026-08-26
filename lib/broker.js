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
  positions() { return this.req("GET", "/v2/positions"); }
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
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(qty), side: "sell", type: "market", time_in_force: "day" });
  }
  /* Extended hours (4:00-9:30 / 16:00-20:00 ET): Alpaca only accepts LIMIT
     DAY orders with extended_hours=true — no market orders, and stop orders
     do not trigger. So the engine enters with marketable limits and manages
     stops itself off the live tape during those sessions. */
  buyLimitExt(sym, qty, limit) {
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(qty), side: "buy", type: "limit", limit_price: limit.toFixed(2), time_in_force: "day", extended_hours: true });
  }
  sellLimitExt(sym, qty, limit) {
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(qty), side: "sell", type: "limit", limit_price: limit.toFixed(2), time_in_force: "day", extended_hours: true });
  }
  /* Re-armed protective stop for a runner after a scale-out (RTH only). */
  sellStop(sym, qty, stopPrice) {
    return this.req("POST", "/v2/orders", { symbol: sym, qty: String(qty), side: "sell", type: "stop", stop_price: stopPrice.toFixed(2), time_in_force: "day" });
  }
  async closeAll() {
    return this.req("DELETE", "/v2/positions?cancel_orders=true");
  }
  async cancelOrders(sym) {
    const open = await this.orders();
    for (const o of open) if (o.symbol === sym) await this.req("DELETE", `/v2/orders/${o.id}`).catch(() => {});
  }
}

module.exports = { PaperBroker, PAPER_URL };
