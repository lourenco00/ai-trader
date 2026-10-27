import type { AgentDTO, BuildingId, StrategyDTO, WorldSnapshot } from '../../../shared/types';
import { BUILDING_BY_ID } from '../world/map';
import { drawEquity, drawSpark } from './charts';
import { ago, cls, dateTime, esc, money, pct, price } from './format';

export interface PanelView {
  title: string;
  sub: string;
  html: string;
  after?: (root: HTMLElement) => void;
}

const stat = (k: string, v: string, c = '') => `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${c}">${v}</div></div>`;

function agentName(s: WorldSnapshot, id: string | null): string {
  if (!id) return '-';
  return esc(s.agents.find((a) => a.id === id)?.name ?? id);
}

function agentLink(s: WorldSnapshot, id: string | null): string {
  if (!id) return '-';
  return `<button class="link" data-action="open-agent" data-id="${esc(id)}" style="background:none;border:0;padding:0;text-decoration:underline;color:inherit;font:inherit">${agentName(s, id)}</button>`;
}

function meter(value: number, limit: number): string {
  const ratio = Math.max(0, Math.min(1, limit > 0 ? value / limit : 0));
  return `<div class="meter ${ratio > 0.7 ? 'danger' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${value}"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>`;
}

function metricsCell(m: StrategyDTO['test']): string {
  return `<span class="${cls(m.totalReturn)}">${pct(m.totalReturn, 1)}</span> · S ${m.sharpe.toFixed(2)} · DD ${pct(m.maxDrawdown, 0, false)} · ${m.trades}t`;
}

// ---------------------------------------------------------------------------

function command(s: WorldSnapshot): PanelView {
  const f = s.fund;
  const passed = s.graduation.filter((c) => c.passed).length;
  const rows = s.traders
    .map((t) => {
      const p = t.position;
      return `<tr class="clickable" data-action="open-agent" data-id="${esc(t.agentId)}">
        <td>${esc(t.name)}</td>
        <td>${t.strategyName ? `${esc(t.strategyName)} <span class="muted">${esc(t.symbol)}</span>` : '<span class="muted">waiting for the Lab</span>'}</td>
        <td>${esc(t.status)}</td>
        <td>${money(t.equity)}</td>
        <td>${pct(t.allocationPct, 1, false)}</td>
        <td class="${cls(t.nav - 1)}">${pct(t.nav - 1)}</td>
        <td>${t.trades} (${t.trades ? Math.round((t.wins / t.trades) * 100) : 0}% win)</td>
        <td>${p ? `<span class="${cls(p.unrealizedPnl)}">${p.side.toUpperCase()} ${esc(p.symbol)} ${money(p.unrealizedPnl, true)}</span>` : '-'}</td>
      </tr>`;
    })
    .join('');
  const checks = s.graduation
    .map(
      (c) => `<div class="check ${c.passed ? 'pass' : ''}">
        <div class="box2" aria-hidden="true">${c.passed ? '✓' : ''}</div>
        <div>${esc(c.label)}</div>
        <div class="${c.passed ? 'good' : 'muted'}">${esc(c.display)}</div>
      </div>`,
    )
    .join('');
  return {
    title: 'COMMAND CENTER',
    sub: `Maxine allocates paper capital to traders and retires strategies that stop working. Season started ${dateTime(s.seasonStartedAt)}.`,
    html: `
      <div class="grid">
        ${stat('Equity', money(f.equity))}
        ${stat('All-time', pct(f.totalReturn), cls(f.totalReturn))}
        ${stat('Today', money(f.pnlToday, true), cls(f.pnlToday))}
        ${stat('Drawdown', `${pct(f.drawdown, 1, false)} <span class="muted" style="font-size:16px">max ${pct(f.maxDrawdown, 1, false)}</span>`)}
        ${stat('Realized P&L', money(f.realizedPnl, true), cls(f.realizedPnl))}
        ${stat('Unrealized', money(f.unrealizedPnl, true), cls(f.unrealizedPnl))}
        ${stat('Fees paid', money(f.fees))}
        ${stat('Trades', `${f.trades} <span class="muted" style="font-size:16px">${pct(f.winRate, 0, false)} win</span>`)}
        ${stat('Profit factor', f.trades ? f.profitFactor.toFixed(2) : '-')}
        ${stat('Sharpe (hourly)', f.sharpe === null ? 'need 2d' : f.sharpe.toFixed(2))}
        ${stat('Cash reserve', money(f.reserve))}
        ${stat('Exposure', pct(f.equity > 0 ? f.grossExposure / f.equity : 0, 0, false))}
      </div>
      <h3>Equity curve</h3>
      <canvas class="chart" id="eq-chart" aria-label="Fund equity over time"></canvas>
      <h3>Trading floor allocation</h3>
      <table><thead><tr><th>Trader</th><th>Strategy</th><th>Status</th><th>Wallet</th><th>Alloc</th><th>NAV</th><th>Trades</th><th>Position</th></tr></thead><tbody>${rows}</tbody></table>
      <h3>Real Money License: ${passed}/${s.graduation.length}</h3>
      ${checks}
      <div class="note">Clearing every check means the system looked good on paper for a month, with fees and slippage included. It is evidence, not a promise: paper fills ignore order-book depth, funding costs, exchange outages and your own nerves. If you do go live, start with money you can afford to lose and keep the War Room limits on.</div>
    `,
    after: (root) => {
      const c = root.querySelector<HTMLCanvasElement>('#eq-chart');
      if (c) drawEquity(c, s.equity, f.startingCapital);
    },
  };
}

