import type { WorldSnapshot } from '../../../shared/types';
import { BUILDINGS } from '../world/map';
import { character } from '../world/sprites';
import { ago, cls, esc, money, pct } from './format';

const ROLE_ORDER: Record<string, number> = { commander: 0, risk: 1, treasurer: 2, scout: 3, explorer: 3, reporter: 4, analyst: 5, strategist: 6, researcher: 7, trader: 8 };

export function renderHud(el: HTMLElement, s: WorldSnapshot): void {
  const f = s.fund;
  const day = Math.floor((s.serverTime - s.seasonStartedAt) / 86_400_000) + 1;
  const passed = s.graduation.filter((c) => c.passed).length;
  const data = s.risk.dataStale
    ? '<span class="badge stale">DATA STALE</span>'
    : s.provider === 'sim'
      ? '<span class="badge sim">SIMULATED DATA</span>'
      : `<span class="muted">${esc(s.provider)} · live</span>`;
  el.innerHTML = `
    <div class="title box"><span class="coin" aria-hidden="true"></span>AI TRADER VALLEY <span class="badge">${s.execution === 'alpaca' ? 'ALPACA PAPER' : 'PAPER MONEY'}</span>${s.risk.halted ? '<span class="badge halt">HALTED</span>' : ''}</div>
    <div class="chip box"><span class="k">Fund</span><span class="v">${money(f.equity)} <small class="${cls(f.totalReturn)}">${pct(f.totalReturn)}</small></span></div>
    <div class="chip box"><span class="k">Today</span><span class="v ${cls(f.pnlToday)}">${money(f.pnlToday, true)}</span></div>
    <div class="chip box"><span class="k">Drawdown</span><span class="v">${pct(f.drawdown, 1, false)}</span></div>
    <div class="chip box"><span class="k">Open</span><span class="v">${f.openPositions}</span></div>
    <button class="chip box" data-action="open-building" data-id="command" title="Real Money License checklist"><span class="k">License</span><span class="v">${passed}/${s.graduation.length}</span></button>
    <div class="chip box"><span class="k">Day ${day}</span><span class="v small">${data}</span></div>
  `;
}

export function renderHotbar(el: HTMLElement, s: WorldSnapshot | null): void {
  const count = (id: string): string => {
    if (!s) return '';
    switch (id) {
      case 'markets':
        return `${s.fund.openPositions} open`;
      case 'lab':
        return `${s.researchers.filter((r) => r.enabled).length} busy`;
      case 'vault':
        return `${s.strategies.length} strats`;
      case 'graveyard':
        return `${s.graveyard.length} graves`;
      case 'hall':
        return `${s.achievements.filter((a) => a.unlockedAt).length}/${s.achievements.length}`;
      case 'warroom':
        return s.risk.halted ? 'HALTED' : 'armed';
      case 'command':
        return money(s.fund.equity).replace(/\.\d+$/, '');
      case 'bank':
        return `${s.fund.trades} trades`;
      case 'media':
        return `${s.signals.length} signals`;
    }
    return '';
  };
  el.innerHTML = BUILDINGS.map(
    (b) => `<button class="hot" data-action="open-building" data-id="${b.id}" title="${esc(b.label)}: ${esc(b.blurb)}">${esc(b.short)}<span class="n">${esc(count(b.id))}</span></button>`,
  ).join('');
}

const portraitCache = new Map<string, string>();

function portraitUrl(s: WorldSnapshot['agents'][number]): string {
  const key = `${s.id}|${s.appearance.hat}|${s.appearance.shirt}`;
  let url = portraitCache.get(key);
  if (!url) {
    url = character(s.appearance, 'down', 0, s.role).toDataURL();
    portraitCache.set(key, url);
  }
  return url;
}

export function renderRoster(el: HTMLElement, s: WorldSnapshot, collapsed: boolean): void {
  const agents = [...s.agents].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
  el.classList.toggle('collapsed', collapsed);
  el.innerHTML = `<h2>VILLAGERS (${agents.length}) <button data-action="toggle-roster" aria-expanded="${!collapsed}">${collapsed ? 'show' : 'hide'}</button></h2>
    ${agents
      .map((a) => {
        const p = a.xpToNext > a.xpForLevel ? (a.xp - a.xpForLevel) / (a.xpToNext - a.xpForLevel) : 1;
        return `<button class="agent" data-action="open-agent" data-id="${esc(a.id)}">
          <img src="${portraitUrl(a)}" width="32" height="54" alt="" style="image-rendering:pixelated">
          <span><span class="name">${esc(a.name)} <span class="muted">Lv ${a.level}</span></span>
          <div class="xpbar"><i style="width:${(p * 100).toFixed(0)}%"></i></div>
          <span class="act">${esc(a.activity)}</span></span>
        </button>`;
      })
      .join('')}`;
}

export function renderQuestLog(el: HTMLElement, s: WorldSnapshot, collapsed: boolean): void {
  el.classList.toggle('collapsed', collapsed);
  el.innerHTML = `<h2>QUEST LOG <button data-action="toggle-log" aria-expanded="${!collapsed}">${collapsed ? 'show' : 'hide'}</button></h2>
    ${s.news
      .slice(0, 14)
      .map((n) => `<div class="news"><time>${ago(n.t, s.serverTime)}</time><span class="tag ${esc(n.kind)}">${esc(n.kind)}</span><span class="${n.good === true ? 'good' : n.good === false ? 'bad' : ''}">${esc(n.text)}</span></div>`)
      .join('')}`;
}
