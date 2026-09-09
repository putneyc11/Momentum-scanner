import type { ParameterDefinition, StrategyDefinition } from "./types.js";

const lever = (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  unit: string,
  description: string,
): ParameterDefinition => ({ key, label, min, max, step, unit, description });
const common = [
  lever(
    "volumeMultiple",
    "Relative volume trigger",
    1,
    5,
    0.25,
    "×",
    "Latest completed bar volume divided by the mean of the previous 20 bars.",
  ),
  lever(
    "stopAtr",
    "Initial stop distance",
    0.75,
    3,
    0.25,
    "ATR",
    "Stop distance uses prior/current completed true ranges; capped by maximum stop percent.",
  ),
  lever(
    "minStopPct",
    "Minimum stop distance",
    0.25,
    3,
    0.25,
    "%",
    "Avoids excessive position sizes on low volatility bars.",
  ),
  lever(
    "maxStopPct",
    "Maximum stop distance",
    2,
    12,
    0.5,
    "%",
    "Rejects entries when a structural stop requires more risk than this cap.",
  ),
  lever(
    "targetR",
    "Profit target",
    0,
    5,
    0.25,
    "R",
    "Zero disables the target for trend riders; one R is the initial price risk.",
  ),
  lever(
    "trailAtr",
    "Trailing stop",
    1,
    5,
    0.25,
    "ATR",
    "Ratcheted after a completed bar; never applied retroactively inside that bar.",
  ),
  lever(
    "maxHoldBars",
    "Maximum holding bars",
    10,
    240,
    10,
    "bars",
    "Time exit at the close after this many bars.",
  ),
  lever(
    "cooldownBars",
    "Re-entry cooldown",
    1,
    30,
    1,
    "bars",
    "Minimum fully completed bars between exit and a fresh setup.",
  ),
  lever(
    "maxSpreadBps",
    "Maximum spread",
    5,
    100,
    5,
    "bps",
    "Rejects live signals above this bid/ask spread when a quote is supplied.",
  ),
];
const defaults = {
  volumeMultiple: 1.5,
  stopAtr: 1.5,
  minStopPct: 1,
  maxStopPct: 5,
  targetR: 2,
  trailAtr: 2,
  maxHoldBars: 60,
  cooldownBars: 5,
  maxSpreadBps: 40,
};
const make = (
  id: string,
  name: string,
  description: string,
  family: StrategyDefinition["family"],
  rules: string[],
  extra: ParameterDefinition[] = [],
  values: Record<string, number> = {},
): StrategyDefinition => ({
  id,
  name,
  description,
  family,
  version: "1.0.0",
  session: ["regular"],
  rules: [
    "Long only. Completed bars only; enter no earlier than the following bar.",
    "Regular session 09:30–15:45 America/New_York. Exit by the supplied session close.",
    "Require at least 25 valid, chronological same-session bars.",
    ...rules,
  ],
  parameters: [...common, ...extra],
  defaults: { ...defaults, ...values },
});
const burst = lever(
  "burstPct",
  "Three-bar impulse",
  0.25,
  5,
  0.25,
  "%",
  "Minimum gain across the latest three green bars.",
);
const gap = lever(
  "gapPct",
  "Minimum opening gap",
  0,
  15,
  0.5,
  "%",
  "Regular-session open must exceed the supplied previous close by this percent.",
);

