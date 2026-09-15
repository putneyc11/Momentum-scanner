import { marketSession, sessionDate } from "./signals.js";
import type { RiskDecision, RiskInput } from "./types.js";

/** Caller MUST persist haltState and the session's opening equity atomically. */
export function riskDecision(input: RiskInput): RiskDecision {
  const day = sessionDate(input.now);
  const haltState =
    input.haltState?.sessionDate === day
      ? { ...input.haltState }
      : { sessionDate: day, halted: false, reason: null, triggeredAt: null };
  const codes: string[] = [];
  let dayLossPct = 0,
    quantity = 0;
  const finiteNonnegative = (v: number) => Number.isFinite(v) && v >= 0;
  const limits = {
    riskPerTradePct: input.riskPerTradePct ?? 0.25,
    maxDailyLossPct: input.maxDailyLossPct ?? 3,
    maxPositionPct: input.maxPositionPct ?? 10,
    maxGrossExposurePct: input.maxGrossExposurePct ?? 40,
    maxOpenRiskPct: input.maxOpenRiskPct ?? 1,
    maxPositions: input.maxPositions ?? 4,
    maxDataAgeMs: input.maxDataAgeMs ?? 30_000,
  };
  if (
    ![input.equity, input.dayStartEquity, input.entry, input.stop].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    ![
      input.buyingPower,
      input.grossExposure ?? 0,
      input.openRisk ?? 0,
      input.openPositions ?? 0,
    ].every(finiteNonnegative) ||
    Object.values(limits).some((v) => !Number.isFinite(v) || v <= 0) ||
    limits.maxDailyLossPct > 100 ||
    limits.riskPerTradePct > 100 ||
    (input.requestedQty !== undefined &&
      (!finiteNonnegative(input.requestedQty) ||
        !Number.isInteger(input.requestedQty)))
  )
    codes.push("INVALID_RISK_INPUT");
  if (input.dayStartSessionDate !== day)
    codes.push("SESSION_BASELINE_REQUIRED");
  if (
    input.dayStartSessionDate === day &&
    Number.isFinite(input.dayStartEquity) &&
    input.dayStartEquity > 0 &&
    Number.isFinite(input.equity)
  ) {
    dayLossPct = Math.max(
      0,
      ((input.dayStartEquity - input.equity) / input.dayStartEquity) * 100,
    );
    if (dayLossPct >= limits.maxDailyLossPct) {
      haltState.halted = true;
      haltState.reason = "DAILY_LOSS_LIMIT";
      haltState.triggeredAt ??= input.now;
    }
  }
  if (haltState.halted) codes.push(haltState.reason ?? "SESSION_HALTED");
  if (input.killSwitch) codes.push("KILL_SWITCH");
  if (input.marketOpen === false || marketSession(input.now) !== "regular")
    codes.push("MARKET_CLOSED");
  if (
    input.dataAgeMs === undefined ||
    !finiteNonnegative(input.dataAgeMs) ||
    input.dataAgeMs > limits.maxDataAgeMs
  )
    codes.push("STALE_OR_UNKNOWN_DATA");
  if (input.stop >= input.entry) codes.push("INVALID_STOP");
  if ((input.openPositions ?? 0) >= limits.maxPositions)
    codes.push("POSITION_LIMIT");
  if (!codes.length) {
    const riskPerShare = input.entry - input.stop;
    const remainingExposure =
      (input.equity * limits.maxGrossExposurePct) / 100 -
      (input.grossExposure ?? 0);
    const remainingRisk =
      (input.equity * limits.maxOpenRiskPct) / 100 - (input.openRisk ?? 0);
    quantity = Math.max(
      0,
      Math.floor(
        Math.min(
          (input.equity * limits.riskPerTradePct) / 100 / riskPerShare,
          (input.equity * limits.maxPositionPct) / 100 / input.entry,
          remainingExposure / input.entry,
          remainingRisk / riskPerShare,
          input.buyingPower / input.entry,
          input.requestedQty ?? Infinity,
        ),
      ),
    );
    if (!quantity) codes.push("INSUFFICIENT_RISK_OR_BUYING_POWER");
  }
  return {
    allowed: codes.length === 0,
    quantity: codes.length ? 0 : quantity,
    reason: codes.length
      ? codes.join(", ")
      : "Within paper-account risk limits",
    codes,
    dayLossPct,
    haltState,
    continueShadow: true,
    flattenRequired: haltState.halted || !!input.killSwitch,
  };
}