function biasCell(b: number): string {
  if (Math.abs(b) < 0.1) return '<span class="muted">neutral</span>';
  return b > 0 ? `<span class="good">▲ ${(b * 100).toFixed(0)}</span>` : `<span class="bad">▼ ${(Math.abs(b) * 100).toFixed(0)}</span>`;
}

function markets(s: WorldSnapshot): PanelView {
  const mk = s.markets
    .map(
      (m, i) => `<tr><td><b>${esc(m.symbol)}</b> <span class="tag ${m.asset}">${m.asset}</span>${m.tier === 'explored' ? ` <span class="tag explored" title="${esc(m.exploreNote ?? '')}">explored</span>` : ''}${m.asset === 'stock' && !m.marketOpen ? ' <span class="muted">(closed)</span>' : ''}</td>
        <td>${price(m.price)}</td><td class="${cls(m.change24h)}">${pct(m.change24h)}</td>
        <td>${esc(m.regime)}</td><td>${(m.volatility * 100).toFixed(0)}%</td><td>${biasCell(m.newsBias)}</td><td><canvas class="spark" data-spark="${i}" aria-label="${esc(m.symbol)} 24h price"></canvas></td></tr>`,
    )
    .join('');
  const open = s.traders.filter((t) => t.position);
  const pos = open
    .map((t) => {
      const p = t.position!;
      return `<tr class="clickable" data-action="open-agent" data-id="${esc(t.agentId)}"><td>${esc(t.name)}</td><td>${p.side.toUpperCase()} ${esc(p.symbol)}</td>
        <td>${price(p.entryPrice)}</td><td>${price(p.markPrice)}</td><td>${price(p.stop)}</td><td>${p.takeProfit ? price(p.takeProfit) : '-'}</td>
        <td class="${cls(p.unrealizedPnl)}">${money(p.unrealizedPnl, true)} (${pct(p.unrealizedPct)})</td><td>${p.barsHeld}</td></tr>`;
    })
    .join('');
  const trades = s.trades
    .slice(0, 25)
    .map(
      (t) => `<tr><td>${ago(t.exitTime)} ago</td><td>${esc(t.traderName)}</td><td>${t.side.toUpperCase()} ${esc(t.symbol)}</td>
        <td>${price(t.entryPrice)} → ${price(t.exitPrice)}</td><td class="${cls(t.pnl)}">${money(t.pnl, true)}</td><td>${esc(t.reason)}</td></tr>`,
    )
    .join('');
  return {
    title: 'TRADING FLOOR',
    sub: `Traders execute Vault strategies on ${esc(s.timeframe)} candles, 24/7. Every fill pays fees and slippage. Data: ${esc(s.provider)}.`,
    html: `
      <table><thead><tr><th>Market</th><th>Price</th><th>24h</th><th>Regime</th><th>Vol</th><th>News</th><th>24h chart</th></tr></thead><tbody>${mk}</tbody></table>
      <h3>Open positions (${open.length})</h3>
      ${open.length ? `<table><thead><tr><th>Trader</th><th>Position</th><th>Entry</th><th>Mark</th><th>Stop</th><th>Target</th><th>P&L</th><th>Bars</th></tr></thead><tbody>${pos}</tbody></table>` : '<p class="muted">Everyone is flat. Traders only enter when their strategy fires on a closed candle.</p>'}
      <h3>Recent trades</h3>
      ${trades ? `<table><thead><tr><th>When</th><th>Trader</th><th>Side</th><th>Entry → Exit</th><th>P&L</th><th>Reason</th></tr></thead><tbody>${trades}</tbody></table>` : '<p class="muted">No closed trades yet.</p>'}
    `,
    after: (root) => {
      root.querySelectorAll<HTMLCanvasElement>('canvas[data-spark]').forEach((c) => {
        const m = s.markets[Number(c.dataset.spark)];
        if (m) drawSpark(c, m.spark);
      });
    },
  };
}

