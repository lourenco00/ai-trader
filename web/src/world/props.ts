import type { Sprite } from './buildings';
import { T, type Prop } from './map';
import { canvas, disc, px, shade } from './pixel';

function pine(variant: number): HTMLCanvasElement {
  const { c, g } = canvas(18, 34);
  const greens = [
    ['#2f6b3a', '#3d8a4a', '#58a85a'],
    ['#2a5f3a', '#367d47', '#4f9c56'],
    ['#33703c', '#43914c', '#62b262'],
  ][variant % 3];
  px(g, '#2a4a2a', 3, 31, 12, 3); // shadow
  px(g, '#6b4226', 7, 25, 4, 8);
  for (let layer = 0; layer < 4; layer++) {
    const top = 2 + layer * 6;
    for (let r = 0; r < 9; r++) {
      const hw = Math.min(8, 1 + Math.floor(((r + 1) * (3 + layer)) / 5));
      px(g, r > 6 ? greens[0] : greens[1], 9 - hw, top + r, hw * 2, 1);
      px(g, greens[2], 9 - hw + 1, top + r, Math.max(1, Math.floor(hw / 2)), 1);
    }
  }
  px(g, greens[2], 8, 1, 2, 2);
  return c;
}

function oak(variant: number): HTMLCanvasElement {
  const { c, g } = canvas(30, 32);
  const leaf = ['#3f8f3f', '#4a9a3a', '#3a8a4a'][variant % 3];
  px(g, 'rgba(20,50,20,0.35)', 5, 28, 20, 4);
  px(g, '#6b4226', 13, 18, 5, 12);
  px(g, '#4a2e1a', 16, 18, 2, 12);
  disc(g, shade(leaf, -0.25), 15, 13, 12);
  disc(g, leaf, 14, 12, 11);
  disc(g, shade(leaf, 0.2), 11, 9, 6);
  disc(g, shade(leaf, 0.35), 9, 7, 2);
  if (variant === 1) for (const [x, y] of [[8, 14], [19, 8], [17, 16], [22, 12]]) px(g, '#e74c3c', x, y, 2, 2);
  return c;
}

function bush(): HTMLCanvasElement {
  const { c, g } = canvas(16, 14);
  disc(g, '#2f7a34', 8, 8, 6);
  disc(g, '#3f9a44', 7, 7, 5);
  disc(g, '#5bbf5a', 5, 5, 2);
  px(g, '#e85d75', 10, 5, 1, 1);
  px(g, '#f7d14a', 4, 9, 1, 1);
  return c;
}

function rock(): HTMLCanvasElement {
  const { c, g } = canvas(14, 10);
  disc(g, '#7a7a86', 7, 6, 4);
  disc(g, '#9a9aa6', 6, 5, 3);
  px(g, '#c0c0ca', 5, 3, 2, 1);
  return c;
}

function lamp(): HTMLCanvasElement {
  const { c, g } = canvas(10, 28);
  px(g, '#2b2b33', 4, 8, 2, 19);
  px(g, '#2b2b33', 2, 26, 6, 2);
  px(g, '#2b2b33', 1, 2, 8, 2);
  px(g, '#2b2b33', 2, 4, 6, 6);
  px(g, '#ffe28a', 3, 5, 4, 4);
  px(g, '#2b2b33', 3, 0, 4, 2);
  return c;
}

function bench(): HTMLCanvasElement {
  const { c, g } = canvas(18, 12);
  px(g, '#7a4a2a', 1, 2, 16, 3);
  px(g, '#9a6a3a', 1, 6, 16, 3);
  px(g, '#4a2e1a', 2, 9, 2, 3);
  px(g, '#4a2e1a', 14, 9, 2, 3);
  return c;
}

