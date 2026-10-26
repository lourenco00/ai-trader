import '@fontsource/press-start-2p/400.css';
import '@fontsource/vt323/400.css';
import './ui/styles.css';
import type { BuildingId, GameEvent, ServerMessage, WorldSnapshot } from '../../shared/types';
import { agentPanel, buildingPanel, type PanelView } from './ui/panels';
import { renderHotbar, renderHud, renderQuestLog, renderRoster } from './ui/hud';
import { esc } from './ui/format';
import { BUILDING_BY_ID } from './world/map';
import { character } from './world/sprites';
import { World } from './world/world';

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const hud = $('hud');
const hotbar = $('buildings');
const roster = $('roster');
const questlog = $('questlog');
const overlay = $('overlay');
const panel = $('panel');
const toasts = $('toasts');
const tooltip = $('tooltip');
const connecting = $('connecting');

const world = new World($<HTMLCanvasElement>('world'));
let snap: WorldSnapshot | null = null;
let openView: { kind: 'building' | 'agent'; id: string } | null = null;
let lastFocus: HTMLElement | null = null;
const prefs = {
  roster: localStorage.getItem('valley.roster') === 'collapsed',
  log: localStorage.getItem('valley.log') === 'collapsed',
};

roster.classList.add('box');
questlog.classList.add('box');
hotbar.classList.add('box');

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function paint(view: PanelView): void {
  const scroll = panel.scrollTop;
  panel.innerHTML = `<button class="close" data-action="close" aria-label="Close">X</button>
    <h1 id="panel-title">${esc(view.title)}</h1><div class="sub">${view.sub}</div>${view.html}`;
  view.after?.(panel);
  const portrait = panel.querySelector<HTMLCanvasElement>('#portrait');
  if (portrait && openView?.kind === 'agent') {
    const a = snap?.agents.find((x) => x.id === openView?.id);
    const g = portrait.getContext('2d');
    if (a && g) {
      g.imageSmoothingEnabled = false;
      g.drawImage(character(a.appearance, 'down', 0, a.role), 0, 0, portrait.width, portrait.height);
    }
  }
  panel.scrollTop = scroll;
}

function refreshPanel(): void {
  if (!openView || !snap) return;
  if (openView.kind === 'building') {
    paint(buildingPanel(openView.id as BuildingId, snap));
  } else {
    const a = snap.agents.find((x) => x.id === openView!.id);
    if (a) paint(agentPanel(a, snap));
  }
}

function openPanel(kind: 'building' | 'agent', id: string): void {
  if (!snap) return;
  if (!overlay.hidden && openView?.kind === kind && openView.id === id) return;
  if (overlay.hidden) lastFocus = document.activeElement as HTMLElement | null;
  openView = { kind, id };
  overlay.hidden = false;
  panel.scrollTop = 0;
  refreshPanel();
  panel.querySelector<HTMLButtonElement>('.close')?.focus();
}

function closePanel(): void {
  openView = null;
  overlay.hidden = true;
  lastFocus?.focus?.();
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(text: string, ms = 4500): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  toasts.appendChild(el);
  setTimeout(() => el.remove(), ms);
  while (toasts.children.length > 4) toasts.firstElementChild?.remove();
}

