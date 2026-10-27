import type { GameEvent, NewsKind, TradeDTO } from '../../shared/types';
import type { Broker } from '../broker/broker';
import type { Config } from '../config';
import type { LlmClient } from '../llm/client';
import type { MarketFeed } from '../market/feed';
import type { CoinIntel } from '../market/intel';
import type { Universe } from '../market/universe';
import type { SignalBoard } from '../signals/board';
import type { IndicatorCache } from '../strategy/indicators';
import type { StrategyVault } from '../strategy/vault';
import type { Agent } from './base';

export interface Dataset {
  symbol: string;
  cache: IndicatorCache;
  lastT: number;
  trainEnd: number;
}

export interface EntryRequest {
  traderId: string;
  symbol: string;
  notional: number;
  side: 'long' | 'short';
}

export interface RiskGate {
  approveEntry(req: EntryRequest): { ok: true } | { ok: false; reason: string };
  readonly halted: boolean;
}

export interface FundView {
  equity(): number;
  startingCapital: number;
  grossExposure(): number;
  symbolExposure(symbol: string): number;
  /** Directional notional across all open positions. */
  netExposure(): { long: number; short: number };
}



/** What agents are allowed to see and do. Implemented by Ecosystem. */
export interface EcoContext {
  readonly cfg: Config;
  readonly feed: MarketFeed;
  readonly universe: Universe;
  readonly intel: CoinIntel;
  readonly broker: Broker;
  readonly vault: StrategyVault;
  readonly risk: RiskGate;
  readonly fund: FundView;
  readonly board: SignalBoard;
  readonly llm: LlmClient;
  news(kind: NewsKind, text: string, opts?: { agentId?: string; good?: boolean }): void;
  emit(e: GameEvent): void;
  levelUp(agent: Agent): void;
  dataset(symbol: string): Dataset | null;
  recordTrade(t: TradeDTO): void;
  countEvaluated(n: number): void;
  unlock(achievementId: string): void;
  /** Record that an LLM-driven agent produced value, for the earn-your-keep check. */
  attributeLlm(agentId: string): void;
  /** Is the market for this symbol open now? Crypto is always open; stocks follow US hours. */
  marketOpen(symbol: string): boolean;
}
