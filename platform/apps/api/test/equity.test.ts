import { it, expect } from "vitest";
import { compactEquity } from "../src/equity.js";
it("keeps monthly extrema and endpoint history while reducing old chart samples", () => {
  const start = Date.parse("2026-08-01T14:00:00Z");
  const points = Array.from({ length: 240 }, (_, i) => ({
    time: new Date(start + i * 15000).toISOString(),
    equity: i === 40 ? 90000 : i === 100 ? 110000 : 100000 + i,
    drawdown: i === 40 ? -10 : 0,
  }));
  const result = compactEquity(points, Date.parse("2026-09-09T14:00:00Z"));
  expect(result).toHaveLength(4);
  expect(result.some((p) => p.equity === 90000)).toBe(true);
  expect(result.some((p) => p.equity === 110000)).toBe(true);
  expect(result[0].time).toBe(points[0].time);
  expect(result.at(-1)?.time).toBe(points.at(-1)?.time);
});
it("preserves every current session sample", () => {
  const now = Date.parse("2026-09-09T14:00:00Z");
  const points = Array.from({ length: 240 }, (_, i) => ({
    time: new Date(now + i * 15000).toISOString(),
    equity: 100000 + i,
    drawdown: 0,
  }));
  expect(compactEquity(points, now + 3600000)).toHaveLength(points.length);
});