function lab(s: WorldSnapshot): PanelView {
  const rows = s.researchers
    .map((r) => {
      const progress = r.generationsPerEpoch ? Math.min(1, r.generation / r.generationsPerEpoch) : 0;
      return `<tr class="clickable" data-action="open-agent" data-id="${esc(r.agentId)}">
        <td><b>${esc(r.name)}</b><div class="muted">${esc(r.specialty)}</div></td>
        <td>${r.enabled ? esc(r.symbol) : '<span class="muted">asleep</span>'}</td>
        <td>${r.origin === 'llm' ? `${r.epoch} sessions` : `epoch ${r.epoch + 1}<div class="meter" style="width:90px"><i style="width:${(progress * 100).toFixed(0)}%"></i></div>`}</td>
        <td>${r.evaluated.toLocaleString()}</td>
        <td>${r.discoveries}</td>
        <td>${r.bestFitness === null ? '-' : r.bestFitness.toFixed(2)}</td>
        <td class="rules">${esc(r.lastResult)}${r.bestRules.length ? `<div>${r.bestRules.map(esc).join('<br>')}</div>` : ''}</td>
      </tr>`;
    })
    .join('');
  return {
    title: 'RESEARCH LAB',
    sub: 'Researchers evolve strategy genomes with a genetic algorithm. Each specialist favours different indicators.',
    html: `
      <div class="grid">
        ${stat('Strategies tested', s.totals.genomesEvaluated.toLocaleString())}
        ${stat('Promoted', String(s.totals.strategiesDiscovered))}
        ${stat('Retired', String(s.totals.strategiesRetired))}
        ${stat('In the Vault', String(s.strategies.length))}
      </div>
      <div class="note">How a strategy gets promoted: it is scored on three separate stretches of the training data (the worst stretch counts most), then must pass an untouched holdout of the most recent ${pct(s.gate.holdoutFraction, 0, false)} of history: return above ${pct(s.gate.minTestReturn, 1, false)}, Sharpe above ${s.gate.minTestSharpe}, profit factor above ${s.gate.minProfitFactor} and drawdown under ${pct(s.gate.maxTestDrawdown, 0, false)}, after ${pct(s.gate.feeRate, 2, false)} fees and ${pct(s.gate.slippage, 2, false)} slippage per fill. Only the best candidate per epoch can be promoted. Some winners will still be luck, so each one starts on small probation capital.</div>
      ${s.llmEnabled ? '' : '<p class="muted">Prof. Quill is asleep. Add LLM_PROVIDER and LLM_API_KEY to .env to let an LLM propose strategy ideas that go through the same tests.</p>'}
      <table><thead><tr><th>Researcher</th><th>Market</th><th>Progress</th><th>Tested</th><th>Found</th><th>Best</th><th>Latest</th></tr></thead><tbody>${rows}</tbody></table>
    `,
  };
}

