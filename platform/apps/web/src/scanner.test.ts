import { describe, expect, it } from "vitest";
import { applyScannerTick, qualifiesMover } from "./scanner-state";
import type { Stock } from "./types";

const time = "2026-09-15T19:00:00Z";
const nextTime = "2026-09-15T19:00:01Z";
function stock(changePct: number, symbol = "MOVE"): Stock {
  return {
    symbol,
    price: 10 * (1 + changePct / 100),
    previousClose: 10,
    changePct,
    volume: 10000,
    relativeVolume: 2,
    score: 99,
    updatedAt: time,
  };
}

describe("scanner qualification", () => {
  it("requires strictly more than +25%, independent of a high momentum score", () => {
    const tracked = [-14, 0, 24.99, 25, 25.01, 120, NaN, Infinity].map(
      (pct, i) => stock(pct, `S${i}`),
    );
    expect(tracked.filter(qualifiesMover).map((s) => s.changePct)).toEqual([
      25.01, 120,
    ]);
    expect(tracked.find(qualifiesMover)?.symbol).toBe("S4");
  });

  it("removes and readmits a mover on live ticks without deleting tracked/selected data", () => {
    const original = [stock(26), stock(30, "OTHER")];
    const below = applyScannerTick(original, "MOVE", 12.4, nextTime);
    expect(below.filter(qualifiesMover).map((s) => s.symbol)).toEqual([
      "OTHER",
    ]);
    expect(below.find((s) => s.symbol === "MOVE")?.changePct).toBeCloseTo(24);
    expect(below).toHaveLength(2);
    const above = applyScannerTick(below, "MOVE", 12.6, "2026-09-15T19:00:02Z");
    expect(above.filter(qualifiesMover).map((s) => s.symbol)).toEqual([
      "MOVE",
      "OTHER",
    ]);
    expect(above[0].changePct).toBeCloseTo(26);
    expect(above[0].price).toBe(12.6);
    expect(above[0].previousClose).toBe(10);
    expect(original[0].updatedAt).toBe(time);
    expect(above[1]).toBe(original[1]);
  });

  it("derives a stable previous-close anchor for older snapshots", () => {
    const initial = { ...stock(50), previousClose: undefined };
    const first = applyScannerTick([initial], "MOVE", 16, nextTime);
    const second = applyScannerTick(first, "MOVE", 17, "2026-09-15T19:00:02Z");
    expect(second[0].previousClose).toBe(10);
    expect(second[0].changePct).toBeCloseTo(70);
  });

  it("ignores stale and invalid ticks and never creates unknown symbols", () => {
    const initial = [stock(30)];
    expect(
      applyScannerTick(initial, "MOVE", 20, "2026-09-15T18:59:59Z")[0],
    ).toBe(initial[0]);
    for (const price of [NaN, Infinity, 0, -1])
      expect(applyScannerTick(initial, "MOVE", price, nextTime)).toBe(initial);
    expect(applyScannerTick(initial, "MOVE", 20, "invalid")).toBe(initial);
    expect(applyScannerTick(initial, "UNKNOWN", 20, nextTime)).toEqual(initial);
  });

  it("does not qualify a quote whose previous-close anchor is invalid", () => {
    const updated = applyScannerTick(
      [{ ...stock(30), previousClose: 0 }],
      "MOVE",
      20,
      nextTime,
    );
    expect(updated.filter(qualifiesMover)).toEqual([]);
  });
});
