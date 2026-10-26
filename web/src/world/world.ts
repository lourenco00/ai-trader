import type { AgentDTO, BuildingId, GameEvent, WorldSnapshot } from '../../../shared/types';
import { renderBuildings, tombstone, type Sprite } from './buildings';
import { renderGround } from './ground';
import { BUILDINGS, BUILDING_BY_ID, MAP_W, POND, T, Tile, WORLD_H, WORLD_W, buildMap, yardTiles, type WorldMap } from './map';
import { findPath, type Pt } from './pathfinding';
import { renderProps } from './props';
import { character, icon, type Facing } from './sprites';

const SIGN_FONT = '"Press Start 2P", monospace';
const TEXT_FONT = '"VT323", monospace';

interface Bubble {
  text: string;
  until: number;
  color: string;
}

interface Errand {
  building: BuildingId;
  holdMs: number;
  arrivedAt: number;
}

interface Villager {
  id: string;
  dto: AgentDTO;
  x: number;
  y: number;
  path: Pt[];
  anchor: BuildingId | null;
  facing: Facing;
  animT: number;
  idleUntil: number;
  errand: Errand | null;
  bubble: Bubble | null;
  carry: 'scroll' | 'coin' | 'skull' | null;
  sparkleUntil: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
  kind: 'smoke' | 'coin' | 'spark' | 'firework';
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
}

interface Duck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}

const GRAVE_SLOTS: Pt[] = [
  { x: 49, y: 31 }, { x: 53, y: 31 }, { x: 55, y: 31 },
  { x: 47, y: 33 }, { x: 49, y: 33 }, { x: 53, y: 33 }, { x: 55, y: 33 },
  { x: 47, y: 35 }, { x: 49, y: 35 }, { x: 53, y: 35 }, { x: 55, y: 35 }, { x: 51, y: 31 },
];

const ERRAND_BUBBLE_MS = 5000;

export class World {
  private g: CanvasRenderingContext2D;
  private map: WorldMap;
  private ground: HTMLCanvasElement;
  private statics: Sprite[];
  private tombCanvases: HTMLCanvasElement[] = [];
  private villagers = new Map<string, Villager>();
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private ducks: Duck[] = [];
  private snap: WorldSnapshot | null = null;
  private cam = { x: 0, y: 0, zoom: 2 };
  private minZoom = 1;
  private dpr = 1;
  private last = performance.now();
  private hover: { building: BuildingId | null; agent: string | null } = { building: null, agent: null };
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private smokeT = 0;
  private yards = new Map<BuildingId, Pt[]>();
  private follow: string | null = null;
  private fireworksUntil = 0;

  onBuildingClick: (id: BuildingId) => void = () => {};
  onAgentClick: (id: string) => void = () => {};
  onHover: (text: string | null, x: number, y: number) => void = () => {};

  constructor(private el: HTMLCanvasElement) {
    const g = el.getContext('2d');
    if (!g) throw new Error('canvas 2D not supported');
    this.g = g;
    this.map = buildMap();
    for (const s of GRAVE_SLOTS) this.map.blocked[s.y * MAP_W + s.x] = 1;
    this.ground = renderGround(this.map);
    this.statics = [...renderBuildings(), ...renderProps(this.map.props)];
    for (let i = 0; i < 4; i++) this.tombCanvases.push(tombstone(i));
    for (const b of BUILDINGS) this.yards.set(b.id, yardTiles(this.map, b.id));
    for (let i = 0; i < 3; i++) {
      this.ducks.push({
        x: (POND.x + 2 + i * 2) * T,
        y: (POND.y + 2 + i) * T,
        vx: (Math.random() - 0.5) * 8,
        vy: (Math.random() - 0.5) * 6,
        t: Math.random() * 10,
      });
    }
    this.resize();
    this.cam.zoom = this.minZoom;
    this.centerOn(WORLD_W / 2, WORLD_H / 2);
    window.addEventListener('resize', () => this.resize());
    this.bindInput();
  }

  // -------------------------------------------------------------------------
  // Data in
  // -------------------------------------------------------------------------

