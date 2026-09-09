import { resolveStrategy, strategyCatalog } from "./catalog.js";
import { computeMetrics } from "./metrics.js";
import { sessionDate, validBar } from "./signals.js";
import { defaultSimulationConfig, simulateDay } from "./simulation.js";
import type {
  Metrics,
  ResearchCandidate,
  ResearchConfig,
  ResearchDay,
  ResearchReport,
  Trade,
} from "./types.js";

export const defaultResearchConfig: ResearchConfig = {
  ...defaultSimulationConfig,
  seed: 42,
  candidateCount: 12,
  minSessions: 60,
  minTrainTrades: 50,
  minValidationTrades: 20,
  minHoldoutTrades: 20,
  embargoSessions: 1,
  minProfitFactor: 1.2,
  maxDrawdownPct: 10,
  strategyIds: strategyCatalog.map((s) => s.id),
  consumedHoldoutDates: [],
  allowPaperPromotion: false,
};
const hash = (value: string) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
};
const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const score = (metrics: Metrics) =>
  metrics.trades
    ? metrics.averageR * Math.sqrt(metrics.trades) - metrics.maxDrawdownPct / 2
    : -1_000_000;

function cleanDays(input: ResearchDay[]): {
  days: ResearchDay[];
  rejected: ResearchReport["rejectedData"];
} {
  const seen = new Set<string>(),
    rejected: ResearchReport["rejectedData"] = [],
    days: ResearchDay[] = [];
  for (const day of [...input].sort(
    (a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol),
  )) {
    let reason = "";
    const key = `${day.date}:${day.symbol}`;
    if (seen.has(key))
      reason =
        "Duplicate symbol/session; data must be consolidated before research";
    else if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      !/^[A-Z][A-Z0-9.\-]{0,14}$/.test(day.symbol)
    )
      reason = "Invalid session date or symbol";
    else if (!["alpaca", "real", "synthetic", "demo"].includes(day.source))
      reason = "Missing or unsupported provenance";
    else if (
      day.discoveredAt &&
      (!Number.isFinite(Date.parse(day.discoveredAt)) ||
        sessionDate(day.discoveredAt) !== day.date)
    )
      reason = "Invalid point-in-time discovery timestamp";
    else if (day.bars.length < 25) reason = "Fewer than 25 bars";
    else if (
      day.bars.some(
        (b, i) =>
          !validBar(b) ||
          sessionDate(b.timestamp) !== day.date ||
          (i > 0 &&
            Date.parse(b.timestamp) <= Date.parse(day.bars[i - 1].timestamp)),
      )
    )
      reason = "Invalid, duplicate, unsorted, or cross-session bars";
    if (reason) rejected.push({ date: day.date, symbol: day.symbol, reason });
    else {
      days.push(day);
      seen.add(key);
    }
  }
  return { days, rejected };
}

/** Split by exchange-session DATE, never by ticker-days. The same date cannot cross partitions. */
export function splitResearchDays(
  days: ResearchDay[],
  embargoSessions = 1,
): ResearchReport["split"] {
  if (!Number.isInteger(embargoSessions) || embargoSessions < 1)
    throw new RangeError("Embargo must be at least one session");
  const dates = [...new Set(days.map((d) => d.date))].sort();
  const trainCut = Math.floor(dates.length * 0.6),
    validationCut = Math.floor(dates.length * 0.8);
  const validationStart = Math.min(validationCut, trainCut + embargoSessions);
  const holdoutStart = Math.min(dates.length, validationCut + embargoSessions);
  return {
    train: dates.slice(0, trainCut),
    validation: dates.slice(validationStart, validationCut),
    holdout: dates.slice(holdoutStart),
    embargo: [
      ...dates.slice(trainCut, validationStart),
      ...dates.slice(validationCut, holdoutStart),
    ],
  };
}

/**
 * Deterministic bounded parameter search. Every candidate is ranked using TRAIN only.
 * A single training-selected challenger and its baseline then see validation/holdout.
 * Holdout metrics never select parameters. Persist consumed holdouts in the caller.
 */
