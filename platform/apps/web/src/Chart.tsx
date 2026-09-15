import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  CaretLeft,
  CaretRight,
} from "@phosphor-icons/react";
import type { Bar, EquityPoint, Trade } from "./types";
import { money, number, timeOnly, easternDate } from "./format";
import {
  chartRanges,
  clampViewport,
  followViewport,
  hoverIndex,
  rangeViewport,
  updateViewport,
  zoomViewport,
  type FollowMode,
} from "./chartViewport";
export { chartWindow, clampWindow } from "./chartViewport";
export default function Chart({
  points = [],
  bars = [],
  trades = [],
  onTrade,
  title = "Equity curve",
  compact = false,
}: {
  points?: EquityPoint[];
  bars?: Bar[];
  trades?: Trade[];
  onTrade?: (trade: Trade) => void;
  title?: string;
  compact?: boolean;
}) {
  const candles = bars.length > 0;
  const data = useMemo(
    () =>
      candles
        ? bars.map((b) => ({
            time: b.time * 1000,
            value: b.close,
            low: b.low,
            high: b.high,
            drawdown: 0,
            bar: b,
          }))
        : points.map((p) => ({
            time: new Date(p.time).getTime(),
            value: p.equity,
            low: p.equity,
            high: p.equity,
            drawdown: p.drawdown,
            bar: null,
          })),
    [points, bars, candles],
  );
  const [range, setRange] = useState("1D");
  const [view, setView] = useState<[number, number]>(() =>
    rangeViewport(
      data.map((p) => p.time),
      "1D",
    ),
  );
  const [followMode, setFollowMode] = useState<FollowMode>("range");
  const [hover, setHover] = useState<number | null>(null);
  const [showDrawdown, setShowDrawdown] = useState(false);
  const [showTrades, setShowTrades] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dateError, setDateError] = useState("");
  const drag = useRef<{ x: number; view: [number, number] } | null>(null);
  const root = useRef<SVGSVGElement>(null);
  const [chartWidth, setChartWidth] = useState(900);
  const uid = useId().replaceAll(":", "");
  const priorTimes = useRef<number[]>([]);
  useEffect(() => {
    const times = data.map((p) => p.time);
    const previous = priorTimes.current;
    const changed =
      times.length !== previous.length ||
      times[0] !== previous[0] ||
      times.at(-1) !== previous.at(-1);
    if (changed && times.length)
      setView((current) =>
        updateViewport(current, previous, times, followMode, range),
      );
    if (changed) setHover(null);
    priorTimes.current = times;
  }, [data, range, followMode]);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () =>
      setChartWidth(Math.max(320, el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data.length > 0]);
  const selectRange = (r: string) => {
    setRange(r);
    setFollowMode("range");
    setHover(null);
    setFrom("");
    setTo("");
    setDateError("");
    setView(
      rangeViewport(
        data.map((p) => p.time),
        r,
      ),
    );
  };
  const W = chartWidth,
    H = compact ? 300 : 330,
    L = 12,
    R = 84,
    T = 22,
    B = 32,
    PW = W - L - R,
    PH = H - T - B;
  const visible = data.slice(
    Math.max(0, Math.floor(view[0])),
    Math.ceil(view[1]) + 1,
  );
  const lo = visible.length ? Math.min(...visible.map((p) => p.low)) : 0,
    hi = visible.length ? Math.max(...visible.map((p) => p.high)) : 1;
  const margin = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.0004, 0.01);
  const min = lo - margin,
    max = hi + margin;
  const x = (i: number) =>
    L + ((i - view[0]) / Math.max(1, view[1] - view[0])) * PW;
  const y = (v: number) => T + ((max - v) / (max - min)) * PH;
  const positions = data
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => i >= Math.floor(view[0]) && i <= Math.ceil(view[1]));
  const drawdownMax = Math.max(
    0.01,
    ...positions.map(({ p }) => Math.abs(p.drawdown)),
  );
  const spansDays =
    visible.length > 1 && visible.at(-1)!.time - visible[0].time > 36 * 3600000;
  const path = positions
    .map(
      ({ p, i }, j) =>
        `${j ? "L" : "M"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`,
    )
    .join(" ");
  const area = positions.length
    ? `${path} L${x(positions.at(-1)!.i)},${T + PH} L${x(positions[0].i)},${T + PH} Z`
    : "";
  const active = hover !== null ? data[hover] : null;
  const zoom = (factor: number, center = (view[0] + view[1]) / 2) => {
    setView(
      zoomViewport(view, data.length, factor, followMode !== "manual", center),
    );
    if (followMode !== "manual") setFollowMode("live");
    setHover(null);
    setRange("CUSTOM");
  };
  const pan = (direction: number) => {
    const offset = (view[1] - view[0]) * 0.2 * direction;
    setView(clampViewport(view[0] + offset, view[1] + offset, data.length));
    setFollowMode("manual");
    setHover(null);
    setRange("CUSTOM");
  };
  const followLatest = () => {
    setView(followViewport(data.length, view[1] - view[0]));
    setFollowMode("live");
    setHover(null);
    setRange("CUSTOM");
    setFrom("");
    setTo("");
    setDateError("");
  };
  const dateRange = () => {
    if (!from && !to) return;
    let a = data.findIndex((p) => !from || easternDate(p.time) >= from),
      b = data.findLastIndex((p) => !to || easternDate(p.time) <= to);
    if (a < 0 || b < a) {
      setDateError("No recorded data falls inside these dates.");
      return;
    }
    setDateError("");
    // Half a slot at each selected edge keeps complete historical candles visible.
    const span = Math.max(4, b - a + 1);
    const center = (a + b) / 2;
    setView(clampViewport(center - span / 2, center + span / 2, data.length));
    setFollowMode("manual");
    setHover(null);
    setRange("CUSTOM");
  };
  const markerTrades = showTrades
    ? trades.flatMap((t) => {
        const time = Date.parse(t.exitTime || t.entryTime);
        if (!data.length || time < data[0].time || time > data.at(-1)!.time)
          return [];
        let index = data.findIndex((p) => p.time >= time);
        if (index < 0) index = data.length - 1;
        return index >= view[0] && index <= view[1]
          ? [{ trade: t, index }]
          : [];
      })
    : [];
  return (
    <section className="panel chart-panel" aria-label={title}>
      <div className="panel-heading chart-heading">
        <div>
          <h2>{title}</h2>
          <span className="subtle">
            {candles ? "OHLC · exchange timestamps" : "Recorded value · USD"}{" "}
            <span className="separator">/</span> Eastern time
          </span>
        </div>
        <div className="segmented" aria-label="Chart date range">
          {Object.keys(chartRanges).map((r) => (
            <button
              className={range === r ? "selected" : ""}
              aria-pressed={range === r}
              onClick={() => selectRange(r)}
              key={r}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-readout">
        <strong>
          {active
            ? money(active.value)
            : data.length
              ? money(data.at(-1)!.value)
              : "No data"}
        </strong>
        <span>
          {active
            ? new Date(active.time).toLocaleString("en-US", {
                timeZone: "America/New_York",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "Hover to inspect · drag to pan · scroll to zoom"}
        </span>
        {active?.bar && (
          <span className="mono">
            O {number(active.bar.open)} · H {number(active.bar.high)} · L{" "}
            {number(active.bar.low)} · V {number(active.bar.volume, 0)}
          </span>
        )}
        <span>
          {followMode === "manual" ? "Historical view" : "Following latest"}
        </span>
      </div>
      {!data.length ? (
        <div className="empty chart-empty">
          <h3>No chart history yet</h3>
          <p>
            Points appear after the service records market data or account
            snapshots.
          </p>
        </div>
      ) : (
        <svg
          ref={root}
          className="financial-chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}. ${data.length} data points. Use chart buttons or keyboard arrows to pan, plus and minus to zoom.`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (["ArrowLeft", "ArrowRight", "+", "=", "-", "0"].includes(e.key))
              e.preventDefault();
            if (e.key === "ArrowLeft") pan(-1);
            if (e.key === "ArrowRight") pan(1);
            if (e.key === "+" || e.key === "=") zoom(0.7);
            if (e.key === "-") zoom(1.4);
            if (e.key === "0") selectRange("ALL");
          }}
          onWheel={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.max(
              0,
              Math.min(
                1,
                (((e.clientX - rect.left) / rect.width) * W - L) / PW,
              ),
            );
            zoom(
              e.deltaY > 0 ? 1.15 : 0.85,
              view[0] + ratio * (view[1] - view[0]),
            );
          }}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, view };
            setHover(null);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerUp={(e) => {
            drag.current = null;
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onPointerLeave={() => {
            if (!drag.current) setHover(null);
          }}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (drag.current) {
              const offset =
                ((e.clientX - drag.current.x) / ((rect.width * PW) / W)) *
                (drag.current.view[1] - drag.current.view[0]);
              setView(
                clampViewport(
                  drag.current.view[0] - offset,
                  drag.current.view[1] - offset,
                  data.length,
                ),
              );
              setFollowMode("manual");
              setRange("CUSTOM");
            } else {
              const px = ((e.clientX - rect.left) / rect.width) * W;
              setHover(hoverIndex(view, (px - L) / PW, data.length));
            }
          }}
        >
          <defs>
            <linearGradient id={`fill${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#dfbd70" stopOpacity=".16" />
              <stop offset="100%" stopColor="#dfbd70" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`clip${uid}`}>
              <rect x={L} y={T} width={PW} height={PH} />
            </clipPath>
          </defs>
          {[0, 1, 2, 3, 4].map((i) => {
            const yy = T + (i * PH) / 4;
            return (
              <g key={i}>
                <line
                  x1={L}
                  x2={W - R}
                  y1={yy}
                  y2={yy}
                  stroke="var(--line)"
                  strokeDasharray={i === 4 ? undefined : "3 5"}
                />
                <text x={W - R + 13} y={yy + 4} className="axis-label">
                  {number(max - ((max - min) * i) / 4, candles ? 2 : 0)}
                </text>
              </g>
            );
          })}
          {[0, 1, 2, 3, 4].map((i) => {
            const index = hoverIndex(view, i / 4, data.length);
            if (index === null) return null;
            return (
              <text
                key={i}
                x={L + (PW * i) / 4}
                y={H - 9}
                textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
                className="axis-label"
              >
                {new Date(data[index].time).toLocaleString("en-US", {
                  timeZone: "America/New_York",
                  ...(spansDays
                    ? { month: "short", day: "numeric" }
                    : { hour: "2-digit", minute: "2-digit", hour12: false }),
                })}
              </text>
            );
          })}
          <g clipPath={`url(#clip${uid})`}>
            {candles ? (
              positions.map(({ p, i }) => {
                const b = p.bar!;
                const color =
                  b.close >= b.open ? "var(--positive)" : "var(--negative)";
                const width = Math.max(
                  1,
                  Math.min(13, (PW / (view[1] - view[0])) * 0.62),
                );
                return (
                  <g key={p.time}>
                    <line
                      x1={x(i)}
                      x2={x(i)}
                      y1={y(b.high)}
                      y2={y(b.low)}
                      stroke={color}
                    />
                    <rect
                      x={x(i) - width / 2}
                      y={Math.min(y(b.open), y(b.close))}
                      width={width}
                      height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
                      fill={color}
                    />
                  </g>
                );
              })
            ) : (
              <>
                <path d={area} fill={`url(#fill${uid})`} />
                <path
                  d={path}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
                {positions.length === 1 && (
                  <circle
                    cx={x(positions[0].i)}
                    cy={y(positions[0].p.value)}
                    r="3"
                    fill="var(--accent)"
                  />
                )}
              </>
            )}
            {showDrawdown && !candles && (
              <path
                d={positions
                  .map(
                    ({ p, i }, j) =>
                      `${j ? "L" : "M"}${x(i)},${T + PH * 0.68 + (Math.abs(p.drawdown) / drawdownMax) * PH * 0.32}`,
                  )
                  .join(" ")}
                stroke="var(--negative)"
                strokeWidth="1.5"
                fill="none"
              />
            )}
            {markerTrades.map(({ trade, index }, i) => (
              <g
                key={`${trade.id}-${i}`}
                tabIndex={0}
                role="button"
                aria-label={`Inspect ${trade.symbol} trade, ${money(trade.netPnl)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onTrade?.(trade)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onTrade?.(trade);
                  }
                }}
                className="trade-marker"
              >
                <circle
                  cx={x(index)}
                  cy={y(data[index].value)}
                  r="5"
                  fill={
                    trade.netPnl >= 0 ? "var(--positive)" : "var(--negative)"
                  }
                  stroke="var(--surface)"
                  strokeWidth="2"
                />
                <title>
                  {trade.symbol} · {money(trade.netPnl)} ·{" "}
                  {timeOnly(trade.exitTime)}
                </title>
              </g>
            ))}
            {active && hover !== null && (
              <>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={T}
                  y2={T + PH}
                  stroke="var(--muted)"
                  strokeDasharray="4 4"
                />
                <line
                  x1={L}
                  x2={W - R}
                  y1={y(active.value)}
                  y2={y(active.value)}
                  stroke="var(--muted)"
                  strokeDasharray="4 4"
                />
                <circle
                  cx={x(hover)}
                  cy={y(active.value)}
                  r="4"
                  fill="var(--accent)"
                />
              </>
            )}
          </g>
        </svg>
      )}
      <div className="chart-toolbar">
        <div className="toolbar-group">
          <button
            className="icon-button"
            aria-label="Pan chart left"
            onClick={() => pan(-1)}
          >
            <CaretLeft />
          </button>
          <button
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => zoom(0.7)}
          >
            <MagnifyingGlassPlus />
          </button>
          <button
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => zoom(1.4)}
          >
            <MagnifyingGlassMinus />
          </button>
          <button
            className="icon-button"
            aria-label="Pan chart right"
            onClick={() => pan(1)}
          >
            <CaretRight />
          </button>
          <button
            className="icon-button"
            aria-label="Reset chart"
            title="Reset to all history and follow latest"
            onClick={() => selectRange("ALL")}
          >
            <ArrowCounterClockwise />
          </button>
          {followMode === "manual" && (
            <button className="text-button" onClick={followLatest}>
              Follow latest
            </button>
          )}
          {!candles && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={showTrades}
                  onChange={(e) => setShowTrades(e.target.checked)}
                />
                Trades
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={showDrawdown}
                  onChange={(e) => setShowDrawdown(e.target.checked)}
                />
                Drawdown
              </label>
            </>
          )}
        </div>
        <div className="date-controls">
          <label>
            From{" "}
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="Chart start date (ET)"
            />
          </label>
          <label>
            To{" "}
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              aria-label="Chart end date (ET)"
            />
          </label>
          <button
            className="text-button"
            disabled={!from && !to}
            onClick={dateRange}
          >
            Apply
          </button>
        </div>
      </div>
      {showDrawdown && !candles && (
        <p className="subtle chart-date-error">
          Drawdown overlay: independent scale 0 to −{number(drawdownMax, 2)}%.{" "}
          {active ? `Inspected point: ${number(active.drawdown, 2)}%.` : ""}{" "}
          Larger losses slope downward.
        </p>
      )}
      {dateError && (
        <p role="alert" className="negative-text chart-date-error">
          {dateError}
        </p>
      )}
    </section>
  );
}