  setSnapshot(s: WorldSnapshot): void {
    this.snap = s;
    const seen = new Set<string>();
    for (const a of s.agents) {
      seen.add(a.id);
      const v = this.villagers.get(a.id);
      if (v) {
        v.dto = a;
        continue;
      }
      const spot = this.randomYard(a.location);
      this.villagers.set(a.id, {
        id: a.id,
        dto: a,
        x: spot.x * T + T / 2,
        y: spot.y * T + T - 2,
        path: [],
        anchor: a.location,
        facing: 'down',
        animT: Math.random() * 4,
        idleUntil: performance.now() + Math.random() * 4000,
        errand: null,
        bubble: null,
        carry: null,
        sparkleUntil: 0,
      });
    }
    for (const id of [...this.villagers.keys()]) if (!seen.has(id)) this.villagers.delete(id);
  }

  handleEvent(e: GameEvent): void {
    const now = performance.now();
    const v = e.agentId ? this.villagers.get(e.agentId) : undefined;
    const say = (text: string, color = '#ffffff', ms = ERRAND_BUBBLE_MS) => {
      if (v) v.bubble = { text, until: now + ms, color };
    };
    switch (e.kind) {
      case 'discovery':
        if (v) {
          v.errand = { building: 'vault', holdMs: 4000, arrivedAt: 0 };
          v.carry = 'scroll';
          v.anchor = null;
        }
        say(e.text, '#fff3b0', 7000);
        break;
      case 'assign':
        if (v) {
          v.errand = { building: 'vault', holdMs: 2500, arrivedAt: 0 };
          v.anchor = null;
          v.carry = 'scroll';
        }
        say(e.text, '#d6f5ff');
        break;
      case 'retire':
        if (v) {
          v.errand = { building: 'graveyard', holdMs: 5000, arrivedAt: 0 };
          v.anchor = null;
          v.carry = 'skull';
        }
        say(e.text, '#dddddd', 7000);
        break;
      case 'trade_open':
        say(e.text, '#d6f5ff', 4000);
        break;
      case 'trade_close': {
        say(e.text, (e.value ?? 0) >= 0 ? '#b8f5b0' : '#ffc4c4', 4000);
        if (v) {
          this.floaters.push({ x: v.x, y: v.y - 30, text: e.text, color: (e.value ?? 0) >= 0 ? '#4cd964' : '#ff5a5a', born: now });
          if ((e.value ?? 0) > 0) this.burst(v.x, v.y - 20, 'coin', 10);
        }
        break;
      }
      case 'halt':
        if (v) {
          v.errand = { building: 'warroom', holdMs: 8000, arrivedAt: 0 };
          v.anchor = null;
        }
        say(e.text, '#ffc4c4', 8000);
        break;
      case 'resume':
        say(e.text, '#b8f5b0');
        break;
      case 'levelup':
        if (v) {
          v.sparkleUntil = now + 2500;
          this.burst(v.x, v.y - 14, 'spark', 16);
        }
        say(e.text, '#fff3b0', 3500);
        break;
      case 'rebalance':
        if (v) {
          v.errand = { building: 'markets', holdMs: 4000, arrivedAt: 0 };
          v.anchor = null;
          v.carry = 'coin';
        }
        say(e.text);
        break;
      case 'achievement': {
        this.fireworksUntil = now + 3500;
        break;
      }
      case 'regime':
      case 'report':
        say(e.text);
        break;
      case 'signal':
        if (v) v.carry = 'scroll';
        say(e.text, '#d6f5ff', 4000);
        break;
    }
  }

  focusAgent(id: string): void {
    const v = this.villagers.get(id);
    if (!v) return;
    this.follow = id;
    this.centerOn(v.x, v.y);
  }

  focusBuilding(id: BuildingId): void {
    const b = BUILDING_BY_ID[id];
    this.follow = null;
    this.centerOn((b.x + b.w / 2) * T, (b.y + b.h / 2) * T);
  }

