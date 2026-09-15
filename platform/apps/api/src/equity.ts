import { sessionDate } from "@momentum/engine";
export type EquityPoint = { time: string; equity: number; drawdown: number };
/** Preserve recent detail and older first/min/max/last points so monthly ranges
 * do not disappear after a week of 15-second samples. Broker statements remain
 * the complete accounting history; this is a bounded multiresolution chart. */
export function compactEquity(
  input: EquityPoint[],
  now = Date.now(),
): EquityPoint[] {
  const today = sessionDate(new Date(now).toISOString());
  const groups = new Map<string, EquityPoint[]>();
  for (const point of input) {
    const time = Date.parse(point.time),
      age = now - time;
    if (
      !Number.isFinite(time) ||
      !Number.isFinite(point.equity) ||
      !Number.isFinite(point.drawdown) ||
      age > 3650 * 86400000
    )
      continue;
    const size =
      sessionDate(point.time) === today
        ? 0
        : age <= 7 * 86400000
          ? 300000
          : age <= 90 * 86400000
            ? 3600000
            : 86400000;
    const key = size ? `${size}:${Math.floor(time / size)}` : point.time;
    const bucket = groups.get(key) || [];
    bucket.push(point);
    groups.set(key, bucket);
  }
  const retained = new Map<string, EquityPoint>();
  for (const bucket of groups.values()) {
    const sorted = bucket.sort(
      (a, b) => Date.parse(a.time) - Date.parse(b.time),
    );
    const minimum = sorted.reduce((a, b) => (a.equity <= b.equity ? a : b)),
      maximum = sorted.reduce((a, b) => (a.equity >= b.equity ? a : b));
    for (const point of [sorted[0], minimum, maximum, sorted.at(-1)!])
      retained.set(point.time, point);
  }
  return [...retained.values()].sort(
    (a, b) => Date.parse(a.time) - Date.parse(b.time),
  );
}
