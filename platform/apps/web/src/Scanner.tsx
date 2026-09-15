import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  ChartLineUp,
  Lightning,
  MagnifyingGlass,
  WarningCircle,
} from "@phosphor-icons/react";
import { useResource, type StreamEvent } from "./api";
import type { Bar, Mode, Scanner, SymbolDetail, TapeTrade } from "./types";
import { compact, money, number, signed, timeOnly } from "./format";
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  Metric,
  Panel,
  StateBadge,
} from "./ui";
import Chart from "./Chart";
import { applyScannerTick, qualifiesMover } from "./scanner-state";

const frames: Record<string, { label: string; seconds: number }> = {
  "1Min": { label: "1m", seconds: 60 },
  "5Min": { label: "5m", seconds: 300 },
  "15Min": { label: "15m", seconds: 900 },
  "1Hour": { label: "1h", seconds: 3600 },
  "1Day": { label: "1D", seconds: 86400 },
};
export function exchangeDayStart(timestamp: string): number {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return NaN;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const guess = Date.parse(
    `${parts.year}-${parts.month}-${parts.day}T05:00:00Z`,
  );
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(guess)),
  );
  return (guess - hour * 3600000) / 1000;
}
export function updateTickBar(
  bars: Bar[],
  trade: TapeTrade,
  timeframe: string,
): Bar[] {
  const seconds = frames[timeframe]?.seconds || 60;
  const timestamp =
    timeframe === "1Day"
      ? exchangeDayStart(trade.time)
      : Math.floor(Date.parse(trade.time) / 1000 / seconds) * seconds;
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(trade.price) ||
    trade.price <= 0
  )
    return bars;
  const last = bars.at(-1);
  if (last && timestamp < last.time) return bars;
  if (last && timestamp === last.time)
    return [
      ...bars.slice(0, -1),
      {
        ...last,
        high: Math.max(last.high, trade.price),
        low: Math.min(last.low, trade.price),
        close: trade.price,
        volume: last.volume + trade.size,
      },
    ];
  return [
    ...bars,
    {
      time: timestamp,
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.size,
    },
  ].slice(-2000);
}
export default function ScannerPage({ mode }: { mode: Mode }) {
  const r = useResource<Scanner>("/scanner?scope=tracked", 15000);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [timeframe, setTimeframe] = useState("1Min");
  const [sort, setSort] = useState("score");
  const [minimum, setMinimum] = useState(0);
  const [watchOnly, setWatchOnly] = useState(false);
  const [watch, setWatch] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("momentum-watchlist") || "[]");
    } catch {
      return [];
    }
  });
  const detail = useResource<SymbolDetail>(
    selected
      ? `/scanner/${encodeURIComponent(selected)}?timeframe=${timeframe}`
      : null,
    10000,
  );
  useEffect(() => {
    const firstMover = r.data?.stocks.find(qualifiesMover);
    if (!selected && firstMover) setSelected(firstMover.symbol);
  }, [r.data, selected]);
  useEffect(() => {
    localStorage.setItem("momentum-watchlist", JSON.stringify(watch));
  }, [watch]);
  useEffect(() => {
    const consume = (event: Event) => {
      for (const entry of (event as CustomEvent<StreamEvent[]>).detail) {
        if (entry.name === "feed") {
          const feed = entry.data as Scanner["feed"];
          if (feed?.state) {
            r.setData((previous) =>
              previous ? { ...previous, feed } : previous,
            );
            detail.setData((previous) =>
              previous ? { ...previous, feed } : previous,
            );
          }
          continue;
        }
        if (entry.name !== "tick") continue;
        const raw = entry.data as Record<string, unknown>;
        const symbol = String(raw.symbol || raw.S || "");
        const price = Number(raw.price ?? raw.p);
        const size = Number(raw.size ?? raw.s ?? 0);
        const time = String(raw.time || raw.t || "");
        if (
          !symbol ||
          !Number.isFinite(price) ||
          price <= 0 ||
          !Number.isFinite(Date.parse(time))
        )
          continue;
        const trade: TapeTrade = {
          id: String(raw.id || raw.i || `${symbol}-${time}-${price}-${size}`),
          time,
          price,
          size,
        };
        r.setData((previous) =>
          previous
            ? {
                ...previous,
                stocks: applyScannerTick(previous.stocks, symbol, price, time),
              }
            : previous,
        );
        if (symbol === selected)
          detail.setData((previous) => {
            if (!previous || previous.trades.some((t) => t.id === trade.id))
              return previous;
            return {
              ...previous,
              bars: updateTickBar(previous.bars, trade, timeframe),
              trades: [trade, ...previous.trades].slice(0, 100),
              feed: { ...previous.feed, lastEventAt: time },
            };
          });
      }
    };
    window.addEventListener("momentum-stream", consume);
    return () => window.removeEventListener("momentum-stream", consume);
  }, [selected, timeframe, r.setData, detail.setData]);
  const stocks = useMemo(
    () =>
      (r.data?.stocks || [])
        .filter(
          (s) =>
            qualifiesMover(s) &&
            s.symbol.toLowerCase().includes(query.toLowerCase()) &&
            s.relativeVolume >= minimum &&
            (!watchOnly || watch.includes(s.symbol)),
        )
        .sort((a, b) =>
          sort === "symbol"
            ? a.symbol.localeCompare(b.symbol)
            : Number(b[sort as keyof typeof b] || 0) -
              Number(a[sort as keyof typeof a] || 0),
        ),
    [r.data, query, sort, minimum, watchOnly, watch],
  );
  const stock = r.data?.stocks.find((s) => s.symbol === selected);
  const d = detail.data;
  const feed = d?.feed || r.data?.feed;
  const price = d?.trades[0]?.price || d?.bars.at(-1)?.close || stock?.price;
  const stale =
    mode !== "demo" &&
    feed?.lastEventAt &&
    Date.now() - Date.parse(feed.lastEventAt) > 30000;
  const toggleWatch = (symbol: string) =>
    setWatch((previous) =>
      previous.includes(symbol)
        ? previous.filter((s) => s !== symbol)
        : [...previous, symbol],
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MOMENTUM SCANNER</div>
          <h1>Find the move. Read the tape.</h1>
          <p>
            One shared market stream, automatic analysis, and every incoming
            trade.
          </p>
        </div>
        <div className="page-actions">
          <Badge tone={mode === "demo" ? "warning" : "neutral"}>
            {mode === "demo" ? "Illustrative scanner" : feed?.feed || "No feed"}
          </Badge>
          <button
            className="button secondary"
            disabled={r.refreshing}
            onClick={() => {
              void r.refresh();
              void detail.refresh();
            }}
          >
            <ArrowClockwise />
            Refresh
          </button>
        </div>
      </div>
      {r.error && <ErrorNotice message={r.error} retry={() => r.refresh()} />}
      {feed &&
        (feed.error ||
          stale ||
          ["disconnected", "error", "unconfigured"].includes(feed.state)) && (
          <div className="notice warning">
            <WarningCircle size={20} />
            <div>
              <strong>
                {stale ? "Market data is stale" : `Market feed: ${feed.state}`}
              </strong>
              <p>
                {feed.error ||
                  feed.reason ||
                  "Waiting for incoming market events. Displayed prices are the last recorded values."}{" "}
                Latest event: {timeOnly(feed.lastEventAt)} ET.
              </p>
            </div>
          </div>
        )}
      <div className="scanner-layout">
        <Panel
          title="Market movers"
          aside={<span className="count-label">{stocks.length}</span>}
          className="scanner-list"
        >
          <div className="scanner-filters">
            <span className="subtle">
              Daily gain &gt; +25% · vs. previous close
            </span>
            <label className="search-field">
              <MagnifyingGlass />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    /^[A-Z][A-Z0-9.\-]{0,9}$/.test(query)
                  )
                    setSelected(query);
                }}
                placeholder="Search or enter symbol"
                aria-label="Search stocks or press Enter to analyze a symbol"
              />
            </label>
            <div className="scanner-sort">
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                aria-label="Sort stocks"
              >
                <option value="score">Momentum score</option>
                <option value="changePct">Change %</option>
                <option value="relativeVolume">Relative volume</option>
                <option value="volume">Volume</option>
                <option value="symbol">Symbol A-Z</option>
              </select>
              <select
                value={minimum}
                onChange={(e) => setMinimum(Number(e.target.value))}
                aria-label="Minimum relative volume"
              >
                <option value={0}>Any RVOL</option>
                <option value={2}>RVOL ≥ 2</option>
                <option value={5}>RVOL ≥ 5</option>
                <option value={10}>RVOL ≥ 10</option>
              </select>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={watchOnly}
                onChange={(e) => setWatchOnly(e.target.checked)}
              />
              Watchlist only
            </label>
          </div>
          {r.loading ? (
            <div className="scanner-loading skeleton" />
          ) : !stocks.length ? (
            <Empty title="No matching symbols">
              No tracked symbols are up more than 25% with these filters. You
              can still enter a tracked ticker and press Enter to inspect it.
            </Empty>
          ) : (
            <div className="movers-table">
              <div className="movers-header">
                <span>Symbol</span>
                <span>Price / change</span>
                <span>Score</span>
              </div>
              {stocks.map((s) => (
                <div
                  key={s.symbol}
                  className={`mover-row ${s.symbol === selected ? "selected" : ""}`}
                >
                  <button
                    className="watch-button"
                    aria-label={`${watch.includes(s.symbol) ? "Remove" : "Add"} ${s.symbol} ${watch.includes(s.symbol) ? "from" : "to"} watchlist`}
                    aria-pressed={watch.includes(s.symbol)}
                    onClick={() => toggleWatch(s.symbol)}
                  >
                    {watch.includes(s.symbol) ? "★" : "☆"}
                  </button>
                  <button
                    className="mover-select"
                    onClick={() => setSelected(s.symbol)}
                    aria-pressed={s.symbol === selected}
                  >
                    <div>
                      <strong>{s.symbol}</strong>
                      <small>
                        {number(s.relativeVolume, 1)}× RVOL ·{" "}
                        {compact(s.volume)}
                      </small>
                    </div>
                    <div className="mover-price">
                      <strong>{money(s.price)}</strong>
                      <small
                        className={
                          s.changePct >= 0 ? "positive-text" : "negative-text"
                        }
                      >
                        {signed(s.changePct, "percent")}
                      </small>
                    </div>
                    <span className="score-value">{number(s.score, 0)}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="scanner-list-footer">
            <span className="status-dot" />
            Ranked on server · no keys in browser
          </div>
        </Panel>
        <div className="symbol-workspace">
          {!selected ? (
            <Panel title="Symbol analysis">
              <Empty title="Choose a symbol to inspect">
                The chart, technical context, and Time & Sales load
                automatically.
              </Empty>
            </Panel>
          ) : (
            <>
              <div className="symbol-heading">
                <div className="symbol-identity">
                  <span className="symbol-icon">
                    <ChartLineUp size={24} />
                  </span>
                  <div>
                    <h2>
                      {selected}
                      <button
                        className="watch-button"
                        aria-label={`${watch.includes(selected) ? "Unwatch" : "Watch"} ${selected}`}
                        onClick={() => toggleWatch(selected)}
                        aria-pressed={watch.includes(selected)}
                      >
                        {watch.includes(selected) ? "★" : "☆"}
                      </button>
                    </h2>
                    <span>Equity · USD</span>
                  </div>
                </div>
                <div className="symbol-value">
                  <strong>{money(price)}</strong>
                  <span
                    className={
                      (stock?.changePct || 0) >= 0
                        ? "positive-text"
                        : "negative-text"
                    }
                  >
                    {signed(stock?.changePct, "percent")}
                  </span>
                </div>
                <div className="symbol-feed">
                  <StateBadge state={feed?.state || "connecting"} />
                  <span>Last event {timeOnly(feed?.lastEventAt)} ET</span>
                </div>
              </div>
              {stock && !qualifiesMover(stock) && (
                <p className="scanner-note">
                  Outside the &gt; +25% mover filter. Kept open for inspection;
                  your watchlist and the worker's tracking are unchanged.
                </p>
              )}
              {detail.error && (
                <ErrorNotice
                  message={detail.error}
                  retry={() => detail.refresh()}
                />
              )}
              <div className="timeframe-row">
                <div className="segmented" aria-label="Candlestick interval">
                  {Object.entries(frames).map(([value, { label }]) => (
                    <button
                      key={value}
                      className={timeframe === value ? "selected" : ""}
                      aria-pressed={timeframe === value}
                      onClick={() => setTimeframe(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span>
                  <Lightning size={14} />
                  {detail.refreshing
                    ? "Refreshing analysis…"
                    : "Analysis loads automatically"}
                </span>
              </div>
              {detail.loading ? (
                <Loading />
              ) : d ? (
                <>
                  <Chart
                    key={`${selected}:${timeframe}`}
                    bars={d.bars}
                    title={`${selected} · price action`}
                    compact
                  />
                  <div className="scanner-detail-grid">
                    <Panel
                      title="Technical context"
                      aside={
                        <span className="subtle">
                          {frames[timeframe].label} bars
                        </span>
                      }
                    >
                      <div className="analysis-heading">
                        <Badge tone="warning">
                          {d.analysis?.trend || "Insufficient data"}
                        </Badge>
                        <span className="mono">
                          Score {number(d.analysis?.score ?? stock?.score, 0)}
                        </span>
                      </div>
                      <div className="analysis-metrics">
                        <Metric label="VWAP" value={money(d.analysis?.vwap)} />
                        <Metric
                          label="EMA 8 / 21"
                          value={`${number(d.analysis?.ema8)} / ${number(d.analysis?.ema21)}`}
                        />
                        <Metric
                          label="RSI (14)"
                          value={number(d.analysis?.rsi, 1)}
                        />
                        <Metric
                          label="ATR (14)"
                          value={money(d.analysis?.atr)}
                        />
                      </div>
                      <p className="analysis-summary">
                        {d.analysis?.summary ||
                          "More bars are needed before technical indicators can be calculated."}
                      </p>
                      <div className="quote-strip">
                        <span>
                          Bid <b>{money(d.quote?.bid)}</b>
                        </span>
                        <span>
                          Ask <b>{money(d.quote?.ask)}</b>
                        </span>
                        <span>
                          Spread <b>{number(d.quote?.spreadBps, 1)} bps</b>
                        </span>
                      </div>
                    </Panel>
                    <Panel
                      title="Time & Sales"
                      aside={
                        <span className="tape-status">
                          <span className="status-dot" />
                          {mode === "demo"
                            ? "Example prints"
                            : "Incoming trades"}
                        </span>
                      }
                    >
                      {!d.trades.length ? (
                        <Empty title="Waiting for trades">
                          This view fills from the shared market stream. Check
                          feed status if the tape stays empty.
                        </Empty>
                      ) : (
                        <div className="tape-scroll">
                          <table className="tape-table">
                            <thead>
                              <tr>
                                <th>Time · ET</th>
                                <th className="numeric">Price</th>
                                <th className="numeric">Size</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.trades.slice(0, 50).map((t, i) => (
                                <tr key={t.id}>
                                  <td className="mono muted">
                                    {timeOnly(t.time)}
                                  </td>
                                  <td
                                    className={`numeric mono ${i < d.trades.length - 1 ? (t.price >= d.trades[i + 1].price ? "positive-text" : "negative-text") : ""}`}
                                  >
                                    {money(t.price)}
                                  </td>
                                  <td className="numeric mono">
                                    {number(t.size, 0)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </Panel>
                  </div>
                  <p className="scanner-note">
                    <ArrowRight size={14} /> Price moves reflect received
                    trades. A quiet market or limited exchange feed can produce
                    gaps; the interface never manufactures ticks.
                  </p>
                </>
              ) : (
                <Panel title="Symbol data">
                  <Empty title="No response available">
                    Retry the request or inspect the server connection.
                  </Empty>
                </Panel>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
