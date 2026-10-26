import type { BuildingId } from '../../../shared/types';

export const T = 16; // tile size in world pixels
export const MAP_W = 64;
export const MAP_H = 44;
export const WORLD_W = MAP_W * T;
export const WORLD_H = MAP_H * T;

export const Tile = { Grass: 0, Path: 1, Water: 2, Dirt: 3, Plaza: 4 } as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

export type BuildingStyle = 'manor' | 'barn' | 'greenhouse' | 'chapel' | 'bank' | 'cottage' | 'vault' | 'graveyard' | 'plaza';

export interface BuildingDef {
  id: BuildingId;
  label: string;
  short: string;
  style: BuildingStyle;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Walkable tile in front of the door where agents gather. */
  door: { x: number; y: number };
  blurb: string;
}

export const BUILDINGS: BuildingDef[] = [
  { id: 'bank', label: 'TREASURY', short: 'TREASURY', style: 'bank', x: 3, y: 3, w: 8, h: 7, door: { x: 7, y: 10 }, blurb: 'Equity curve, ledger and fees' },
  { id: 'media', label: 'MEDIA STUDIO', short: 'MEDIA', style: 'cottage', x: 13, y: 3, w: 7, h: 7, door: { x: 16, y: 10 }, blurb: 'News desk, signal board and the Gazette' },
  { id: 'command', label: 'COMMAND CENTER', short: 'COMMAND', style: 'manor', x: 25, y: 2, w: 14, h: 9, door: { x: 32, y: 11 }, blurb: 'Fund overview, allocation, Real Money License' },
  { id: 'markets', label: 'TRADING FLOOR', short: 'TRADING', style: 'barn', x: 44, y: 3, w: 13, h: 8, door: { x: 50, y: 11 }, blurb: 'Live prices, positions and trades' },
  { id: 'lab', label: 'RESEARCH LAB', short: 'LAB', style: 'greenhouse', x: 4, y: 16, w: 10, h: 8, door: { x: 9, y: 24 }, blurb: 'Researchers evolving new strategies' },
  { id: 'warroom', label: 'WAR ROOM', short: 'WAR ROOM', style: 'chapel', x: 45, y: 15, w: 8, h: 9, door: { x: 49, y: 24 }, blurb: 'Risk limits and the kill switch' },
  { id: 'hall', label: 'HALL OF FAME', short: 'FAME', style: 'plaza', x: 34, y: 15, w: 8, h: 8, door: { x: 37, y: 22 }, blurb: 'Leaderboard and achievements' },
  { id: 'vault', label: 'STRATEGY VAULT', short: 'VAULT', style: 'vault', x: 5, y: 30, w: 9, h: 7, door: { x: 9, y: 37 }, blurb: 'Promoted strategies waiting for traders' },
  { id: 'graveyard', label: 'GRAVEYARD', short: 'GRAVES', style: 'graveyard', x: 45, y: 29, w: 12, h: 8, door: { x: 50, y: 37 }, blurb: 'Retired strategies and their epitaphs' },
];

export const BUILDING_BY_ID = Object.fromEntries(BUILDINGS.map((b) => [b.id, b])) as Record<BuildingId, BuildingDef>;

export const POND = { x: 18, y: 15, w: 9, h: 8 };
export const FIELD = { x: 18, y: 29, w: 10, h: 6 };
export const STATUE = { x: 37, y: 17, w: 2, h: 2 };

export interface Prop {
  kind: 'pine' | 'oak' | 'bush' | 'lamp' | 'bench' | 'sign' | 'well' | 'barrel' | 'crate' | 'scarecrow' | 'mailbox' | 'rock';
  x: number; // tile
  y: number; // tile
  variant: number;
}

/** Deterministic PRNG so the village looks the same on every load. */
function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WorldMap {
  tiles: Uint8Array;
  blocked: Uint8Array;
  props: Prop[];
  flowers: { x: number; y: number; color: string }[];
}

function rect(tiles: Uint8Array, x: number, y: number, w: number, h: number, t: Tile): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < MAP_W && j < MAP_H) tiles[j * MAP_W + i] = t;
}

