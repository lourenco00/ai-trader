import type { Appearance, Metrics, ResearcherDTO } from '../../shared/types';
import { backtest, fitness, type BacktestOptions } from '../strategy/backtest';
import {
  classicGenomes,
  crossover,
  describeGenome,
  genomeKey,
  mutate,
  randomGenome,
  strategyName,
  SPECIALTY_LABEL,
  type Genome,
  type Specialty,
} from '../strategy/genome';
import { emptyLive, type StrategyRecord } from '../strategy/vault';
import { Rng, shortId } from '../util/rng';
import { Agent } from './base';
import type { Dataset, EcoContext } from './context';

interface Scored {
  genome: Genome;
  fitness: number;
}

export interface Validation {
  train: Metrics;
  test: Metrics;
  fitness: number;
  passed: boolean;
  /** Passes the original train + holdout checks, before the walk-forward and multiple-testing rules. */
  passedBasic: boolean;
  needSharpe: number;
  why: string;
}

/** Sharpe of just holding the asset over [from, to). The yardstick a long strategy must beat. */
export function holdSharpe(close: ArrayLike<number>, from: number, to: number, barsPerYear: number): number {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    if (!(close[i - 1] > 0) || !(close[i] > 0)) continue;
    const r = close[i] / close[i - 1] - 1;
    n++;
    sum += r;
    sum2 += r * r;
  }
  if (n < 2) return 0;
  const m = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - m * m));
  return sd > 0 ? (m / sd) * Math.sqrt(barsPerYear) : 0;
}

export function backtestOptions(ctx: EcoContext, symbol: string): BacktestOptions {
  return { feeRate: ctx.universe.feeRate(symbol), slippage: ctx.universe.slippage(symbol), barsPerYear: ctx.universe.barsPerYear(symbol) };
}

/** Full train + untouched holdout check. The holdout is the most recent 30% of history. */
export function validate(ctx: EcoContext, data: Dataset, g: Genome): Validation {
  const opts = backtestOptions(ctx, data.symbol);
  const p = ctx.universe.promotion(data.symbol);
  const train = backtest(data.cache, g, 0, data.trainEnd, opts).metrics;
  const test = backtest(data.cache, g, data.trainEnd, data.cache.length, opts).metrics;
  // Walk-forward: the holdout in two halves, judged separately.
  const mid = data.trainEnd + Math.floor((data.cache.length - data.trainEnd) / 2);
  const early = backtest(data.cache, g, data.trainEnd, mid, opts).metrics;
  const late = backtest(data.cache, g, mid, data.cache.length, opts).metrics;
  const fails: string[] = [];
  if (g.side === 'short' && !ctx.universe.shortable(data.symbol)) fails.push(`${data.symbol} cannot be shorted`);
  if (train.trades < p.minTrainTrades) fails.push(`train trades ${train.trades}<${p.minTrainTrades}`);
  if (train.sharpe < p.minTrainSharpe) fails.push(`train Sharpe ${train.sharpe.toFixed(2)}`);
  if (train.profitFactor < p.minProfitFactor) fails.push(`train PF ${train.profitFactor.toFixed(2)}`);
  if (test.trades < p.minTestTrades) fails.push(`test trades ${test.trades}<${p.minTestTrades}`);
  if (test.sharpe < p.minTestSharpe) fails.push(`test Sharpe ${test.sharpe.toFixed(2)}`);
  if (test.totalReturn <= p.minTestReturn) fails.push(`test return ${(test.totalReturn * 100).toFixed(1)}%`);
  if (test.maxDrawdown > p.maxTestDrawdown) fails.push(`test DD ${(test.maxDrawdown * 100).toFixed(0)}%`);
  if (test.profitFactor < p.minProfitFactor) fails.push(`test PF ${test.profitFactor.toFixed(2)}`);
  const passedBasic = fails.length === 0;
  const looks = ctx.universe.noteLook(data.symbol);
  const years = Math.max(0.05, (data.cache.length - data.trainEnd) / ctx.universe.barsPerYear(data.symbol));
  const haircut = (0.5 * Math.sqrt(2 * Math.log(Math.max(2, looks)))) / Math.sqrt(years);
  const needSharpe = Math.min(p.maxRequiredSharpe, p.minTestSharpe + haircut);
  if (test.sharpe < needSharpe) fails.push(`holdout Sharpe ${test.sharpe.toFixed(2)} < ${needSharpe.toFixed(2)} needed after ${looks} looks`);
  for (const [name, h] of [['first', early], ['second', late]] as const) {
    if (h.trades < p.minHalfTrades) fails.push(`${name} half only ${h.trades} trades`);
    else if (h.totalReturn <= 0) fails.push(`${name} half lost ${(h.totalReturn * 100).toFixed(1)}%`);
  }
  // A long strategy that does no better than simply holding through a rally has shown no skill, only a rising market.
  if (g.side === 'long') {
    const bench = holdSharpe(data.cache.c, data.trainEnd, data.cache.length, ctx.universe.barsPerYear(data.symbol));
    if (test.sharpe <= bench) fails.push(`holdout Sharpe ${test.sharpe.toFixed(2)} no better than buy-and-hold ${bench.toFixed(2)}`);
  }
  const score = 0.5 * fitness(train, p.minTrainTrades) + 0.5 * fitness(test, p.minTestTrades);
  return { train, test, fitness: score, passed: fails.length === 0, passedBasic, needSharpe, why: fails.join(', ') };
}

