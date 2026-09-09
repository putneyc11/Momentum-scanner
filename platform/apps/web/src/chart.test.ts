import { describe, expect, it } from "vitest";
import { chartWindow, clampWindow } from "./Chart";
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