export function runResearch(
  input: ResearchDay[],
  configInput: Partial<ResearchConfig> = {},
): ResearchReport {
  const config: ResearchConfig = {
    ...defaultResearchConfig,
    ...configInput,
    strategyIds: [
      ...(configInput.strategyIds ?? defaultResearchConfig.strategyIds),
    ],
    consumedHoldoutDates: [...(configInput.consumedHoldoutDates ?? [])],
  };
  const integers = [
    config.seed,
    config.candidateCount,
    config.minSessions,
    config.minTrainTrades,
    config.minValidationTrades,
    config.minHoldoutTrades,
    config.embargoSessions,
  ];
  if (
    integers.some(
      (v) => !Number.isFinite(v) || !Number.isInteger(v) || v < 0,
    ) ||
    config.candidateCount < 2 ||
    config.candidateCount > 100 ||
    config.embargoSessions < 1 ||
    config.minSessions < 1 ||
    config.strategyIds.length > 8 ||
    config.strategyIds.length < 1 ||
    !Number.isFinite(config.minProfitFactor) ||
    config.minProfitFactor < 1 ||
    !Number.isFinite(config.maxDrawdownPct) ||
    config.maxDrawdownPct <= 0
  )
    throw new RangeError("Invalid research configuration");
  config.strategyIds = [...new Set(config.strategyIds)];
  config.strategyIds.forEach(resolveStrategy);
  const { days, rejected } = cleanDays(input);
  const split = splitResearchDays(days, config.embargoSessions);
  const realSessions = new Set(
    days
      .filter((d) => d.source === "alpaca" || d.source === "real")
      .map((d) => d.date),
  ).size;
  const datasetFingerprint = hash(JSON.stringify(days));
  const report: ResearchReport = {
    version: "1",
    datasetFingerprint,
    config,
    status:
      realSessions >= config.minSessions &&
      split.validation.length > 0 &&
      split.holdout.length > 0
        ? "COMPLETED"
        : "INSUFFICIENT_DATA",
    realSessions,
    split,
    candidates: [],
    challengers: [],
    rejectedData: rejected,
    warnings: [],
    walkForward: [],
    promotionPolicy:
      "Challengers remain SHADOW. Paper eligibility requires explicit authorization, sufficient real observations, untouched holdout, cost-aware validation, and drawdown gates. Research does not place orders or enable live money.",
  };
  if (realSessions < config.minSessions)
    report.warnings.push(
      `Only ${realSessions} real sessions; need ${config.minSessions}. Research can continue in shadow.`,
    );
  if (days.some((d) => d.source === "synthetic" || d.source === "demo"))
    report.warnings.push(
      "Synthetic/demo data present: all paper promotion is prohibited.",
    );
  if (rejected.length)
    report.warnings.push(
      `${rejected.length} input records rejected; review the data-quality log before interpreting results.`,
    );
  if (split.holdout.some((d) => config.consumedHoldoutDates.includes(d)))
    report.warnings.push(
      "Holdout overlaps a previously consumed holdout. New unseen sessions are required before paper promotion.",
    );
  report.warnings.push(
    "Individual-symbol simulations do not model shared portfolio capital, queue position, halts or borrow. Metrics do not establish profitability.",
    "A daily research run is parameter discovery inside registered strategy families; it does not invent or execute arbitrary new strategy code.",
    "Day bars must reflect the universe known at that time. End-of-day winners alone introduce selection bias; the caller must retain discovery snapshots.",
    "Slippage and a prior-bar volume participation cap are assumptions, not a fill guarantee. Repeated validation is not a new independent experiment.",
  );
  const onDates = (dates: string[]) => {
    const dateSet = new Set(dates);
    return days.filter((d) => dateSet.has(d.date));
  };
  const trainDays = onDates(split.train),
    validationDays = onDates(split.validation),
    holdoutDays = onDates(split.holdout);
  const metrics = (trades: Trade[]) =>
    computeMetrics(trades, config.initialEquity);
  const trainByCandidate = new Map<string, Trade[]>();
  const evaluate = (
    dataset: ResearchDay[],
    strategyId: string,
    parameters: Record<string, number>,
  ) =>
    dataset.flatMap((day) => simulateDay(day, strategyId, parameters, config));
  for (const strategyId of config.strategyIds) {
    const strategy = resolveStrategy(strategyId),
      rng = random(config.seed ^ parseInt(hash(strategyId), 16));
    const params = [{ ...strategy.defaults }];
    const signatures = new Set([JSON.stringify(params[0])]);
    // Risk limits and market-session permissions are never search dimensions.
    const searchable = strategy.parameters.filter(
      (p) =>
        !["maxSpreadBps", "maxStopPct", "minStopPct"].includes(p.key) &&
        !(strategy.defaults.targetR === 0 && p.key === "targetR"),
    );
    for (
      let attempt = 0;
      params.length < config.candidateCount &&
      attempt < config.candidateCount * 20;
      attempt++
    ) {
      const candidate = { ...strategy.defaults };
      for (let mutation = 0; mutation < 2; mutation++) {
        const p = searchable[Math.floor(rng() * searchable.length)];
        const steps = Math.round((p.max - p.min) / p.step);
        candidate[p.key] = Number(
          (p.min + Math.floor(rng() * (steps + 1)) * p.step).toFixed(8),
        );
      }
      const signature = JSON.stringify(candidate);
      if (!signatures.has(signature)) {
        params.push(candidate);
        signatures.add(signature);
      }
    }
    const candidates = params.map((parameters, index): ResearchCandidate => {
      const id = `${strategyId}:${index === 0 ? "baseline" : hash(JSON.stringify(parameters))}`;
      const trades = evaluate(trainDays, strategyId, parameters),
        train = metrics(trades);
      trainByCandidate.set(id, trades);
      return {
        id,
        strategyId,
        version: `${strategy.version}+${hash(JSON.stringify(parameters))}`,
        parameters,
        status: index ? "REJECTED" : "BASELINE",
        train,
        validation: null,
        holdout: null,
        score: score(train),
        rejectionReasons: [],
        promotionEligible: false,
      };
    });
    const baseline = candidates[0];
    const ranked = candidates
      .slice(1)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const challenger = ranked[0];
    for (const candidate of candidates.slice(1)) {
      if (candidate.train.trades < config.minTrainTrades)
        candidate.rejectionReasons.push(
          `TRAIN_SAMPLE_TOO_SMALL:${candidate.train.trades}/${config.minTrainTrades}`,
        );
      if (candidate.score <= baseline.score)
        candidate.rejectionReasons.push("DOES_NOT_IMPROVE_TRAIN_BASELINE");
      if (candidate !== challenger)
        candidate.rejectionReasons.push("NOT_SELECTED_ON_TRAIN");
    }
    challenger.status = "SHADOW";
    // Only the already-selected challenger and baseline are evaluated outside training.
    for (const candidate of [baseline, challenger]) {
      candidate.validation = metrics(
        evaluate(validationDays, strategyId, candidate.parameters),
      );
      candidate.holdout = metrics(
        evaluate(holdoutDays, strategyId, candidate.parameters),
      );
    }
    const reasons = challenger.rejectionReasons;
    for (const [name, observation, minimum] of [
      [
        "VALIDATION",
        challenger.validation!,
        Math.max(20, config.minValidationTrades),
      ],
      ["HOLDOUT", challenger.holdout!, Math.max(20, config.minHoldoutTrades)],
    ] as const) {
      if (observation.trades < minimum)
        reasons.push(
          `${name}_SAMPLE_TOO_SMALL:${observation.trades}/${minimum}`,
        );
      if (observation.netPnl <= 0)
        reasons.push(`${name}_NOT_PROFITABLE_AFTER_COSTS`);
      if (
        observation.profitFactor === null ||
        observation.profitFactor < config.minProfitFactor
      )
        reasons.push(`${name}_PROFIT_FACTOR_UNPROVEN`);
      if (observation.maxDrawdownPct > config.maxDrawdownPct)
        reasons.push(`${name}_DRAWDOWN_LIMIT`);
    }
    if (score(challenger.validation!) < score(baseline.validation!))
      reasons.push("VALIDATION_WORSE_THAN_BASELINE");
    if (challenger.train.trades < Math.max(50, config.minTrainTrades))
      reasons.push("MINIMUM_TRAIN_EVIDENCE_REQUIRED");
    if (realSessions < Math.max(60, config.minSessions))
      reasons.push("MINIMUM_REAL_SESSIONS_REQUIRED");
    if (days.some((d) => d.source === "synthetic" || d.source === "demo"))
      reasons.push("SYNTHETIC_DATA_NOT_ELIGIBLE");
    if (days.some((d) => !d.discoveredAt || !d.universeSnapshotId))
      reasons.push("POINT_IN_TIME_UNIVERSE_EVIDENCE_REQUIRED");
    if (days.some((d) => d.sessionComplete !== true))
      reasons.push("COMPLETE_SESSION_DATA_REQUIRED");
    if (rejected.length) reasons.push("DATA_QUALITY_REJECTIONS_REQUIRE_REVIEW");
    if (split.holdout.some((d) => config.consumedHoldoutDates.includes(d)))
      reasons.push("HOLDOUT_ALREADY_CONSUMED");
    if (!config.allowPaperPromotion)
      reasons.push("EXPLICIT_PAPER_PROMOTION_NOT_AUTHORIZED");
    challenger.promotionEligible = reasons.length === 0;
    report.candidates.push(...candidates);
    report.challengers.push(challenger);
    // Expanding-window walk-forward audit entirely inside TRAIN. Each fold selects using
    // its past prefix only; its next segment cannot influence that fold's choice.
    const initialCut = Math.floor(split.train.length / 2),
      width = Math.max(1, Math.floor((split.train.length - initialCut) / 3));
    for (
      let cut = initialCut;
      cut < split.train.length - config.embargoSessions && initialCut > 0;
      cut += width
    ) {
      const futureStart = cut + config.embargoSessions,
        futureDates = split.train.slice(
          futureStart,
          Math.min(split.train.length, futureStart + width),
        );
      if (!futureDates.length) continue;
      const prefixSet = new Set(split.train.slice(0, cut)),
        futureSet = new Set(futureDates);
      const withPastScore = candidates.map((c) => ({
        candidate: c,
        pastScore: score(
          metrics(
            trainByCandidate
              .get(c.id)!
              .filter((t) => prefixSet.has(sessionDate(t.entryTime))),
          ),
        ),
      }));
      withPastScore.sort(
        (a, b) =>
          b.pastScore - a.pastScore ||
          a.candidate.id.localeCompare(b.candidate.id),
      );
      const selected = withPastScore[0].candidate;
      report.walkForward.push({
        strategyId,
        trainedThrough: split.train[cut - 1],
        evaluationDates: futureDates,
        selectedCandidateId: selected.id,
        metrics: metrics(
          trainByCandidate
            .get(selected.id)!
            .filter((t) => futureSet.has(sessionDate(t.entryTime))),
        ),
      });
    }
  }
  return report;
}
