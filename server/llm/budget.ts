import type { LlmUsage } from './client';

export interface LlmCostState {
  dayKey: string;
  spentToday: number;
  totalSpent: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function freshCost(): LlmCostState {
  return { dayKey: utcDay(Date.now()), spentToday: 0, totalSpent: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
}

/**
 * Tracks LLM spend and enforces the daily cap. `paused` lets the ecosystem stop
 * the LLM when it is not earning its keep, independently of the budget.
 */
export class LlmBudget {
  paused = false;

  constructor(
    private state: LlmCostState,
    readonly dailyBudget: number,
  ) {}

  /** Replace the tracked state (used when restoring a saved season). */
  load(state: LlmCostState): void {
    this.state = state;
    this.roll();
  }

  private roll(): void {
    const key = utcDay(Date.now());
    if (key !== this.state.dayKey) {
      this.state.dayKey = key;
      this.state.spentToday = 0;
    }
  }

  canSpend(): boolean {
    if (this.paused) return false;
    this.roll();
    return this.dailyBudget <= 0 ? true : this.state.spentToday < this.dailyBudget;
  }

  record(usage: LlmUsage): void {
    this.roll();
    this.state.spentToday += usage.costUsd;
    this.state.totalSpent += usage.costUsd;
    this.state.totalCalls++;
    this.state.totalInputTokens += usage.inputTokens;
    this.state.totalOutputTokens += usage.outputTokens;
  }

  spentToday(): number {
    this.roll();
    return this.state.spentToday;
  }

  totalSpent(): number {
    return this.state.totalSpent;
  }

  snapshot(): LlmCostState {
    this.roll();
    return { ...this.state };
  }
}