function well(): HTMLCanvasElement {
  const { c, g } = canvas(20, 26);
  px(g, '#6b4226', 3, 4, 2, 14);
  px(g, '#6b4226', 15, 4, 2, 14);
  for (let r = 0; r < 6; r++) px(g, '#a83a3a', 2 + (5 - r), r, 16 - (5 - r) * 2, 1);
  px(g, '#8a8a96', 1, 14, 18, 10);
  px(g, '#a8a8b4', 1, 14, 18, 2);
  px(g, '#2f5f9f', 4, 15, 12, 2);
  px(g, '#5a3a22', 9, 6, 2, 8);
  return c;
}

function barrel(): HTMLCanvasElement {
  const { c, g } = canvas(12, 14);
  px(g, '#8b5a2b', 1, 1, 10, 13);
  px(g, '#a8703a', 2, 1, 3, 13);
  px(g, '#4a4a4a', 1, 3, 10, 1);
  px(g, '#4a4a4a', 1, 10, 10, 1);
  return c;
}

function crate(): HTMLCanvasElement {
  const { c, g } = canvas(14, 14);
  px(g, '#a8703a', 1, 1, 12, 12);
  px(g, '#6b4226', 1, 1, 12, 1);
  px(g, '#6b4226', 1, 12, 12, 1);
  px(g, '#6b4226', 1, 1, 1, 12);
  px(g, '#6b4226', 12, 1, 1, 12);
  for (let i = 0; i < 10; i++) px(g, '#6b4226', 2 + i, 2 + i, 1, 1);
  return c;
}

function scarecrow(): HTMLCanvasElement {
  const { c, g } = canvas(18, 28);
  px(g, '#6b4226', 8, 8, 2, 20);
  px(g, '#6b4226', 1, 11, 16, 2);
  px(g, '#d9534f', 4, 10, 10, 9);
  px(g, '#f0c060', 5, 3, 8, 7);
  px(g, '#333333', 7, 5, 1, 1);
  px(g, '#333333', 10, 5, 1, 1);
  px(g, '#8b6b3a', 3, 1, 12, 3);
  px(g, '#8b6b3a', 6, 0, 6, 1);
  px(g, '#f0c060', 1, 13, 2, 3);
  px(g, '#f0c060', 15, 13, 2, 3);
  return c;
}

function mailbox(): HTMLCanvasElement {
  const { c, g } = canvas(10, 16);
  px(g, '#6b4226', 4, 7, 2, 9);
  px(g, '#3f6fb5', 1, 1, 8, 7);
  px(g, '#5a8fd5', 2, 1, 6, 2);
  px(g, '#d9534f', 8, 0, 2, 4);
  return c;
}

const CACHE = new Map<string, HTMLCanvasElement>();

function art(p: Prop): HTMLCanvasElement {
  const key = `${p.kind}:${p.variant}`;
  let c = CACHE.get(key);
  if (c) return c;
  switch (p.kind) {
    case 'pine':
      c = pine(p.variant);
      break;
    case 'oak':
      c = oak(p.variant);
      break;
    case 'bush':
      c = bush();
      break;
    case 'rock':
      c = rock();
      break;
    case 'lamp':
      c = lamp();
      break;
    case 'bench':
      c = bench();
      break;
    case 'well':
      c = well();
      break;
    case 'barrel':
      c = barrel();
      break;
    case 'crate':
      c = crate();
      break;
    case 'scarecrow':
      c = scarecrow();
      break;
    case 'mailbox':
    case 'sign':
      c = mailbox();
      break;
  }
  CACHE.set(key, c);
  return c;
}

export function renderProps(props: Prop[]): Sprite[] {
  return props.map((p) => {
    const c = art(p);
    const baseY = (p.y + 1) * T;
    const sprite: Sprite = {
      canvas: c,
      x: p.x * T + Math.floor((T - c.width) / 2),
      y: baseY - c.height + (p.kind === 'oak' || p.kind === 'pine' ? 2 : 0),
      baseY,
      windows: [],
      smoke: [],
    };
    if (p.kind === 'lamp') sprite.light = { x: p.x * T + T / 2, y: baseY - 22, r: 34 };
    return sprite;
  });
}
