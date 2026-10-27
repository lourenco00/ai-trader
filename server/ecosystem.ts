import path from 'node:path';
import type {
  EquityPoint,
  GameEvent,
  NewsItem,
  NewsKind,
  ServerMessage,
  TradeDTO,
  WorldSnapshot,
} from '../shared/types';
import type { Agent, AgentSave } from './agents/base';
import { Commander } from './agents/commander';
import { Explorer } from './agents/explorer';
import type { Dataset, EcoContext, FundView } from './agents/context';
import { NewsDesk } from './agents/newsDesk';
import { Researcher } from './agents/researcher';
import { RiskOfficer } from './agents/riskOfficer';
import { Strategist } from './agents/strategist';
import { Reporter, Scout, Treasurer } from './agents/support';
import { Trader } from './agents/trader';
import { AlpacaBroker, AlpacaClient } from './broker/alpaca';
import { PaperBroker, type Broker } from './broker/broker';
import type { Config } from './config';
import { achievementList, ACHIEVEMENTS, graduation } from './gamification';
import { LlmClient } from './llm/client';
import { freshCost, LlmBudget, type LlmCostState } from './llm/budget';
import { MarketFeed } from './market/feed';
import { Universe, type UniverseSave } from './market/universe';
import { NEWS_ANCHORS, RESEARCHERS, STAFF, TRADERS } from './roster';
import { SignalBoard, type Signal } from './signals/board';
import { IndicatorCache } from './strategy/indicators';
import { StrategyVault, toStrategyDTO, type StrategyRecord } from './strategy/vault';
import { logger } from './util/log';
import { appendJsonLine, backupFile, readJson, writeJsonAtomic } from './util/persist';
import { shortId } from './util/rng';

const log = logger('eco');

interface FundState {
  startingCapital: number;
  reserve: number;
  peakEquity: number;
  maxDrawdown: number;
  dayKey: string;
  dayStartEquity: number;
  fees: number;
  realizedPnl: number;
  trades: number;
  wins: number;
  grossWin: number;
  grossLoss: number;
}

interface LlmAttribution {
  /** Realised P&L of trades whose strategy or signal came from the LLM, per day key. */
  byDay: Record<string, number>;
  total: number;
}

interface SaveFile {
  version: 1;
  savedAt: number;
  seasonStartedAt: number;
  fund: FundState;
  agents: AgentSave[];
  strategies: StrategyRecord[];
  trades: TradeDTO[];
  news: NewsItem[];
  signals: Signal[];
  equity: EquityPoint[];
  unlocked: Record<string, number>;
  totals: WorldSnapshot['totals'];
  lastEdition: { equity: number; trades: number; fees: number };
  llmCost: LlmCostState;
  llmAttribution: LlmAttribution;
  universe?: UniverseSave;
}

const MAX_NEWS = 300;
const MAX_TRADES = 500;
const MAX_EQUITY_POINTS = 20_000;

function utcDayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function freshFund(capital: number): FundState {
  return {
    startingCapital: capital,
    reserve: capital,
    peakEquity: capital,
    maxDrawdown: 0,
    dayKey: utcDayKey(Date.now()),
    dayStartEquity: capital,
    fees: 0,
    realizedPnl: 0,
    trades: 0,
    wins: 0,
    grossWin: 0,
    grossLoss: 0,
  };
}

export class Ecosystem implements EcoContext {
  readonly feed: MarketFeed;
  readonly universe: Universe;
  readonly broker: Broker;
  readonly vault: StrategyVault;
  readonly fund: FundView;
  readonly board = new SignalBoard();
  readonly llm: LlmClient;

  private alpaca: AlpacaClient | null = null;
  private fundState: FundState;
  private llmBudget: LlmBudget;
  private llmCost: LlmCostState;
  private llmAttribution: LlmAttribution = { byDay: {}, total: 0 };
  readonly traders: Trader[] = [];
  readonly researchers: Researcher[] = [];
  private analysts: NewsDesk[] = [];
  private riskOfficer!: RiskOfficer;
  private commander!: Commander;
  private scout!: Scout;
  private explorer!: Explorer;
  private reporter!: Reporter;
  private treasurer!: Treasurer;
  private strategist!: Strategist;
  private agents: Agent[] = [];
  private llmPausedReason: string | null = null;
  private stockMarketOpen = true;
  private capital: number;
  private lastBrokerCheck = 0;