  // -------------------------------------------------------------------------
  // Camera and input
  // -------------------------------------------------------------------------

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.el.width = Math.floor(w * this.dpr);
    this.el.height = Math.floor(h * this.dpr);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.minZoom = Math.max(w / WORLD_W, h / WORLD_H);
    this.cam.zoom = Math.max(this.cam.zoom, this.minZoom);
    this.clampCam();
  }

  private viewW(): number {
    return window.innerWidth / this.cam.zoom;
  }

  private viewH(): number {
    return window.innerHeight / this.cam.zoom;
  }

  private centerOn(x: number, y: number): void {
    this.cam.x = x - this.viewW() / 2;
    this.cam.y = y - this.viewH() / 2;
    this.clampCam();
  }

  private clampCam(): void {
    this.cam.x = Math.max(0, Math.min(WORLD_W - this.viewW(), this.cam.x));
    this.cam.y = Math.max(0, Math.min(WORLD_H - this.viewH(), this.cam.y));
  }

  private toWorld(sx: number, sy: number): Pt {
    return { x: this.cam.x + sx / this.cam.zoom, y: this.cam.y + sy / this.cam.zoom };
  }

  private toScreen(wx: number, wy: number): Pt {
    return { x: (wx - this.cam.x) * this.cam.zoom, y: (wy - this.cam.y) * this.cam.zoom };
  }

  zoomBy(factor: number, sx = window.innerWidth / 2, sy = window.innerHeight / 2): void {
    const before = this.toWorld(sx, sy);
    this.cam.zoom = Math.max(this.minZoom, Math.min(5, this.cam.zoom * factor));
    this.cam.x = before.x - sx / this.cam.zoom;
    this.cam.y = before.y - sy / this.cam.zoom;
    this.clampCam();
  }

  private bindInput(): void {
    const el = this.el;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
        if (this.drag.moved) {
          this.follow = null;
          this.cam.x = this.drag.cx - dx / this.cam.zoom;
          this.cam.y = this.drag.cy - dy / this.cam.zoom;
          this.clampCam();
        }
        return;
      }
      this.updateHover(e.clientX, e.clientY);
    });
    el.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved) this.click(e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', () => {
      this.hover = { building: null, agent: null };
      this.onHover(null, 0, 0);
    });
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, #overlay:not([hidden])')) return;
      const step = 40 / this.cam.zoom;
      const keys: Record<string, () => void> = {
        ArrowLeft: () => (this.cam.x -= step),
        ArrowRight: () => (this.cam.x += step),
        ArrowUp: () => (this.cam.y -= step),
        ArrowDown: () => (this.cam.y += step),
        '+': () => this.zoomBy(1.15),
        '=': () => this.zoomBy(1.15),
        '-': () => this.zoomBy(1 / 1.15),
      };
      const fn = keys[e.key];
      if (fn) {
        this.follow = null;
        fn();
        this.clampCam();
      }
    });
  }

  private pick(sx: number, sy: number): { building: BuildingId | null; agent: string | null } {
    const p = this.toWorld(sx, sy);
    let agent: string | null = null;
    let best = Infinity;
    for (const v of this.villagers.values()) {
      if (p.x >= v.x - 7 && p.x <= v.x + 7 && p.y >= v.y - 24 && p.y <= v.y + 1) {
        const d = Math.abs(p.y - v.y);
        if (d < best) {
          best = d;
          agent = v.id;
        }
      }
    }
    if (agent) return { building: null, agent };
    for (const b of BUILDINGS) {
      const top = b.style === 'chapel' ? b.y - 2 : b.y - 1;
      if (p.x >= b.x * T && p.x <= (b.x + b.w) * T && p.y >= top * T && p.y <= (b.y + b.h) * T) return { building: b.id, agent: null };
    }
    return { building: null, agent: null };
  }

  private updateHover(sx: number, sy: number): void {
    this.hover = this.pick(sx, sy);
    this.el.style.cursor = this.hover.building || this.hover.agent ? 'pointer' : 'grab';
    if (this.hover.agent) {
      const v = this.villagers.get(this.hover.agent);
      this.onHover(v ? `${v.dto.name} (Lv ${v.dto.level} ${v.dto.title}): ${v.dto.activity}` : null, sx, sy);
    } else if (this.hover.building) {
      const b = BUILDING_BY_ID[this.hover.building];
      this.onHover(`${b.label}: ${b.blurb}`, sx, sy);
    } else {
      this.onHover(null, sx, sy);
    }
  }

  private click(sx: number, sy: number): void {
    const hit = this.pick(sx, sy);
    if (hit.agent) this.onAgentClick(hit.agent);
    else if (hit.building) this.onBuildingClick(hit.building);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  private randomYard(id: BuildingId): Pt {
    const tiles = this.yards.get(id) ?? [];
    if (!tiles.length) return BUILDING_BY_ID[id].door;
    return tiles[Math.floor(Math.random() * tiles.length)];
  }

  private walkTo(v: Villager, target: Pt): void {
    const from = { x: Math.floor(v.x / T), y: Math.floor((v.y - 1) / T) };
    const path = findPath(this.map, from, target);
    if (path.length) v.path = path;
  }

  private updateVillager(v: Villager, dt: number, now: number): void {
    const sleeping = v.dto.mood === 'sleeping';
    const desired: BuildingId = v.errand ? v.errand.building : v.dto.location;
    if (v.anchor !== desired) {
      v.anchor = desired;
      this.walkTo(v, this.randomYard(desired));
    }
    if (v.path.length) {
      const next = v.path[0];
      const tx = next.x * T + T / 2;
      const ty = next.y * T + T - 2;
      const dx = tx - v.x;
      const dy = ty - v.y;
      const dist = Math.hypot(dx, dy);
      const speed = v.errand ? 46 : 30;
      const stepLen = speed * dt;
      if (dist <= stepLen) {
        v.x = tx;
        v.y = ty;
        v.path.shift();
      } else {
        v.x += (dx / dist) * stepLen;
        v.y += (dy / dist) * stepLen;
      }
      v.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
      v.animT += dt * 8;
      if (!v.path.length) v.idleUntil = now + 2500 + Math.random() * 6000;
      return;
    }
    v.animT = 0;
    if (v.errand) {
      if (!v.errand.arrivedAt) v.errand.arrivedAt = now;
      else if (now - v.errand.arrivedAt > v.errand.holdMs) {
        v.errand = null;
        v.carry = null;
      }
      return;
    }
    if (!sleeping && now > v.idleUntil) {
      v.idleUntil = now + 3000 + Math.random() * 7000;
      const tiles = this.yards.get(desired) ?? [];
      const cx = Math.floor(v.x / T);
      const cy = Math.floor(v.y / T);
      const near = tiles.filter((t) => Math.abs(t.x - cx) + Math.abs(t.y - cy) <= 4);
      const pool = near.length ? near : tiles;
      if (pool.length) this.walkTo(v, pool[Math.floor(Math.random() * pool.length)]);
      if (Math.random() < 0.5) v.facing = (['down', 'left', 'right', 'down'] as Facing[])[Math.floor(Math.random() * 4)];
    }
  }

  private burst(x: number, y: number, kind: Particle['kind'], n: number): void {
    const colors = kind === 'coin' ? ['#f5c542', '#ffe28a', '#d4a017'] : ['#fff3b0', '#ffffff', '#6ec6ff', '#e85d75'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 20 + Math.random() * 40;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        life: 0,
        max: 0.8 + Math.random() * 0.6,
        color: colors[i % colors.length],
        size: kind === 'coin' ? 2 : 1,
        kind,
      });
    }
  }

  private updateParticles(dt: number, now: number): void {
    this.smokeT += dt;
    if (this.smokeT > 0.35) {
      this.smokeT = 0;
      const labBusy = this.snap?.researchers.some((r) => r.enabled && r.origin === 'evolution') ?? false;
      for (const s of this.statics) {
        for (const p of s.smoke) {
          if (s.building === 'lab' && !labBusy) continue;
          this.particles.push({
            x: p.x + (Math.random() - 0.5) * 2,
            y: p.y,
            vx: 3 + Math.random() * 4,
            vy: -10 - Math.random() * 6,
            life: 0,
            max: 2.5,
            color: s.building === 'lab' ? '#e8fbff' : '#d8d8d8',
            size: 2,
            kind: 'smoke',
          });
        }
      }
    }
    if (now < this.fireworksUntil && Math.random() < dt * 5) {
      const hall = BUILDING_BY_ID.hall;
      this.burst((hall.x + Math.random() * hall.w) * T, (hall.y - 1 + Math.random() * 3) * T, 'firework', 24);
    }
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind !== 'smoke') p.vy += 90 * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    this.floaters = this.floaters.filter((f) => now - f.born < 2200);
    for (const d of this.ducks) {
      d.t += dt;
      if (Math.random() < dt * 0.3) {
        d.vx = (Math.random() - 0.5) * 10;
        d.vy = (Math.random() - 0.5) * 8;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const x0 = (POND.x + 1) * T;
      const x1 = (POND.x + POND.w - 1) * T - 8;
      const y0 = (POND.y + 1) * T;
      const y1 = (POND.y + POND.h - 1) * T - 6;
      if (d.x < x0 || d.x > x1) d.vx *= -1;
      if (d.y < y0 || d.y > y1) d.vy *= -1;
      d.x = Math.max(x0, Math.min(x1, d.x));
      d.y = Math.max(y0, Math.min(y1, d.y));
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  start(): void {
    const frame = (t: number) => {
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      for (const v of this.villagers.values()) this.updateVillager(v, dt, t);
      this.updateParticles(dt, t);
      if (this.follow) {
        const v = this.villagers.get(this.follow);
        if (v) {
          this.cam.x += (v.x - this.viewW() / 2 - this.cam.x) * Math.min(1, dt * 3);
          this.cam.y += (v.y - this.viewH() / 2 - this.cam.y) * Math.min(1, dt * 3);
          this.clampCam();
        }
      }
      this.render(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private darkness(): { a: number; dusk: number } {
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    if (h >= 7 && h < 17.5) return { a: 0, dusk: 0 };
    if (h >= 17.5 && h < 20) {
      const k = (h - 17.5) / 2.5;
      return { a: 0.5 * k, dusk: 1 - Math.abs(k - 0.4) * 1.6 };
    }
    if (h >= 5 && h < 7) {
      const k = (7 - h) / 2;
      return { a: 0.5 * k, dusk: 0.5 * (1 - k) };
    }
    return { a: 0.5, dusk: 0 };
  }

  private render(now: number): void {
    const g = this.g;
    const z = this.cam.zoom * this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#2f6b3a';
    g.fillRect(0, 0, this.el.width, this.el.height);
    g.setTransform(z, 0, 0, z, -this.cam.x * z, -this.cam.y * z);

    const vx = Math.floor(this.cam.x);
    const vy = Math.floor(this.cam.y);
    const vw = Math.ceil(this.viewW()) + 2;
    const vh = Math.ceil(this.viewH()) + 2;
    g.drawImage(this.ground, vx, vy, vw, vh, vx, vy, vw, vh);
    this.drawWater(now);

    // Y-sorted drawables
    type D = { baseY: number; draw: () => void };
    const list: D[] = [];
    for (const s of this.statics) {
      if (s.x > vx + vw || s.x + s.canvas.width < vx || s.y > vy + vh || s.baseY < vy) continue;
      list.push({ baseY: s.baseY, draw: () => this.drawSprite(s) });
    }
    const graves = this.snap?.graveyard ?? [];
    graves.slice(0, GRAVE_SLOTS.length).forEach((grave, i) => {
      const slot = GRAVE_SLOTS[i];
      const c = this.tombCanvases[(grave.id.charCodeAt(grave.id.length - 1) + i) % this.tombCanvases.length];
      list.push({ baseY: (slot.y + 1) * T, draw: () => g.drawImage(c, slot.x * T + 2, (slot.y + 1) * T - 16) });
    });
    for (const v of this.villagers.values()) {
      list.push({ baseY: v.y, draw: () => this.drawVillager(v, now) });
    }
    list.sort((a, b) => a.baseY - b.baseY);
    for (const d of list) d.draw();

    for (const p of this.particles) {
      const k = 1 - p.life / p.max;
      g.globalAlpha = p.kind === 'smoke' ? 0.55 * k : Math.min(1, k * 1.5);
      g.fillStyle = p.color;
      const size = p.kind === 'smoke' ? p.size + p.life * 2 : p.size;
      g.fillRect(p.x, p.y, size, size);
    }
    g.globalAlpha = 1;

    this.drawLighting(now, vx, vy, vw, vh);
    this.drawWeather(now, vx, vy, vw, vh);

    // Screen-space labels
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSigns();
    this.drawBoard(now);
    this.drawVillagerLabels(now);
    this.drawFloaters(now);
  }

  private drawSprite(s: Sprite): void {
    const g = this.g;
    if (s.building && this.hover.building === s.building) {
      g.globalAlpha = 0.35;
      g.fillStyle = '#fff3b0';
      g.fillRect(s.x - 2, s.y - 2, s.canvas.width + 4, s.baseY - s.y + 4);
      g.globalAlpha = 1;
    }
    g.drawImage(s.canvas, s.x, s.y);
    if (s.siren) {
      const halted = this.snap?.risk.halted || this.snap?.risk.dataStale;
      const on = s.building === 'warroom' ? halted && Math.floor(performance.now() / 300) % 2 === 0 : Math.floor(performance.now() / 900) % 2 === 0;
      g.fillStyle = on ? '#ff3b3b' : s.building === 'warroom' ? '#7a2a2a' : '#5a1a1a';
      g.fillRect(s.siren.x - 2, s.siren.y - 2, 4, 3);
      if (on && s.building === 'warroom') {
        g.globalAlpha = 0.35;
        g.fillStyle = '#ff3b3b';
        g.fillRect(s.siren.x - 10, s.siren.y - 8, 20, 14);
        g.globalAlpha = 1;
      }
    }
  }

  private drawWater(now: number): void {
    const g = this.g;
    const t = now / 1000;
    g.fillStyle = '#8fd3f7';
    for (let ty = POND.y; ty < POND.y + POND.h; ty++) {
      for (let tx = POND.x; tx < POND.x + POND.w; tx++) {
        if (this.map.tiles[ty * MAP_W + tx] !== Tile.Water) continue;
        const phase = (tx * 3 + ty * 7 + Math.floor(t * 1.5)) % 5;
        if (phase === 0) g.fillRect(tx * T + 4, ty * T + 6, 4, 1);
        if (phase === 2) g.fillRect(tx * T + 9, ty * T + 11, 3, 1);
      }
    }
    // lily pads
    g.fillStyle = '#3f9a44';
    for (const [x, y] of [[POND.x + 1.5, POND.y + 5.2], [POND.x + 6.3, POND.y + 1.6], [POND.x + 7, POND.y + 6]]) {
      g.fillRect(x * T, y * T, 5, 3);
      g.fillStyle = '#e85d75';
      g.fillRect(x * T + 1, y * T, 1, 1);
      g.fillStyle = '#3f9a44';
    }
    // dock
    g.fillStyle = '#8b5a2b';
    g.fillRect((POND.x + 3.6) * T, (POND.y + POND.h - 2) * T, 0.8 * T + 6, 2 * T);
    g.fillStyle = '#6b4226';
    for (let j = 0; j < 2 * T; j += 4) g.fillRect((POND.x + 3.6) * T, (POND.y + POND.h - 2) * T + j, 0.8 * T + 6, 1);
    // ducks
    for (const d of this.ducks) {
      const bob = Math.sin(d.t * 3) > 0 ? 0 : 1;
      g.fillStyle = '#ffffff';
      g.fillRect(d.x, d.y + bob, 7, 4);
      g.fillRect(d.vx >= 0 ? d.x + 5 : d.x - 1, d.y - 2 + bob, 3, 3);
      g.fillStyle = '#f39c12';
      g.fillRect(d.vx >= 0 ? d.x + 8 : d.x - 2, d.y - 1 + bob, 1, 1);
      g.fillStyle = '#6ec6ff';
      g.fillRect(d.x - 1, d.y + 4 + bob, 9, 1);
    }
  }

  private drawVillager(v: Villager, now: number): void {
    const g = this.g;
    const moving = v.path.length > 0;
    const frame = moving ? Math.floor(v.animT) % 4 : 0;
    const sprite = character(v.dto.appearance, v.facing, frame, v.dto.role);
    const sx = Math.round(v.x - sprite.width / 2);
    const sy = Math.round(v.y - sprite.height + 2);
    if (this.hover.agent === v.id || this.follow === v.id) {
      g.fillStyle = 'rgba(255,243,176,0.6)';
      g.fillRect(sx + 2, v.y - 1, sprite.width - 4, 3);
    }
    g.drawImage(sprite, sx, sy);
    const iconY = sy - 9;
    let ic: HTMLCanvasElement | null = null;
    if (v.carry) ic = icon(v.carry);
    else if (v.dto.mood === 'sleeping') ic = icon('zzz');
    else if (v.dto.mood === 'excited' && Math.floor(now / 600) % 2 === 0) ic = icon('heart');
    else if (v.dto.role === 'risk' && this.snap?.risk.halted) ic = icon('bang');
    if (ic) g.drawImage(ic, Math.round(v.x - 4), iconY + (v.dto.mood === 'sleeping' ? Math.round(Math.sin(now / 400) * 2) : 0));
    if (now < v.sparkleUntil) {
      g.fillStyle = '#fff3b0';
      for (let i = 0; i < 4; i++) {
        const a = now / 200 + (i * Math.PI) / 2;
        g.fillRect(v.x + Math.cos(a) * 10, v.y - 12 + Math.sin(a) * 10, 2, 2);
      }
    }
  }

  private drawLighting(now: number, vx: number, vy: number, vw: number, vh: number): void {
    const { a, dusk } = this.darkness();
    const g = this.g;
    const weather = this.snap?.markets[0]?.regime;
    const cloud = weather === 'volatile' ? 0.22 : weather === 'bear' ? 0.1 : 0;
    if (cloud > 0) {
      g.fillStyle = `rgba(40,50,70,${cloud})`;
      g.fillRect(vx, vy, vw, vh);
    }
    if (dusk > 0) {
      g.fillStyle = `rgba(255,140,60,${0.12 * dusk})`;
      g.fillRect(vx, vy, vw, vh);
    }
    if (a <= 0) return;
    g.fillStyle = `rgba(12,20,58,${a})`;
    g.fillRect(vx, vy, vw, vh);
    g.globalCompositeOperation = 'lighter';
    const flicker = 0.85 + Math.sin(now / 180) * 0.05;
    for (const s of this.statics) {
      for (const w of s.windows) {
        g.fillStyle = `rgba(255,190,90,${0.55 * (a / 0.5) * flicker})`;
        g.fillRect(w.x, w.y, w.w, w.h);
      }
      if (s.light) {
        const grd = g.createRadialGradient(s.light.x, s.light.y, 2, s.light.x, s.light.y, s.light.r);
        grd.addColorStop(0, `rgba(255,200,110,${0.45 * (a / 0.5)})`);
        grd.addColorStop(1, 'rgba(255,200,110,0)');
        g.fillStyle = grd;
        g.fillRect(s.light.x - s.light.r, s.light.y - s.light.r, s.light.r * 2, s.light.r * 2);
      }
    }
    g.globalCompositeOperation = 'source-over';
  }

  private drawWeather(now: number, vx: number, vy: number, vw: number, vh: number): void {
    const regime = this.snap?.markets[0]?.regime;
    const g = this.g;
    if (regime === 'volatile') {
      g.fillStyle = 'rgba(180,200,255,0.55)';
      const t = now / 1000;
      for (let i = 0; i < 160; i++) {
        const x = vx + ((i * 97.3 + t * 40) % vw);
        const y = vy + ((i * 53.7 + t * 260) % vh);
        g.fillRect(x, y, 1, 5);
      }
    } else if (regime === 'bull') {
      // butterflies on sunny days
      for (let i = 0; i < 6; i++) {
        const t = now / 1000 + i * 13;
        const x = ((i * 173 + Math.sin(t * 0.3) * 80 + t * 6) % WORLD_W + WORLD_W) % WORLD_W;
        const y = (i * 117 + Math.cos(t * 0.4) * 50 + 200) % WORLD_H;
        const flap = Math.floor(t * 8) % 2;
        g.fillStyle = ['#f7d14a', '#e85d75', '#ffffff', '#b07cf0', '#6ec6ff', '#ff9f43'][i];
        g.fillRect(x - 2, y - flap, 2, 2);
        g.fillRect(x + 1, y - flap, 2, 2);
      }
    }
  }

  private drawSigns(): void {
    const g = this.g;
    const size = Math.round(Math.max(7, Math.min(11, this.cam.zoom * 3.6)));
    g.font = `${size}px ${SIGN_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const b of BUILDINGS) {
      const wx = (b.x + b.w / 2) * T;
      const wy = b.style === 'chapel' ? (b.y - 2) * T - 6 : b.style === 'plaza' ? b.y * T - 2 : b.y * T - 4;
      const p = this.toScreen(wx, wy);
      if (p.x < -100 || p.y < -20 || p.x > window.innerWidth + 100 || p.y > window.innerHeight + 20) continue;
      const w = g.measureText(b.label).width + size * 1.6;
      const h = size * 2;
      const x = Math.round(p.x - w / 2);
      const y = Math.round(p.y - h / 2);
      g.fillStyle = '#4a2e1a';
      g.fillRect(x - 2, y - 2, w + 4, h + 4);
      g.fillStyle = this.hover.building === b.id ? '#f6d9a0' : '#d9a864';
      g.fillRect(x, y, w, h);
      g.fillStyle = '#b8864a';
      g.fillRect(x, y + h - 2, w, 2);
      g.fillStyle = '#3b2412';
      g.fillText(b.label, p.x, p.y + 1);
    }
  }

  private drawBoard(now: number): void {
    const markets = this.snap?.markets ?? [];
    const sprite = this.statics.find((s) => s.board);
    if (!sprite?.board || !markets.length) return;
    const b = sprite.board;
    const tl = this.toScreen(b.x, b.y);
    const br = this.toScreen(b.x + b.w, b.y + b.h);
    const h = br.y - tl.y;
    if (h < 8) return;
    const m = markets[Math.floor(now / 3000) % markets.length];
    const up = m.change24h >= 0;
    const g = this.g;
    g.save();
    g.beginPath();
    g.rect(tl.x, tl.y, br.x - tl.x, h);
    g.clip();
    g.font = `${Math.round(h * 0.42)}px ${SIGN_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = up ? '#4cd964' : '#ff5a5a';
    const price = m.price >= 1000 ? Math.round(m.price).toLocaleString('en-US') : m.price.toFixed(2);
    g.fillText(`${m.symbol} ${price}`, (tl.x + br.x) / 2, tl.y + h * 0.33);
    g.fillText(`${up ? '▲' : '▼'}${Math.abs(m.change24h * 100).toFixed(1)}%`, (tl.x + br.x) / 2, tl.y + h * 0.75);
    g.restore();
  }

  private drawVillagerLabels(now: number): void {
    const g = this.g;
    const nameSize = Math.round(Math.max(12, Math.min(18, this.cam.zoom * 6)));
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    const sorted = [...this.villagers.values()].sort((a, b) => a.y - b.y);
    for (const v of sorted) {
      const p = this.toScreen(v.x, v.y - 27);
      if (p.x < -60 || p.x > window.innerWidth + 60 || p.y < -40 || p.y > window.innerHeight + 40) continue;
      g.font = `${nameSize}px ${TEXT_FONT}`;
      const label = `${v.dto.name} ${v.dto.level}`;
      const w = g.measureText(label).width + 8;
      const x = Math.round(p.x - w / 2);
      const y = Math.round(p.y - nameSize * 0.6);
      g.fillStyle = 'rgba(20,16,10,0.72)';
      g.fillRect(x, y, w, nameSize * 1.1);
      g.fillStyle = v.dto.role === 'trader' ? '#ffe066' : v.dto.role === 'researcher' || v.dto.role === 'strategist' ? '#9fe7ff' : '#ffffff';
      g.fillText(label, p.x, y + nameSize * 0.58);

      if (v.bubble && now < v.bubble.until) {
        const bs = Math.round(nameSize * 1.05);
        g.font = `${bs}px ${TEXT_FONT}`;
        const text = v.bubble.text.length > 34 ? v.bubble.text.slice(0, 33) + '…' : v.bubble.text;
        const bw = g.measureText(text).width + 12;
        const bh = bs * 1.3;
        const bx = Math.round(p.x - bw / 2);
        const by = Math.round(y - bh - 8);
        g.fillStyle = '#2b1d0e';
        g.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
        g.fillStyle = v.bubble.color;
        g.fillRect(bx, by, bw, bh);
        g.fillRect(p.x - 3, by + bh, 6, 3);
        g.fillStyle = '#2b1d0e';
        g.fillRect(p.x - 1, by + bh + 3, 2, 3);
        g.fillText(text, p.x, by + bh / 2 + 1);
      }
    }
  }

  private drawFloaters(now: number): void {
    const g = this.g;
    const size = Math.round(Math.max(14, Math.min(22, this.cam.zoom * 7)));
    g.font = `${size}px ${SIGN_FONT}`;
    g.textAlign = 'center';
    for (const f of this.floaters) {
      const k = (now - f.born) / 2200;
      const p = this.toScreen(f.x, f.y - k * 24);
      g.globalAlpha = Math.max(0, 1 - k * k);
      g.fillStyle = '#1b1b1b';
      g.fillText(f.text, p.x + 2, p.y + 2);
      g.fillStyle = f.color;
      g.fillText(f.text, p.x, p.y);
    }
    g.globalAlpha = 1;
  }
}
