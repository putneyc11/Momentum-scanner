export type ChartView = [number, number];
export type FollowMode = "range" | "live" | "manual";

export const chartRanges: Record<string, number> = {
  "1H": 3600000,
  "4H": 14400000,
  "1D": 86400000,
  "1W": 604800000,
  "1M": 2592000000,
  ALL: Infinity,
};
const DEFAULT_LATEST_POSITION = 0.85;
const MIN_SPAN = 4;

// These are logical x-axis slots, not fabricated market records. A view may
// extend beyond either end of a short series without adding OHLC/equity data.
const maximumSpan = (count: number) =>
  Math.max(MIN_SPAN, (Math.max(0, count - 1) + 0.5) / DEFAULT_LATEST_POSITION);

export function chartWindow(times: number[], range: string): ChartView {
  if (times.length < 2) return [0, Math.max(1, times.length - 1)];
  const end = times.length - 1;
  const min = times[end] - (chartRanges[range] ?? Infinity);
  const found = times.findIndex((t) => t >= min);
  return [Math.max(0, Math.min(found, end - 1)), end];
}

// Retained for callers selecting strictly recorded index ranges.
export function clampWindow(
  start: number,
  end: number,
  count: number,
): ChartView {
  const max = Math.max(1, count - 1);
  const width = Math.min(max, Math.max(Math.min(2, max), end - start));
  const left = Math.max(0, Math.min(start, max - width));
  return [left, left + width];
}

export function clampViewport(
  start: number,
  end: number,
  count: number,
): ChartView {
  const width = Math.min(maximumSpan(count), Math.max(MIN_SPAN, end - start));
  const last = Math.max(0, count - 1);
  const firstLeft = Math.min(-0.5, last - DEFAULT_LATEST_POSITION * width);
  // Allow panning the latest record to the middle, but never into an entirely
  // empty future viewport. Preserve the viewport width at both boundaries.
  const lastLeft = last - width * 0.5;
  const left = Math.max(firstLeft, Math.min(start, lastLeft));
  return [left, left + width];
}

export function followViewport(
  count: number,
  span: number,
  position = 0.5,
): ChartView {
  const width = Math.min(maximumSpan(count), Math.max(MIN_SPAN, span));
  const left = Math.max(0, count - 1) - width * position;
  return [left, left + width];
}

export function rangeViewport(times: number[], range: string): ChartView {
  const [first, last] = chartWindow(times, range);
  return followViewport(
    times.length,
    (last - first + 0.5) / DEFAULT_LATEST_POSITION,
    DEFAULT_LATEST_POSITION,
  );
}

export function zoomViewport(
  view: ChartView,
  count: number,
  factor: number,
  following: boolean,
  center = (view[0] + view[1]) / 2,
): ChartView {
  const width = view[1] - view[0];
  if (following) {
    const position =
      factor < 1 ? 0.5 : (Math.max(0, count - 1) - view[0]) / width;
    return followViewport(count, width * factor, position);
  }
  const left = center - (center - view[0]) * factor;
  return clampViewport(left, left + width * factor, count);
}

export function updateViewport(
  view: ChartView,
  previous: number[],
  times: number[],
  mode: FollowMode,
  range: string,
): ChartView {
  if (!previous.length || mode === "range") return rangeViewport(times, range);
  if (mode === "live") {
    const delta = times.length - previous.length;
    return clampViewport(view[0] + delta, view[1] + delta, times.length);
  }
  const anchorIndex = Math.max(
    0,
    Math.min(previous.length - 1, Math.floor(view[0])),
  );
  const found = times.findIndex((time) => time >= previous[anchorIndex]);
  const index = found < 0 ? Math.max(0, times.length - 1) : found;
  const left = index + view[0] - anchorIndex;
  return clampViewport(left, left + view[1] - view[0], times.length);
}

export function hoverIndex(
  view: ChartView,
  ratio: number,
  count: number,
): number | null {
  if (ratio < 0 || ratio > 1) return null;
  const index = Math.round(view[0] + ratio * (view[1] - view[0]));
  return index >= 0 && index < count ? index : null;
}
