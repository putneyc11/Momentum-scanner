export type Mode = "demo" | "paper" | "unconfigured" | string;
export interface Session {
  authenticated: boolean;
  mode: Mode;
  role: string;
  product?: "trader" | "scanner";
  csrfToken?: string;
}
export interface Feed {
  state: string;
  feed?: string;
  lastEventAt?: string | null;
  error?: string | null;
  reason?: string;
}
export interface EquityPoint {
  time: string;
  equity: number;
  drawdown: number;
}
export interface Metrics {
  trades: number;
  winRate: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdown: number;
  avgWin?: number;
  avgLoss?: number;
  avgR?: number;
  winRateConfidence95?: number[];
  averageHoldMinutes?: number;
  fees?: number;
}
export interface Trade {
  id: string;
  symbol: string;
  strategyId: string;
  strategyName?: string;
  side: string;
  status: string;
  source?: string;
  entryTime: string;
  exitTime?: string | null;
  entryPrice: number;
  exitPrice?: number | null;
  quantity: number;
  netPnl: number;
  pnlPct?: number;
  rMultiple?: number;
  mfe?: number;
  mae?: number;
  fees?: number;
  exitReason?: string;
  entryReason?: string;
}
export interface Parameter {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  description?: string;
}
export interface StrategyVersion {
  id: string;
  version: string | number;
  status: string;
  createdAt: string;
  notes?: string;
  parameters?: Record<string, number>;
  diff?: Record<string, { from: number; to: number }>;
}
export interface Strategy {
  book?: string;
  approvedVersion?: string | null;
  id: string;
  name: string;
  family?: string;
  description?: string;
  status: string;
  version: string | number;
  allocationPct?: number;
  metrics: Metrics;
  parameters?: Record<string, Parameter | number>;
  rules?: string[];
  trades?: Trade[];
  versions?: StrategyVersion[];
  equity?: EquityPoint[];
  lastDecision?: string;
}
export interface Overview {
  mode: Mode;
  asOf: string;
  account: {
    equity: number;
    dayPnl: number;
    dayPnlPct: number;
    buyingPower: number;
    openPositions: number;
  };
  engine: {
    state: string;
    reason?: string;
    session: string;
    lastHeartbeat: string | null;
    shadowActive: boolean;
  };
  feed: Feed;
  equity: EquityPoint[];
  strategies: Strategy[];
  recentTrades: Trade[];
  risk: {
    dailyLossLimitPct: number;
    lossUsedPct: number;
    maxPositions: number;
    riskPerTradePct: number;
  };
}
export interface ResearchResult {
  strategyId?: string;
  name: string;
  decision: string;
  reason: string;
  trainScore?: number;
  validationScore?: number;
  holdoutScore?: number;
  sampleSize?: number;
  parameters?: Record<string, number>;
}
export interface ResearchRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: string;
  candidates?: number;
  accepted?: number;
  rejected?: number;
  summary?: string;
  stages?: { name: string; status: string; detail?: string }[];
  results?: ResearchResult[];
}
export interface Research {
  runs: ResearchRun[];
  schedule?: string;
  policy?: string | Record<string, unknown>;
}
export interface Stock {
  symbol: string;
  price: number;
  previousClose?: number | null;
  changePct: number;
  volume: number;
  relativeVolume: number;
  score: number;
  spreadBps?: number;
  updatedAt: string;
}
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface TapeTrade {
  id: string;
  time: string;
  price: number;
  size: number;
}
export interface Scanner {
  asOf: string;
  feed: Feed;
  stocks: Stock[];
}
export interface SymbolDetail {
  symbol: string;
  bars: Bar[];
  trades: TapeTrade[];
  analysis: {
    score?: number;
    trend?: string;
    vwap?: number;
    ema8?: number;
    ema21?: number;
    atr?: number;
    rsi?: number;
    summary?: string;
  };
  quote?: { bid: number; ask: number; spreadBps: number };
  feed: Feed;
}
