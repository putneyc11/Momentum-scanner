import WebSocket from "ws";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { sessionDate, type Bar } from "@momentum/engine";
import type { Config } from "./config.js";
import { Store } from "./store.js";

export type Feed = {
  state: string;
  feed: string;
  lastEventAt: string | null;
  error: string | null;
};
export type Tick = {
  id: string;
  symbol: string;
  time: string;
  price: number;
  size: number;
};
export type Quote = {
  bid: number;
  ask: number;
  spreadBps: number;
  time: string;
};
export type Stock = {
  symbol: string;
  price: number;
  changePct: number;
  volume: number;
  relativeVolume: number;
  score: number;
  spreadBps: number | null;
  updatedAt: string;
};
export class Alpaca {
  constructor(private c: Config) {}
  async request<T>(
    pathname: string,
    params: Record<string, string> = {},
    trading = false,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    // Broker destinations are compiled constants; no client-controlled URLs or live-money endpoint.
    const base = trading
      ? "https://paper-api.alpaca.markets"
      : "https://data.alpaca.markets";
    const url = new URL(pathname, base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, {
      method,
      headers: {
        "APCA-API-KEY-ID": this.c.APCA_API_KEY_ID,
        "APCA-API-SECRET-KEY": this.c.APCA_API_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!r.ok)
      throw new Error(
        `Alpaca ${trading ? "paper broker" : "data"} returned HTTP ${r.status}${r.status === 403 ? " (check feed entitlement)" : r.status === 429 ? " (rate limit)" : ""}`,
      );
    if (r.status === 204) return undefined as T;
    return r.json() as Promise<T>;
  }
  async bars(
    symbols: string[],
    start: string,
    end?: string,
    timeframe = "1Min",
  ): Promise<Record<string, Bar[]>> {
    const result: Record<string, Bar[]> = {};
    let page = "";
    let pages = 0;
    do {
      const data = await this.request<any>("/v2/stocks/bars", {
        symbols: symbols.join(","),
        timeframe,
        start,
        ...(end ? { end } : {}),
        limit: "10000",
        adjustment: "raw",
        feed: this.c.ALPACA_DATA_FEED,
        ...(page ? { page_token: page } : {}),
      });
      for (const [s, bars] of Object.entries(data.bars ?? {}))
        result[s] = [
          ...(result[s] ?? []),
          ...(bars as any[]).map((b) => ({
            timestamp: b.t,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
          })),
        ];
      page = data.next_page_token || "";
      if (++pages >= 30 && page)
        throw new Error(
          "Historical data pagination exceeded limit; dataset not marked complete",
        );
    } while (page);
    return result;
  }
}
export class MarketFeed extends EventEmitter {
  readonly alpaca: Alpaca;
  feed: Feed;
  stocks: Stock[] = [];
  barsBySymbol = new Map<string, Bar[]>();
  trades = new Map<string, Tick[]>();
  quotes = new Map<string, Quote>();
  private socket?: WebSocket;
  private stopped = false;
  private reconnect?: NodeJS.Timeout;
  private attempts = 0;
  private symbols = new Set<string>();
  private restBusy = false;
  private persistBusy = false;
  private fallbackBusy = false;
  private seen = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private wsAuthenticated = false;
  private tickBatch: Tick[] = [];
  private flushBusy = false;
  private dirtySymbols = new Set<string>();
  private universeDate = "";
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {
    super();
    this.alpaca = new Alpaca(config);
    this.feed = {
      state: "connecting",
      feed: config.ALPACA_DATA_FEED,
      lastEventAt: null,
      error: null,
    };
  }
  async start() {
    if (!this.config.APCA_API_KEY_ID || !this.config.APCA_API_SECRET_KEY) {
      await this.setFeed({
        state: "unconfigured",
        error:
          "Add APCA_API_KEY_ID and APCA_API_SECRET_KEY in Render Environment",
      });
      return;
    }
    this.symbols = new Set(
      this.config.SEED_SYMBOLS.split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)),
    );
    await this.discover().catch((e) =>
      this.setFeed({ state: "error", error: e.message }),
    );
    this.connect();
    this.timers.push(
      setInterval(
        () => this.discover().catch((e) => this.setFeed({ error: e.message })),
        90000,
      ),
    );
    this.timers.push(
      setInterval(
        () =>
          this.refresh().catch((e) =>
            this.setFeed({ state: "error", error: e.message }),
          ),
        15000,
      ),
    );
    this.timers.push(setInterval(() => this.pollFallback(), 3000));
    this.timers.push(setInterval(() => this.persist().catch(() => {}), 2000));
    this.timers.push(setInterval(() => void this.flush(), 50));
    this.timers.push(
      setInterval(() => {
        if (
          this.feed.state === "live" &&
          this.feed.lastEventAt &&
          Date.now() - Date.parse(this.feed.lastEventAt) > 30000
        )
          void this.setFeed({
            state: "stale",
            error: "No recent prints; check market session and connection",
          });
      }, 10000),
    );
    await this.refresh();
  }
  async setFeed(change: Partial<Feed>) {
    this.feed = { ...this.feed, ...change };
    await this.store.put("feed", this.feed);
    await this.store.publish("feed", this.feed);
  }
  private connect() {
    if (this.stopped) return;
    this.wsAuthenticated = false;
    const ws = new WebSocket(
      `wss://stream.data.alpaca.markets/v2/${this.config.ALPACA_DATA_FEED}`,
      { handshakeTimeout: 10000 },
    );
    this.socket = ws;
    const authTimeout = setTimeout(() => {
      if (!this.wsAuthenticated) ws.terminate();
    }, 15000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          action: "auth",
          key: this.config.APCA_API_KEY_ID,
          secret: this.config.APCA_API_SECRET_KEY,
        }),
      ),
    );
    ws.on("message", (raw) => {
      let messages: any[];
      try {
        messages = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(messages)) return;
      for (const m of messages) {
        if (m.T === "success" && m.msg === "authenticated") {
          clearTimeout(authTimeout);
          this.attempts = 0;
          this.wsAuthenticated = true;
          ws.send(
            JSON.stringify({
              action: "subscribe",
              trades: [...this.symbols],
              quotes: [...this.symbols],
              bars: [...this.symbols],
            }),
          );
          void this.setFeed({ state: "connected", error: null });
        }
        if (m.T === "subscription")
          void this.setFeed({ state: "connected", error: null });
        if (m.T === "error") {
          const message =
            (
              {
                402: "Authentication failed: rotate or verify server keys",
                406: "Connection limit reached: stop other Alpaca streams sharing this account",
                409: "SIP subscription unavailable: verify your market-data plan",
              } as Record<number, string>
            )[m.code] || `Alpaca stream error ${m.code}`;
          void this.setFeed({ state: "error", error: message });
          ws.close();
        }
        if (m.T === "t")
          this.ingest({
            id: `${m.S}:${m.i ?? m.t}:${m.x ?? ""}`,
            symbol: m.S,
            time: m.t,
            price: m.p,
            size: m.s,
          });
        if (m.T === "q") this.ingestQuote(m.S, m.bp, m.ap, m.t);
        if (m.T === "b") {
          const bar = {
            timestamp: m.t,
            open: m.o,
            high: m.h,
            low: m.l,
            close: m.c,
            volume: m.v,
          };
          const bars = this.barsBySymbol.get(m.S) || [];
          const i = bars.findIndex((b) => b.timestamp === bar.timestamp);
          if (i >= 0) bars[i] = bar;
          else bars.push(bar);
          this.barsBySymbol.set(
            m.S,
            bars
              .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
              .slice(-3000),
          );
          this.emit("bar", m.S, bar);
        }
      }
    });
    ws.on("error", () => {
      void this.setFeed({
        state: "reconnecting",
        error: "Stream transport failed; REST fallback is active",
      });
    });
    ws.on("close", () => {
      clearTimeout(authTimeout);
      this.wsAuthenticated = false;
      if (this.stopped) return;
      const delay =
        Math.min(60000, 1000 * 2 ** Math.min(6, this.attempts++)) +
        Math.random() * 500;
      this.reconnect = setTimeout(() => this.connect(), delay);
    });
  }
  ingestQuote(symbol: string, bid: number, ask: number, time: string) {
    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask < bid ||
      !Number.isFinite(Date.parse(time)) ||
      Date.parse(time) > Date.now() + 60000
    )
      return;
    const old = this.quotes.get(symbol);
    if (old && Date.parse(old.time) > Date.parse(time)) return;
    this.quotes.set(symbol, {
      bid,
      ask,
      spreadBps: ((ask - bid) / ((ask + bid) / 2)) * 10000,
      time,
    });
    this.dirtySymbols.add(symbol);
  }
  ingest(tick: Tick) {
    if (
      !(tick.price > 0) ||
      !(tick.size > 0) ||
      !Number.isFinite(Date.parse(tick.time)) ||
      Date.parse(tick.time) > Date.now() + 60000 ||
      this.seen.has(tick.id)
    )
      return;
    this.seen.add(tick.id);
    if (this.seen.size > 100000)
      this.seen.delete(this.seen.values().next().value!);
    const tape = this.trades.get(tick.symbol) || [];
    this.trades.set(
      tick.symbol,
      [tick, ...tape]
        .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
        .slice(0, 200),
    );
    if (
      !this.feed.lastEventAt ||
      Date.parse(tick.time) >= Date.parse(this.feed.lastEventAt)
    ) {
      this.feed.lastEventAt = tick.time;
      this.feed.state = this.wsAuthenticated ? "live" : "polling";
    }
    const stock = this.stocks.find((s) => s.symbol === tick.symbol);
    if (stock && Date.parse(tick.time) >= Date.parse(stock.updatedAt)) {
      const prev = stock.price / (1 + stock.changePct / 100);
      stock.price = tick.price;
      stock.changePct = (tick.price / prev - 1) * 100;
      stock.updatedAt = tick.time;
    }
    // Late ticks appear in tape but may not rewrite a more recent candle's close.
    const bars = this.barsBySymbol.get(tick.symbol) || [];
    const stamp = Math.floor(Date.parse(tick.time) / 60000) * 60000;
    const last = bars.at(-1);
    if (last && stamp === Date.parse(last.timestamp)) {
      last.high = Math.max(last.high, tick.price);
      last.low = Math.min(last.low, tick.price);
      if (
        tape.length === 0 ||
        Date.parse(tick.time) >= Date.parse(tape[0].time)
      )
        last.close = tick.price;
      last.volume += tick.size;
    } else if (!last || stamp > Date.parse(last.timestamp))
      bars.push({
        timestamp: new Date(stamp).toISOString(),
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.size,
      });
    this.barsBySymbol.set(tick.symbol, bars.slice(-3000));
    this.dirtySymbols.add(tick.symbol);
    if (this.tickBatch.length < 5000) this.tickBatch.push(tick);
    else
      void this.setFeed({
        state: "degraded",
        error: "Stream delivery is behind; reconnect to refresh snapshots",
      });
    this.emit("tick", tick);
  }
  private async flush() {
    if (this.flushBusy || !this.tickBatch.length) return;
    this.flushBusy = true;
    const batch = this.tickBatch.splice(0, 250);
    try {
      await this.store.publishBatch(
        batch.map((data) => ({ type: "tick", data })),
      );
    } catch {
      await this.setFeed({
        state: "degraded",
        error: "Live delivery is interrupted; snapshots remain available",
      }).catch(() => {});
    } finally {
      this.flushBusy = false;
    }
  }
  async discover() {
    const r = await this.alpaca.request<any>(
      "/v1beta1/screener/stocks/movers",
      { top: "50" },
    );
    const list = (r.gainers || []).filter((v: any) =>
      /^[A-Z][A-Z0-9.\-]{0,9}$/.test(v.symbol),
    );
    const now = new Date().toISOString(),
      date = sessionDate(now),
      old = new Set(this.symbols);
    const owned = (await this.store.list<any>("intent:"))
      .filter((i) => !["closed", "cancelled", "rejected"].includes(i.state))
      .map((i) => i.symbol);
    const seeds = this.config.SEED_SYMBOLS.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s));
    const retained = this.universeDate === date ? [...this.symbols] : seeds;
    this.universeDate = date;
    // Retain owned symbols first, then today's observed universe. Remove unused upstream subscriptions too.
    this.symbols = new Set(
      [
        ...new Set([...owned, ...retained, ...list.map((m: any) => m.symbol)]),
      ].slice(0, 150),
    );
    const snapshotId = crypto.randomUUID();
    await this.store.put(`universe:${date}:${snapshotId}`, {
      id: snapshotId,
      asOf: now,
      symbols: [...this.symbols],
      source: "Alpaca movers plus configured seeds and owned positions",
    });
    for (const symbol of this.symbols)
      await this.store.insertOnce(`discovery:${date}:${symbol}`, {
        discoveredAt: now,
        universeSnapshotId: snapshotId,
      });
    const removed = [...old].filter((s) => !this.symbols.has(s));
    if (removed.length && this.wsAuthenticated)
      this.socket?.send(
        JSON.stringify({
          action: "unsubscribe",
          trades: removed,
          quotes: removed,
          bars: removed,
        }),
      );
    const added = [...this.symbols].filter((s) => !old.has(s));
    if (added.length && this.wsAuthenticated)
      this.socket?.send(
        JSON.stringify({
          action: "subscribe",
          trades: added,
          quotes: added,
          bars: added,
        }),
      );
  }
  async refresh() {
    if (this.restBusy) return;
    this.restBusy = true;
    try {
      const symbols = [...this.symbols];
      if (!symbols.length) return;
      const snaps = await this.alpaca.request<Record<string, any>>(
        "/v2/stocks/snapshots",
        { symbols: symbols.join(","), feed: this.config.ALPACA_DATA_FEED },
      );
      for (const [symbol, snapshot] of Object.entries(snaps)) {
        const q = snapshot.latestQuote;
        if (q) this.ingestQuote(symbol, q.bp, q.ap, q.t);
        const key = `discovery:${sessionDate(new Date().toISOString())}:${symbol}`;
        const discovery = await this.store.get<any>(key, null);
        if (
          discovery &&
          !discovery.previousClose &&
          snapshot.prevDailyBar?.c > 0
        )
          await this.store.put(key, {
            ...discovery,
            previousClose: snapshot.prevDailyBar.c,
          });
      }
      this.stocks = Object.entries(snaps)
        .flatMap(([symbol, s]) => {
          const t = s.latestTrade,
            prev = s.prevDailyBar?.c;
          if (!t?.p || !prev) return [];
          const change = (t.p / prev - 1) * 100;
          const rel = s.prevDailyBar?.v ? s.dailyBar?.v / s.prevDailyBar.v : 0;
          return [
            {
              symbol,
              price: t.p,
              changePct: change,
              volume: s.dailyBar?.v || 0,
              relativeVolume: rel,
              score: Math.round(
                Math.max(0, Math.min(99, 35 + change * 1.4 + rel * 8)),
              ),
              spreadBps: this.quotes.get(symbol)?.spreadBps ?? null,
              updatedAt: t.t,
            },
          ];
        })
        .sort((a, b) => b.score - a.score);
      const today = sessionDate(new Date().toISOString());
      const start = new Date(
        sessionStartSeconds(new Date().toISOString()) * 1000,
      ).toISOString();
      const map = await this.alpaca.bars(symbols, start);
      for (const [s, bars] of Object.entries(map)) {
        this.barsBySymbol.set(
          s,
          bars.filter((b) => sessionDate(b.timestamp) === today),
        );
        this.dirtySymbols.add(s);
      }
      await this.persist();
    } finally {
      this.restBusy = false;
    }
  }
  private async pollFallback() {
    if (this.fallbackBusy) return;
    if (this.wsAuthenticated && this.feed.state === "live") return;
    const symbols = [...this.symbols];
    if (!symbols.length) return;
    this.fallbackBusy = true;
    try {
      const [r, q] = await Promise.all([
        this.alpaca.request<any>("/v2/stocks/trades/latest", {
          symbols: symbols.join(","),
          feed: this.config.ALPACA_DATA_FEED,
        }),
        this.alpaca.request<any>("/v2/stocks/quotes/latest", {
          symbols: symbols.join(","),
          feed: this.config.ALPACA_DATA_FEED,
        }),
      ]);
      for (const [s, t] of Object.entries(r.trades || {}) as [string, any][])
        this.ingest({
          id: `${s}:${t.i ?? t.t}:${t.x ?? ""}`,
          symbol: s,
          time: t.t,
          price: t.p,
          size: t.s,
        });
      for (const [s, t] of Object.entries(q.quotes || {}) as [string, any][])
        this.ingestQuote(s, t.bp, t.ap, t.t);
    } catch (e: any) {
      await this.setFeed({ state: "error", error: e.message });
    } finally {
      this.fallbackBusy = false;
    }
  }
  async persist() {
    if (this.persistBusy) return;
    this.persistBusy = true;
    try {
      await this.store.put("scanner", {
        asOf: new Date().toISOString(),
        feed: this.feed,
        stocks: this.stocks,
      });
      await this.store.put("feed", this.feed);
      const symbols = [...this.dirtySymbols];
      this.dirtySymbols.clear();
      for (const s of symbols) {
        await this.store.put(`market:${s}`, {
          symbol: s,
          bars: this.barsBySymbol.get(s) || [],
          trades: this.trades.get(s) || [],
          quote: this.quotes.get(s) || null,
          feed: this.feed,
        });
      }
    } finally {
      this.persistBusy = false;
    }
  }
  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    clearTimeout(this.reconnect);
    this.socket?.close();
  }
}
export function analyze(bars: Bar[]) {
  if (!bars.length)
    return {
      score: 0,
      trend: "unavailable",
      vwap: null,
      ema8: null,
      ema21: null,
      atr: null,
      rsi: null,
      summary: "Waiting for market data.",
    };
  const ema = (period: number) => {
    let value = bars[0].close;
    for (const b of bars)
      value = (b.close * 2) / (period + 1) + value * (1 - 2 / (period + 1));
    return value;
  };
  const volume = bars.reduce((s, b) => s + b.volume, 0);
  const vwap = volume
    ? bars.reduce(
        (s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume,
        0,
      ) / volume
    : bars.at(-1)!.close;
  const e8 = ema(8),
    e21 = ema(21),
    last = bars.at(-1)!.close;
  const changes = bars
    .slice(-15)
    .map((b, i, a) => (i ? b.close - a[i - 1].close : 0));
  const up = changes.reduce((s, c) => s + Math.max(c, 0), 0),
    down = changes.reduce((s, c) => s + Math.max(-c, 0), 0);
  const rsi = down ? 100 - 100 / (1 + up / down) : up ? 100 : 50;
  const atr =
    bars
      .slice(-14)
      .reduce(
        (s, b, i, a) =>
          s +
          Math.max(
            b.high - b.low,
            Math.abs(b.high - (a[i - 1]?.close ?? b.open)),
            Math.abs(b.low - (a[i - 1]?.close ?? b.open)),
          ),
        0,
      ) / Math.min(14, bars.length);
  const score =
    (last > vwap ? 35 : 0) +
    (e8 > e21 ? 35 : 0) +
    (rsi > 45 && rsi < 75 ? 30 : 0);
  return {
    score,
    trend: score >= 70 ? "bullish" : score < 35 ? "bearish" : "mixed",
    vwap,
    ema8: e8,
    ema21: e21,
    atr,
    rsi,
    summary: `${bars.length} observed bars. Price is ${last > vwap ? "above" : "below"} VWAP; short EMA is ${e8 > e21 ? "above" : "below"} the 21-period EMA. Deterministic indicators; no predictive guarantee.`,
  };
}
export function sessionStartSeconds(timestamp: string) {
  const day = sessionDate(timestamp);
  const guess = Date.parse(`${day}T05:00:00Z`);
  const localHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(guess)),
  );
  return (guess - localHour * 3600000) / 1000;
}
export function aggregateBars(bars: Bar[], timeframe: string) {
  const seconds =
    (
      {
        "1Min": 60,
        "5Min": 300,
        "15Min": 900,
        "1Hour": 3600,
        "1Day": 86400,
      } as Record<string, number>
    )[timeframe] || 60;
  const out: any[] = [];
  for (const b of bars) {
    const time =
      timeframe === "1Day"
        ? sessionStartSeconds(b.timestamp)
        : Math.floor(Date.parse(b.timestamp) / 1000 / seconds) * seconds;
    let last = out.at(-1);
    if (last?.time === time) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else
      out.push({
        time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      });
  }
  return out;
}