  private trades: TradeDTO[] = [];
  private newsItems: NewsItem[] = [];
  private equity: EquityPoint[] = [];
  private unlocked: Record<string, number> = {};
  private totals = { genomesEvaluated: 0, strategiesDiscovered: 0, strategiesRetired: 0 };
  private lastEdition = { equity: 0, trades: 0, fees: 0 };
  private seasonStartedAt = Date.now();
  private datasets = new Map<string, Dataset>();
  private listeners: ((m: ServerMessage) => void)[] = [];
  private timers: NodeJS.Timeout[] = [];
  private researchTimer: NodeJS.Timeout | null = null;
  private stateFile: string;
  private tradesFile: string;
  private saving = false;
  private started = false;

  constructor(readonly cfg: Config) {
    if (cfg.execution === 'alpaca' || cfg.provider === 'alpaca' || cfg.universe.scanStocks) this.alpaca = new AlpacaClient(cfg);
    this.universe = new Universe(cfg);
    this.feed = new MarketFeed(cfg, this.alpaca);
    this.broker = cfg.execution === 'alpaca' && this.alpaca ? new AlpacaBroker(this.alpaca) : new PaperBroker(cfg.feeRate, cfg.slippage, (s) => this.universe.slippage(s));
    this.vault = new StrategyVault(cfg.research.vaultCapacity);
    this.capital = cfg.startingCapital;
    this.fundState = freshFund(this.capital);
    this.llmCost = freshCost();
    this.llmBudget = new LlmBudget(this.llmCost, cfg.llm.dailyBudgetUsd);
    this.llm = new LlmClient(cfg, this.llmBudget);
    this.stateFile = path.join(cfg.dataDir, 'state.json');
    this.tradesFile = path.join(cfg.dataDir, 'trades.jsonl');
    const self = this;
    this.fund = {
      equity: () => self.fundEquity(),
      get startingCapital() {
        return self.fundState.startingCapital;
      },
      grossExposure: () => self.traders.reduce((s, t) => s + t.notional(), 0),
      symbolExposure: (symbol: string) =>
        self.traders.reduce((s, t) => s + (t.wallet.position?.symbol === symbol ? t.notional() : 0), 0),
      netExposure: () => {
        let long = 0;
        let short = 0;
        for (const t of self.traders) {
          const p = t.wallet.position;
          if (!p) continue;
          if (p.side === 'long') long += t.notional();
          else short += t.notional();
        }
        return { long, short };
      },
    };
  }