function strategyRows(s: WorldSnapshot, list: StrategyDTO[]): string {
  return list
    .map(
      (st) => `<tr>
        <td><b>${esc(st.name)}</b> <span class="muted">${esc(st.symbol)} ${st.side.toUpperCase()}</span>
          <div class="rules">${st.rules.map(esc).join('<br>')}</div></td>
        <td>${st.status === 'active' ? `with ${agentLink(s, st.traderId)}` : 'waiting'}</td>
        <td>${esc(st.author)}${st.origin === 'llm' ? ' (LLM)' : ''}<div class="muted">${ago(st.createdAt)} ago</div></td>
        <td>${metricsCell(st.test)}</td>
        <td>${metricsCell(st.train)}</td>
        <td>${st.live.trades ? `<span class="${cls(st.live.pnl)}">${money(st.live.pnl, true)}</span> · ${st.live.trades}t · ${Math.round((st.live.wins / st.live.trades) * 100)}% win` : '<span class="muted">no trades yet</span>'}</td>
      </tr>`,
    )
    .join('');
}

function vault(s: WorldSnapshot): PanelView {
  return {
    title: 'STRATEGY VAULT',
    sub: 'Strategies that passed the holdout test. Active ones are being traded; the rest wait for a free trader.',
    html: s.strategies.length
      ? `<table><thead><tr><th>Strategy</th><th>Status</th><th>Author</th><th>Holdout</th><th>Training</th><th>Live paper</th></tr></thead><tbody>${strategyRows(s, s.strategies)}</tbody></table>`
      : '<p class="muted">Empty for now. Depending on the market, the first promotion can take minutes or hours. If nothing beats fees on the holdout, nothing gets traded, which is the point.</p>',
  };
}

function warroom(s: WorldSnapshot): PanelView {
  const r = s.risk;
  const f = s.fund;
  const dayLoss = Math.max(0, f.dayStartEquity > 0 ? 1 - f.equity / f.dayStartEquity : 0);
  const exposure = f.equity > 0 ? f.grossExposure / f.equity : 0;
  const status = r.halted ? `<span class="bad">HALTED</span>: ${esc(r.haltReason)}` : r.cooldownUntil ? `<span class="bad">COOLDOWN</span> until ${dateTime(r.cooldownUntil)}` : r.dataStale ? '<span class="bad">DATA STALE</span>, entries blocked' : '<span class="good">ARMED</span>, all limits green';
  const llm = s.llmCost;
  return {
    title: 'WAR ROOM',
    sub: 'Sarge checks every entry against the limits below and can flatten the whole fund.',
    html: `
      <p style="font-size:24px">Status: ${status}</p>
      <div class="check"><div></div><div>Fund drawdown ${pct(f.drawdown, 1, false)} of ${pct(r.limits.fundMaxDrawdown, 0, false)} limit (auto kill switch)</div>${meter(f.drawdown, r.limits.fundMaxDrawdown)}</div>
      <div class="check"><div></div><div>Today's loss ${pct(dayLoss, 1, false)} of ${pct(r.limits.dailyLossLimit, 0, false)} limit (pauses entries)</div>${meter(dayLoss, r.limits.dailyLossLimit)}</div>
      <div class="check"><div></div><div>Gross exposure ${pct(exposure, 0, false)} of ${pct(r.limits.maxGrossExposure, 0, false)} cap (1x, no leverage)</div>${meter(exposure, r.limits.maxGrossExposure)}</div>
      <div class="check"><div></div><div>Net long ${pct(r.netLong, 0, false)} / net short ${pct(r.netShort, 0, false)}</div><div class="muted">${pct(r.netLong, 0, false)} ▲ · ${pct(r.netShort, 0, false)} ▼</div></div>
      <p class="muted">Also enforced: max ${pct(r.limits.maxSymbolExposure, 0, false)} of equity per market, a ${pct(r.limits.traderMaxDrawdown, 0, false)} per-trader drawdown retires the strategy, and entries that fight strong news are blocked. Last market data ${ago(r.lastDataAt)} ago from ${esc(s.provider)}.</p>
      <div class="actions">
        ${r.halted ? '<button class="btn green" data-action="resume">Release kill switch</button>' : '<button class="btn red" data-action="halt">Pull kill switch</button>'}
        <button class="btn" data-action="new-season">New season (reset paper fund)</button>
      </div>
      <h3>LLM budget</h3>
      ${llm.enabled ? `
        <div class="grid">
          ${stat('Spent today', `${money(llm.spentToday)} <span class="muted" style="font-size:16px">/ ${money(llm.dailyBudget)}</span>`)}
          ${stat('Total spent', money(llm.totalSpent))}
          ${stat('Attributed P&L', money(llm.attributedPnl, true), cls(llm.attributedPnl))}
          ${stat('Net of cost', money(llm.netOfCost, true), cls(llm.netOfCost))}
          ${stat('Calls', String(llm.totalCalls))}
          ${stat('Tokens', llm.totalTokens.toLocaleString())}
        </div>
        ${llm.paused ? `<p class="bad">LLM paused: ${esc(llm.pausedReason ?? 'not earning its keep')}</p><div class="actions"><button class="btn green" data-action="resume-llm">Wake the LLM back up</button></div>` : '<p class="muted">The LLM sleeps on its own when the day\'s budget is spent, or when its attributed P&L trails its cost over the rolling window. Attributed P&L counts only trades from LLM-authored strategies.</p>'}
      ` : '<p class="muted">LLM is off. Set LLM_PROVIDER and LLM_API_KEY in .env to enable Prof. Quill and the news desk.</p>'}
      <p class="muted">The kill switch closes every position at market and blocks new entries until released. A new season backs up the current state file, then restarts with fresh paper money. Agents keep their levels.</p>
    `,
  };
}

