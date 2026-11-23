import type { AgentDTO, WorldSnapshot } from '../../../shared/types';

export interface ReadinessView {
  state: string;
  reason: string;
  lastAttemptAt?: number | null;
  lastSuccessAt?: number | null;
  nextRunAt?: number | null;
}

/** Configuration is not evidence of a running worker. Values are display-only. */
export function llmReadiness(s: WorldSnapshot, agentId: string, enabled: boolean): ReadinessView {
  if (!enabled) return { state: 'disabled', reason: 'Not configured or disabled' };
  if (s.llmCost?.paused) return { state: 'paused', reason: s.llmCost.pausedReason ?? 'LLM review required' };
  if (s.llmCost?.dailyBudget > 0 && s.llmCost.spentToday >= s.llmCost.dailyBudget) {
    return { state: 'paused-budget', reason: 'Daily estimated usage budget exhausted' };
  }
  const worker = [...(s.analysts ?? []), ...(s.researchers ?? [])].find(r => r.agentId === agentId);
  const readiness: unknown = worker && 'readiness' in worker ? worker.readiness : undefined;
  if (readiness && typeof readiness === 'object' && 'state' in readiness && 'reason' in readiness &&
      typeof readiness.state === 'string' && typeof readiness.reason === 'string') return readiness as ReadinessView;
  return { state: 'waiting', reason: 'Configured; no current running heartbeat reported' };
}

export function agentReadiness(a: AgentDTO, s: WorldSnapshot): ReadinessView {
  if (a.role === 'strategist' || a.role === 'analyst') {
    const worker = [...(s.analysts ?? []), ...(s.researchers ?? [])].find(r => r.agentId === a.id);
    return llmReadiness(s, a.id, worker?.enabled ?? s.llmEnabled);
  }
  if (a.role === 'researcher') {
    const researcher = s.researchers.find(r => r.agentId === a.id);
    if (researcher?.workState) return {state:researcher.workState,reason:researcher.workState === 'waiting-data' ? 'Waiting for a new completed dataset; no replay work admitted' : researcher.workState === 'resting' ? 'Completed bounded work; resting' : 'Processing an admitted dataset'};
  }
  if (a.role === 'trader') {
    const trader = s.traders.find(t => t.agentId === a.id);
    if (!trader?.strategyId) return { state: 'waiting-strategy', reason: 'No eligible strategy assigned' };
    if (trader.position) return { state: 'managing-position', reason: 'Position management; entry status is separate' };
    if (s.risk.halted || s.risk.entriesPaused) {
      return { state: 'blocked-risk', reason: s.risk.entryPauseReasons?.join('; ') || s.risk.haltReason || 'New entries paused; exits remain available' };
    }
    const market = s.markets.find(m => m.symbol === trader.symbol);
    if (market?.marketOpen === false) return { state: 'waiting-market', reason: `${trader.symbol} market is closed for new entries` };
    if (!(trader.cash > 0)) return { state: 'waiting-funding', reason: 'Assigned strategy has no allocated cash' };
    const last = trader.entryDiagnostics;
    return { state: 'watching', reason: last?.lastReason ? `Last entry evaluation: ${last.lastReason} (not a new signal)` : 'Waiting for a completed-candle signal; no recent evaluation telemetry' };
  }
  return { state: 'last-reported', reason: a.activity };
}
