import type { Appearance } from '../shared/types';
import type { Specialty } from './strategy/genome';

// Fixed IDs so saved progress (XP, wallets) maps back to the same villagers after a restart.

export const RESEARCHERS: { id: string; name: string; specialty: Specialty; look: Appearance }[] = [
  { id: 'r_ada', name: 'Ada', specialty: 'trend', look: { skin: '#f1c27d', hair: '#3b2219', shirt: '#f4f4f4', pants: '#4a5a8a', hat: 'goggles' } },
  { id: 'r_linus', name: 'Linus', specialty: 'meanrev', look: { skin: '#e0ac69', hair: '#d9a441', shirt: '#f4f4f4', pants: '#3d3d4d', hat: 'goggles' } },
  { id: 'r_marie', name: 'Marie', specialty: 'momentum', look: { skin: '#ffdbac', hair: '#8b3a1a', shirt: '#f4f4f4', pants: '#5b3a6b', hat: 'goggles' } },
  { id: 'r_nikola', name: 'Nikola', specialty: 'breakout', look: { skin: '#c68642', hair: '#111111', shirt: '#f4f4f4', pants: '#2f4f4f', hat: 'goggles' } },
  { id: 'r_grace', name: 'Grace', specialty: 'wildcard', look: { skin: '#8d5524', hair: '#2b1a10', shirt: '#f4f4f4', pants: '#7a2e2e', hat: 'goggles' } },
  { id: 'r_alan', name: 'Alan', specialty: 'trend', look: { skin: '#f1c27d', hair: '#6b4e2e', shirt: '#f4f4f4', pants: '#405060', hat: 'goggles' } },
  { id: 'r_rosa', name: 'Rosalind', specialty: 'meanrev', look: { skin: '#ffdbac', hair: '#c94f2c', shirt: '#f4f4f4', pants: '#2e4a2e', hat: 'goggles' } },
  { id: 'r_carl', name: 'Carl', specialty: 'wildcard', look: { skin: '#e0ac69', hair: '#999999', shirt: '#f4f4f4', pants: '#4a3a2a', hat: 'goggles' } },
];

const BASE_TRADERS: { id: string; name: string; look: Appearance }[] = [
  { id: 't_earl', name: 'Earl', look: { skin: '#f1c27d', hair: '#5a3a1a', shirt: '#2e8b57', pants: '#2b2b3b', hat: 'visor' } },
  { id: 't_ant', name: 'Ant', look: { skin: '#c68642', hair: '#111111', shirt: '#d9534f', pants: '#2b2b3b', hat: 'cap' } },
  { id: 't_rosa', name: 'Rosa', look: { skin: '#ffdbac', hair: '#a0522d', shirt: '#f0ad4e', pants: '#3b3b5b', hat: 'visor' } },
  { id: 't_blaze', name: 'Blaze', look: { skin: '#e0ac69', hair: '#e25822', shirt: '#5bc0de', pants: '#2b2b3b', hat: 'cap' } },
  { id: 't_mika', name: 'Mika', look: { skin: '#8d5524', hair: '#2b1a10', shirt: '#9b59b6', pants: '#3b3b3b', hat: 'visor' } },
  { id: 't_juno', name: 'Juno', look: { skin: '#ffdbac', hair: '#f5deb3', shirt: '#1abc9c', pants: '#2b3b4b', hat: 'cap' } },
  { id: 't_otis', name: 'Otis', look: { skin: '#c68642', hair: '#3b2219', shirt: '#e67e22', pants: '#2b2b3b', hat: 'visor' } },
  { id: 't_pearl', name: 'Pearl', look: { skin: '#f1c27d', hair: '#dcdcdc', shirt: '#e84393', pants: '#3b2b4b', hat: 'cap' } },
  { id: 't_rex', name: 'Rex', look: { skin: '#e0ac69', hair: '#222222', shirt: '#34495e', pants: '#1b1b2b', hat: 'visor' } },
  { id: 't_wren', name: 'Wren', look: { skin: '#8d5524', hair: '#6b3e26', shirt: '#27ae60', pants: '#2b2b3b', hat: 'cap' } },
];

