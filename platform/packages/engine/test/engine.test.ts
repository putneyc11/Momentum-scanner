import { describe, expect, it } from "vitest";
import {
  computeMetrics,
  evaluateSignal,
  reconcileFills,
  riskDecision,
  runResearch,
  sessionDate,
  simulateDay,
  splitResearchDays,
  strategyCatalog,
  type Bar,
  type ExecutionFill,
  type ResearchDay,
  type RiskInput,
  type Trade,
} from "../src/index.js";

function day(date = "2026-09-08", symbol = "TEST"): ResearchDay {
  const start = Date.parse(`${date}T13:30:00Z`);
  const bars: Bar[] = Array.from({ length: 26 }, (_, i) => {
    const open = 10 + i * 0.005;
    return {
      timestamp: new Date(start + i * 60_000).toISOString(),
      open,
      close: open + 0.003,
      high: open + 0.02,
      low: open - 0.02,
      volume: 1000,
    };
  });
  bars[24] = {
    ...bars[24],
    open: 10.12,
    close: 10.7,
    high: 10.72,
    low: 10.1,
    volume: 6000,
  };
  bars[25] = {
    ...bars[25],
    open: 10.72,
    close: 10.7,
    high: 11.6,
    low: 10.1,
    volume: 6000,
  };
  return { date, symbol, bars, source: "real", previousClose: 9.5 };
}
function researchDays(count = 35): ResearchDay[] {
  const result: ResearchDay[] = [];
  for (let offset = 0; result.length < count; offset++) {
    const date = new Date(Date.UTC(2026, 5, 1 + offset));
    if ([0, 6].includes(date.getUTCDay())) continue;
    result.push(day(date.toISOString().slice(0, 10)));
  }
  return result;
}
const risk: RiskInput = {
  now: "2026-09-08T15:00:00Z",
  equity: 100_000,
  dayStartEquity: 100_000,
  dayStartSessionDate: "2026-09-08",
  buyingPower: 100_000,
  entry: 10,
  stop: 9.9,
  dataAgeMs: 0,
};

describe("causal signal and conservative execution", () => {
  it("has eight implemented, parameterized strategy definitions", () => {
    expect(strategyCatalog).toHaveLength(8);
    expect(new Set(strategyCatalog.map((s) => s.id)).size).toBe(8);
    for (const s of strategyCatalog) expect(s.rules.length).toBeGreaterThan(4);
  });
  it("excludes future observations and does not mutate input", () => {
    const fixture = day(),
      original = structuredClone(fixture);
    const asOf = fixture.bars[24].timestamp;
    const signal = evaluateSignal("moon", fixture.bars, {
      symbol: fixture.symbol,
      asOf,
    });
    expect(signal).not.toBeNull();
    fixture.bars[25] = { ...fixture.bars[25], close: 99, high: 100 };
    expect(
      evaluateSignal("moon", fixture.bars, { symbol: fixture.symbol, asOf }),
    ).toEqual(signal);
    expect(original.bars.slice(0, 25)).toEqual(fixture.bars.slice(0, 25));
  });
  it("rejects malformed bars, stale chronology and unsupported levers", () => {
    const fixture = day();
    const duplicate = [...fixture.bars.slice(0, 24), fixture.bars[23]];
    expect(evaluateSignal("moon", duplicate, { symbol: "TEST" })).toBeNull();
    expect(() =>
      evaluateSignal("moon", fixture.bars, {
        symbol: "TEST",
        parameters: { riskPct: 10 },
      }),
    ).toThrow();
  });
  it("enters on the next bar, charges costs, and stops before a simultaneous target", () => {
    const fixture = day();
    expect(
      simulateDay({ ...fixture, bars: fixture.bars.slice(0, 25) }, "moon"),
    ).toHaveLength(0);
    const [trade] = simulateDay(fixture, "moon", { targetR: 2 });
    expect(trade.entryTime).toBe(fixture.bars[25].timestamp);
    expect(trade.entryPrice).toBeGreaterThan(fixture.bars[25].open);
    expect(trade.reason).toBe("stop");
    expect(trade.fees).toBeGreaterThan(0);
    expect(trade.pnl).toBeLessThan(trade.grossPnl);
    expect(trade.quantity).toBeLessThanOrEqual(fixture.bars[24].volume * 0.01);
  });
  it("does not fill a delayed missing-minute entry or trade before universe discovery", () => {
    const fixture = day();
    fixture.bars[25].timestamp = new Date(
      Date.parse(fixture.bars[25].timestamp) + 120_000,
    ).toISOString();
    expect(simulateDay(fixture, "moon")).toHaveLength(0);
    expect(
      simulateDay({ ...day(), discoveredAt: "2026-09-08T15:00:00Z" }, "moon"),
    ).toHaveLength(0);
  });
  it("does not fabricate completed session trades from an unfinished intraday window", () => {
    const fixture = day();
    fixture.bars[25] = {
      ...fixture.bars[25],
      open: 10.72,
      high: 10.77,
      low: 10.68,
      close: 10.74,
    };
    expect(simulateDay(fixture, "moon")[0].reason).toBe("data_end");
    expect(
      simulateDay(fixture, "moon", {}, { closeAtDataEnd: false }),
    ).toHaveLength(0);
  });
});