export const strategyCatalog: StrategyDefinition[] = [
  make(
    "moon",
    "Moonshot Rider",
    "Volume-confirmed range expansion with a wide, ratcheting exit.",
    "breakout",
    [
      "Close above the prior 20-bar high and session VWAP.",
      "EMA 8 above EMA 21; volume exceeds its historical baseline.",
      "No fixed profit target. Trail only after each completed bar.",
    ],
    [],
    { targetR: 0, trailAtr: 3, maxHoldBars: 180, volumeMultiple: 2 },
  ),
  make(
    "surge",
    "Surge Rider",
    "Three-bar acceleration followed with a trailing stop.",
    "continuation",
    [
      "Three consecutive green bars with a minimum cumulative impulse.",
      "Close above VWAP and EMA 8 above EMA 21.",
      "Volume confirmation; no fixed target.",
    ],
    [burst],
    {
      burstPct: 1,
      targetR: 0,
      trailAtr: 3,
      maxHoldBars: 120,
      volumeMultiple: 2,
    },
  ),
  make(
    "gapgo",
    "Gap-and-Go",
    "An opening-range breakout in a stock that opened above the prior close.",
    "breakout",
    [
      "Previous close is required; do not infer it from future bars.",
      "Break the first 15 regular-session bars’ high after the opening range is complete.",
      "Close above VWAP with relative volume confirmation.",
    ],
    [gap],
    { gapPct: 2 },
  ),
  make(
    "reclaim",
    "VWAP Reclaim",
    "A recovery through VWAP after price has traded below it.",
    "reclaim",
    [
      "Previous close below its contemporaneous VWAP, current close above current VWAP.",
      "At least two of the prior six closes below their contemporaneous VWAP.",
      "Relative volume confirmation; stop below the dip or reject an over-wide setup.",
    ],
  ),
  make(
    "flag",
    "First Pullback",
    "A compact pullback after a measurable impulse.",
    "continuation",
    [
      "Prior eight-bar impulse rises at least the configured percent.",
      "Four-bar flag stays below the impulse high and retraces at most half the impulse.",
      "Close breaks the flag high above VWAP, with EMA 8 above EMA 21.",
    ],
    [
      lever(
        "impulsePct",
        "Impulse size",
        0.5,
        8,
        0.5,
        "%",
        "Minimum trough-to-peak rise in the eight bars preceding the flag.",
      ),
    ],
    { impulsePct: 2, volumeMultiple: 1.25 },
  ),
  make(
    "igniter",
    "Volume Igniter",
    "Short-horizon acceleration with a defined target.",
    "continuation",
    [
      "Three green candles with a minimum cumulative impulse.",
      "Volume expansion and close above VWAP.",
      "Defined initial stop, target and trailing stop.",
    ],
    [burst],
    { burstPct: 0.75, volumeMultiple: 2, maxHoldBars: 30 },
  ),
  make(
    "redgreen",
    "Red-to-Green",
    "A recovery above the actual regular-session opening price.",
    "reclaim",
    [
      "A recorded 09:30 bar or explicitly supplied regular-session open is required.",
      "Previous close below the opening price and latest close above it.",
      "Relative volume confirmation and a dip-based stop.",
    ],
  ),
  make(
    "compression",
    "Compression Breakout",
    "A volume-backed escape from a narrow recent range.",
    "breakout",
    [
      "Previous ten bars fit inside the configured percentage range.",
      "Close breaks that range high above VWAP.",
      "EMA 8 above EMA 21 and relative volume confirmation.",
    ],
    [
      lever(
        "rangePct",
        "Compression width",
        0.5,
        5,
        0.25,
        "%",
        "Maximum high-low width of the ten completed bars before the signal.",
      ),
    ],
    { rangePct: 2, volumeMultiple: 2 },
  ),
];

export function resolveStrategy(
  strategy: string | StrategyDefinition,
): StrategyDefinition {
  const result =
    typeof strategy === "string"
      ? strategyCatalog.find((s) => s.id === strategy)
      : strategy;
  if (!result) throw new RangeError(`Unknown strategy: ${strategy}`);
  return result;
}

export function strategyParameters(
  strategy: StrategyDefinition,
  values: Record<string, number> = {},
): Record<string, number> {
  const result = { ...strategy.defaults };
  for (const [key, value] of Object.entries(values)) {
    const rule = strategy.parameters.find((p) => p.key === key);
    if (
      !rule ||
      !Number.isFinite(value) ||
      value < rule.min ||
      value > rule.max
    )
      throw new RangeError(`Invalid ${strategy.id} parameter: ${key}`);
    result[key] = value;
  }
  if (result.minStopPct > result.maxStopPct)
    throw new RangeError("Minimum stop exceeds maximum stop");
  return result;
}
