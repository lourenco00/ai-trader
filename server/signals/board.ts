import type { Side } from '../../shared/types';
import { shortId } from '../util/rng';

export type SignalSource = 'news' | 'scout';

export interface Signal {
  id: string;
  source: SignalSource;
  authorId: string;
  authorName: string;
  symbol: string;
  /** long = bullish, short = bearish. */
  direction: Side;
  /** 0..1, how strongly the author believes it. */
  confidence: number;
  headline: string;
  createdAt: number;
  expiresAt: number;
  /** Price when posted, for scoring the call later. */
  refPrice: number | null;
}

export interface SymbolBias {
  /** -1..1: positive = net bullish, negative = net bearish. */
  score: number;
  /** 0..1: how much corroboration there is. */
  strength: number;
  top: Signal | null;
}

/**
 * The village notice board. News analysts and the market scout post directional
 * signals here; strategies, the commander and the risk officer read them. This
 * is the shared context that lets the agents coordinate instead of acting blind.
 */
export class SignalBoard {
  private signals: Signal[] = [];

  restore(signals: Signal[]): void {
    const now = Date.now();
    this.signals = signals.filter((s) => s.expiresAt > now);
  }

  all(): Signal[] {
    this.prune();
    return [...this.signals].sort((a, b) => b.createdAt - a.createdAt);
  }

  post(s: Omit<Signal, 'id' | 'createdAt'>): Signal {
    const sig: Signal = { ...s, id: shortId('sig_'), createdAt: Date.now() };
    // Replace an earlier live signal from the same author on the same symbol.
    this.signals = this.signals.filter((x) => !(x.authorId === sig.authorId && x.symbol === sig.symbol && x.expiresAt > Date.now()));
    this.signals.push(sig);
    this.prune();
    return sig;
  }

  forSymbol(symbol: string): Signal[] {
    const now = Date.now();
    return this.signals.filter((s) => s.symbol === symbol && s.expiresAt > now);
  }

  /**
   * Aggregate opinion on a symbol, decayed toward expiry so stale news fades.
   * Confidence-weighted so a strong, fresh call outweighs several weak old ones.
   */
  bias(symbol: string): SymbolBias {
    const now = Date.now();
    const live = this.forSymbol(symbol);
    if (!live.length) return { score: 0, strength: 0, top: null };
    let num = 0;
    let den = 0;
    for (const s of live) {
      const life = s.expiresAt - s.createdAt;
      const remaining = life > 0 ? Math.max(0, (s.expiresAt - now) / life) : 0;
      const w = s.confidence * remaining;
      num += w * (s.direction === 'long' ? 1 : -1);
      den += w;
    }
    const top = [...live].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
    const score = den > 0 ? num / Math.max(den, 1e-9) : 0;
    return { score, strength: Math.min(1, den), top };
  }

  private prune(): void {
    const now = Date.now();
    if (this.signals.some((s) => s.expiresAt <= now)) this.signals = this.signals.filter((s) => s.expiresAt > now);
    if (this.signals.length > 300) this.signals.splice(0, this.signals.length - 300);
  }

  save(): Signal[] {
    this.prune();
    return this.signals;
  }
}
