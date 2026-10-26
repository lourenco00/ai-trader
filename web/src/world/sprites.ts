import type { Appearance } from '../../../shared/types';
import { canvas, px, shade, type Ctx } from './pixel';

export type Facing = 'down' | 'up' | 'left' | 'right';

export const CHAR_W = 16;
export const CHAR_H = 24;

const cache = new Map<string, HTMLCanvasElement>();

function hat(g: Ctx, a: Appearance, facing: Facing): void {
  const side = facing === 'left' || facing === 'right';
  switch (a.hat) {
    case 'cap':
      px(g, shade(a.shirt, -0.2), 4, 3, 8, 3);
      if (facing === 'down') px(g, shade(a.shirt, -0.35), 4, 6, 9, 1);
      if (side) px(g, shade(a.shirt, -0.35), facing === 'left' ? 2 : 10, 5, 4, 1);
      break;
    case 'visor':
      px(g, '#2ecc71', 4, 4, 8, 2);
      if (facing === 'down') px(g, '#27ae60', 3, 6, 10, 1);
      if (side) px(g, '#27ae60', facing === 'left' ? 2 : 10, 6, 4, 1);
      break;
    case 'goggles':
      if (facing === 'up') {
        px(g, '#5a3a22', 4, 6, 8, 1);
      } else if (facing === 'down') {
        px(g, '#5a3a22', 4, 5, 8, 1);
        px(g, '#9fe0ea', 5, 4, 2, 2);
        px(g, '#9fe0ea', 9, 4, 2, 2);
      } else {
        px(g, '#5a3a22', 4, 5, 8, 1);
        px(g, '#9fe0ea', facing === 'left' ? 4 : 10, 4, 2, 2);
      }
      break;
    case 'wizard':
      px(g, '#5b2a86', 3, 4, 10, 2);
      px(g, '#6c3a9a', 5, 1, 6, 3);
      px(g, '#6c3a9a', 6, -1, 4, 2);
      px(g, '#f5c542', 7, 2, 2, 1);
      break;
    case 'captain':
      px(g, '#1f2a44', 4, 2, 8, 4);
      px(g, '#f2efe6', 4, 5, 8, 1);
      px(g, '#f5c542', 7, 3, 2, 2);
      if (facing === 'down') px(g, '#111111', 4, 6, 8, 1);
      break;
    case 'helmet':
      px(g, '#4a5a2a', 3, 2, 10, 5);
      px(g, '#5f6f3a', 4, 2, 6, 1);
      break;
    case 'press':
      px(g, '#6b5a4a', 3, 4, 10, 2);
      px(g, '#7d6b58', 5, 2, 6, 3);
      px(g, '#f4f1e8', 10, 2, 2, 2);
      break;
    case 'tophat':
      px(g, '#1b1b1b', 3, 4, 10, 2);
      px(g, '#1b1b1b', 5, -2, 6, 6);
      px(g, '#1e7a46', 5, 2, 6, 1);
      break;
    case 'none':
      break;
  }
}

/**
 * Draw a villager. Frames 0-3 are a walk cycle; frame 0 is also the idle pose.
 * The canvas is 16x24 with the feet at the bottom centre.
 */
