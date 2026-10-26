// Types shared between the server (agents) and the web client (village UI).
// Keep this file type-only so the browser bundle never pulls in server code.

export type AgentRole =
  | 'researcher'
  | 'strategist'
  | 'trader'
  | 'commander'
  | 'risk'
  | 'scout'
  | 'reporter'
  | 'treasurer'
  | 'analyst';

export type BuildingId =
  | 'command'
  | 'lab'
  | 'vault'
  | 'markets'
  | 'warroom'
  | 'bank'
  | 'media'
  | 'graveyard'
  | 'hall';

export type Mood = 'happy' | 'neutral' | 'sad' | 'sleeping' | 'excited';

export interface Appearance {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  hat: 'none' | 'cap' | 'goggles' | 'wizard' | 'captain' | 'helmet' | 'press' | 'tophat' | 'visor';
}

export interface AgentDTO {
  id: string;
  name: string;
  role: AgentRole;
  title: string;
  home: BuildingId;
  location: BuildingId;
  level: number;
  xp: number;
  xpForLevel: number;
  xpToNext: number;
  activity: string;
  mood: Mood;
  appearance: Appearance;
  stats: Record<string, string | number>;
}

export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Side = 'long' | 'short';

export interface Metrics {
  totalReturn: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  trades: number;
  exposure: number;
  avgTrade: number;
}

export interface LiveStats {
  trades: number;
  wins: number;
  pnl: number;
  grossWin: number;
  grossLoss: number;
  lastTradeAt: number | null;
}

export type StrategyStatus = 'vault' | 'active' | 'retired';

export interface StrategyDTO {
  id: string;
  name: string;
  symbol: string;
  side: Side;
  author: string;
  authorId: string;
  origin: 'evolution' | 'llm';
  createdAt: number;
  rules: string[];
  fitness: number;
  train: Metrics;
  test: Metrics;
  live: LiveStats;
  status: StrategyStatus;
  traderId: string | null;
  retiredAt: number | null;
  retiredReason: string | null;
  epitaph: string | null;
}

export interface PositionDTO {
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryTime: number;
  stop: number;
  takeProfit: number | null;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  barsHeld: number;
}

export interface TradeDTO {
  id: string;
  traderId: string;
  traderName: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  reason: string;
}

export interface TraderDTO {
  agentId: string;
  name: string;
  strategyId: string | null;
  strategyName: string | null;
  symbol: string | null;
  equity: number;
  cash: number;
  nav: number;
  allocationPct: number;
  position: PositionDTO | null;
  trades: number;
  wins: number;
  streak: number;
  status: 'idle' | 'watching' | 'in-trade' | 'halted';
}

export interface ResearcherDTO {
  agentId: string;
  name: string;
  specialty: string;
  symbol: string;
  generation: number;
  generationsPerEpoch: number;
  epoch: number;
  evaluated: number;
  discoveries: number;
  bestFitness: number | null;
  bestTrainSharpe: number | null;
  bestRules: string[];
  lastResult: string;
  origin: 'evolution' | 'llm';
  enabled: boolean;
}

export type Regime = 'bull' | 'bear' | 'ranging' | 'volatile' | 'unknown';

export type AssetClass = 'crypto' | 'stock';

export interface MarketDTO {
  symbol: string;
  asset: AssetClass;
  price: number;
  change24h: number;
  regime: Regime;
  volatility: number; // annualised, fraction
  trend: number;
  lastCandleTime: number;
  spark: number[];
  marketOpen: boolean;
  newsBias: number; // -1..1 from the signal board
}

export interface SignalDTO {
  id: string;
  source: 'news' | 'scout';
  authorId: string;
  authorName: string;
  symbol: string;
  direction: Side;
  confidence: number;
  headline: string;
  createdAt: number;
  expiresAt: number;
}

export interface AnalystDTO {
  agentId: string;
  name: string;
  beat: string;
  headlinesRead: number;
  signalsPosted: number;
  hitRate: number | null;
  scored: number;
  lastHeadline: string;
  enabled: boolean;
}

export interface LlmCostDTO {
  enabled: boolean;
  model: string;
  fastModel: string;
  spentToday: number;
  dailyBudget: number;
  totalSpent: number;
  totalCalls: number;
  totalTokens: number;
  attributedPnl: number;
  netOfCost: number;
  paused: boolean;
  pausedReason: string | null;
}

export interface FundDTO {
  startingCapital: number;
  equity: number;
  reserve: number;
  allocated: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalReturn: number;
  peakEquity: number;
  drawdown: number;
  maxDrawdown: number;
  dayStartEquity: number;
  pnlToday: number;
  fees: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  sharpe: number | null;
  grossExposure: number;
  openPositions: number;
}

export interface RiskDTO {
  halted: boolean;
  haltReason: string | null;
  cooldownUntil: number | null;
  dataStale: boolean;
  lastDataAt: number;
  limits: {
    fundMaxDrawdown: number;
    traderMaxDrawdown: number;
    dailyLossLimit: number;
    maxGrossExposure: number;
    maxSymbolExposure: number;
  };
  netLong: number;
  netShort: number;
}

export type NewsKind =
  | 'trade'
  | 'discovery'
  | 'risk'
  | 'allocation'
  | 'market'
  | 'system'
  | 'achievement'
  | 'retire'
  | 'levelup'
  | 'report'
  | 'signal';

export interface NewsItem {
  id: string;
  t: number;
  kind: NewsKind;
  text: string;
  agentId?: string;
  good?: boolean;
}

export interface AchievementDTO {
  id: string;
  title: string;
  description: string;
  unlockedAt: number | null;
}

export interface GraduationCheck {
  id: string;
  label: string;
  current: number;
  target: number;
  display: string;
  passed: boolean;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface WorldSnapshot {
  serverTime: number;
  seasonStartedAt: number;
  mode: 'paper';
  provider: string;
  timeframe: string;
  llmEnabled: boolean;
  fund: FundDTO;
  risk: RiskDTO;
  markets: MarketDTO[];
  agents: AgentDTO[];
  traders: TraderDTO[];
  researchers: ResearcherDTO[];
  analysts: AnalystDTO[];
  strategies: StrategyDTO[];
  graveyard: StrategyDTO[];
  trades: TradeDTO[];
  news: NewsItem[];
  signals: SignalDTO[];
  equity: EquityPoint[];
  achievements: AchievementDTO[];
  graduation: GraduationCheck[];
  llmCost: LlmCostDTO;
  totals: { genomesEvaluated: number; strategiesDiscovered: number; strategiesRetired: number };
  report: string | null;
  gate: {
    holdoutFraction: number;
    minTestSharpe: number;
    minTestReturn: number;
    minProfitFactor: number;
    maxTestDrawdown: number;
    feeRate: number;
    slippage: number;
  };
}

// Short-lived events used to animate the village (bubbles, coins, errands).
export type GameEventKind =
  | 'trade_open'
  | 'trade_close'
  | 'discovery'
  | 'retire'
  | 'assign'
  | 'halt'
  | 'resume'
  | 'achievement'
  | 'levelup'
  | 'rebalance'
  | 'regime'
  | 'report'
  | 'signal';

export interface GameEvent {
  kind: GameEventKind;
  agentId?: string;
  text: string;
  value?: number;
  building?: BuildingId;
}

export type ServerMessage =
  | { type: 'snapshot'; data: WorldSnapshot }
  | { type: 'event'; data: GameEvent };
