import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Agent, xpForLevel } from '../server/agents/base';
import type { EcoContext } from '../server/agents/context';
import type { Appearance } from '../shared/types';

const appearance: Appearance = { skin: '', hair: '', shirt: '', pants: '', hat: 'none' };
class Worker extends Agent {
  constructor() { super({ levelUp: () => {} } as unknown as EcoContext, 'worker', 'Worker', 'researcher', 'Worker', 'lab', appearance); }
  stats() { return {}; }
}

test('restoration preserves historical activity XP but derives consistent level in bounded time', () => {
  const worker = new Worker();
  worker.restore({ id: worker.id, xp: 1_273_710, level: 1 });
  assert.equal(worker.xp, 1_273_710);
  assert.equal(worker.level, 368);
  worker.restore({ id: worker.id, xp: 0, level: Number.MAX_SAFE_INTEGER });
  assert.equal(worker.level, 1);
  for (const bad of [NaN, Infinity, -Infinity, -12]) {
    worker.restore({ id: worker.id, xp: bad, level: 300 });
    assert.equal(worker.xp, 0);
    assert.equal(worker.level, 1);
  }
  worker.restore({ id: worker.id, xp: Number.MAX_VALUE, level: Infinity });
  assert.equal(worker.xp, Number.MAX_SAFE_INTEGER);
  assert.ok(xpForLevel(worker.level) <= worker.xp);
  assert.ok(xpForLevel(worker.level + 1) > worker.xp);
});

test('activity changes timestamp status without claiming work; explicit work never earns XP', () => {
  const worker = new Worker();
  const initial = worker.toDTO() as ReturnType<Worker['toDTO']> & {activityAt: number | null; lastWorkAt: number | null};
  assert.equal(initial.lastWorkAt, null);
  worker.activity = 'Waiting for new completed data';
  const changed = worker.toDTO() as typeof initial;
  assert.equal(typeof changed.activityAt, 'number');
  assert.equal(changed.lastWorkAt, null);
  worker.activity = worker.activity;
  assert.equal((worker.toDTO() as typeof initial).activityAt, changed.activityAt);
  (worker as Worker & { markWork(): void }).markWork();
  assert.equal(typeof (worker.toDTO() as typeof initial).lastWorkAt, 'number');
  assert.equal(worker.xp, 0);
});

test('extreme rewards are finite and bounded without unbounded level-up loops', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { Agent, xpForLevel } from './server/agents/base.ts';
    class Worker extends Agent { stats() { return {}; } }
    let notifications = 0;
    const worker = new Worker({ levelUp: () => notifications++ }, 'x', 'X', 'researcher', '', 'lab', {});
    worker.addXp(Infinity);
    assert.equal(worker.xp, 0);
    worker.addXp(Number.MAX_VALUE);
    assert.equal(worker.xp, Number.MAX_SAFE_INTEGER);
    assert.ok(xpForLevel(worker.level) <= worker.xp);
    assert.ok(xpForLevel(worker.level + 1) > worker.xp);
    assert.ok(notifications <= 1);
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