export function makeRecord(
  data: Dataset,
  g: Genome,
  v: Validation,
  author: { id: string; name: string },
  origin: 'evolution' | 'llm',
  trial = false,
): StrategyRecord {
  return {
    id: shortId('s_'),
    name: strategyName(g, data.symbol),
    symbol: data.symbol,
    genome: g,
    author: author.name,
    authorId: author.id,
    origin,
    trial,
    createdAt: Date.now(),
    fitness: v.fitness,
    train: v.train,
    test: v.test,
    live: emptyLive(),
    status: 'vault',
    traderId: null,
    retiredAt: null,
    retiredReason: null,
    epitaph: null,
  };
}

/**
 * Runs a genetic algorithm over strategy genomes. Each epoch: pick a symbol,
 * evolve on the training window, then test the best few on the holdout.
 * At most one strategy is promoted per epoch to limit lucky survivors.
 */
export class Researcher extends Agent {
  private rng = new Rng();
  private population: Genome[] = [];
  private scored: Scored[] = [];
  private immigrants: Genome[] = [];
  private data: Dataset | null = null;
  private restUntil = 0;
  private bestEver: Scored | null = null;
  private epochSymbol: string | null = null;

  generation = 0;
  epoch = 0;
  evaluated = 0;
  discoveries = 0;
  symbol: string;
  lastResult = 'Just arrived at the lab';

  constructor(
    ctx: EcoContext,
    id: string,
    name: string,
    appearance: Appearance,
    readonly specialty: Specialty,
    private offset: number,
  ) {
    super(ctx, id, name, 'researcher', `${SPECIALTY_LABEL[specialty]} Researcher`, 'lab', appearance);
    this.symbol = ctx.cfg.symbols[offset % ctx.cfg.symbols.length];
  }

  receive(genomes: Genome[]): void {
    this.immigrants.push(...genomes.map((g) => structuredClone(g)));
    if (this.immigrants.length > 6) this.immigrants.splice(0, this.immigrants.length - 6);
  }

  /** Cooperative slice of work; returns quickly so the event loop stays responsive. */
  work(budgetMs: number): void {
    const now = Date.now();
    if (now < this.restUntil) {
      this.location = 'hall';
      this.mood = 'neutral';
      this.activity = `Coffee break, back in ${Math.ceil((this.restUntil - now) / 1000)}s`;
      return;
    }
    if (!this.data && !this.beginEpoch()) return;
    const data = this.data;
    if (!data) return;
    this.location = 'lab';
    this.mood = 'happy';

    const deadline = performance.now() + budgetMs;
    let n = 0;
    while (performance.now() < deadline) {
      if (this.scored.length < this.population.length) {
        this.evaluate(data, this.population[this.scored.length]);
        n++;
        continue;
      }
      this.generation++;
      this.addXp(0.5);
      if (this.generation >= this.ctx.cfg.research.generationsPerEpoch) {
        this.finishEpoch(data);
        break;
      }
      this.breed();
    }
    if (n) this.ctx.countEvaluated(n);
    const best = this.bestEver;
    this.activity = `Evolving ${this.symbol} gen ${this.generation + 1}/${this.ctx.cfg.research.generationsPerEpoch}` +
      (best ? `, best score ${best.fitness.toFixed(2)}` : '');
  }