function bank(s: WorldSnapshot): PanelView {
  const f = s.fund;
  const rows = s.trades
    .map(
      (t) => `<tr><td>${dateTime(t.exitTime)}</td><td>${esc(t.traderName)}</td><td>${esc(t.strategyName)}</td><td>${t.side.toUpperCase()} ${esc(t.symbol)}</td>
        <td>${price(t.entryPrice)} → ${price(t.exitPrice)}</td><td>${money(t.fees)}</td><td class="${cls(t.pnl)}">${money(t.pnl, true)} (${pct(t.pnlPct)})</td><td>${esc(t.reason)}</td></tr>`,
    )
    .join('');
  return {
    title: 'TREASURY',
    sub: `Penny keeps the books. Starting capital ${money(f.startingCapital)} of paper money. The full trade log is in data/trades.jsonl.`,
    html: `
      <div class="grid">
        ${stat('Equity', money(f.equity))}
        ${stat('Peak', money(f.peakEquity))}
        ${stat('Realized', money(f.realizedPnl, true), cls(f.realizedPnl))}
        ${stat('Fees', money(f.fees))}
        ${stat('Win rate', f.trades ? pct(f.winRate, 0, false) : '-')}
        ${stat('Profit factor', f.trades ? f.profitFactor.toFixed(2) : '-')}
      </div>
      <h3>Equity curve</h3>
      <canvas class="chart" id="eq-chart" aria-label="Fund equity over time"></canvas>
      <h3>Ledger (latest ${s.trades.length})</h3>
      ${rows ? `<table><thead><tr><th>Closed</th><th>Trader</th><th>Strategy</th><th>Side</th><th>Entry → Exit</th><th>Fees</th><th>Net P&L</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No closed trades yet.</p>'}
    `,
    after: (root) => {
      const c = root.querySelector<HTMLCanvasElement>('#eq-chart');
      if (c) drawEquity(c, s.equity, f.startingCapital);
    },
  };
}

function media(s: WorldSnapshot): PanelView {
  const items = s.news
    .map((n) => `<div class="news"><time>${ago(n.t)}</time><span class="tag ${esc(n.kind)}">${esc(n.kind)}</span><span class="${n.good === true ? 'good' : n.good === false ? 'bad' : ''}">${esc(n.text)}</span></div>`)
    .join('');
  const analysts = s.analysts
    .map(
      (a) => `<tr class="clickable" data-action="open-agent" data-id="${esc(a.agentId)}">
        <td><b>${esc(a.name)}</b><div class="muted">${esc(a.beat)}</div></td>
        <td>${a.enabled ? 'on duty' : '<span class="muted">asleep</span>'}</td>
        <td>${a.headlinesRead.toLocaleString()}</td>
        <td>${a.signalsPosted}</td>
        <td>${a.hitRate === null ? `<span class="muted">${a.scored}/5 graded</span>` : `${Math.round(a.hitRate * 100)}% <span class="muted">(${a.scored})</span>`}</td>
        <td class="rules">${esc(a.lastHeadline)}</td>
      </tr>`,
    )
    .join('');
  const signals = s.signals
    .map(
      (sig) => `<div class="news"><time>${ago(sig.createdAt)}</time><span class="tag ${sig.source}">${sig.source}</span>
        <span class="${sig.direction === 'long' ? 'good' : 'bad'}">${sig.direction === 'long' ? '▲' : '▼'} ${esc(sig.symbol)} ${Math.round(sig.confidence * 100)}%</span>
        <span>${esc(sig.headline)} <span class="muted">— ${esc(sig.authorName)}</span></span></div>`,
    )
    .join('');
  return {
    title: 'MEDIA STUDIO',
    sub: 'The news desk reads the wire and posts directional calls to the shared board. Gus prints a Gazette every 6 hours.',
    html: `
      <h3>News desk</h3>
      ${s.analysts.length ? `<table><thead><tr><th>Analyst</th><th>Status</th><th>Read</th><th>Signals</th><th>Hit rate</th><th>Latest</th></tr></thead><tbody>${analysts}</tbody></table>` : ''}
      ${s.llmEnabled ? '' : '<p class="muted">The news desk is asleep. Set LLM_PROVIDER and LLM_API_KEY in .env to wake it. Hit rate grades each call against the actual move after fees once its horizon passes.</p>'}
      <h3>Signal board (${s.signals.length})</h3>
      ${signals || '<p class="muted">No live signals. The scout posts chart signals on regime changes; the news desk posts on relevant headlines.</p>'}
      <h3>Latest Gazette</h3>
      ${s.report ? `<div class="gazette">${esc(s.report)}</div>` : '<p class="muted">The first edition goes to print after 6 hours of operation.</p>'}
      <h3>Wire</h3>
      ${items}
    `,
  };
}

function graveyard(s: WorldSnapshot): PanelView {
  const graves = s.graveyard
    .map(
      (g) => `<div class="grave"><div class="stone" aria-hidden="true">RIP</div><div>
        <b>${esc(g.name)}</b> <span class="muted">${esc(g.symbol)} ${g.side.toUpperCase()} by ${esc(g.author)}</span>
        <div><i>"${esc(g.epitaph)}"</i></div>
        <div class="muted">Cause: ${esc(g.retiredReason)}. Lived ${g.retiredAt ? ago(g.createdAt, g.retiredAt) : '?'}; live ${g.live.trades} trades, <span class="${cls(g.live.pnl)}">${money(g.live.pnl, true)}</span>. Holdout was ${pct(g.test.totalReturn, 1)}.</div>
      </div></div>`,
    )
    .join('');
  return {
    title: 'STRATEGY GRAVEYARD',
    sub: 'Strategies that failed in live paper trading. Comparing holdout vs live results here shows how much backtests flatter.',
    html: graves || '<p class="muted">Nobody has died yet.</p>',
  };
}

function hall(s: WorldSnapshot): PanelView {
  const board = [...s.agents]
    .sort((a, b) => b.level - a.level || b.xp - a.xp)
    .map(
      (a, i) => `<tr class="clickable" data-action="open-agent" data-id="${esc(a.id)}"><td>#${i + 1}</td><td><b>${esc(a.name)}</b></td><td>${esc(a.title)}</td><td>Lv ${a.level}</td><td>${a.xp.toLocaleString()} xp</td></tr>`,
    )
    .join('');
  const ach = s.achievements
    .map((a) => `<div class="ach ${a.unlockedAt ? 'on' : ''}"><b>${esc(a.title)}</b>${esc(a.description)}${a.unlockedAt ? `<div class="muted">${dateTime(a.unlockedAt)}</div>` : ''}</div>`)
    .join('');
  const unlocked = s.achievements.filter((a) => a.unlockedAt).length;
  return {
    title: 'HALL OF FAME',
    sub: 'Agents earn XP for testing strategies, discovering winners, trading well and keeping the fund safe.',
    html: `
      <h3>Achievements ${unlocked}/${s.achievements.length}</h3>
      <div class="achievements">${ach}</div>
      <h3>Leaderboard</h3>
      <table><thead><tr><th>Rank</th><th>Agent</th><th>Role</th><th>Level</th><th>XP</th></tr></thead><tbody>${board}</tbody></table>
    `,
  };
}

