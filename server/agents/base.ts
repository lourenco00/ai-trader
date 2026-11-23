import type { AgentDTO, AgentRole, Appearance, BuildingId, Mood } from '../../shared/types';
import type { EcoContext } from './context';

/** Cumulative XP needed to reach `level`. Level 2 = 100xp, level 10 ≈ 3.4k xp. */
export function xpForLevel(level: number): number {
  return Math.round(100 * Math.max(0, level - 1) ** 1.6);
}

/** Exact threshold search; bounded even for the largest supported historical XP. */
function levelForXp(xp: number): number {
  let lo = 1;
  let hi = Math.ceil((Number.MAX_SAFE_INTEGER / 100) ** (1 / 1.6)) + 2;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (xpForLevel(mid) <= xp) lo = mid;
    else hi = mid;
  }
  return lo;
}

function validXp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value)) : 0;
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
  private _activity = 'Waking up';
  activityAt: number | null = null;
  lastWorkAt: number | null = null;

  get activity(): string { return this._activity; }
  set activity(value: string) {
    if (value !== this._activity) {
      this._activity = value;
      this.activityAt = Date.now();
    }
  }

  /** Genuine work heartbeat, independent of prose changes and activity XP. */
  markWork(): void { this.lastWorkAt = Date.now(); }
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
    if (!Number.isFinite(amount) || !(amount > 0)) return;
    this.xp = validXp(this.xp + Math.min(amount, Number.MAX_SAFE_INTEGER));
    const nextLevel = levelForXp(this.xp);
    if (nextLevel > this.level) {
      // One notification per reward, not millions of replayed historical milestones.
      this.level = nextLevel;
      this.ctx.levelUp(this);
    }
  }

  abstract stats(): Record<string, string | number>;

  save(): AgentSave {
    return { id: this.id, xp: this.xp, level: this.level, extra: this.saveExtra() };
  }

  restore(s: AgentSave): void {
    this.xp = validXp(s.xp);
    this.level = levelForXp(this.xp);
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
      activityAt: this.activityAt,
      lastWorkAt: this.lastWorkAt,
      mood: this.mood,
      appearance: this.appearance,
      stats: this.stats(),
    };
  }
}