  private beginEpoch(): boolean {
    // Least recently researched first, so a newly explored market gets attention right away.
    this.symbol = this.ctx.universe.pickForResearch(this.ctx.cfg.symbols, this.epoch + this.offset);
    const data = this.ctx.dataset(this.symbol);
    if (!data) {
      this.ctx.universe.finishResearch(this.symbol);
      this.activity = `Waiting for ${this.symbol} data`;
      return false;
    }
    this.epochSymbol = this.symbol;
    this.data = data;
    this.generation = 0;
    this.scored = [];
    this.bestEver = null;

    const size = this.ctx.cfg.research.populationSize;
    // Each epoch starts mostly fresh. Carrying whole populations forward keeps
    // optimising against the same training window and overfits it.
    const seeds: Genome[] = [...classicGenomes(this.specialty)];
    // Reuse knowledge: variants of our own surviving strategies on this symbol.
    const mine = this.ctx.vault
      .all()
      .filter((s) => s.authorId === this.id && s.symbol === this.symbol && s.status !== 'retired')
      .slice(0, 3);
    for (const s of mine) seeds.push(mutate(this.rng, s.genome, this.specialty, 0.6));
    seeds.push(...this.immigrants.splice(0));
    while (seeds.length < size) seeds.push(randomGenome(this.rng, this.specialty));
    this.population = dedupe(seeds).slice(0, size);
    while (this.population.length < size) this.population.push(randomGenome(this.rng, this.specialty));
    return true;
  }

  private evaluate(data: Dataset, g: Genome): void {
    // Shorting is not assumed possible outside the core majors; don't spend CPU on it.
    if (g.side === 'short' && !this.ctx.universe.shortable(data.symbol)) {
      this.scored.push({ genome: g, fitness: -10 });
      this.evaluated++;
      return;
    }
    const opts = backtestOptions(this.ctx, data.symbol);
    const folds = 3;
    const minTrades = Math.ceil(this.ctx.universe.promotion(data.symbol).minTrainTrades / folds);
    // Score each fold of the training window separately. Weighting the worst fold
    // heavily favours strategies that hold up across regimes instead of one lucky stretch.
    const scores: number[] = [];
    for (let k = 0; k < folds; k++) {
      const from = Math.floor((data.trainEnd * k) / folds);
      const to = Math.floor((data.trainEnd * (k + 1)) / folds);
      scores.push(fitness(backtest(data.cache, g, from, to, opts).metrics, minTrades));
    }
    const mean = scores.reduce((a, b) => a + b, 0) / folds;
    // Occam penalty: every extra rule is another chance to curve-fit.
    const complexity = 0.08 * (g.entry.length + g.exit.length - 1);
    const f = 0.6 * Math.min(...scores) + 0.4 * mean - complexity;
    const s = { genome: g, fitness: Number.isFinite(f) ? f : -10 };
    this.scored.push(s);
    this.evaluated++;
    if (!this.bestEver || s.fitness > this.bestEver.fitness) this.bestEver = s;
  }

  private tournament(k = 3): Genome {
    let best: Scored | null = null;
    for (let i = 0; i < k; i++) {
      const c = this.rng.pick(this.scored);
      if (!best || c.fitness > best.fitness) best = c;
    }
    return (best as Scored).genome;
  }

  private breed(): void {
    const size = this.ctx.cfg.research.populationSize;
    const ranked = [...this.scored].sort((x, y) => y.fitness - x.fitness);
    const next: Genome[] = ranked.slice(0, 3).map((s) => s.genome);
    next.push(...this.immigrants.splice(0, 3));
    const keys = new Set(next.map(genomeKey));
    let guard = 0;
    while (next.length < size && guard++ < size * 10) {
      let child: Genome;
      if (this.rng.chance(0.1)) {
        child = randomGenome(this.rng, this.specialty);
      } else {
        const p1 = this.tournament();
        child = this.rng.chance(0.6) ? crossover(this.rng, p1, this.tournament()) : p1;
        if (this.rng.chance(0.9)) child = mutate(this.rng, child, this.specialty);
      }
      const key = genomeKey(child);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(child);
    }
    while (next.length < size) next.push(randomGenome(this.rng, this.specialty));
    this.population = next;
    this.scored = [];
  }

