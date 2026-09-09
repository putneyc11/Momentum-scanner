/** All timestamps are ISO 8601 instants; prices are USD and volume is shares. */
export interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export type MarketSession = "premarket" | "regular" | "afterhours" | "closed";
export interface ParameterDefinition {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  description: string;
}
export interface StrategyDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  family: "breakout" | "reclaim" | "continuation";
  session: MarketSession[];
  rules: string[];
  parameters: ParameterDefinition[];
  defaults: Record<string, number>;
}
export interface SignalContext {
  symbol: string;
  asOf?: string;
  parameters?: Record<string, number>;
  version?: string;
  previousClose?: number;
  sessionOpen?: number;
  spreadBps?: number;
}
export interface Signal {
  strategyId: string;
  version: string;
  symbol: string;
  timestamp: string;
  side: "buy";
  entry: number;
  stop: number;
  target: number | null;
  riskPerShare: number;
  reason: string;
  indicators: Record<string, number>;
  parameters: Record<string, number>;
}
export interface HaltState {
  sessionDate: string;
  halted: boolean;
  reason: string | null;
  triggeredAt: string | null;
}
export interface RiskInput {
  now: string;
  equity: number;
  dayStartEquity: number;
  dayStartSessionDate: string;
  buyingPower: number;
  entry: number;
  stop: number;
  openPositions?: number;
  grossExposure?: number;
  openRisk?: number;
  requestedQty?: number;
  riskPerTradePct?: number;
  maxDailyLossPct?: number;
  maxPositionPct?: number;
  maxGrossExposurePct?: number;
  maxOpenRiskPct?: number;
  maxPositions?: number;
  dataAgeMs?: number;
  maxDataAgeMs?: number;
  marketOpen?: boolean;
  killSwitch?: boolean;
  haltState?: HaltState;
}
export interface RiskDecision {
  allowed: boolean;
  quantity: number;
  reason: string;
  codes: string[];
  dayLossPct: number;
  haltState: HaltState;
  continueShadow: true;
  flattenRequired: boolean;
}
export interface Trade {
  id: string;
  strategyId: string;
  version: string;
  symbol: string;
  side: "long";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  fees: number;
  grossPnl: number;
  pnl: number;
  rMultiple: number;
  mfe: number | null;
  mae: number | null;
  reason: string;
  entryReason: string;
  initialStop: number;
  source: "simulation" | "paper";
}
export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  hitRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  fees: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  averageHoldMinutes: number;
  averageMfe: number | null;
  averageMae: number | null;
  consecutiveLosses: number;
  winRateConfidence95: [number, number];
}
export interface ResearchDay {
  date: string;
  symbol: string;
  bars: Bar[];
  source: "alpaca" | "real" | "synthetic" | "demo";
  previousClose?: number;
  /** First contemporaneous scanner admission. Historical final winners alone are biased. */
  discoveredAt?: string;
  universeSnapshotId?: string;
  sessionComplete?: boolean;
}
export interface SimulationConfig {
  initialEquity: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  slippageBps: number;
  feePerShare: number;
  maxParticipationPct: number;
  /** False leaves an unfinished intraday position unreported until its real exit. */
  closeAtDataEnd?: boolean;
}
export interface ResearchConfig extends SimulationConfig {
  seed: number;
  candidateCount: number;
  minSessions: number;
  minTrainTrades: number;
  minValidationTrades: number;
  minHoldoutTrades: number;
  embargoSessions: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
  strategyIds: string[];
  consumedHoldoutDates: string[];
  /** Explicitly permits an eligibility recommendation only; research never submits orders. */
  allowPaperPromotion: boolean;
}
export interface ResearchCandidate {
  id: string;
  strategyId: string;
  version: string;
  parameters: Record<string, number>;
  status: "BASELINE" | "REJECTED" | "SHADOW";
  train: Metrics;
  validation: Metrics | null;
  holdout: Metrics | null;
  score: number;
  rejectionReasons: string[];
  promotionEligible: boolean;
}
export interface ResearchReport {
  version: "1";
  datasetFingerprint: string;
  config: ResearchConfig;
  status: "INSUFFICIENT_DATA" | "COMPLETED";
  realSessions: number;
  split: {
    train: string[];
    validation: string[];
    holdout: string[];
    embargo: string[];
  };
  candidates: ResearchCandidate[];
  challengers: ResearchCandidate[];
  rejectedData: { date: string; symbol: string; reason: string }[];
  warnings: string[];
  promotionPolicy: string;
  walkForward: {
    strategyId: string;
    trainedThrough: string;
    evaluationDates: string[];
    selectedCandidateId: string;
    metrics: Metrics;
  }[];
}
