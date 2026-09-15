import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Chart, { chartWindow, clampWindow } from "./Chart";
import {
  clampViewport,
  followViewport,
  hoverIndex,
  rangeViewport,
  updateViewport,
  zoomViewport,
  type ChartView,
} from "./chartViewport";
import { exchangeDayStart, updateTickBar } from "./Scanner";
import type { Bar, TapeTrade } from "./types";

describe("chart navigation", () => {
  it("selects the actual last hour rather than a fixed number of points", () => {
    expect(
      chartWindow([0, 1000, 3500000, 3600000, 5400000, 7200000], "1H"),
    ).toEqual([3, 5]);
  });
  it("keeps a single point and empty series safe to render", () => {
    expect(chartWindow([], "1D")).toEqual([0, 1]);
    expect(chartWindow([1000], "ALL")).toEqual([0, 1]);
  });
  it("clamps pan at both ends without changing viewport width", () => {
    expect(clampWindow(-5, 15, 100)).toEqual([0, 20]);
    expect(clampWindow(90, 110, 100)).toEqual([79, 99]);
  });
  it("caps zoom-out to the entire recorded history", () => {
    expect(clampWindow(-500, 500, 100)).toEqual([0, 99]);
  });
});
describe("chart future space and live navigation", () => {
  const times = Array.from({ length: 100 }, (_, i) => i * 60000);
  const fraction = (view: ChartView, index: number) =>
    (index - view[0]) / (view[1] - view[0]);

  it("leaves 15% empty space after the newest point in a preset/reset view", () => {
    for (const range of ["1H", "1D", "ALL"]) {
      const view = rangeViewport(times, range);
      expect(fraction(view, 99)).toBeCloseTo(0.85);
      expect(view[1]).toBeGreaterThan(99);
    }
    expect(rangeViewport(times, "ALL")[0]).toBeCloseTo(-0.5);
  });

  it("centers the latest real-time candle when zooming in, independent of cursor position", () => {
    const initial = rangeViewport(times, "ALL");
    const zoomed = zoomViewport(initial, times.length, 0.7, true, 5);
    expect(fraction(zoomed, 99)).toBeCloseTo(0.5);
    expect(zoomed[1] - zoomed[0]).toBeCloseTo((initial[1] - initial[0]) * 0.7);
    const again = zoomViewport(zoomed, times.length, 0.7, true);
    expect(fraction(again, 99)).toBeCloseTo(0.5);
  });

  it("keeps a centered live zoom and its width on incoming bars", () => {
    const zoomed = zoomViewport(
      rangeViewport(times, "ALL"),
      times.length,
      0.7,
      true,
    );
    const appended = [...times, 100 * 60000];
    const next = updateViewport(zoomed, times, appended, "live", "CUSTOM");
    expect(fraction(next, 100)).toBeCloseTo(0.5);
    expect(next[1] - next[0]).toBeCloseTo(zoomed[1] - zoomed[0]);
    expect(next[0]).toBeCloseTo(zoomed[0] + 1);
  });

  it("keeps the preset right gap while a selected time range follows new data", () => {
    const appended = [...times, 100 * 60000];
    const next = updateViewport(
      rangeViewport(times, "1H"),
      times,
      appended,
      "range",
      "1H",
    );
    expect(fraction(next, 100)).toBeCloseTo(0.85);
    expect(next).toEqual(rangeViewport(appended, "1H"));
  });

  it("does not jump a panned/custom historical range to incoming data", () => {
    const historical: ChartView = [20.25, 40.25];
    const appended = [...times, 100 * 60000];
    expect(
      updateViewport(historical, times, appended, "manual", "CUSTOM"),
    ).toEqual(historical);
    expect(
      updateViewport(historical, times, times, "manual", "CUSTOM"),
    ).toEqual(historical);
  });

  it("preserves historical timestamps when a rolling buffer drops old records", () => {
    const historical: ChartView = [20.25, 40.25];
    const rolled = [...times.slice(5), 100 * 60000];
    expect(
      updateViewport(historical, times, rolled, "manual", "CUSTOM"),
    ).toEqual([15.25, 35.25]);
  });

  it("follows the newest slot through same-length rolling-buffer updates", () => {
    const live = followViewport(times.length, 20);
    const rolled = [...times.slice(1), 100 * 60000];
    expect(updateViewport(live, times, rolled, "live", "CUSTOM")).toEqual(live);
    expect(fraction(live, rolled.length - 1)).toBeCloseTo(0.5);
  });

  it("permits historical pan and half a viewport of future slots, without an all-empty view", () => {
    expect(clampViewport(20, 40, 100)).toEqual([20, 40]);
    expect(clampViewport(-50, -30, 100)).toEqual([-0.5, 19.5]);
    expect(clampViewport(150, 170, 100)).toEqual([89, 109]);
    const all = clampViewport(-500, 500, 100);
    expect(all[1] - all[0]).toBeCloseTo((99 + 0.5) / 0.85);
  });

  it("zooms a manually panned view around the chosen historical point", () => {
    expect(zoomViewport([20, 40], 100, 0.5, false, 30)).toEqual([25, 35]);
    expect(zoomViewport([20, 40], 100, 0.5, false, 20)).toEqual([20, 30]);
  });

  it("Follow latest retains zoom width, while reset returns to the default gap", () => {
    const followed = followViewport(100, 20);
    expect(followed).toEqual([89, 109]);
    expect(fraction(followed, 99)).toBeCloseTo(0.5);
    expect(fraction(rangeViewport(times, "ALL"), 99)).toBeCloseTo(0.85);
  });

  it("renders empty/single/short histories with a finite span and a complete newest bar", () => {
    for (const count of [0, 1, 2, 3]) {
      const short = times.slice(0, count);
      const initial = rangeViewport(short, "ALL");
      const zoomed = zoomViewport(initial, count, 0.1, true);
      expect(initial.every(Number.isFinite)).toBe(true);
      expect(initial[1] - initial[0]).toBeGreaterThanOrEqual(4);
      expect(fraction(initial, Math.max(0, count - 1))).toBeCloseTo(0.85);
      expect(fraction(zoomed, Math.max(0, count - 1))).toBeCloseTo(0.5);
      expect(
        updateViewport(
          initial,
          short,
          [...short, count * 60000],
          "manual",
          "CUSTOM",
        ).every(Number.isFinite),
      ).toBe(true);
    }
  });

  it("does not display a copied newest timestamp/quote in the empty future space", () => {
    const view = followViewport(100, 20);
    expect(hoverIndex(view, 0.5, 100)).toBe(99);
    expect(hoverIndex(view, 0.75, 100)).toBeNull();
    expect(hoverIndex(view, 1, 100)).toBeNull();
    expect(hoverIndex(view, -0.1, 100)).toBeNull();
    expect(hoverIndex(view, 1.1, 100)).toBeNull();
  });

  it("applies the shared gap to equity paths without extending recorded values into the future", () => {
    const points = times.map((time, i) => ({
      time: new Date(time).toISOString(),
      equity: 100 + i,
      drawdown: 0,
    }));
    const markup = renderToStaticMarkup(createElement(Chart, { points }));
    // Default 900px SVG: plot starts at 12 and is 804 wide; 85% is x=695.4.
    expect(markup).toContain("L695.40,");
    expect(markup).toContain("100 data points");
    expect(points).toHaveLength(100);
  });

  it("draws a visible single equity point and only the supplied OHLC candle", () => {
    const point = { time: new Date(0).toISOString(), equity: 100, drawdown: 0 };
    const equity = renderToStaticMarkup(
      createElement(Chart, { points: [point] }),
    );
    expect(equity.match(/<circle /g)).toHaveLength(1);
    const bar = {
      time: 0,
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 100,
    };
    const candle = renderToStaticMarkup(createElement(Chart, { bars: [bar] }));
    // One clipping rectangle plus one real candle body; no synthetic bars.
    expect(candle.match(/<rect /g)).toHaveLength(2);
    expect(candle).toContain("1 data points");
    expect(renderToStaticMarkup(createElement(Chart))).toContain(
      "No chart history yet",
    );
  });
});
describe("tick-driven candles", () => {
  it("aligns daily candles to the exchange session in summer and winter", () => {
    expect(exchangeDayStart("2026-09-09T14:00:00Z")).toBe(
      Date.parse("2026-09-09T04:00:00Z") / 1000,
    );
    expect(exchangeDayStart("2026-01-09T14:00:00Z")).toBe(
      Date.parse("2026-01-09T05:00:00Z") / 1000,
    );
    expect(exchangeDayStart("2026-09-10T01:00:00Z")).toBe(
      Date.parse("2026-09-09T04:00:00Z") / 1000,
    );
  });
  const time = Date.parse("2026-09-09T14:00:00.000Z") / 1000;
  const bars: Bar[] = [
    { time, open: 10, high: 10.3, low: 9.9, close: 10.1, volume: 100 },
  ];
  const tick = (
    price: number,
    stamp = "2026-09-09T14:00:10.000Z",
  ): TapeTrade => ({ id: "test-print", price, size: 25, time: stamp });
  it("updates the current candle and volume on every received print", () => {
    const next = updateTickBar(bars, tick(10.7), "1Min");
    expect(next).toEqual([
      { ...bars[0], high: 10.7, close: 10.7, volume: 125 },
    ]);
    expect(bars[0].close).toBe(10.1);
  });
  it("opens a new interval without manufacturing intervening candles", () => {
    const next = updateTickBar(
      bars,
      tick(11, "2026-09-09T14:04:02.000Z"),
      "1Min",
    );
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({
      time: time + 240,
      open: 11,
      high: 11,
      low: 11,
      close: 11,
      volume: 25,
    });
  });
  it("uses the selected aggregation interval", () => {
    expect(
      updateTickBar(bars, tick(11, "2026-09-09T14:04:02.000Z"), "5Min"),
    ).toHaveLength(1);
  });
  it("does not corrupt current candles with delayed or invalid trades", () => {
    expect(
      updateTickBar(bars, tick(8, "2026-09-09T13:59:00.000Z"), "1Min"),
    ).toBe(bars);
    expect(updateTickBar(bars, tick(NaN), "1Min")).toBe(bars);
    expect(updateTickBar(bars, tick(12, "invalid"), "1Min")).toBe(bars);
  });
});
