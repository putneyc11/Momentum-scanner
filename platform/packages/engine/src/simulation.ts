import { resolveStrategy, strategyParameters } from "./catalog.js";
import {
  atr,
  evaluateSignal,
  sessionDate,
  sessionMinute,
  validBar,
} from "./signals.js";
import type {
  ResearchDay,
  Signal,
  SimulationConfig,
  StrategyDefinition,
  Trade,
} from "./types.js";

export const defaultSimulationConfig: SimulationConfig = {
  initialEquity: 100_000,
  riskPerTradePct: 0.25,
  maxPositionPct: 10,
  slippageBps: 15,
  feePerShare: 0.005,
  maxParticipationPct: 1,
  closeAtDataEnd: true,
};

/** Single-symbol, single-strategy shadow simulation. Not a shared-capital portfolio backtest. */
export function simulateDay(
  day: ResearchDay,
  strategyInput: string | StrategyDefinition,
  values: Record<string, number> = {},
  configInput: Partial<SimulationConfig> = {},
): Trade[] {
  const strategy = resolveStrategy(strategyInput),
    parameters = strategyParameters(strategy, values);
  const config = { ...defaultSimulationConfig, ...configInput },
    bars = day.bars;
  if (
    [
      config.initialEquity,
      config.riskPerTradePct,
      config.maxPositionPct,
      config.slippageBps,
      config.feePerShare,
      config.maxParticipationPct,
    ].some((v) => !Number.isFinite(v) || v < 0) ||
    config.initialEquity <= 0 ||
    config.maxParticipationPct > 100 ||
    config.slippageBps > 1000
  )
    throw new RangeError("Invalid simulation costs or sizing");
  if (
    bars.some(
      (b, i) =>
        !validBar(b) ||
        sessionDate(b.timestamp) !== day.date ||
        (i && Date.parse(b.timestamp) <= Date.parse(bars[i - 1].timestamp)),
    )
  )
    throw new RangeError(
      "Simulation requires valid chronological bars from one session date",
    );
  const trades: Trade[] = [];
  const slip = config.slippageBps / 10_000;
  let pending: Signal | null = null;
  let position: {
    signal: Signal;
    entry: number;
    index: number;
    qty: number;
    stop: number;
    target: number | null;
    risk: number;
    high: number;
    low: number;
  } | null = null;
  let cooldownUntil = 0,
    equity = config.initialEquity;
  const close = (
    index: number,
    priceBeforeSlippage: number,
    reason: string,
  ) => {
    if (!position) return;
    const p = position,
      b = bars[index],
      exit = priceBeforeSlippage * (1 - slip);
    const fees = p.qty * config.feePerShare * 2,
      grossPnl = (exit - p.entry) * p.qty,
      pnl = grossPnl - fees;
    trades.push({
      id: `${day.date}:${day.symbol}:${strategy.id}:${trades.length + 1}`,
      strategyId: strategy.id,
      version: p.signal.version,
      symbol: day.symbol,
      side: "long",
      entryTime: bars[p.index].timestamp,
      exitTime: b.timestamp,
      entryPrice: p.entry,
      exitPrice: exit,
      quantity: p.qty,
      fees,
      grossPnl,
      pnl,
      rMultiple: pnl / (p.risk * p.qty),
      // A partial exit bar has unknown intrabar ordering. Never present its extrema as observed excursions.
      mfe: ["stop", "trailing_stop", "target"].includes(reason)
        ? null
        : Math.max(0, p.high - p.entry) * p.qty,
      mae: ["stop", "trailing_stop", "target"].includes(reason)
        ? null
        : Math.max(0, p.entry - p.low) * p.qty,
      reason,
      entryReason: p.signal.reason,
      initialStop: p.entry - p.risk,
      source: "simulation",
    });
    equity += pnl;
    position = null;
    cooldownUntil = index + parameters.cooldownBars;
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (pending && !position) {
      const signal = pending;
      pending = null;
      const entry = b.open * (1 + slip),
        risk = entry - signal.stop;
      // A stopped-through open invalidates the setup. Size is decided using prior volume, never future bar volume.
      const nextMinute =
        Date.parse(b.timestamp) - Date.parse(signal.timestamp) === 60_000;
      if (
        nextMinute &&
        b.open > signal.stop &&
        risk > 0 &&
        (risk / entry) * 100 <= parameters.maxStopPct &&
        sessionMinute(b.timestamp) < 945 &&
        equity > 0
      ) {
        const availableVolume = bars[i - 1]?.volume ?? 0;
        const qty = Math.floor(
          Math.min(
            (equity * config.riskPerTradePct) / 100 / risk,
            (equity * config.maxPositionPct) / 100 / entry,
            (availableVolume * config.maxParticipationPct) / 100,
          ),
        );
        if (qty > 0)
          position = {
            signal,
            entry,
            index: i,
            qty,
            stop: signal.stop,
            target: parameters.targetR
              ? entry + parameters.targetR * risk
              : null,
            risk,
            high: entry,
            low: entry,
          };
      }
    }
    if (position) {
      const p = position;
      // OHLC cannot tell which came first. Stop wins a bar that crosses both stop and target.
      if (b.open <= p.stop) {
        p.low = Math.min(p.low, b.open);
        close(i, b.open, "gap_stop");
      } else if (b.low <= p.stop) {
        p.low = Math.min(p.low, p.stop);
        close(i, p.stop, p.stop > p.entry ? "trailing_stop" : "stop");
      } else if (p.target !== null && b.high >= p.target) {
        p.high = Math.max(p.high, p.target);
        close(i, p.target, "target");
      } else {
        p.high = Math.max(p.high, b.high);
        p.low = Math.min(p.low, b.low);
        if (sessionMinute(b.timestamp) >= 959)
          close(i, b.close, "session_close");
        else if (
          i === bars.length - 1 &&
          (day.sessionComplete || config.closeAtDataEnd !== false)
        )
          close(i, b.close, day.sessionComplete ? "session_close" : "data_end");
        else if (i - p.index + 1 >= parameters.maxHoldBars)
          close(i, b.close, "time_stop");
        else
          p.stop = Math.max(
            p.stop,
            b.high - atr(bars.slice(0, i + 1)) * parameters.trailAtr,
          );
      }
    }
    if (
      !position &&
      i >= cooldownUntil &&
      i < bars.length - 1 &&
      (!day.discoveredAt ||
        Date.parse(b.timestamp) >= Date.parse(day.discoveredAt))
    ) {
      pending = evaluateSignal(strategy, bars.slice(0, i + 1), {
        symbol: day.symbol,
        parameters,
        previousClose: day.previousClose,
      });
    }
  }
  return trades;
}
