import type { LiveStats, Metrics, StrategyDTO, StrategyStatus } from '../../shared/types';
import { describeGenome, genomeKey, type Genome } from './genome';

export interface StrategyRecord {
  id: string;
  name: string;
  symbol: string;
  genome: Genome;
  author: string;
  authorId: string;
  origin: 'evolution' | 'llm';
  createdAt: number;
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

export function emptyLive(): LiveStats {
  return { trades: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0, lastTradeAt: null };
}

/** The Strategy Vault: promoted strategies waiting for a trader, the ones in use, and the graveyard. */
export class StrategyVault {
  private items = new Map<string, StrategyRecord>();
  private keys = new Set<string>();

  constructor(
    private capacity: number,
    private graveyardCapacity = 120,
  ) {}

  restore(records: StrategyRecord[]): void {
    for (const r of records) {
      this.items.set(r.id, r);
      this.keys.add(this.dedupeKey(r.symbol, r.genome));
    }
  }

  all(): StrategyRecord[] {
    return [...this.items.values()];
  }

  get(id: string): StrategyRecord | undefined {
    return this.items.get(id);
  }

  private dedupeKey(symbol: string, g: Genome): string {
    return `${symbol}|${genomeKey(g)}`;
  }

  has(symbol: string, g: Genome): boolean {
    return this.keys.has(this.dedupeKey(symbol, g));
  }

  byStatus(status: StrategyStatus): StrategyRecord[] {
    return this.all().filter((s) => s.status === status);
  }

  /**
   * Near-clone detection by behaviour: same market and side, and practically the
   * same trades in both windows. Parameter tweaks of one idea would otherwise
   * fill several trader slots with the same bet.
   */
  private findClone(rec: StrategyRecord): StrategyRecord | undefined {
    return this.all().find(
      (s) =>
        s.status !== 'retired' &&
        s.symbol === rec.symbol &&
        s.genome.side === rec.genome.side &&
        Math.abs(s.train.trades - rec.train.trades) <= 2 &&
        Math.abs(s.test.trades - rec.test.trades) <= 1 &&
        Math.abs(s.train.totalReturn - rec.train.totalReturn) < 0.02 &&
        Math.abs(s.test.totalReturn - rec.test.totalReturn) < 0.01,
    );
  }

  /** Adds a promoted strategy. Returns false when it is a duplicate, a weaker clone, or worse than everything in a full vault. */
  add(rec: StrategyRecord): boolean {
    const key = this.dedupeKey(rec.symbol, rec.genome);
    if (this.keys.has(key)) return false;
    const clone = this.findClone(rec);
    if (clone) {
      // Keep the better twin; an active one is never swapped out from under its trader.
      if (clone.status !== 'vault' || clone.fitness >= rec.fitness) {
        this.keys.add(key);
        return false;
      }
      this.items.delete(clone.id);
    }
    const waiting = this.byStatus('vault');
    if (waiting.length >= this.capacity) {
      const worst = waiting.reduce((a, b) => (a.fitness < b.fitness ? a : b));
      if (worst.fitness >= rec.fitness) return false;
      this.items.delete(worst.id); // evicted quietly: it never traded
    }
    this.items.set(rec.id, rec);
    this.keys.add(key);
    return true;
  }

  /**
   * Best waiting strategy, preferring coins that are not crowded yet. No coin
   * gets more than `maxPerSymbol` traders, so one market can't dominate the floor.
   */
  bestAvailable(activeSymbols: string[], maxPerSymbol: number, isOpen: (symbol: string) => boolean = () => true): StrategyRecord | undefined {
    const counts = new Map<string, number>();
    for (const s of activeSymbols) counts.set(s, (counts.get(s) ?? 0) + 1);
    const waiting = this.byStatus('vault').filter((s) => (counts.get(s.symbol) ?? 0) < maxPerSymbol && isOpen(s.symbol));
    if (!waiting.length) return undefined;
    return waiting
      .map((s) => ({ s, score: s.fitness - 0.5 * (counts.get(s.symbol) ?? 0) }))
      .sort((a, b) => b.score - a.score)[0].s;
  }

  /** Put an untested active strategy back on the shelf (used when a much better one shows up). */
  shelve(id: string): void {
    const s = this.items.get(id);
    if (!s) return;
    s.status = 'vault';
    s.traderId = null;
  }

  assign(id: string, traderId: string): void {
    const s = this.items.get(id);
    if (!s) throw new Error(`vault: unknown strategy ${id}`);
    s.status = 'active';
    s.traderId = traderId;
  }

  retire(id: string, reason: string, epitaph: string): StrategyRecord | undefined {
    const s = this.items.get(id);
    if (!s) return undefined;
    s.status = 'retired';
    s.traderId = null;
    s.retiredAt = Date.now();
    s.retiredReason = reason;
    s.epitaph = epitaph;
    const graves = this.byStatus('retired').sort((a, b) => (a.retiredAt ?? 0) - (b.retiredAt ?? 0));
    while (graves.length > this.graveyardCapacity) {
      const old = graves.shift();
      if (old) this.items.delete(old.id); // keep the dedupe key so it is not rediscovered
    }
    return s;
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
    this.keys.clear();
  }
}

export function toStrategyDTO(s: StrategyRecord): StrategyDTO {
  return {
    id: s.id,
    name: s.name,
    symbol: s.symbol,
    side: s.genome.side,
    author: s.author,
    authorId: s.authorId,
    origin: s.origin,
    createdAt: s.createdAt,
    rules: describeGenome(s.genome),
    fitness: s.fitness,
    train: s.train,
    test: s.test,
    live: s.live,
    status: s.status,
    traderId: s.traderId,
    retiredAt: s.retiredAt,
    retiredReason: s.retiredReason,
    epitaph: s.epitaph,
  };
}