describe("session risk state", () => {
  it("latches a 3% loss halt across recovery and restart, while allowing shadow research", () => {
    const halted = riskDecision({ ...risk, equity: 96_900 });
    expect(halted.allowed).toBe(false);
    expect(halted.flattenRequired).toBe(true);
    expect(halted.continueShadow).toBe(true);
    const restored = riskDecision({
      ...risk,
      haltState: JSON.parse(JSON.stringify(halted.haltState)),
    });
    expect(restored.codes).toContain("DAILY_LOSS_LIMIT");
    const next = riskDecision({
      ...risk,
      now: "2026-09-09T15:00:00Z",
      dayStartSessionDate: "2026-09-09",
      haltState: halted.haltState,
    });
    expect(next.allowed).toBe(true);
  });
  it("requires a fresh session baseline and known-fresh data", () => {
    expect(
      riskDecision({ ...risk, dayStartSessionDate: "2026-09-07" }).codes,
    ).toContain("SESSION_BASELINE_REQUIRED");
    expect(riskDecision({ ...risk, dataAgeMs: undefined }).codes).toContain(
      "STALE_OR_UNKNOWN_DATA",
    );
    expect(riskDecision({ ...risk, entry: Infinity }).allowed).toBe(false);
  });
  it("uses America/New_York dates through DST and sizes against buying power/exposure", () => {
    expect(sessionDate("2026-11-02T04:30:00Z")).toBe("2026-11-01");
    expect(sessionDate("2026-07-02T04:30:00Z")).toBe("2026-07-02");
    expect(riskDecision({ ...risk, buyingPower: 95 }).quantity).toBe(9);
    expect(riskDecision({ ...risk, grossExposure: 40_000 }).allowed).toBe(
      false,
    );
  });
});

describe("research evidence and partitioning", () => {
  it("splits all symbols on a date together, with embargo between partitions", () => {
    const days = researchDays().flatMap((d) => [d, { ...d, symbol: "TWO" }]);
    const split = splitResearchDays(days);
    const flattened = Object.values(split).flat();
    expect(new Set(flattened).size).toBe(35);
    expect(flattened.length).toBe(35);
    expect(split.embargo).toHaveLength(2);
    expect(split.train.at(-1)! < split.validation[0]).toBe(true);
    expect(split.validation.at(-1)! < split.holdout[0]).toBe(true);
  });
  it("is deterministic, records every candidate, and never promotes synthetic data", () => {
    const data = researchDays(12).map((d) => ({
      ...d,
      source: "synthetic" as const,
    }));
    const config = {
      candidateCount: 3,
      strategyIds: ["moon"],
      seed: 7,
      allowPaperPromotion: true,
    };
    const first = runResearch(data, config);
    expect(runResearch(data, config)).toEqual(first);
    expect(first.candidates).toHaveLength(3);
    expect(first.challengers[0].status).toBe("SHADOW");
    expect(first.challengers[0].promotionEligible).toBe(false);
    expect(first.challengers[0].rejectionReasons).toContain(
      "SYNTHETIC_DATA_NOT_ELIGIBLE",
    );
  });
  it("holdout prices cannot change candidate selection; reusing holdout blocks promotion", () => {
    const data = researchDays(20),
      config = { candidateCount: 3, strategyIds: ["moon"], seed: 9 };
    const first = runResearch(data, config);
    const holdout = new Set(first.split.holdout);
    const changed = data.map((d) =>
      holdout.has(d.date)
        ? {
            ...d,
            bars: d.bars.map((b) => ({
              ...b,
              open: b.open * 2,
              high: b.high * 2,
              low: b.low * 2,
              close: b.close * 2,
            })),
          }
        : d,
    );
    const second = runResearch(changed, {
      ...config,
      consumedHoldoutDates: first.split.holdout,
    });
    expect(second.challengers[0].id).toBe(first.challengers[0].id);
    expect(second.challengers[0].train).toEqual(first.challengers[0].train);
    expect(second.challengers[0].rejectionReasons).toContain(
      "HOLDOUT_ALREADY_CONSUMED",
    );
    expect(
      second.walkForward.every((f) => f.trainedThrough < f.evaluationDates[0]),
    ).toBe(true);
  });
});

describe("execution accounting", () => {
  const identity = {
    id: "trade-1",
    strategyId: "moon",
    version: "1.0.0",
    symbol: "TEST",
    initialStop: 9,
    entryReason: "breakout",
    exitReason: "stop",
  };
  const fill = (
    executionId: string,
    side: "buy" | "sell",
    quantity: number,
    price: number,
    minute: number,
  ): ExecutionFill => ({
    executionId,
    orderId: executionId,
    symbol: "TEST",
    side,
    quantity,
    price,
    timestamp: `2026-09-08T14:${String(minute).padStart(2, "0")}:00Z`,
    fees: 1,
  });
  it("waits for all partial fills and computes P&L from executed prices exactly once", () => {
    const bought = fill("buy-1", "buy", 100, 10, 0),
      partial = fill("sell-1", "sell", 30, 11, 1),
      final = fill("sell-2", "sell", 70, 9, 2);
    expect(reconcileFills([bought, partial], identity).state).toBe("partial");
    expect(reconcileFills([bought, partial], identity).trade).toBeNull();
    const result = reconcileFills([bought, partial, bought, final], identity);
    expect(result.state).toBe("closed");
    expect(result.trade!.pnl).toBe(-43);
    expect(result.trade!.exitPrice).toBe(9.6);
    expect(() =>
      reconcileFills([bought, fill("oversell", "sell", 101, 9, 1)], identity),
    ).toThrow("exceed");
  });
  it("reports uncertainty and undefined profit factor honestly", () => {
    const reconciled = reconcileFills(
      [fill("b", "buy", 100, 10, 0), fill("s", "sell", 100, 11, 1)],
      identity,
    ).trade!;
    const metrics = computeMetrics([reconciled]);
    expect(metrics.hitRate).toBe(100);
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.winRateConfidence95[0]).toBeLessThan(25);
    expect(computeMetrics([]).winRateConfidence95).toEqual([0, 100]);
  });
});