export function buildingPanel(id: BuildingId, s: WorldSnapshot): PanelView {
  switch (id) {
    case 'command':
      return command(s);
    case 'markets':
      return markets(s);
    case 'lab':
      return lab(s);
    case 'vault':
      return vault(s);
    case 'warroom':
      return warroom(s);
    case 'bank':
      return bank(s);
    case 'media':
      return media(s);
    case 'graveyard':
      return graveyard(s);
    case 'hall':
      return hall(s);
  }
}

export function agentPanel(a: AgentDTO, s: WorldSnapshot): PanelView {
  const xpPct = a.xpToNext > a.xpForLevel ? (a.xp - a.xpForLevel) / (a.xpToNext - a.xpForLevel) : 1;
  const stats = Object.entries(a.stats)
    .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');
  let extra = '';
  const t = s.traders.find((x) => x.agentId === a.id);
  if (t?.position) {
    const p = t.position;
    extra = `<h3>Open position</h3><p>${p.side.toUpperCase()} ${p.qty.toPrecision(4)} ${esc(p.symbol)} @ ${price(p.entryPrice)}, mark ${price(p.markPrice)}, stop ${price(p.stop)}${p.takeProfit ? `, target ${price(p.takeProfit)}` : ''}: <span class="${cls(p.unrealizedPnl)}">${money(p.unrealizedPnl, true)}</span></p>`;
  }
  const strat = t?.strategyId ? s.strategies.find((x) => x.id === t.strategyId) : undefined;
  if (strat) extra += `<h3>Strategy: ${esc(strat.name)} (${esc(strat.symbol)})</h3><div class="rules">${strat.rules.map(esc).join('<br>')}</div><p>Holdout: ${metricsCell(strat.test)}</p>`;
  const r = s.researchers.find((x) => x.agentId === a.id);
  if (r?.bestRules.length) extra += `<h3>Current best candidate</h3><div class="rules">${r.bestRules.map(esc).join('<br>')}</div>`;
  const home = BUILDING_BY_ID[a.home];
  return {
    title: `${a.name.toUpperCase()}`,
    sub: `${a.title}, works at the ${home.label.toLowerCase()}`,
    html: `
      <canvas class="portrait" id="portrait" width="64" height="108" aria-hidden="true"></canvas>
      <p style="font-size:22px;margin:0">Level ${a.level} · ${a.xp.toLocaleString()} xp</p>
      <div class="xpbar" style="width:260px"><i style="width:${(xpPct * 100).toFixed(0)}%"></i></div>
      <p class="muted" style="margin:2px 0 8px">${(a.xpToNext - a.xp).toLocaleString()} xp to level ${a.level + 1} · feeling ${esc(a.mood)}</p>
      <p><b>Now:</b> ${esc(a.activity)}</p>
      <table style="clear:both"><tbody>${stats}</tbody></table>
      ${extra}
      <div class="actions"><button class="btn" data-action="follow" data-id="${esc(a.id)}">Follow in the village</button>
      <button class="btn" data-action="open-building" data-id="${esc(a.home)}">Open ${esc(home.label.toLowerCase())}</button></div>
    `,
  };
}