  get risk(): RiskOfficer {
    return this.riskOfficer;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const saved = await readJson<SaveFile>(this.stateFile);
    if (saved && saved.version === 1) {
      this.fundState = { ...freshFund(saved.fund.startingCapital), ...saved.fund };
      this.vault.restore(saved.strategies ?? []);
      this.trades = saved.trades ?? [];
      this.newsItems = saved.news ?? [];
      this.equity = saved.equity ?? [];
      this.unlocked = saved.unlocked ?? {};
      this.totals = { ...this.totals, ...saved.totals };
      this.seasonStartedAt = saved.seasonStartedAt ?? Date.now();
      this.lastEdition = saved.lastEdition ?? this.lastEdition;
      if (saved.signals) this.board.restore(saved.signals);
      if (saved.llmCost) this.llmBudget.load({ ...freshCost(), ...saved.llmCost });
      if (saved.llmAttribution) this.llmAttribution = saved.llmAttribution;
      log.info(`restored season from ${new Date(saved.savedAt).toISOString()} (${this.vault.all().length} strategies)`);
    }

    if (!saved && this.cfg.execution === 'alpaca' && this.alpaca) await this.fundFromAlpaca();
    const savedExplored = this.universe.restoreFacts(saved?.universe);
    await this.feed.start();
    await this.rehydrateUniverse(savedExplored);
    this.createAgents();
    if (saved?.agents) {
      const byId = new Map(saved.agents.map((a) => [a.id, a]));
      for (const a of this.agents) {
        const s = byId.get(a.id);
        if (s) a.restore(s);
      }
      this.reclaimOrphanWallets(saved.agents);
    }
    this.reconcile();
    this.scout.init();
    if (!this.lastEdition.equity) this.lastEdition = { equity: this.fundEquity(), trades: 0, fees: 0 };

    this.feed.onTick(() => this.onTick());
    this.feed.onCandle((symbol) => this.onCandle(symbol));

    this.timers.push(setInterval(() => void this.fastLoop(), 15_000));
    this.timers.push(setInterval(() => this.minuteLoop(), 60_000));
    this.timers.push(setInterval(() => void this.save(), 30_000));
    this.scheduleResearch();
    this.started = true;
    this.news('system', `The valley wakes up. Paper fund at $${this.fundEquity().toFixed(2)}, market data from ${this.feed.provider.name}`, { good: true });
    this.minuteLoop();
    void this.fastLoop();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.researchTimer) clearTimeout(this.researchTimer);
    this.feed.stop();
    if (this.started) await this.save();
  }

  private createAgents(): void {
    const cfg = this.cfg;
    this.riskOfficer = new RiskOfficer(this, STAFF.risk.id, STAFF.risk.name, STAFF.risk.look, this.traders, this.fundState);
    for (const t of TRADERS.slice(0, cfg.traders)) this.traders.push(new Trader(this, t.id, t.name, t.look));
    RESEARCHERS.slice(0, cfg.researchers).forEach((r, i) => {
      this.researchers.push(new Researcher(this, r.id, r.name, r.look, r.specialty, i));
    });
    this.commander = new Commander(this, STAFF.commander.id, STAFF.commander.name, STAFF.commander.look, this.traders, this.fundState);
    this.scout = new Scout(this, STAFF.scout.id, STAFF.scout.name, STAFF.scout.look);
    this.explorer = new Explorer(this, STAFF.explorer.id, STAFF.explorer.name, STAFF.explorer.look, this.alpaca);
    this.universe.onChange((c) => this.onUniverseChange(c));
    this.reporter = new Reporter(this, STAFF.reporter.id, STAFF.reporter.name, STAFF.reporter.look);
    this.treasurer = new Treasurer(this, STAFF.treasurer.id, STAFF.treasurer.name, STAFF.treasurer.look);
    this.strategist = new Strategist(this, STAFF.strategist.id, STAFF.strategist.name, STAFF.strategist.look);
    this.strategist.marketBrief = () => this.scout.brief();
    this.strategist.shareIdeas = (ideas) => {
      for (const r of this.researchers) r.receive(ideas.filter((x) => x.symbol === r.symbol).map((x) => x.genome));
    };
    for (const a of NEWS_ANCHORS) this.analysts.push(new NewsDesk(this, a.id, a.name, a.beat, a.look));
    this.agents = [
      this.commander,
      this.riskOfficer,
      this.scout,
      this.explorer,
      this.reporter,
      this.treasurer,
      this.strategist,
      ...this.analysts,
      ...this.researchers,
      ...this.traders,
    ];
  }

  /**
   * With Alpaca as the venue the money comes from the Alpaca paper account: the fund starts
   * with the account's cash, capped by STARTING_CAPITAL so the agents use a slice of it.
   */
  private async fundFromAlpaca(): Promise<void> {
    const acct = await this.alpaca!.account();
    if (acct.status !== 'ACTIVE') throw new Error(`Alpaca account is ${acct.status}, not ACTIVE`);
    this.capital = Math.floor(Math.min(acct.cash, this.cfg.startingCapital));
    if (!(this.capital >= 100)) throw new Error(`Alpaca paper account has only $${acct.cash.toFixed(2)} cash`);
    this.fundState = freshFund(this.capital);
    const held = await this.alpaca!.positions().catch(() => []);
    log.info(`funded from Alpaca paper account: $${this.capital} of $${acct.cash.toFixed(2)} cash${held.length ? `; account already holds ${held.map((p) => p.symbol).join(', ')} (not managed by the agents)` : ''}`);
  }

  /** Every few minutes, check that what the ledger thinks it holds is what Alpaca holds. */
  private async checkBroker(): Promise<void> {
    if (this.cfg.execution !== 'alpaca' || !this.alpaca || Date.now() - this.lastBrokerCheck < 5 * 60_000) return;
    this.lastBrokerCheck = Date.now();
    try {
      const real = new Map((await this.alpaca.positions()).map((p) => [p.symbol, p.marketValue]));
      for (const t of this.traders) {
        const p = t.wallet.position;
        if (p && !real.has(p.symbol)) this.news('risk', `MISMATCH: ${t.name} thinks it holds ${p.symbol} but Alpaca has no such position`, { agentId: t.id, good: false });
      }
    } catch (err) {
      log.debug('broker check failed', err);
    }
  }

  /** Bring back explored symbols from the last run. Any whose data no longer loads are dropped. */
  private async rehydrateUniverse(entries: ReturnType<Universe['restoreFacts']>): Promise<void> {
    for (const e of entries) {
      const why = await this.feed.addSymbol(e.symbol, e.asset, this.cfg.universe.minBars);
      if (why) {
        log.warn(`explored symbol ${e.symbol} not restored: ${why}`);
        continue;
      }
      this.universe.add(e);
    }
  }

  private onUniverseChange(c: { added?: string; removed?: string }): void {
    if (c.added) {
      this.scout.watch(c.added);
      return;
    }
    if (!c.removed) return;
    const symbol = c.removed;
    this.feed.removeSymbol(symbol);
    this.datasets.delete(symbol);
    this.scout.forget(symbol);
    for (const s of this.vault.byStatus('vault')) if (s.symbol === symbol) this.vault.remove(s.id);
  }

  /** Make restored state consistent with the current config. */
  private reconcile(): void {
    for (const t of this.traders) {
      const p = t.wallet.position;
      if (p && !this.cfg.symbols.includes(p.symbol)) {
        log.warn(`${t.name} held ${p.symbol} which is no longer configured; dropping the position at entry price`);
        t.wallet.position = null;
      }
    }
    // A strategy whose market could not be restored (e.g. an explored coin that was delisted) has nothing to trade.
    for (const t of this.traders) {
      const s = t.strategy;
      if (s && !this.cfg.symbols.includes(s.symbol)) {
        log.warn(`${t.name}'s strategy ${s.name} lost its market ${s.symbol}; retiring it`);
        this.vault.retire(s.id, `${s.symbol} is no longer on the map`, 'Its market vanished.');
        t.unassign();
      }
    }
    for (const s of this.vault.byStatus('vault')) if (!this.cfg.symbols.includes(s.symbol)) this.vault.remove(s.id);
    const held = new Set(this.traders.map((t) => t.strategy?.id).filter(Boolean));
    for (const s of this.vault.byStatus('active')) {
      if (!held.has(s.id)) {
        s.status = 'vault';
        s.traderId = null;
      }
    }
  }

  /** If TRADERS was lowered since the last run, return the missing traders' cash to the reserve. */
  private reclaimOrphanWallets(saves: AgentSave[]): void {
    const known = new Set(this.traders.map((t) => t.id));
    for (const s of saves) {
      if (!s.id.startsWith('t_') || known.has(s.id)) continue;
      const w = (s.extra as { wallet?: { cash?: number; position?: { qty: number; entryPrice: number } | null } } | undefined)?.wallet;
      const cash = Number(w?.cash) || 0;
      if (cash > 0) {
        this.fundState.reserve += cash;
        log.warn(`trader ${s.id} is no longer staffed; returned $${cash.toFixed(2)} to the reserve${w?.position ? ' (open position dropped at entry)' : ''}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event plumbing
  // -------------------------------------------------------------------------

  private onTick(): void {
    for (const t of this.traders) void t.onTick();
    void this.riskOfficer.check().then(() => this.trackDrawdown());
  }

  private onCandle(symbol: string): void {
    this.scout.onCandle(symbol);
    for (const t of this.traders) void t.onCandle(symbol);
  }

  private trackDrawdown(): void {
    const eq = this.fundEquity();
    const peak = Math.max(this.fundState.peakEquity, eq);
    const dd = peak > 0 ? 1 - eq / peak : 0;
    if (dd > this.fundState.maxDrawdown) this.fundState.maxDrawdown = dd;
  }

  private async fastLoop(): Promise<void> {
    try {
      this.enforceLlmEarnings();
      await this.commander.tick();
      this.strategist.tick();
      this.explorer.tick();
      await Promise.all(this.analysts.map((a) => a.tick()));
    } catch (err) {
      log.error('fast loop failed', err);
    }
  }

  /**
   * The LLM must earn its keep. If its attributed net P&L over the rolling
   * window is below what it cost over the same window, pause it until a new
   * season or a manual resume. This is the guardrail the user asked for: the
   * model can never quietly cost more than it makes.
   */
  private enforceLlmEarnings(): void {
    if (!this.cfg.llm.enabled || this.llmBudget.paused) return;
    const windowDays = this.cfg.llm.earnWindowDays;
    // Give it a grace period: judge only after a full window has elapsed.
    if (Date.now() - this.seasonStartedAt < windowDays * 86_400_000) return;
    const since = Date.now() - windowDays * 86_400_000;
    let attributed = 0;
    for (const [day, pnl] of Object.entries(this.llmAttribution.byDay)) {
      if (Date.parse(day + 'T00:00:00Z') >= since) attributed += pnl;
    }
    // Approximate windowed cost by the daily budget times the window, capped at actual spend.
    const windowedCost = Math.min(this.llmBudget.totalSpent(), this.cfg.llm.dailyBudgetUsd * windowDays);
    if (attributed < windowedCost) {
      this.llmBudget.paused = true;
      this.llmPausedReason = `LLM-attributed P&L $${attributed.toFixed(2)} trailed its $${windowedCost.toFixed(2)} cost over ${windowDays}d`;
      this.news('system', `Prof. Quill and the news desk are paused: ${this.llmPausedReason}. Resume them in the War Room if you want to keep paying.`, { good: false });
    }
  }

  private minuteLoop(): void {
    try {
      const now = Date.now();
      const eq = this.fundEquity();
      const key = utcDayKey(now);
      if (key !== this.fundState.dayKey) {
        this.fundState.dayKey = key;
        this.fundState.dayStartEquity = eq;
      }
      this.equity.push({ t: now, equity: eq });
      if (this.equity.length > MAX_EQUITY_POINTS) {
        // Thin out the older half so long seasons stay small on disk.
        const half = Math.floor(this.equity.length / 2);
        this.equity = [...this.equity.slice(0, half).filter((_, i) => i % 2 === 0), ...this.equity.slice(half)];
      }
      this.treasurer.counted(eq, eq / this.fundState.startingCapital - 1);
      this.riskOfficer.minuteTick();
      this.checkPeriodicAchievements(eq);
      if (this.cfg.hasStocks && this.alpaca) void this.refreshStockClock();
      void this.checkBroker();
      if (now - this.reporter.lastEditionAt > 6 * 3_600_000) this.publishGazette();
    } catch (err) {
      log.error('minute loop failed', err);
    }
  }

  private async refreshStockClock(): Promise<void> {
    if (!this.alpaca) return;
    try {
      const clock = await this.alpaca.clock();
      const was = this.stockMarketOpen;
      this.stockMarketOpen = clock.isOpen;
      if (was !== clock.isOpen) {
        this.news('market', `US stock market ${clock.isOpen ? 'opened' : 'closed'}. Stock traders ${clock.isOpen ? 'back on the floor' : 'heading home'}.`);
        if (!clock.isOpen && this.cfg.execution !== 'alpaca') {
          // Flatten stock positions overnight so nothing drifts unmanaged while closed.
          for (const t of this.traders) {
            if (t.wallet.position && this.cfg.assetClass(t.wallet.position.symbol) === 'stock') void t.flatten('market closed');
          }
        }
      }
    } catch (err) {
      log.debug('stock clock poll failed', err);
    }
  }

  private scheduleResearch(): void {
    const slice = 15;
    const rest = Math.max(5, slice / this.cfg.researchCpu - slice);
    const loop = () => {
      try {
        const per = slice / Math.max(1, this.researchers.length);
        for (const r of this.researchers) r.work(per);
      } catch (err) {
        log.error('research loop failed', err);
      }
      this.researchTimer = setTimeout(loop, rest);
    };
    this.researchTimer = setTimeout(loop, 1000);
  }

  subscribe(fn: (m: ServerMessage) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private broadcast(m: ServerMessage): void {
    for (const l of this.listeners) {
      try {
        l(m);
      } catch (err) {
        log.warn('listener failed', err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // EcoContext
  // -------------------------------------------------------------------------

  fundEquity(): number {
    return this.fundState.reserve + this.traders.reduce((s, t) => s + t.equity(), 0);
  }

  news(kind: NewsKind, text: string, opts: { agentId?: string; good?: boolean } = {}): void {
    const item: NewsItem = { id: shortId('n_'), t: Date.now(), kind, text, ...opts };
    this.newsItems.push(item);
    if (this.newsItems.length > MAX_NEWS) this.newsItems.splice(0, this.newsItems.length - MAX_NEWS);
    this.reporter?.cover(item);
    log.info(`[${kind}] ${text}`);
  }

  emit(e: GameEvent): void {
    if (e.kind === 'discovery') {
      this.totals.strategiesDiscovered++;
      if (this.totals.strategiesDiscovered >= 10) this.unlock('think_tank');
      // A fresh strategy may fill an idle trader slot right away.
      setImmediate(() => this.commander?.assignIdle());
    }
    if (e.kind === 'retire') this.totals.strategiesRetired++;
    this.broadcast({ type: 'event', data: e });
  }

  levelUp(agent: Agent): void {
    if (!this.started) return;
    // Every level gets a sparkle in the village; only milestones make the news.
    if (agent.level % 5 === 0) this.news('levelup', `${agent.name} reached level ${agent.level}!`, { agentId: agent.id, good: true });
    this.emit({ kind: 'levelup', agentId: agent.id, text: `Level ${agent.level}!` });
    if (agent.level >= 10) this.unlock('veteran');
  }

  dataset(symbol: string): Dataset | null {
    const series = this.feed.series(symbol);
    if (series.length < 1000) return null;
    const lastT = series[series.length - 1].t;
    const cur = this.datasets.get(symbol);
    if (cur && cur.lastT === lastT) return cur;
    const candles = series.slice(-this.cfg.historyBars);
    const ds: Dataset = {
      symbol,
      cache: new IndicatorCache(candles),
      lastT,
      trainEnd: Math.floor(candles.length * this.cfg.research.trainFraction),
    };
    this.datasets.set(symbol, ds);
    return ds;
  }

  recordTrade(t: TradeDTO): void {
    this.trades.push(t);
    if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
    const f = this.fundState;
    f.trades++;
    f.fees += t.fees;
    f.realizedPnl += t.pnl;
    if (t.pnl > 0) {
      f.wins++;
      f.grossWin += t.pnl;
    } else {
      f.grossLoss -= t.pnl;
    }
    this.attributeTrade(t);
    appendJsonLine(this.tradesFile, t).catch((err) => log.error('writing trade log', err));
    const sign = t.pnl >= 0 ? '+' : '-';
    this.news('trade', `${t.traderName} closed ${t.side.toUpperCase()} ${t.symbol} (${t.reason}): ${sign}$${Math.abs(t.pnl).toFixed(2)} (${sign}${Math.abs(t.pnlPct * 100).toFixed(2)}%)`, { agentId: t.traderId, good: t.pnl > 0 });
    if (t.pnl > 0) this.unlock('first_profit');
    if (f.trades >= 100) this.unlock('busy_floor');
    if (t.pnl >= f.startingCapital * 0.01) this.unlock('whale');
    const trader = this.traders.find((x) => x.id === t.traderId);
    if (trader && trader.streak >= 5) this.unlock('hot_hand');
  }

  countEvaluated(n: number): void {
    this.totals.genomesEvaluated += n;
    if (this.totals.genomesEvaluated >= 100_000) this.unlock('brute_force');
  }

  /** Marks that an LLM-driven agent did work this cycle. Attribution of P&L happens in recordTrade. */
  attributeLlm(_agentId: string): void {
    // Spend is recorded by the LlmClient; this hook exists for future per-agent accounting.
  }

  marketOpen(symbol: string): boolean {
    if (this.cfg.assetClass(symbol) === 'crypto') return true;
    // Stocks: trust the cached Alpaca clock; default open if we have not polled yet.
    return this.stockMarketOpen;
  }

  /** Attribute a closed trade's P&L to the LLM if its strategy was LLM-authored. */
  private attributeTrade(t: TradeDTO): void {
    const s = this.vault.get(t.strategyId);
    if (!s || s.origin !== 'llm') return;
    const day = utcDayKey(t.exitTime);
    this.llmAttribution.byDay[day] = (this.llmAttribution.byDay[day] ?? 0) + t.pnl;
    this.llmAttribution.total += t.pnl;
    // Keep the per-day map bounded.
    const days = Object.keys(this.llmAttribution.byDay).sort();
    while (days.length > 120) {
      const d = days.shift();
      if (d) delete this.llmAttribution.byDay[d];
    }
  }

  unlock(id: string): void {
    if (this.unlocked[id]) return;
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return;
    this.unlocked[id] = Date.now();
    this.news('achievement', `Achievement unlocked: ${a.title} (${a.description})`, { good: true });
    this.broadcast({ type: 'event', data: { kind: 'achievement', text: a.title } });
  }

  private checkPeriodicAchievements(eq: number): void {
    const ret = eq / this.fundState.startingCapital - 1;
    if (ret >= 0.05) this.unlock('green_5');
    if (ret >= 0.25) this.unlock('green_25');
    if (Date.now() - this.seasonStartedAt >= 7 * 86_400_000) this.unlock('survivor');
    if (this.graduationChecks().every((c) => c.passed)) this.unlock('graduate');
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  private fundSharpe(): number | null {
    // Hourly buckets of the minute equity curve.
    const hourly: number[] = [];
    let bucket = -1;
    for (const p of this.equity) {
      const b = Math.floor(p.t / 3_600_000);
      if (b !== bucket) {
        hourly.push(p.equity);
        bucket = b;
      } else {
        hourly[hourly.length - 1] = p.equity;
      }
    }
    if (hourly.length < 49) return null;
    const r: number[] = [];
    for (let i = 1; i < hourly.length; i++) r.push(hourly[i] / hourly[i - 1] - 1);
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
    return sd > 0 ? (m / sd) * Math.sqrt(24 * 365) : 0;
  }

  private provenStrategies(): number {
    return this.vault.all().filter((s) => s.live.trades >= 10 && s.live.pnl > 0).length;
  }

  private llmCostDTO() {
    const snap = this.llmBudget.snapshot();
    const attributed = this.llmAttribution.total;
    return {
      enabled: this.cfg.llm.enabled,
      model: this.cfg.llm.model,
      fastModel: this.cfg.llm.fastModel,
      spentToday: snap.spentToday,
      dailyBudget: this.cfg.llm.dailyBudgetUsd,
      totalSpent: snap.totalSpent,
      totalCalls: snap.totalCalls,
      totalTokens: snap.totalInputTokens + snap.totalOutputTokens,
      attributedPnl: attributed,
      netOfCost: attributed - snap.totalSpent,
      paused: this.llmBudget.paused,
      pausedReason: this.llmBudget.paused ? this.llmPausedReason : null,
    };
  }

  private graduationChecks() {
    const eq = this.fundEquity();
    return graduation({
      seasonStartedAt: this.seasonStartedAt,
      trades: this.fundState.trades,
      totalReturn: eq / this.fundState.startingCapital - 1,
      maxDrawdown: this.fundState.maxDrawdown,
      sharpe: this.fundSharpe(),
      provenStrategies: this.provenStrategies(),
      realData: this.feed.provider.name !== 'sim',
    });
  }

  private publishGazette(): void {
    const eq = this.fundEquity();
    const f = this.fundState;
    const tradesSince = f.trades - this.lastEdition.trades;
    const feesSince = f.fees - this.lastEdition.fees;
    const best = [...this.traders].filter((t) => t.strategy).sort((a, b) => b.navSinceAssign() - a.navSinceAssign())[0];
    const markets = this.scout.markets().map((m) => `${m.symbol} ${m.regime} (${(m.change24h * 100).toFixed(1)}% 24h)`).join(', ');
    const n = this.reporter.editions + 1;
    const lines = [
      `THE VALLEY GAZETTE #${n}, ${new Date().toUTCString()}`,
      `Fund: $${eq.toFixed(2)} (${pctStr(eq / f.startingCapital - 1)} all-time, ${pctStr(eq / Math.max(1, this.lastEdition.equity) - 1)} since last edition).`,
      `Floor: ${tradesSince} trades closed, $${feesSince.toFixed(2)} paid in fees.`,
      best ? `Star trader: ${best.name} running ${best.strategy?.name} (${pctStr(best.navSinceAssign() - 1)} since hire).` : 'Star trader: nobody has a strategy yet.',
      `Lab: ${this.totals.genomesEvaluated.toLocaleString()} strategies tested, ${this.totals.strategiesDiscovered} discovered, ${this.totals.strategiesRetired} retired.`,
      `Weather: ${markets}.`,
      `Risk: ${this.riskOfficer.halted ? `HALTED (${this.riskOfficer.haltReason})` : 'all systems armed'}. Max drawdown so far ${(f.maxDrawdown * 100).toFixed(1)}%.`,
    ];
    this.reporter.publish(lines.join('\n'));
    this.lastEdition = { equity: eq, trades: f.trades, fees: f.fees };
    this.news('report', `Gazette #${n} is out: fund ${pctStr(eq / f.startingCapital - 1)} all-time`, { agentId: this.reporter.id });
    this.emit({ kind: 'report', agentId: this.reporter.id, text: `Gazette #${n}!`, building: 'media' });
  }

  snapshot(): WorldSnapshot {
    const eq = this.fundEquity();
    const f = this.fundState;
    const unrealized = this.traders.reduce((s, t) => s + t.unrealized(), 0);
    const halted = this.riskOfficer.halted;
    const strategies = this.vault.all();
    const step = Math.max(1, Math.ceil(this.equity.length / 600));
    const equity = this.equity.filter((_, i) => i % step === 0 || i === this.equity.length - 1);
    const researchers = this.researchers.map((r) => r.toResearcherDTO());
    researchers.push(this.strategist.toResearcherDTO());
    return {
      serverTime: Date.now(),
      seasonStartedAt: this.seasonStartedAt,
      mode: 'paper',
      execution: this.cfg.execution === 'alpaca' ? 'alpaca' : 'local',
      provider: this.feed.provider.name,
      timeframe: this.cfg.timeframe,
      llmEnabled: this.cfg.llm.enabled,
      fund: {
        startingCapital: f.startingCapital,
        equity: eq,
        reserve: f.reserve,
        allocated: eq - f.reserve,
        realizedPnl: f.realizedPnl,
        unrealizedPnl: unrealized,
        totalReturn: eq / f.startingCapital - 1,
        peakEquity: Math.max(f.peakEquity, eq),
        drawdown: f.peakEquity > 0 ? Math.max(0, 1 - eq / f.peakEquity) : 0,
        maxDrawdown: f.maxDrawdown,
        dayStartEquity: f.dayStartEquity,
        pnlToday: eq - f.dayStartEquity,
        fees: f.fees,
        trades: f.trades,
        winRate: f.trades ? f.wins / f.trades : 0,
        profitFactor: f.grossLoss > 0 ? f.grossWin / f.grossLoss : f.grossWin > 0 ? 99 : 0,
        sharpe: this.fundSharpe(),
        grossExposure: this.fund.grossExposure(),
        openPositions: this.traders.filter((t) => t.wallet.position).length,
      },
      risk: this.riskOfficer.toRiskDTO(),
      markets: this.scout.markets(),
      agents: this.agents.map((a) => a.toDTO()),
      traders: this.traders.map((t) => t.toTraderDTO(eq, halted)),
      researchers,
      analysts: this.analysts.map((a) => a.toAnalystDTO()),
      strategies: strategies
        .filter((s) => s.status !== 'retired')
        .sort((a, b) => (a.status === b.status ? b.fitness - a.fitness : a.status === 'active' ? -1 : 1))
        .map(toStrategyDTO),
      graveyard: strategies
        .filter((s) => s.status === 'retired')
        .sort((a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0))
        .slice(0, 40)
        .map(toStrategyDTO),
      trades: this.trades.slice(-60).reverse(),
      news: this.newsItems.slice(-80).reverse(),
      signals: this.board.all().slice(0, 40).map((s) => ({
        id: s.id,
        source: s.source,
        authorId: s.authorId,
        authorName: s.authorName,
        symbol: s.symbol,
        direction: s.direction,
        confidence: s.confidence,
        headline: s.headline,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      })),
      equity,
      achievements: achievementList(this.unlocked),
      graduation: this.graduationChecks(),
      llmCost: this.llmCostDTO(),
      totals: { ...this.totals },
      report: this.reporter.report,
      gate: {
        holdoutFraction: 1 - this.cfg.research.trainFraction,
        minTestSharpe: this.cfg.research.promotion.minTestSharpe,
        minTestReturn: this.cfg.research.promotion.minTestReturn,
        minProfitFactor: this.cfg.research.promotion.minProfitFactor,
        maxTestDrawdown: this.cfg.research.promotion.maxTestDrawdown,
        feeRate: this.cfg.feeRate,
        slippage: this.cfg.slippage,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Commands from the UI
  // -------------------------------------------------------------------------

  async halt(): Promise<void> {
    await this.riskOfficer.halt('manual kill switch from the War Room');
  }

  resume(): void {
    this.riskOfficer.resume();
    this.commander.assignIdle();
  }

  /** Manually wake the LLM agents after an earn-your-keep pause. */
  resumeLlm(): void {
    if (!this.llmBudget.paused) return;
    this.llmBudget.paused = false;
    this.llmPausedReason = null;
    this.news('system', 'Prof. Quill and the news desk are back to work by your call.', { good: true });
  }

  /** Start over with a fresh paper fund. The old season is backed up first. Agents keep their XP. */
  async newSeason(): Promise<string | null> {
    await this.save();
    const backup = await backupFile(this.stateFile, `season-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    for (const t of this.traders) {
      t.wallet = { cash: 0, units: 0, position: null };
      t.unassign();
      t.trades = 0;
      t.wins = 0;
      t.streak = 0;
      t.navAtAssign = 1;
      t.peakNav = 1;
    }
    this.vault.clear();
    this.datasets.clear();
    this.board.restore([]);
    const fresh = freshFund(this.capital);
    Object.assign(this.fundState, fresh);
    this.trades = [];
    this.newsItems = [];
    this.equity = [];
    this.unlocked = {};
    this.totals = { genomesEvaluated: 0, strategiesDiscovered: 0, strategiesRetired: 0 };
    this.llmAttribution = { byDay: {}, total: 0 };
    this.llmBudget.paused = false;
    this.llmPausedReason = null;
    this.seasonStartedAt = Date.now();
    this.lastEdition = { equity: this.fundEquity(), trades: 0, fees: 0 };
    if (this.riskOfficer.halted) this.riskOfficer.resume();
    this.riskOfficer.cooldownUntil = null;
    for (const r of this.researchers) r.resetResearch();
    this.universe.reset();
    this.news('system', `A new season begins with $${this.capital.toFixed(2)} of paper money${backup ? `. Old season saved to ${path.basename(backup)}` : ''}`, { good: true });
    await this.save();
    return backup;
  }

  async save(): Promise<void> {
    if (this.saving || !this.started) return;
    this.saving = true;
    try {
      const data: SaveFile = {
        version: 1,
        savedAt: Date.now(),
        seasonStartedAt: this.seasonStartedAt,
        fund: this.fundState,
        agents: this.agents.map((a) => a.save()),
        strategies: this.vault.all(),
        trades: this.trades,
        news: this.newsItems,
        signals: this.board.save(),
        equity: this.equity,
        unlocked: this.unlocked,
        totals: this.totals,
        lastEdition: this.lastEdition,
        llmCost: this.llmBudget.snapshot(),
        llmAttribution: this.llmAttribution,
        universe: this.universe.save(),
      };
      await writeJsonAtomic(this.stateFile, data);
    } catch (err) {
      log.error('saving state failed', err);
    } finally {
      this.saving = false;
    }
  }
}

function pctStr(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
}
