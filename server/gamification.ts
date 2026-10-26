import type { AchievementDTO, GraduationCheck } from '../shared/types';

export const ACHIEVEMENTS: { id: string; title: string; description: string }[] = [
  { id: 'first_trade', title: 'First Blood', description: 'A trader opened the first position' },
  { id: 'first_profit', title: 'Money Printer', description: 'First profitable trade closed' },
  { id: 'eureka', title: 'Eureka!', description: 'A strategy passed the holdout test' },
  { id: 'think_tank', title: 'Think Tank', description: '10 strategies discovered' },
  { id: 'big_brain', title: 'Big Brain', description: 'An LLM idea made it into the Vault' },
  { id: 'busy_floor', title: 'Busy Floor', description: '100 trades closed' },
  { id: 'hot_hand', title: 'Hot Hand', description: 'A trader won 5 trades in a row' },
  { id: 'whale', title: 'Whale Catch', description: 'One trade made 1% of starting capital' },
  { id: 'green_5', title: 'In the Green', description: 'Fund up 5% from the start' },
  { id: 'green_25', title: 'Quarter Up', description: 'Fund up 25% from the start' },
  { id: 'survivor', title: 'Survivor', description: '7 days of paper trading' },
  { id: 'veteran', title: 'Veteran', description: 'An agent reached level 10' },
  { id: 'brute_force', title: 'Brute Force', description: '100,000 strategies tested' },
  { id: 'funeral', title: 'Rest in Peace', description: 'First strategy retired to the graveyard' },
  { id: 'circuit_breaker', title: 'Circuit Breaker', description: 'The kill switch was pulled' },
  { id: 'graduate', title: 'Graduate', description: 'Every Real Money License check passed' },
];

export function achievementList(unlocked: Record<string, number>): AchievementDTO[] {
  return ACHIEVEMENTS.map((a) => ({ ...a, unlockedAt: unlocked[a.id] ?? null }));
}

export interface GraduationInput {
  seasonStartedAt: number;
  trades: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number | null;
  provenStrategies: number;
  realData: boolean;
}

/**
 * The "Real Money License": conservative bars the paper fund should clear
 * before anyone considers real capital. Passing it is evidence, not a guarantee.
 */
export function graduation(g: GraduationInput, now = Date.now()): GraduationCheck[] {
  const days = (now - g.seasonStartedAt) / 86_400_000;
  const pctS = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    { id: 'real_data', label: 'Trading on real market data', current: g.realData ? 1 : 0, target: 1, display: g.realData ? 'yes' : 'simulated feed', passed: g.realData },
    { id: 'days', label: 'Days of paper trading', current: days, target: 30, display: `${days.toFixed(1)} / 30`, passed: days >= 30 },
    { id: 'trades', label: 'Closed trades', current: g.trades, target: 100, display: `${g.trades} / 100`, passed: g.trades >= 100 },
    { id: 'return', label: 'Net return after fees', current: g.totalReturn, target: 0, display: pctS(g.totalReturn), passed: g.totalReturn > 0 },
    { id: 'drawdown', label: 'Max drawdown under 15%', current: g.maxDrawdown, target: 0.15, display: pctS(g.maxDrawdown), passed: g.maxDrawdown < 0.15 },
    { id: 'sharpe', label: 'Fund Sharpe ratio of 1.0+', current: g.sharpe ?? 0, target: 1, display: g.sharpe === null ? 'need more data' : g.sharpe.toFixed(2), passed: (g.sharpe ?? 0) >= 1 },
    { id: 'proven', label: 'Strategies profitable after 10+ live trades', current: g.provenStrategies, target: 3, display: `${g.provenStrategies} / 3`, passed: g.provenStrategies >= 3 },
  ];
}
