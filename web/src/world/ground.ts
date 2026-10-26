import { FIELD, MAP_H, MAP_W, T, Tile, WORLD_H, WORLD_W, type WorldMap } from './map';
import { canvas, px, seeded } from './pixel';

const GRASS = '#5fae47';
const GRASS_DARK = '#4e9a3c';
const GRASS_LIGHT = '#78c45a';
const PATH = '#e9d6a6';
const PATH_LINE = '#d4bd86';
const PATH_LIGHT = '#f4e6c0';
const PLAZA = '#d8d0bd';
const PLAZA_LINE = '#bdb39c';
const DIRT = '#c98f55';
const DIRT_DARK = '#a8723f';
const WATER = '#4aa3df';

/** Pre-rendered static ground layer (grass, streets, water bed, field, flowers). */
export function renderGround(map: WorldMap): HTMLCanvasElement {
  const { c, g } = canvas(WORLD_W, WORLD_H);
  const rnd = seeded(42);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? Tile.Grass : map.tiles[y * MAP_W + x]);

  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const x = tx * T;
      const y = ty * T;
      const t = at(tx, ty);
      if (t === Tile.Grass) {
        px(g, GRASS, x, y, T, T);
        for (let k = 0; k < 6; k++) px(g, rnd() < 0.5 ? GRASS_DARK : GRASS_LIGHT, x + rnd() * 15, y + rnd() * 15, 1, 1);
        if (rnd() < 0.35) {
          // grass tuft
          const gx = x + 2 + rnd() * 10;
          const gy = y + 4 + rnd() * 9;
          px(g, GRASS_DARK, gx, gy + 1, 1, 2);
          px(g, GRASS_DARK, gx + 2, gy, 1, 3);
          px(g, GRASS_DARK, gx + 4, gy + 1, 1, 2);
        }
      } else if (t === Tile.Path) {
        px(g, PATH, x, y, T, T);
        // brick pattern
        const off = ty % 2 === 0 ? 0 : 8;
        px(g, PATH_LINE, x, y + 7, T, 1);
        px(g, PATH_LINE, x, y + 15, T, 1);
        px(g, PATH_LINE, x + ((off + 4) % 16), y, 1, 7);
        px(g, PATH_LINE, x + ((off + 12) % 16), y + 8, 1, 7);
        px(g, PATH_LIGHT, x + ((off + 5) % 16), y + 1, 2, 1);
        px(g, PATH_LIGHT, x + ((off + 13) % 16), y + 9, 2, 1);
      } else if (t === Tile.Plaza) {
        px(g, PLAZA, x, y, T, T);
        px(g, PLAZA_LINE, x, y, T, 1);
        px(g, PLAZA_LINE, x, y, 1, T);
        px(g, (tx + ty) % 2 ? '#e2dbca' : PLAZA, x + 1, y + 1, T - 1, T - 1);
        px(g, '#efe9dc', x + 2, y + 2, 3, 1);
      } else if (t === Tile.Dirt) {
        px(g, DIRT, x, y, T, T);
        for (let k = 0; k < 4; k++) px(g, DIRT_DARK, x + rnd() * 15, y + rnd() * 15, 1, 1);
      } else if (t === Tile.Water) {
        px(g, WATER, x, y, T, T);
      }
    }
  }

  // Path and plaza edges: darker rim so streets read clearly against grass.
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const t = at(tx, ty);
      if (t !== Tile.Path && t !== Tile.Plaza) continue;
      const x = tx * T;
      const y = ty * T;
      const rim = '#b89f6a';
      const isG = (a: number, b: number) => at(a, b) === Tile.Grass;
      if (isG(tx, ty - 1)) px(g, rim, x, y, T, 1);
      if (isG(tx, ty + 1)) px(g, rim, x, y + T - 1, T, 1);
      if (isG(tx - 1, ty)) px(g, rim, x, y, 1, T);
      if (isG(tx + 1, ty)) px(g, rim, x + T - 1, y, 1, T);
    }
  }

  // Water shoreline
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      if (at(tx, ty) !== Tile.Water) continue;
      const x = tx * T;
      const y = ty * T;
      if (at(tx, ty - 1) !== Tile.Water) {
        px(g, '#3a8a3a', x, y, T, 2);
        px(g, '#8fd3f7', x, y + 2, T, 1);
      }
      if (at(tx, ty + 1) !== Tile.Water) px(g, '#2f7fc0', x, y + T - 2, T, 2);
      if (at(tx - 1, ty) !== Tile.Water) {
        px(g, '#3a8a3a', x, y, 2, T);
        px(g, '#8fd3f7', x + 2, y, 1, T);
      }
      if (at(tx + 1, ty) !== Tile.Water) px(g, '#2f7fc0', x + T - 2, y, 2, T);
    }
  }

  // Field crops
  for (let ty = FIELD.y; ty < FIELD.y + FIELD.h; ty++) {
    for (let tx = FIELD.x; tx < FIELD.x + FIELD.w; tx++) {
      const x = tx * T;
      const y = ty * T;
      px(g, DIRT_DARK, x, y + 5, T, 2);
      px(g, DIRT_DARK, x, y + 13, T, 2);
      if (tx === FIELD.x + 5 && ty === FIELD.y + 2) continue; // scarecrow spot
      for (const [ox, oy] of [
        [3, 1],
        [11, 1],
        [7, 9],
      ]) {
        const kind = (tx * 7 + ty * 3 + ox) % 3;
        const stem = kind === 0 ? '#3f9a3a' : kind === 1 ? '#5bbf4a' : '#2f8a3a';
        px(g, stem, x + ox, y + oy + 1, 1, 3);
        px(g, stem, x + ox - 1, y + oy + 1, 1, 1);
        px(g, stem, x + ox + 1, y + oy, 1, 1);
        if (kind === 2) px(g, '#f39c12', x + ox, y + oy + 4, 2, 2); // pumpkin
        if (kind === 1) px(g, '#e74c3c', x + ox + 1, y + oy - 1, 1, 1); // berry
      }
    }
  }

  // Flowers
  for (const f of map.flowers) {
    px(g, f.color, f.x, f.y, 1, 1);
    px(g, f.color, f.x + 2, f.y, 1, 1);
    px(g, f.color, f.x + 1, f.y - 1, 1, 1);
    px(g, f.color, f.x + 1, f.y + 1, 1, 1);
    px(g, '#ffe066', f.x + 1, f.y, 1, 1);
  }

  return c;
}
