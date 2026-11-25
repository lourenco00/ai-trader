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
  | 'analyst'
  | 'explorer';

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
  /** Last status text change, not a successful-work heartbeat. */
  activityAt?: number | null;
  /** Last explicitly recorded genuine work; null until observed this process. */
  lastWorkAt?: number | null;
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
  opportunity?: { baselineBar: number; lastBar: number; count: number; timeframeMs: number; lastTradeAt: number | null };
  parked?: { at: number; reason: string; afterBar: number; navSinceAssign: number; peakNav: number };
  id: string;
  name: string;
  symbol: string;
  side: Side;
  author: string;
  authorId: string;
  origin: 'evolution' | 'llm';
  /** On trial: passed the basic holdout checks but not the strict gate, so it trades small until it proves itself live. */
  trial: boolean;
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

export type EntryDecisionReason = 'no-strategy' | 'insufficient-history' | 'no-signal' | 'invalid-atr' |
  'unresolved-execution' | 'exit-only' | 'retiring' | 'market-closed' | 'invalid-size' | 'minimum-notional' |
  'risk-rejected' | 'missing-price' | 'checkpoint-cancelled' | 'submission-attempted' | 'entry-filled' | 'execution-unknown';

export interface EntrySizingDiagnostics {
  symbol: string;
  strategyId: string;
  evaluatedAt: number;
  referencePrice: number;
  stopDistance: number;
  walletNotionalLimit: number;
  riskNotionalLimit: number;
  requestedQty: number;
  roundedQty: number;
  actualNotional: number;
  plannedStopRisk: number;
  bindingLimit: 'wallet' | 'risk' | 'both';
  venueRounded: boolean;
}

export interface EntryDiagnostics {
  counts: Partial<Record<EntryDecisionReason, number>>;
  lastReason: EntryDecisionReason | null;
  lastAt: number | null;
  /** Initial pre-reservation sizing, not a fill/approval. Ephemeral: resets on restart. */
  lastSizing?: EntrySizingDiagnostics;
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
  entryDiagnostics?: EntryDiagnostics;
}

export interface LlmReadiness {
  state: 'disabled' | 'paused-earnings' | 'paused-budget' | 'paused-accounting' | 'waiting' | 'running' | 'error';
  reason: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  attempts?: number;
  successes?: number;
  lastError?: 'provider-rejected' | 'ambiguous-billing' | 'persistence' | null;
}

export interface ResearcherDTO {
  workState?: 'running' | 'resting' | 'waiting-data';
  readiness?: LlmReadiness;
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
  /** core = from SYMBOLS; explored = found by the Explorer. */
  tier: 'core' | 'explored';
  /** Why the Explorer picked it (explored only). */
  exploreNote: string | null;
  volumeUsd: number | null;
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
  readiness?: LlmReadiness;
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
  status?: LlmReadiness['state'];
  canResume?: boolean;
  pausedAt?: number | null;
  grant?: { startedAt: number; expiresAt: number; day: string; maxAdditionalUsd: number; baselineSpent: number; remainingUsd: number; active: boolean } | null;
  accountingBasis?: string;
  accountingComplete?: boolean;
  reservedUsd?: number;
  window?: { startDay: string; endDay: string; days: number; policy: 'inclusive-utc-calendar-days'; strategyCost: number; newsCost: number; otherCost: number; directAuthoredPnl: number };
  seasonSpent?: number;
  seasonAttributedPnl?: number;
  attempts?: number;
  successes?: number;
  lastAttemptAt?: number | null;
  lastSuccessAt?: number | null;
  lastError?: 'provider-rejected' | 'ambiguous-billing' | 'persistence' | null;
  attributionScope?: string;
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
  entriesPaused: boolean;
  entryPauseReasons: string[];
  dailyReviewRequired: boolean;
  reconciliationReviewRequired: boolean;
  reconciliationCurrent: boolean;
  reconciliation: { at:number; ok:boolean; issues:string[]; broker:{symbol:string;qty:number}[]; ledger:{symbol:string;qty:number}[]; equityGap?:number } | null;
  halted: boolean;
  haltReason: string | null;
  cooldownUntil: number | null;
  dataStale: boolean;
  lastDataAt: number;
  limits: {
    fundMaxDrawdown: number;
    traderMaxDrawdown: number;
    dailyLossLimit: number;
    unprovenTradeRisk: number;
    maxSymbolStopRisk: number;
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

export interface DsaResearchSnapshot {
  enabled: boolean;
  running: boolean;
  shadowOnly: true;
  mode: 'history' | 'submit';
  lastError: string | null;
  attemptedToday: number;
  budgetDay: string;
  dailyCap: number;
  pendingTasks: number;
  exhaustedTasks: number;
  ambiguousSubmissions: number;
  records: {symbol:string;queryId:string;reportId:number|null;createdAt:number;receivedAt:number;
    stale:boolean;action:'buy'|'add'|'hold'|'reduce'|'sell'|'watch'|'avoid'|'alert'|null;sentimentScore:number|null}[];
}

export interface SetupWatchlistSnapshot {
  researchOnly: true;
  status: 'disabled' | 'enabled';
  rows: SetupWatchRow[];
}

export interface SetupWatchRow {
  symbol: string;
  timeframeMs: number;
  asOf: number | null;
  bars: number;
  status: 'match' | 'no-match' | 'insufficient-history' | 'invalid-data' | 'stale' | 'unsupported';
  setups: string[];
}

export interface WorldSnapshot {
  allocationDiagnostics?: {
    waiting: number;
    eligible: number;
    blocked: Record<'parked' | 'market-closed' | 'symbol-owned' | 'trial-cap' | 'frozen' | 'halted', number>;
    parked: (NonNullable<StrategyDTO['parked']> & {strategyId:string;symbol:string;ready:boolean})[];
  };
  runtime?: {
    experiment?: 'hi-intraday-v1';
    artifactFingerprint: string | null;
    identityStatus: 'measured' | 'unavailable';
    nodeVersion: string;
    venue: 'local' | 'alpaca' | 'okx';
    configuredMoneyMode: 'paper' | 'live';
    brokerVerified: false;
  };
  setupWatchlist?: SetupWatchlistSnapshot;
  frozenExperiment?: {
    version: 1;
    fingerprint: string;
    startedAt: number;
    endAt: number;
    criteria: string;
    expired: boolean;
    realDataForward: boolean;
  } | null;
  dsaResearch: DsaResearchSnapshot;
  serverTime: number;
  seasonStartedAt: number;
  mode: 'paper';
  /** Where orders are filled: a local simulator, or the Alpaca paper account. */
  execution: 'local' | 'alpaca' | 'okx';
  /** The real Alpaca account, when it is the venue, so the fund can be checked against it. */
  broker: { equity: number; cash: number; updatedAt: number; gap: number } | null;
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