const EXTRA_NAMES = ['Abe', 'Bea', 'Cal', 'Dot', 'Eli', 'Fay', 'Gil', 'Hal', 'Ida', 'Jax', 'Kai', 'Lou', 'Mae', 'Ned', 'Oly', 'Pia', 'Quin', 'Ray', 'Sal', 'Tia', 'Uma', 'Vic', 'Wes', 'Xia', 'Yan', 'Zed', 'Bo', 'Cy', 'Di', 'Eve'];
const SKINS = ['#f1c27d', '#c68642', '#ffdbac', '#e0ac69', '#8d5524'];
const HAIRS = ['#3b2219', '#111111', '#d9a441', '#8b3a1a', '#2b1a10', '#6b4e2e', '#dcdcdc', '#c94f2c'];
const SHIRTS = ['#2e8b57', '#d9534f', '#f0ad4e', '#5bc0de', '#9b59b6', '#1abc9c', '#e67e22', '#e84393', '#34495e', '#27ae60'];
// Ids stay stable (t_<name>) so saved wallets map back to the same villager after a restart.
for (let i = 0; i < EXTRA_NAMES.length; i++) {
  BASE_TRADERS.push({
    id: 't_' + EXTRA_NAMES[i].toLowerCase(),
    name: EXTRA_NAMES[i],
    look: { skin: SKINS[i % SKINS.length], hair: HAIRS[(i * 3) % HAIRS.length], shirt: SHIRTS[(i * 7) % SHIRTS.length], pants: '#2b2b3b', hat: i % 2 ? 'cap' : 'visor' },
  });
}
export const TRADERS = BASE_TRADERS;

export const NEWS_ANCHORS: { id: string; name: string; beat: string; look: Appearance }[] = [
  { id: 'n_vera', name: 'Vera', beat: 'crypto wire', look: { skin: '#ffdbac', hair: '#2b1a10', shirt: '#b03a52', pants: '#2b2b3b', hat: 'press' } },
  { id: 'n_desmond', name: 'Desmond', beat: 'macro & stocks', look: { skin: '#8d5524', hair: '#1b1b1b', shirt: '#2c3e70', pants: '#2b2b3b', hat: 'press' } },
];

export const STAFF = {
  commander: { id: 'c_maxine', name: 'Maxine', look: { skin: '#f1c27d', hair: '#2b1a10', shirt: '#2c3e70', pants: '#1f2a44', hat: 'captain' } as Appearance },
  risk: { id: 'k_sarge', name: 'Sarge', look: { skin: '#c68642', hair: '#333333', shirt: '#556b2f', pants: '#3b4a2a', hat: 'helmet' } as Appearance },
  scout: { id: 'p_pip', name: 'Pip', look: { skin: '#ffdbac', hair: '#d2691e', shirt: '#ff8c00', pants: '#4a4a2a', hat: 'cap' } as Appearance },
  reporter: { id: 'g_gus', name: 'Gus', look: { skin: '#e0ac69', hair: '#4a3a2a', shirt: '#8b6b4a', pants: '#3b2b1b', hat: 'press' } as Appearance },
  treasurer: { id: 'b_penny', name: 'Penny', look: { skin: '#f1c27d', hair: '#b8860b', shirt: '#1e7a46', pants: '#1b3b2b', hat: 'tophat' } as Appearance },
  explorer: { id: 'x_magellan', name: 'Magellan', look: { skin: '#c68642', hair: '#7a3b1a', shirt: '#1f6f8b', pants: '#4a3a2a', hat: 'captain' } as Appearance },
  strategist: { id: 'q_quill', name: 'Prof. Quill', look: { skin: '#f1c27d', hair: '#e8e8e8', shirt: '#5b2a86', pants: '#3b1a56', hat: 'wizard' } as Appearance },
};