export function character(a: Appearance, facing: Facing, frame: number, role: string): HTMLCanvasElement {
  const key = `${a.skin}${a.hair}${a.shirt}${a.pants}${a.hat}|${facing}|${frame}|${role}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, g } = canvas(CHAR_W, CHAR_H + 3);
  g.translate(0, 3); // headroom for tall hats
  const step = [0, 1, 0, -1][frame % 4];
  const bob = frame % 2 === 1 ? -1 : 0;
  const skinD = shade(a.skin, -0.15);
  const shirtD = shade(a.shirt, -0.2);
  const pantsD = shade(a.pants, -0.25);
  const coat = role === 'researcher';

  // shadow
  px(g, 'rgba(0,0,0,0.22)', 3, 22, 10, 2);
  // legs
  const legY = 16;
  if (facing === 'left' || facing === 'right') {
    px(g, a.pants, 6 + step, legY, 2, 5);
    px(g, pantsD, 8 - step, legY, 2, 5);
    px(g, '#3b2a1a', 6 + step, legY + 5, 3, 1);
    px(g, '#3b2a1a', 8 - step, legY + 5, 3, 1);
  } else {
    px(g, a.pants, 5, legY, 3, 5 - Math.max(0, step));
    px(g, pantsD, 8, legY, 3, 5 - Math.max(0, -step));
    px(g, '#3b2a1a', 5, legY + 5 - Math.max(0, step), 3, 1);
    px(g, '#3b2a1a', 8, legY + 5 - Math.max(0, -step), 3, 1);
  }
  g.translate(0, bob);
  // body
  px(g, coat ? '#f4f4f4' : a.shirt, 4, 10, 8, 7);
  px(g, coat ? '#d8d8d8' : shirtD, 10, 10, 2, 7);
  if (coat) px(g, a.pants, 7, 10, 2, 5); // shirt under lab coat
  if (role === 'trader' && facing === 'down') px(g, '#c0392b', 7, 10, 2, 4); // tie
  if (role === 'commander') px(g, '#f5c542', 5, 10, 2, 1);
  if (role === 'reporter' && facing !== 'up') px(g, '#f4f1e8', 4, 12, 3, 4); // notepad
  // arms
  const arm = coat ? '#e8e8e8' : shirtD;
  if (facing === 'left' || facing === 'right') {
    const ax = facing === 'left' ? 6 + step : 8 - step;
    px(g, arm, ax, 11, 2, 5);
    px(g, a.skin, ax, 16, 2, 1);
  } else {
    px(g, arm, 2, 11 + Math.max(0, step), 2, 5);
    px(g, arm, 12, 11 + Math.max(0, -step), 2, 5);
    px(g, a.skin, 2, 16 + Math.max(0, step), 2, 1);
    px(g, a.skin, 12, 16 + Math.max(0, -step), 2, 1);
  }
  // head
  px(g, a.skin, 4, 3, 8, 7);
  px(g, skinD, 4, 9, 8, 1);
  // hair
  px(g, a.hair, 4, 2, 8, 2);
  if (facing === 'up') px(g, a.hair, 4, 3, 8, 6);
  else if (facing === 'down') {
    px(g, a.hair, 3, 3, 1, 4);
    px(g, a.hair, 12, 3, 1, 4);
    px(g, '#1b1b1b', 6, 6, 1, 2);
    px(g, '#1b1b1b', 9, 6, 1, 2);
    px(g, shade(a.skin, -0.25), 7, 8, 2, 1);
  } else {
    const back = facing === 'left' ? 9 : 4;
    px(g, a.hair, back, 3, 3, 5);
    px(g, '#1b1b1b', facing === 'left' ? 5 : 10, 6, 1, 2);
  }
  hat(g, a, facing);
  cache.set(key, c);
  return c;
}

/** Small icons drawn above heads: carried items and moods. */
export function icon(kind: 'scroll' | 'coin' | 'zzz' | 'bang' | 'heart' | 'skull'): HTMLCanvasElement {
  const key = `icon:${kind}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { c, g } = canvas(9, 9);
  switch (kind) {
    case 'scroll':
      px(g, '#f4e3b5', 1, 2, 7, 5);
      px(g, '#c9a85a', 0, 1, 2, 7);
      px(g, '#c9a85a', 7, 1, 2, 7);
      px(g, '#8a6a3a', 2, 4, 5, 1);
      break;
    case 'coin':
      px(g, '#a8741a', 2, 1, 5, 7);
      px(g, '#a8741a', 1, 2, 7, 5);
      px(g, '#f5c542', 2, 2, 5, 5);
      px(g, '#fff3b0', 3, 3, 1, 2);
      break;
    case 'zzz':
      px(g, '#ffffff', 1, 1, 4, 1);
      px(g, '#ffffff', 3, 2, 1, 1);
      px(g, '#ffffff', 2, 3, 1, 1);
      px(g, '#ffffff', 1, 4, 4, 1);
      px(g, '#ffffff', 5, 5, 3, 1);
      px(g, '#ffffff', 6, 6, 1, 1);
      px(g, '#ffffff', 5, 7, 3, 1);
      break;
    case 'bang':
      px(g, '#e74c3c', 3, 0, 3, 6);
      px(g, '#e74c3c', 3, 7, 3, 2);
      break;
    case 'heart':
      px(g, '#e85d75', 1, 2, 3, 3);
      px(g, '#e85d75', 5, 2, 3, 3);
      px(g, '#e85d75', 2, 5, 5, 2);
      px(g, '#e85d75', 3, 7, 3, 1);
      break;
    case 'skull':
      px(g, '#f4f4f4', 1, 1, 7, 5);
      px(g, '#f4f4f4', 2, 6, 5, 2);
      px(g, '#1b1b1b', 2, 3, 2, 2);
      px(g, '#1b1b1b', 5, 3, 2, 2);
      break;
  }
  cache.set(key, c);
  return c;
}

/** Bigger portrait for agent cards: the idle frame scaled up. */
export function portrait(a: Appearance, role: string, scale = 4): HTMLCanvasElement {
  const src = character(a, 'down', 0, role);
  const { c, g } = canvas(src.width * scale, src.height * scale);
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
