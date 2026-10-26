import type { AgentDTO, AgentRole, Appearance, BuildingId, Mood } from '../../shared/types';
import type { EcoContext } from './context';

/** Cumulative XP needed to reach `level`. Level 2 = 100xp, level 10 ≈ 3.4k xp. */
export function xpForLevel(level: number): number {
  return Math.round(100 * Math.max(0, level - 1) ** 1.6);
}

export interface AgentSave {
  id: string;
  xp: number;
  level: number;
  extra?: unknown;
}

export abstract class Agent {
  xp = 0;
  level = 1;
  activity = 'Waking up';
  mood: Mood = 'neutral';
  location: BuildingId;

  constructor(
    protected ctx: EcoContext,
    readonly id: string,
    readonly name: string,
    readonly role: AgentRole,
    readonly title: string,
    readonly home: BuildingId,
    readonly appearance: Appearance,
  ) {
    this.location = home;
  }

  addXp(amount: number): void {
    if (!(amount > 0)) return;
    this.xp += amount;
    while (this.xp >= xpForLevel(this.level + 1)) {
      this.level++;
      this.ctx.levelUp(this);
    }
  }

  abstract stats(): Record<string, string | number>;

  save(): AgentSave {
    return { id: this.id, xp: this.xp, level: this.level, extra: this.saveExtra() };
  }

  restore(s: AgentSave): void {
    this.xp = Math.max(0, Number(s.xp) || 0);
    this.level = Math.max(1, Math.floor(Number(s.level) || 1));
    if (s.extra !== undefined) this.restoreExtra(s.extra);
  }

  protected saveExtra(): unknown {
    return undefined;
  }

  protected restoreExtra(_extra: unknown): void {}

  toDTO(): AgentDTO {
    const cur = xpForLevel(this.level);
    const next = xpForLevel(this.level + 1);
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      title: this.title,
      home: this.home,
      location: this.location,
      level: this.level,
      xp: Math.floor(this.xp),
      xpForLevel: cur,
      xpToNext: next,
      activity: this.activity,
      mood: this.mood,
      appearance: this.appearance,
      stats: this.stats(),
    };
  }
}