  private finishEpoch(data: Dataset): void {
    const ranked = [...this.scored].sort((x, y) => y.fitness - x.fitness);
    if (this.bestEver && !ranked.includes(this.bestEver)) ranked.unshift(this.bestEver);
    const seen = new Set<string>();
    const candidates = ranked.filter((s) => {
      const k = genomeKey(s.genome);
      // Loose pre-filter; the train + holdout gate in validate() is the real judge.
      if (seen.has(k) || s.fitness <= -1) return false;
      seen.add(k);
      return true;
    });

    let promoted: StrategyRecord | null = null;
    let trialPick: { genome: Genome; v: Validation } | null = null;
    let closest: Validation | null = null;
    for (const c of candidates.slice(0, 5)) {
      if (this.ctx.vault.has(data.symbol, c.genome)) continue;
      const v = validate(this.ctx, data, c.genome);
      if (!closest || v.fitness > closest.fitness) closest = v;
      // Positive on the holdout but short of the strict gate: keep the best as a small trial.
      if (!v.passed && v.passedBasic && (!trialPick || v.fitness > trialPick.v.fitness)) trialPick = { genome: c.genome, v };
      if (!v.passed) continue;
      const rec = makeRecord(data, c.genome, v, this, 'evolution');
      if (this.ctx.vault.add(rec)) {
        promoted = rec;
        break;
      }
    }
    let trialRec: StrategyRecord | null = null;
    if (!promoted && trialPick) {
      const rec = makeRecord(data, trialPick.genome, trialPick.v, this, 'evolution', true);
      if (this.ctx.vault.add(rec)) trialRec = rec;
    }

    const label = `Epoch ${this.epoch + 1} on ${data.symbol}`;
    if (promoted) {
      this.discoveries++;
      this.addXp(60);
      this.mood = 'excited';
      this.lastResult = `${label}: promoted ${promoted.name} (holdout Sharpe ${promoted.test.sharpe.toFixed(2)}, ${pct(promoted.test.totalReturn)})`;
      this.ctx.news('discovery', `${this.name} discovered "${promoted.name}" for ${promoted.symbol}: holdout ${pct(promoted.test.totalReturn)}, Sharpe ${promoted.test.sharpe.toFixed(2)}`, { agentId: this.id, good: true });
      this.ctx.emit({ kind: 'discovery', agentId: this.id, text: `Eureka! ${promoted.name}`, building: 'vault' });
      this.ctx.unlock('eureka');
    } else if (trialRec) {
      this.addXp(15);
      this.lastResult = `${label}: ${trialRec.name} goes on trial (holdout ${pct(trialRec.test.totalReturn)}, short of the strict gate: ${trialPick?.v.why.slice(0, 60)})`;
      this.ctx.news('discovery', `${this.name}'s "${trialRec.name}" (${trialRec.symbol}) is on trial: positive holdout, but below the strict gate`, { agentId: this.id });
    } else if (candidates.length === 0) {
      this.lastResult = `${label}: nothing beat fees in training`;
    } else {
      this.lastResult = `${label}: best candidate failed holdout${closest ? ` (${closest.why})` : ''}`;
    }
    this.epoch++;
    if (this.epochSymbol) this.ctx.universe.finishResearch(this.epochSymbol);
    this.epochSymbol = null;
    this.data = null;
    this.population = [];
    this.scored = [];
    this.restUntil = Date.now() + this.ctx.cfg.research.restBetweenEpochsMs;
  }

  toResearcherDTO(): ResearcherDTO {
    return {
      agentId: this.id,
      name: this.name,
      specialty: SPECIALTY_LABEL[this.specialty],
      symbol: this.symbol,
      generation: this.generation,
      generationsPerEpoch: this.ctx.cfg.research.generationsPerEpoch,
      epoch: this.epoch,
      evaluated: this.evaluated,
      discoveries: this.discoveries,
      bestFitness: this.bestEver ? this.bestEver.fitness : null,
      bestTrainSharpe: null,
      bestRules: this.bestEver ? describeGenome(this.bestEver.genome) : [],
      lastResult: this.lastResult,
      origin: 'evolution',
      enabled: true,
    };
  }

  stats(): Record<string, string | number> {
    return {
      Specialty: SPECIALTY_LABEL[this.specialty],
      Symbol: this.symbol,
      Epoch: this.epoch,
      'Strategies tested': this.evaluated,
      Discoveries: this.discoveries,
      'Last result': this.lastResult,
    };
  }

  protected saveExtra(): unknown {
    return { evaluated: this.evaluated, discoveries: this.discoveries, epoch: this.epoch, lastResult: this.lastResult };
  }

  protected restoreExtra(extra: unknown): void {
    const e = extra as Partial<{ evaluated: number; discoveries: number; epoch: number; lastResult: string }>;
    this.evaluated = Number(e.evaluated) || 0;
    this.discoveries = Number(e.discoveries) || 0;
    this.epoch = Number(e.epoch) || 0;
    if (typeof e.lastResult === 'string') this.lastResult = e.lastResult;
  }

  resetResearch(): void {
    this.immigrants = [];
    this.data = null;
    this.epochSymbol = null;
    this.discoveries = 0;
  }
}

function dedupe(gs: Genome[]): Genome[] {
  const seen = new Set<string>();
  return gs.filter((g) => {
    const k = genomeKey(g);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function pct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}
