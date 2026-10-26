import type { BuildingId } from '../../../shared/types';
import { BUILDINGS, STATUE, T, type BuildingDef } from './map';
import { canvas, disc, px, shade, type Ctx } from './pixel';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pre-rendered, y-sorted world sprite. Coordinates are world pixels. */
export interface Sprite {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  baseY: number;
  building?: BuildingId;
  windows: Rect[];
  smoke: { x: number; y: number }[];
  board?: Rect;
  siren?: { x: number; y: number };
  light?: { x: number; y: number; r: number };
}

// ---------------------------------------------------------------------------
// Building parts
// ---------------------------------------------------------------------------

function roof(g: Ctx, x: number, y: number, w: number, h: number, base: string, inset: number): void {
  const dark = shade(base, -0.3);
  const seam = shade(base, -0.15);
  const hi = shade(base, 0.12);
  for (let r = 0; r < h; r++) {
    const ins = Math.round(inset * (1 - r / Math.max(1, h - 1)));
    const row = r % 5;
    px(g, row === 4 ? seam : row === 0 ? hi : base, x + ins, y + r, w - ins * 2, 1);
    if (row === 2) {
      const off = Math.floor(r / 5) % 2 ? 0 : 4;
      for (let sx = x + ins + off; sx < x + w - ins; sx += 8) px(g, seam, sx, y + r - 1, 1, 3);
    }
    px(g, dark, x + ins, y + r, 1, 1);
    px(g, dark, x + w - ins - 1, y + r, 1, 1);
  }
  px(g, dark, x + inset, y, w - inset * 2, 1);
  px(g, dark, x - 1, y + h, w + 2, 2);
}

function gable(g: Ctx, cx: number, top: number, halfW: number, h: number, base: string): void {
  const dark = shade(base, -0.3);
  const seam = shade(base, -0.15);
  for (let r = 0; r < h; r++) {
    const hw = Math.round((halfW * (r + 1)) / h);
    px(g, r % 5 === 4 ? seam : base, cx - hw, top + r, hw * 2, 1);
    px(g, dark, cx - hw, top + r, 1, 1);
    px(g, dark, cx + hw - 1, top + r, 1, 1);
  }
  px(g, dark, cx - halfW - 1, top + h, halfW * 2 + 2, 2);
}

function planks(g: Ctx, x: number, y: number, w: number, h: number, base: string, vertical = false): void {
  px(g, base, x, y, w, h);
  const line = shade(base, -0.2);
  if (vertical) for (let i = x + 3; i < x + w; i += 5) px(g, line, i, y, 1, h);
  else for (let j = y + 3; j < y + h; j += 5) px(g, line, x, j, w, 1);
  px(g, shade(base, -0.35), x, y + h - 1, w, 1);
}

function bricks(g: Ctx, x: number, y: number, w: number, h: number, base: string): void {
  px(g, base, x, y, w, h);
  const line = shade(base, -0.18);
  const hi = shade(base, 0.1);
  for (let j = 0; j < h; j += 5) {
    px(g, line, x, y + j, w, 1);
    const off = (j / 5) % 2 ? 0 : 5;
    for (let i = off; i < w; i += 10) {
      px(g, line, x + i, y + j, 1, 5);
      px(g, hi, x + i + 2, y + j + 1, 3, 1);
    }
  }
}

function win(g: Ctx, out: Rect[], ox: number, oy: number, x: number, y: number, w: number, h: number, frame = '#5a3a22'): void {
  px(g, frame, x - 1, y - 1, w + 2, h + 2);
  px(g, '#7cc4e4', x, y, w, h);
  px(g, '#b9e6f7', x + 1, y + 1, Math.max(1, Math.floor(w / 3)), 1);
  px(g, '#b9e6f7', x + 1, y + 2, 1, Math.max(1, Math.floor(h / 3)));
  px(g, frame, x + Math.floor(w / 2), y, 1, h);
  px(g, frame, x, y + Math.floor(h / 2), w, 1);
  px(g, shade(frame, 0.3), x - 2, y + h + 1, w + 4, 2); // sill
  out.push({ x: ox + x, y: oy + y, w, h });
}

