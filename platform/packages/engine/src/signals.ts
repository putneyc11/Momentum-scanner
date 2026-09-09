import { resolveStrategy, strategyParameters } from "./catalog.js";
import type {
  Bar,
  MarketSession,
  Signal,
  SignalContext,
  StrategyDefinition,
} from "./types.js";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const minuteFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function sessionDate(timestamp: string): string {
  const parts = dateFormatter.formatToParts(new Date(timestamp));
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}-${parts.find((p) => p.type === "day")!.value}`;
}
export function sessionMinute(timestamp: string): number {
  const parts = minuteFormatter.formatToParts(new Date(timestamp));
  return (
    Number(parts.find((p) => p.type === "hour")!.value) * 60 +
    Number(parts.find((p) => p.type === "minute")!.value)
  );
}
/** Calendar holidays/early closes must be supplied by the broker/calendar integration. */
export function marketSession(timestamp: string): MarketSession {
  const date = new Date(timestamp);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(date);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const minute = sessionMinute(timestamp);
  return minute < 240 || minute >= 1200
    ? "closed"
    : minute < 570
      ? "premarket"
      : minute < 960
        ? "regular"
        : "afterhours";
}
export function validBar(bar: Bar): boolean {
  return (
    Number.isFinite(Date.parse(bar.timestamp)) &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
      Number.isFinite,
    ) &&
    Math.min(bar.open, bar.high, bar.low, bar.close) > 0 &&
    bar.volume >= 0 &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close, bar.high)
  );
}
export function atr(bars: Bar[], period = 14): number {
  const ranges = bars.slice(-period).map((b, local) => {
    const index = bars.length - Math.min(period, bars.length) + local;
    const previous = bars[index - 1]?.close ?? b.open;
    return Math.max(
      b.high - b.low,
      Math.abs(b.high - previous),
      Math.abs(b.low - previous),
    );
  });
  return ranges.reduce((a, b) => a + b, 0) / Math.max(1, ranges.length);
}
const ema = (bars: Bar[], period: number) =>
  bars
    .slice(1)
    .reduce(
      (acc, b) => acc + (2 / (period + 1)) * (b.close - acc),
      bars[0].close,
    );
const high = (bars: Bar[]) => Math.max(...bars.map((b) => b.high));
const low = (bars: Bar[]) => Math.min(...bars.map((b) => b.low));

export function evaluateSignal(
  strategyInput: string | StrategyDefinition,
  input: Bar[],
  context: SignalContext,
): Signal | null {
  const strategy = resolveStrategy(strategyInput);
  const parameters = strategyParameters(strategy, context.parameters);
  const asOf = context.asOf ? Date.parse(context.asOf) : Infinity;
  if (Number.isNaN(asOf)) return null;
  const bars = input.filter((b) => Date.parse(b.timestamp) <= asOf);
  if (
    bars.length < 25 ||
    bars.some(
      (b, i) =>
        !validBar(b) ||
        (i > 0 && Date.parse(b.timestamp) <= Date.parse(bars[i - 1].timestamp)),
    )
  )
    return null;
  const latest = bars[bars.length - 1];
  const day = sessionDate(latest.timestamp);
  if (bars.some((b) => sessionDate(b.timestamp) !== day)) return null;
  if (
    !strategy.session.includes(marketSession(latest.timestamp)) ||
    sessionMinute(latest.timestamp) >= 945
  )
    return null;
  if (
    context.spreadBps !== undefined &&
    (!Number.isFinite(context.spreadBps) ||
      context.spreadBps < 0 ||
      context.spreadBps > parameters.maxSpreadBps)
  )
    return null;
  const prior = bars.slice(0, -1);
  const previous = prior[prior.length - 1];
  let cumulativeVolume = 0,
    cumulativePriceVolume = 0;
  const vwaps = bars.map((b) => {
    cumulativeVolume += b.volume;
    cumulativePriceVolume += ((b.high + b.low + b.close) / 3) * b.volume;
    return cumulativeVolume
      ? cumulativePriceVolume / cumulativeVolume
      : b.close;
  });
  const vwap = vwaps[vwaps.length - 1];
  const averageVolume = prior.slice(-20).reduce((s, b) => s + b.volume, 0) / 20;
  const relativeVolume = averageVolume > 0 ? latest.volume / averageVolume : 0;
  if (relativeVolume < parameters.volumeMultiple) return null;
  const fastEma = ema(bars, 8),
    slowEma = ema(bars, 21),
    currentAtr = atr(bars);
  let accepted = false,
    reason = "",
    structuralLow = latest.close;
  switch (strategy.id) {
    case "moon":
      accepted =
        latest.close > high(prior.slice(-20)) &&
        latest.close > vwap &&
        fastEma > slowEma;
      reason = "20-bar breakout, rising trend and relative volume";
      break;
    case "surge":
    case "igniter": {
      const last3 = bars.slice(-3);
      accepted =
        last3.every((b) => b.close > b.open) &&
        (latest.close / last3[0].open - 1) * 100 >= parameters.burstPct &&
        latest.close > vwap;
      if (strategy.id === "surge") accepted &&= fastEma > slowEma;
      structuralLow = low(last3);
      reason = "Three green bars, impulse and volume expansion";
      break;
    }
    case "gapgo": {
      const opening = bars.filter(
        (b) =>
          sessionMinute(b.timestamp) >= 570 && sessionMinute(b.timestamp) < 585,
      );
      // Require an actual 09:30 opening print, not the first available bar after it.
      const open = opening.find(
        (b) => sessionMinute(b.timestamp) === 570,
      )?.open;
      accepted =
        !!open &&
        opening.length >= 15 &&
        sessionMinute(latest.timestamp) >= 585 &&
        Number.isFinite(context.previousClose) &&
        context.previousClose! > 0 &&
        (open / context.previousClose! - 1) * 100 >= parameters.gapPct &&
        latest.close > high(opening) &&
        previous.close <= high(opening) &&
        latest.close > vwap;
      reason = "Opening gap with a confirmed opening-range breakout";
      break;
    }
    case "reclaim": {
      const start = Math.max(0, bars.length - 7);
      const below = prior
        .slice(start)
        .filter((b, i) => b.close < vwaps[start + i]).length;
      accepted =
        below >= 2 &&
        previous.close <= vwaps[vwaps.length - 2] &&
        latest.close > vwap;
      structuralLow = low(bars.slice(-7));
      reason = "VWAP reclaim following a multi-bar dip";
      break;
    }
    case "flag": {
      const flag = prior.slice(-4),
        leg = prior.slice(-12, -4);
      const legLow = low(leg),
        legHigh = high(leg),
        flagLow = low(flag),
        flagHigh = high(flag);
      accepted =
        (legHigh / legLow - 1) * 100 >= parameters.impulsePct &&
        flagHigh < legHigh &&
        flagLow >= legHigh - (legHigh - legLow) / 2 &&
        latest.close > flagHigh &&
        latest.close > vwap &&
        fastEma > slowEma;
      structuralLow = flagLow;
      reason = "Shallow first pullback breaks higher above VWAP";
      break;
    }
    case "redgreen": {
      const sessionOpen =
        context.sessionOpen ??
        bars.find((b) => sessionMinute(b.timestamp) === 570)?.open;
      accepted =
        !!sessionOpen &&
        previous.close < sessionOpen &&
        latest.close > sessionOpen;
      structuralLow = Math.min(previous.low, latest.low);
      reason = "Volume-backed cross above the regular-session open";
      break;
    }
    case "compression": {
      const range = prior.slice(-10),
        rangeHigh = high(range),
        rangeLow = low(range);
      accepted =
        (rangeHigh / rangeLow - 1) * 100 <= parameters.rangePct &&
        latest.close > rangeHigh &&
        latest.close > vwap &&
        fastEma > slowEma;
      structuralLow = rangeLow;
      reason = "Volume-backed break from a compressed ten-bar range";
      break;
    }
    default:
      throw new RangeError(`Unsupported signal implementation: ${strategy.id}`);
  }
  if (!accepted || currentAtr <= 0) return null;
  const riskPerShare = Math.max(
    currentAtr * parameters.stopAtr,
    (latest.close * parameters.minStopPct) / 100,
    latest.close - structuralLow,
  );
  if (riskPerShare > (latest.close * parameters.maxStopPct) / 100) return null;
  return {
    strategyId: strategy.id,
    version: context.version ?? strategy.version,
    symbol: context.symbol,
    timestamp: latest.timestamp,
    side: "buy",
    entry: latest.close,
    stop: latest.close - riskPerShare,
    target:
      parameters.targetR > 0
        ? latest.close + riskPerShare * parameters.targetR
        : null,
    riskPerShare,
    reason,
    indicators: { vwap, atr: currentAtr, fastEma, slowEma, relativeVolume },
    parameters,
  };
}