export function buildMap(): WorldMap {
  const tiles = new Uint8Array(MAP_W * MAP_H);
  const blocked = new Uint8Array(MAP_W * MAP_H);
  const rnd = mulberry(1337);

  // Streets
  rect(tiles, 2, 11, 60, 2, Tile.Path); // main street
  rect(tiles, 2, 25, 60, 2, Tile.Path); // middle street
  rect(tiles, 2, 38, 60, 2, Tile.Path); // lower street
  rect(tiles, 32, 11, 2, 29, Tile.Path); // central avenue
  rect(tiles, 2, 11, 2, 29, Tile.Path); // west lane
  rect(tiles, 60, 11, 2, 29, Tile.Path); // east lane
  for (const b of BUILDINGS) {
    // Short walkway from each door to the nearest street.
    if (b.style === 'plaza') continue;
    let y = b.door.y;
    while (y < MAP_H && tiles[y * MAP_W + b.door.x] !== Tile.Path) {
      tiles[y * MAP_W + b.door.x] = Tile.Path;
      y++;
    }
  }
  // Plaza
  const hall = BUILDING_BY_ID.hall;
  rect(tiles, hall.x, hall.y, hall.w, hall.h, Tile.Plaza);
  rect(tiles, 34, 22, 1, 3, Tile.Plaza);
  rect(tiles, hall.x + 3, hall.y + hall.h, 2, 25 - (hall.y + hall.h), Tile.Plaza);
  // Pond with a dock leading to the middle street
  rect(tiles, POND.x, POND.y, POND.w, POND.h, Tile.Water);
  for (const [cx, cy] of [
    [POND.x, POND.y],
    [POND.x + POND.w - 1, POND.y],
    [POND.x, POND.y + POND.h - 1],
    [POND.x + POND.w - 1, POND.y + POND.h - 1],
  ]) {
    tiles[cy * MAP_W + cx] = Tile.Grass;
  }
  rect(tiles, POND.x + 4, POND.y + POND.h, 1, 25 - (POND.y + POND.h), Tile.Path);
  // Field
  rect(tiles, FIELD.x, FIELD.y, FIELD.w, FIELD.h, Tile.Dirt);

  const isBlocked = (x: number, y: number) => blocked[y * MAP_W + x] === 1;
  const block = (x: number, y: number, w = 1, h = 1) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < MAP_W && j < MAP_H) blocked[j * MAP_W + i] = 1;
  };

  for (let i = 0; i < tiles.length; i++) if (tiles[i] === Tile.Water) blocked[i] = 1;
  for (const b of BUILDINGS) {
    if (b.style === 'plaza') continue;
    if (b.style === 'graveyard') {
      // Fence ring with a gate at the bottom; tombstones are added at runtime.
      block(b.x, b.y, b.w, 1);
      block(b.x, b.y, 1, b.h);
      block(b.x + b.w - 1, b.y, 1, b.h);
      for (let i = b.x; i < b.x + b.w; i++) if (Math.abs(i - b.door.x) > 0 && i !== b.door.x + 1) block(i, b.y + b.h - 1);
      continue;
    }
    block(b.x, b.y, b.w, b.h);
  }
  block(STATUE.x, STATUE.y, STATUE.w, STATUE.h);

  const props: Prop[] = [];
  const free = (x: number, y: number, pad = 0) => {
    for (let j = y - pad; j <= y + pad; j++)
      for (let i = x - pad; i <= x + pad; i++) {
        if (i < 0 || j < 0 || i >= MAP_W || j >= MAP_H) return false;
        if (tiles[j * MAP_W + i] !== Tile.Grass || isBlocked(i, j)) return false;
      }
    return true;
  };
  const inBuildingZone = (x: number, y: number) =>
    BUILDINGS.some((b) => x >= b.x - 1 && x <= b.x + b.w && y >= b.y - 2 && y <= b.y + b.h + 1) ||
    (x >= FIELD.x - 1 && x <= FIELD.x + FIELD.w && y >= FIELD.y - 1 && y <= FIELD.y + FIELD.h);
  const addProp = (p: Prop, solid = true) => {
    props.push(p);
    if (solid) block(p.x, p.y);
  };

  // Forest border
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const border = x < 2 || y < 2 || x >= MAP_W - 2 || y >= MAP_H - 4;
      if (!border || !free(x, y)) continue;
      if (rnd() < 0.62) addProp({ kind: rnd() < 0.65 ? 'pine' : 'oak', x, y, variant: Math.floor(rnd() * 3) });
    }
  }
  // Scattered trees and bushes in open grass
  for (let k = 0; k < 140; k++) {
    const x = 2 + Math.floor(rnd() * (MAP_W - 4));
    const y = 2 + Math.floor(rnd() * (MAP_H - 6));
    if (!free(x, y, 1) || inBuildingZone(x, y)) continue;
    const r = rnd();
    addProp({ kind: r < 0.35 ? 'oak' : r < 0.6 ? 'pine' : r < 0.85 ? 'bush' : 'rock', x, y, variant: Math.floor(rnd() * 3) });
  }
  // Street lamps
  for (let x = 6; x < MAP_W - 4; x += 9) {
    for (const y of [10, 24, 37]) if (free(x, y)) addProp({ kind: 'lamp', x, y, variant: 0 });
  }
  // Plaza furniture
  addProp({ kind: 'bench', x: hall.x + 1, y: hall.y + 2, variant: 0 });
  addProp({ kind: 'bench', x: hall.x + hall.w - 2, y: hall.y + 2, variant: 0 });
  addProp({ kind: 'bench', x: hall.x + 1, y: hall.y + 5, variant: 0 });
  addProp({ kind: 'bench', x: hall.x + hall.w - 2, y: hall.y + 5, variant: 0 });
  // Flavor props
  const flavor: Prop[] = [
    { kind: 'well', x: 23, y: 9, variant: 0 },
    { kind: 'barrel', x: 43, y: 9, variant: 0 },
    { kind: 'barrel', x: 43, y: 8, variant: 1 },
    { kind: 'crate', x: 57, y: 9, variant: 0 },
    { kind: 'mailbox', x: 20, y: 9, variant: 0 },
    { kind: 'scarecrow', x: FIELD.x + 5, y: FIELD.y + 2, variant: 0 },
    { kind: 'crate', x: 14, y: 35, variant: 1 },
  ];
  for (const p of flavor) if (!isBlocked(p.x, p.y)) addProp(p);

  const flowers: WorldMap['flowers'] = [];
  const colors = ['#f7d14a', '#e85d75', '#ffffff', '#b07cf0', '#6ec6ff', '#ff9f43'];
  for (let k = 0; k < 420; k++) {
    const x = Math.floor(rnd() * MAP_W * T);
    const y = Math.floor(rnd() * MAP_H * T);
    const tx = Math.floor(x / T);
    const ty = Math.floor(y / T);
    if (tiles[ty * MAP_W + tx] !== Tile.Grass || isBlocked(tx, ty)) continue;
    flowers.push({ x, y, color: colors[Math.floor(rnd() * colors.length)] });
  }

  return { tiles, blocked, props, flowers };
}

/** Tiles near a building's door that agents can stand on. */
export function yardTiles(map: WorldMap, id: BuildingId): { x: number; y: number }[] {
  const b = BUILDING_BY_ID[id];
  const out: { x: number; y: number }[] = [];
  if (id === 'graveyard') {
    for (let y = b.y + 1; y < b.y + b.h - 1; y++)
      for (let x = b.x + 1; x < b.x + b.w - 1; x++) if (!map.blocked[y * MAP_W + x]) out.push({ x, y });
    return out;
  }
  if (id === 'hall') {
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) if (!map.blocked[y * MAP_W + x]) out.push({ x, y });
    return out;
  }
  const r = 3;
  for (let y = b.door.y - 1; y <= b.door.y + r; y++) {
    for (let x = b.door.x - r - 1; x <= b.door.x + r + 1; x++) {
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
      if (map.blocked[y * MAP_W + x]) continue;
      out.push({ x, y });
    }
  }
  return out;
}