function door(g: Ctx, x: number, y: number, w: number, h: number, color = '#7a4a2a'): void {
  px(g, shade(color, -0.4), x - 1, y - 1, w + 2, h + 1);
  px(g, color, x, y, w, h);
  for (let i = x + 2; i < x + w - 1; i += 3) px(g, shade(color, -0.2), i, y + 1, 1, h - 1);
  px(g, '#f1c40f', x + w - 3, y + Math.floor(h / 2), 1, 2);
}

function flowerBox(g: Ctx, x: number, y: number, w: number): void {
  px(g, '#6b3f22', x, y, w, 3);
  for (let i = x + 1; i < x + w - 1; i += 2) px(g, i % 4 ? '#e85d75' : '#f7d14a', i, y - 1, 1, 1);
  px(g, '#3f8f3f', x + 1, y - 2, w - 2, 1);
}

function newSprite(def: BuildingDef, topPad: number): { g: Ctx; s: Sprite } {
  const w = def.w * T;
  const h = def.h * T + topPad;
  const { c, g } = canvas(w, h);
  const s: Sprite = {
    canvas: c,
    x: def.x * T,
    y: def.y * T - topPad,
    baseY: (def.y + def.h) * T,
    building: def.id,
    windows: [],
    smoke: [],
  };
  return { g, s };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function manor(def: BuildingDef): Sprite {
  const pad = 16;
  const { g, s } = newSprite(def, pad);
  const W = def.w * T;
  const H = def.h * T + pad;
  // chimneys
  for (const cx of [34, W - 44]) {
    bricks(g, cx, 6, 12, 30, '#9a4a3a');
    px(g, '#5a2a1a', cx - 1, 4, 14, 3);
    s.smoke.push({ x: s.x + cx + 6, y: s.y + 3 });
  }
  // walls
  const wallTop = H - 64;
  px(g, '#efe0bd', 8, wallTop, W - 16, 56);
  const beam = '#7a4a2a';
  for (let x = 8; x <= W - 10; x += 30) px(g, beam, x, wallTop, 3, 56);
  px(g, beam, 8, wallTop, W - 16, 3);
  px(g, beam, 8, wallTop + 28, W - 16, 2);
  bricks(g, 6, H - 10, W - 12, 10, '#8c8c96');
  // windows
  for (let x = 16; x < W - 24; x += 30) {
    if (Math.abs(x + 7 - W / 2) < 20) continue;
    win(g, s.windows, s.x, s.y, x + 1, wallTop + 7, 14, 16);
    flowerBox(g, x - 1, wallTop + 26, 18);
  }
  for (let x = 16; x < W - 24; x += 30) {
    if (Math.abs(x + 7 - W / 2) < 20) continue;
    win(g, s.windows, s.x, s.y, x + 2, wallTop + 34, 12, 12);
  }
  // door with porch
  const dx = Math.floor(W / 2) - 9;
  door(g, dx, H - 36, 18, 26, '#6b3f22');
  px(g, '#b5651d', dx - 4, H - 40, 26, 3);
  px(g, '#c8c8d0', dx - 6, H - 10, 30, 4);
  // roof
  roof(g, 0, 18, W, wallTop - 14, '#3d4a6e', 26);
  // dormers
  for (const cx of [W * 0.25, W * 0.5, W * 0.75]) {
    const x = Math.round(cx - 12);
    px(g, '#efe0bd', x, 40, 24, 20);
    win(g, s.windows, s.x, s.y, x + 6, 44, 12, 12);
    gable(g, x + 12, 26, 15, 14, '#2f3a58');
  }
  // flag
  px(g, '#5a3a22', W / 2, 0, 1, 20);
  px(g, '#f5c542', W / 2 + 1, 1, 10, 6);
  px(g, '#d4a017', W / 2 + 1, 6, 10, 1);
  return s;
}

function barn(def: BuildingDef): Sprite {
  const pad = 16;
  const { g, s } = newSprite(def, pad);
  const W = def.w * T;
  const H = def.h * T + pad;
  const wallTop = H - 76;
  planks(g, 6, wallTop, W - 12, 76, '#b8432f', true);
  px(g, '#f2efe6', 6, wallTop, 3, 76);
  px(g, '#f2efe6', W - 9, wallTop, 3, 76);
  px(g, '#f2efe6', 6, wallTop, W - 12, 3);
  // big door with X braces
  const dw = 44;
  const dx = Math.floor(W / 2 - dw / 2);
  const dy = H - 44;
  px(g, '#f2efe6', dx - 2, dy - 2, dw + 4, 46);
  px(g, '#8e3324', dx, dy, dw, 44);
  for (const [x0, w0] of [
    [dx, dw / 2],
    [dx + dw / 2, dw / 2],
  ]) {
    for (let i = 0; i < 44; i++) {
      const t = i / 44;
      px(g, '#f2efe6', x0 + t * (w0 - 2), dy + i, 2, 1);
      px(g, '#f2efe6', x0 + (1 - t) * (w0 - 2), dy + i, 2, 1);
    }
  }
  px(g, '#f2efe6', dx + dw / 2 - 1, dy, 2, 44);
  // LED price board above the door
  const board = { x: dx - 14, y: wallTop + 6, w: dw + 28, h: 18 };
  px(g, '#3b2a1a', board.x - 2, board.y - 2, board.w + 4, board.h + 4);
  px(g, '#0f1f14', board.x, board.y, board.w, board.h);
  s.board = { x: s.x + board.x, y: s.y + board.y, w: board.w, h: board.h };
  // windows with striped awnings
  for (const x of [22, 52, W - 66, W - 36]) {
    win(g, s.windows, s.x, s.y, x, wallTop + 34, 14, 14, '#f2efe6');
    for (let i = 0; i < 20; i += 4) px(g, i % 8 ? '#f2efe6' : '#d9534f', x - 3 + i, wallTop + 28, 4, 4);
    px(g, '#a03a2a', x - 3, wallTop + 32, 20, 1);
  }
  // gambrel roof
  roof(g, 0, 6, W, wallTop - 4, '#4a4a5a', 22);
  px(g, '#f2efe6', W / 2 - 8, 14, 16, 12);
  px(g, '#3b3b48', W / 2 - 6, 16, 12, 10);
  // weathervane
  px(g, '#333333', W / 2, 0, 1, 8);
  px(g, '#333333', W / 2 - 4, 2, 9, 1);
  return s;
}

function greenhouse(def: BuildingDef): Sprite {
  const pad = 16;
  const { g, s } = newSprite(def, pad);
  const W = def.w * T;
  const H = def.h * T + pad;
  const glassTop = H - 70;
  bricks(g, 4, H - 14, W - 8, 14, '#9a5a3a');
  // glass walls with plants inside
  px(g, '#9fe0ea', 6, glassTop, W - 12, 56);
  for (let x = 10; x < W - 12; x += 7) {
    const h = 8 + ((x * 13) % 14);
    px(g, '#3f9a4a', x, H - 14 - h, 5, h);
    px(g, '#5bbf5a', x + 1, H - 14 - h, 3, 2);
    if (x % 3 === 0) px(g, '#e85d75', x + 2, H - 16 - h, 2, 2);
  }
  px(g, '#c9f1f6', 8, glassTop + 2, W - 16, 2);
  for (let x = 6; x <= W - 8; x += 16) px(g, '#f0f7f7', x, glassTop, 2, 56);
  px(g, '#f0f7f7', 6, glassTop + 26, W - 12, 2);
  px(g, '#f0f7f7', 6, glassTop, W - 12, 2);
  s.windows.push({ x: s.x + 8, y: s.y + glassTop + 4, w: W - 16, h: 48 });
  // glass gable roof
  const cx = W / 2;
  const rh = glassTop - 6;
  for (let r = 0; r < rh; r++) {
    const hw = Math.round(((W / 2 + 4) * (r + 1)) / rh);
    px(g, r % 6 === 0 ? '#e6f7f9' : '#b8ecf3', cx - hw, 6 + r, hw * 2, 1);
    px(g, '#f0f7f7', cx - hw, 6 + r, 2, 1);
    px(g, '#f0f7f7', cx + hw - 2, 6 + r, 2, 1);
  }
  for (let r = 0; r < rh; r += 2) px(g, '#f0f7f7', cx - 1, 6 + r, 2, 2);
  px(g, '#7d8a8a', cx - W / 2 - 4, glassTop - 1, W + 8, 2);
  // door
  px(g, '#f0f7f7', cx - 10, H - 40, 20, 40);
  px(g, '#8fd6e2', cx - 8, H - 38, 16, 38);
  px(g, '#f0f7f7', cx - 1, H - 38, 2, 38);
  // chimney pipe for steam
  px(g, '#7d8a8a', W - 26, 6, 6, glassTop - 10);
  px(g, '#5d6a6a', W - 28, 4, 10, 3);
  s.smoke.push({ x: s.x + W - 23, y: s.y + 3 });
  // flask sign
  px(g, '#6b3f22', 10, H - 34, 18, 14);
  px(g, '#e8d3a0', 11, H - 33, 16, 12);
  px(g, '#5bbf5a', 16, H - 28, 6, 5);
  px(g, '#3b3b3b', 18, H - 32, 2, 4);
  return s;
}

function chapel(def: BuildingDef): Sprite {
  const pad = 32;
  const { g, s } = newSprite(def, pad);
  const W = def.w * T;
  const H = def.h * T + pad;
  const wallTop = H - 72;
  bricks(g, 6, wallTop, W - 12, 72, '#a7a7b7');
  // side windows (tall, arched)
  for (const x of [16, W - 28]) {
    win(g, s.windows, s.x, s.y, x, wallTop + 22, 12, 22, '#4a4a5a');
    px(g, '#4a4a5a', x + 2, wallTop + 19, 8, 3);
  }
  // rose window
  disc(g, '#4a4a5a', W / 2, wallTop + 22, 10);
  disc(g, '#e85d75', W / 2, wallTop + 22, 8);
  disc(g, '#6ec6ff', W / 2, wallTop + 22, 5);
  disc(g, '#f7d14a', W / 2, wallTop + 22, 2);
  s.windows.push({ x: s.x + W / 2 - 6, y: s.y + wallTop + 16, w: 12, h: 12 });
  // arched door
  door(g, W / 2 - 10, H - 30, 20, 30, '#5a3a22');
  px(g, '#5a3a22', W / 2 - 8, H - 33, 16, 3);
  px(g, '#8c8c96', W / 2 - 14, H - 4, 28, 4);
  // steep roof
  roof(g, 0, pad + 26, W, wallTop - pad - 24, '#b03a3a', 12);
  // steeple
  const sx = W / 2 - 14;
  bricks(g, sx, 18, 28, pad + 28, '#b4b4c4');
  px(g, '#2b2b3b', sx + 8, 26, 12, 14);
  disc(g, '#d4a017', sx + 14, 34, 4);
  px(g, '#f5c542', sx + 12, 31, 3, 2);
  gable(g, W / 2, 2, 18, 18, '#b03a3a');
  s.siren = { x: s.x + W / 2, y: s.y + 1 };
  return s;
}

function bank(def: BuildingDef): Sprite {
  const pad = 16;
  const { g, s } = newSprite(def, pad);
  const W = def.w * T;
  const H = def.h * T + pad;
  // back wall
  bricks(g, 8, 52, W - 16, H - 66, '#d8ceb0');
  win(g, s.windows, s.x, s.y, 24, 70, 12, 16, '#8a7a5a');
  win(g, s.windows, s.x, s.y, W - 36, 70, 12, 16, '#8a7a5a');
  door(g, W / 2 - 10, H - 46, 20, 32, '#6b4a2a');
  px(g, '#d4a017', W / 2 - 12, H - 49, 24, 3);
  // columns
  for (const x of [10, 38, W - 48, W - 20]) {
    px(g, '#f6f2e6', x, 54, 10, H - 68);
    px(g, '#dcd6c6', x + 7, 54, 3, H - 68);
    px(g, '#ffffff', x + 2, 54, 1, H - 68);
    px(g, '#cfc8b4', x - 2, 52, 14, 4);
    px(g, '#cfc8b4', x - 2, H - 16, 14, 4);
  }
  // entablature + pediment
  px(g, '#e8e0c8', 2, 42, W - 4, 10);
  px(g, '#bfb393', 2, 50, W - 4, 2);
  for (let i = 6; i < W - 6; i += 8) px(g, '#cfc5a8', i, 44, 4, 4);
  for (let r = 0; r < 28; r++) {
    const hw = Math.round(((W / 2) * (r + 1)) / 28);
    px(g, r === 27 ? '#bfb393' : '#efe8d4', W / 2 - hw, 14 + r, hw * 2, 1);
    px(g, '#bfb393', W / 2 - hw, 14 + r, 2, 1);
    px(g, '#bfb393', W / 2 + hw - 2, 14 + r, 2, 1);
  }
  disc(g, '#a8741a', W / 2, 32, 7);
  disc(g, '#f5c542', W / 2, 32, 6);
  px(g, '#a8741a', W / 2 - 1, 28, 2, 9);
  px(g, '#a8741a', W / 2 - 3, 29, 6, 1);
  px(g, '#a8741a', W / 2 - 3, 35, 6, 1);
  // steps
  px(g, '#b8b8c0', 4, H - 14, W - 8, 5);
  px(g, '#a0a0a8', 0, H - 9, W, 9);
  px(g, '#c8c8d0', 4, H - 14, W - 8, 1);
  return s;
}

function cottage(def: BuildingDef): Sprite {
  const pad = 24;
  const { g, s } = newSprite(def, pad);
  const W = def.w * T;
  const H = def.h * T + pad;
  const wallTop = H - 62;
  planks(g, 6, wallTop, W - 12, 62, '#b07a46');
  px(g, '#6b4a2a', 6, wallTop, 3, 62);
  px(g, '#6b4a2a', W - 9, wallTop, 3, 62);
  win(g, s.windows, s.x, s.y, 16, wallTop + 14, 14, 14);
  win(g, s.windows, s.x, s.y, W - 30, wallTop + 14, 14, 14);
  flowerBox(g, 14, wallTop + 31, 18);
  flowerBox(g, W - 32, wallTop + 31, 18);
  door(g, W / 2 - 8, H - 28, 16, 28, '#4a6fa5');
  // newspaper sign
  px(g, '#5a3a22', W / 2 - 13, wallTop + 4, 26, 1);
  px(g, '#f4f1e8', W / 2 - 11, wallTop + 6, 22, 14);
  px(g, '#333333', W / 2 - 9, wallTop + 8, 18, 2);
  for (let j = wallTop + 12; j < wallTop + 19; j += 2) px(g, '#888888', W / 2 - 9, j, 18, 1);
  // roof
  roof(g, 0, pad + 8, W, wallTop - pad - 6, '#3f6fb5', 14);
  // antenna + dish
  px(g, '#777777', W - 26, 0, 2, pad + 14);
  px(g, '#777777', W - 32, 4, 14, 1);
  px(g, '#777777', W - 30, 9, 10, 1);
  s.siren = { x: s.x + W - 25, y: s.y + 0 };
  disc(g, '#c8c8d0', 22, pad + 6, 6);
  disc(g, '#9a9aa6', 22, pad + 6, 3);
  px(g, '#777777', 22, pad + 6, 1, 8);
  return s;
}

function vaultStyle(def: BuildingDef): Sprite {
  const pad = 16;
  const { g, s } = newSprite(def, pad);
  const W = def.w * T;
  const H = def.h * T + pad;
  const wallTop = H - 72;
  bricks(g, 6, wallTop, W - 12, 72, '#6e7280');
  // vault door
  const cx = W / 2;
  const cy = H - 30;
  disc(g, '#3b3e48', cx, cy, 24);
  disc(g, '#a8aeb8', cx, cy, 22);
  disc(g, '#8a909a', cx, cy, 18);
  disc(g, '#c8ced8', cx, cy, 6);
  for (let a = 0; a < 6; a++) {
    const ang = (a / 6) * Math.PI * 2;
    for (let r = 6; r < 16; r++) px(g, '#5a606a', cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, 2, 2);
  }
  disc(g, '#d4a017', cx, cy, 3);
  px(g, '#6e7280', 0, H - 6, W, 6);
  px(g, '#8c8c96', cx - 26, H - 6, 52, 6);
  // torches
  for (const x of [18, W - 22]) {
    px(g, '#5a3a22', x, wallTop + 20, 4, 10);
    px(g, '#ff9f43', x - 1, wallTop + 15, 6, 5);
    px(g, '#ffd166', x + 1, wallTop + 14, 2, 3);
    s.windows.push({ x: s.x + x - 1, y: s.y + wallTop + 14, w: 6, h: 6 });
  }
  roof(g, 0, 10, W, wallTop - 8, '#2f5f5f', 10);
  px(g, '#d4a017', 0, wallTop + 1, W, 2);
  // shield emblem
  const sx = W / 2 - 9;
  px(g, '#d4a017', sx, 16, 18, 14);
  for (let r = 0; r < 8; r++) px(g, '#d4a017', sx + r, 30 + r, 18 - r * 2, 1);
  px(g, '#8e2b2b', sx + 2, 18, 14, 12);
  for (let r = 0; r < 6; r++) px(g, '#8e2b2b', sx + 2 + r, 30 + r, 14 - r * 2, 1);
  px(g, '#f5c542', sx + 8, 20, 2, 12);
  px(g, '#f5c542', sx + 5, 24, 8, 2);
  return s;
}

function graveyard(def: BuildingDef): Sprite[] {
  const W = def.w * T;
  const H = def.h * T;
  const iron = '#34343f';
  const ironHi = '#5a5a6a';
  // Back part: top fence, side fences, dead tree.
  const back = canvas(W, H + 8);
  const g = back.g;
  const fenceRow = (y: number, x0: number, x1: number, gg: Ctx) => {
    px(gg, iron, x0, y + 4, x1 - x0, 2);
    px(gg, iron, x0, y + 11, x1 - x0, 2);
    for (let x = x0; x < x1; x += 5) {
      px(gg, iron, x, y + 1, 2, 14);
      px(gg, ironHi, x, y, 2, 2);
    }
  };
  fenceRow(8, 0, W, g);
  for (let y = 8; y < H + 2; y += 5) {
    px(g, iron, 6, y, 2, 12);
    px(g, iron, W - 8, y, 2, 12);
    px(g, ironHi, 6, y, 2, 1);
    px(g, ironHi, W - 8, y, 2, 1);
  }
  // dead tree
  px(g, '#4a3424', 22, 18, 4, 30);
  px(g, '#4a3424', 14, 24, 9, 2);
  px(g, '#4a3424', 25, 20, 10, 2);
  px(g, '#4a3424', 14, 18, 2, 7);
  px(g, '#4a3424', 33, 14, 2, 7);
  const backSprite: Sprite = {
    canvas: back.c,
    x: def.x * T,
    y: def.y * T - 8,
    baseY: def.y * T + 16,
    building: def.id,
    windows: [],
    smoke: [],
  };
  // Front fence with an open gate.
  const front = canvas(W, 20);
  const gateX = (def.door.x - def.x) * T;
  fenceRow(2, 0, gateX, front.g);
  fenceRow(2, gateX + 2 * T, W, front.g);
  px(front.g, '#4a4a5a', gateX - 2, 0, 4, 18);
  px(front.g, '#4a4a5a', gateX + 2 * T - 2, 0, 4, 18);
  disc(front.g, '#f5c542', gateX, 0, 2);
  disc(front.g, '#f5c542', gateX + 2 * T, 0, 2);
  const frontSprite: Sprite = {
    canvas: front.c,
    x: def.x * T,
    y: (def.y + def.h - 1) * T - 4,
    baseY: (def.y + def.h) * T,
    building: def.id,
    windows: [],
    smoke: [],
  };
  return [backSprite, frontSprite];
}

function statue(): Sprite {
  const W = STATUE.w * T + 8;
  const H = STATUE.h * T + 28;
  const { c, g } = canvas(W, H);
  // pedestal
  px(g, '#8c8c96', 2, H - 14, W - 4, 14);
  px(g, '#a8a8b4', 4, H - 22, W - 8, 9);
  px(g, '#c8c8d0', 4, H - 22, W - 8, 1);
  px(g, '#6a5a3a', 10, H - 18, W - 20, 4);
  // golden trader holding a coin aloft
  const gold = '#e2b23a';
  const dark = '#a8741a';
  const cx = Math.floor(W / 2);
  px(g, gold, cx - 4, H - 38, 8, 16); // body
  px(g, dark, cx + 2, H - 38, 2, 16);
  px(g, gold, cx - 3, H - 46, 6, 7); // head
  px(g, dark, cx + 1, H - 46, 2, 7);
  px(g, gold, cx + 4, H - 50, 2, 14); // raised arm
  disc(g, '#f5d76e', cx + 5, H - 53, 3);
  px(g, '#fff3b0', cx + 4, H - 55, 1, 1);
  px(g, gold, cx - 6, H - 36, 2, 9); // other arm
  return {
    canvas: c,
    x: STATUE.x * T - 4,
    y: (STATUE.y + STATUE.h) * T - H,
    baseY: (STATUE.y + STATUE.h) * T,
    building: 'hall',
    windows: [],
    smoke: [],
  };
}

export function renderBuildings(): Sprite[] {
  const out: Sprite[] = [];
  for (const def of BUILDINGS) {
    switch (def.style) {
      case 'manor':
        out.push(manor(def));
        break;
      case 'barn':
        out.push(barn(def));
        break;
      case 'greenhouse':
        out.push(greenhouse(def));
        break;
      case 'chapel':
        out.push(chapel(def));
        break;
      case 'bank':
        out.push(bank(def));
        break;
      case 'cottage':
        out.push(cottage(def));
        break;
      case 'vault':
        out.push(vaultStyle(def));
        break;
      case 'graveyard':
        out.push(...graveyard(def));
        break;
      case 'plaza':
        out.push(statue());
        break;
    }
  }
  return out;
}

/** Small tombstone sprite for a retired strategy. */
export function tombstone(variant: number): HTMLCanvasElement {
  const { c, g } = canvas(12, 16);
  const stone = variant % 3 === 0 ? '#9a9aa8' : variant % 3 === 1 ? '#8a8a98' : '#a8a8b4';
  px(g, '#3a5a2a', 0, 13, 12, 3);
  if (variant % 2 === 0) {
    px(g, stone, 2, 3, 8, 11);
    px(g, stone, 3, 2, 6, 1);
    px(g, stone, 4, 1, 4, 1);
  } else {
    px(g, stone, 5, 1, 2, 13);
    px(g, stone, 2, 4, 8, 2);
    px(g, stone, 3, 8, 6, 6);
  }
  px(g, shade(stone, -0.3), 9, 3, 1, 11);
  px(g, shade(stone, -0.4), 4, 6, 4, 1);
  px(g, shade(stone, -0.4), 4, 8, 4, 1);
  if (variant % 4 === 1) px(g, '#e85d75', 1, 12, 2, 2);
  return c;
}