function onEvent(e: GameEvent): void {
  world.handleEvent(e);
  if (e.kind === 'achievement') toast(`ACHIEVEMENT: ${e.text}`, 6000);
  else if (e.kind === 'discovery') toast(`NEW STRATEGY: ${e.text.replace(/^[^:]*:\s*/, '')}`);
  else if (e.kind === 'halt') toast(`WAR ROOM: ${e.text}`, 6000);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function post(path: string): Promise<{ ok: boolean; backup?: string | null }> {
  const res = await fetch(path, { method: 'POST', headers: { 'x-valley-action': '1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

document.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) {
    if (ev.target === overlay) closePanel();
    return;
  }
  const id = target.dataset.id ?? '';
  switch (target.dataset.action) {
    case 'close':
      closePanel();
      break;
    case 'open-building':
      if (id in BUILDING_BY_ID) {
        world.focusBuilding(id as BuildingId);
        openPanel('building', id);
      }
      break;
    case 'open-agent':
      openPanel('agent', id);
      world.focusAgent(id);
      break;
    case 'follow':
      closePanel();
      world.focusAgent(id);
      break;
    case 'halt':
      if (confirm('Pull the kill switch? Every open position is closed at market and new entries stop until you release it.')) {
        post('/api/halt').catch((err) => toast(`Kill switch failed: ${err.message}`));
      }
      break;
    case 'resume':
      post('/api/resume').catch((err) => toast(`Resume failed: ${err.message}`));
      break;
    case 'resume-llm':
      post('/api/resume-llm').catch((err) => toast(`Resume failed: ${err.message}`));
      break;
    case 'new-season':
      if (confirm('Start a new season? Open positions are dropped, the paper fund resets to the starting capital, and strategies/trades/news are cleared. The current state is backed up to data/ first.')) {
        post('/api/new-season')
          .then((r) => toast(r.backup ? `New season! Backup: ${r.backup}` : 'New season!'))
          .catch((err) => toast(`New season failed: ${err.message}`));
      }
      break;
    case 'toggle-roster':
      prefs.roster = !prefs.roster;
      localStorage.setItem('valley.roster', prefs.roster ? 'collapsed' : 'open');
      if (snap) renderRoster(roster, snap, prefs.roster);
      break;
    case 'toggle-log':
      prefs.log = !prefs.log;
      localStorage.setItem('valley.log', prefs.log ? 'collapsed' : 'open');
      if (snap) renderQuestLog(questlog, snap, prefs.log);
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.hidden) closePanel();
});

world.onBuildingClick = (id) => openPanel('building', id);
world.onAgentClick = (id) => {
  openPanel('agent', id);
  world.focusAgent(id);
};
world.onHover = (text, x, y) => {
  if (!text) {
    tooltip.hidden = true;
    return;
  }
  tooltip.textContent = text;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(window.innerWidth - 340, x + 16)}px`;
  tooltip.style.top = `${y + 18}px`;
};

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------

let retry = 0;
let rosterTick = 0;

let deepLinked = false;

/** Support links like /#building=lab or /#agent=t_earl. */
function openFromHash(): void {
  const m = /^#(building|agent)=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  if (m[1] === 'building' && m[2] in BUILDING_BY_ID) openPanel('building', m[2]);
  if (m[1] === 'agent') openPanel('agent', m[2]);
}

window.addEventListener('hashchange', openFromHash);

function onSnapshot(s: WorldSnapshot): void {
  snap = s;
  if (!deepLinked) {
    deepLinked = true;
    queueMicrotask(openFromHash);
  }
  world.setSnapshot(s);
  renderHud(hud, s);
  renderHotbar(hotbar, s);
  renderQuestLog(questlog, s, prefs.log);
  // The roster has images; repaint it less often so hover states stay stable.
  if (rosterTick++ % 3 === 0 && !roster.matches(':hover')) renderRoster(roster, s, prefs.roster);
  if (!overlay.hidden) refreshPanel();
}

function connect(): void {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let shown = false;
  const showTimer = setTimeout(() => {
    shown = true;
    connecting.hidden = false;
  }, 1500);
  ws.onopen = () => {
    retry = 0;
    clearTimeout(showTimer);
    connecting.hidden = true;
  };
  ws.onmessage = (m) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(m.data)) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'snapshot') onSnapshot(msg.data);
    else if (msg.type === 'event') onEvent(msg.data);
  };
  ws.onclose = () => {
    clearTimeout(showTimer);
    if (!shown) connecting.hidden = false;
    connecting.textContent = 'Lost contact with the valley. Reconnecting...';
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

renderHotbar(hotbar, null);
void Promise.allSettled([document.fonts.load('10px "Press Start 2P"'), document.fonts.load('18px "VT323"')]).finally(() => {
  world.start();
  connect();
});
