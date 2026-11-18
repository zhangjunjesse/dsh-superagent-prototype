import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemControl } from './control.mjs';

const entry = fileURLToPath(new URL('./manager-fixture-child.mjs', import.meta.url));
const bridgeFactory = () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {},
  setCapabilityHold() {}, capabilityActivity: () => ({ busy: false, work: [], fingerprint: 'idle' }) });

test('online addition conflicts with an accepted original restart and the unchanged revision can retry after it completes', { timeout: 10000 }, async t => {
  const artifacts = resolve('.artifacts/live-topology/restart-review');
  mkdirSync(artifacts, { recursive: true });
  const rootDir = mkdtempSync(join(artifacts, 'run-'));
  t.diagnostic(`Isolated restart evidence: ${rootDir}`);
  const control = new SystemControl({}, { rootDir, defaultModel: { provider: 'controlled', model: 'controlled' },
    managerOptions: { entry, bridgeFactory, nativeFactory: () => null } });
  const manager = control.manager;
  const progressFile = join(rootDir, 'progress.json');
  const progress = (phase, extra = {}) => writeFileSync(progressFile, JSON.stringify({ phase, runtime: manager.status(), ...extra }, null, 2));
  let item, accepted, result;
  try {
    const initial = await control.get();
    const configured = await control.save({ revision: initial.revision, nodes: [{ ...initial.nodes[0], workerTools: ['read'] }] });
    await control.action('root', 'start', configured.revision);
    item = manager.instance('root');
    const before = manager.status().instances[0];
    const intentFile = join(item.config.stateDir, 'restart-intent.json');
    const savedBytes = readFileSync(control.file, 'utf8');
    accepted = manager.requestRestart(item, item.generation);
    assert.equal(accepted.requested, true);
    const intentBytes = readFileSync(intentFile, 'utf8');
    const originalIntent = JSON.parse(intentBytes);
    progress('restart-accepted', { originalIntent });

    // The synchronous save wins the same event-loop turn before the accepted
    // zero-delay restart can run; this is the production management response gap.
    const addition = { revision: configured.revision, nodes: [...configured.nodes, { id: 'research', parent: 'root', kind: 'instance',
      name: 'Research', description: 'Bounded research', capabilities: 'Read-only research', concurrency: 1, workerTools: ['read'] }] };
    await assert.rejects(control.save(addition), error => error.status === 409 && /正在重启/.test(error.message));
    const stillAccepted = manager.restartIntent(item);
    assert.equal(stillAccepted.id, accepted.id);
    assert.equal(stillAccepted.phase, 'requested');
    assert.equal(manager.status().instances[0].pid, before.pid);
    assert.equal(manager.status().instances.length, 1);
    assert.equal(readFileSync(intentFile, 'utf8'), intentBytes, 'the rejected addition cannot rewrite the original accepted intent');
    assert.equal(readFileSync(control.file, 'utf8'), savedBytes, 'the rejected addition cannot advance the saved revision or nodes');
    progress('addition-rejected-with-original-restart-intact', { originalIntent, stillAccepted });

    for (let attempt = 0; attempt < 250; attempt++) {
      const current = manager.status().instances[0];
      if (current.phase === 'running' && current.pid !== before.pid) break;
      await delay(10);
    }
    const restarted = manager.status();
    assert.equal(restarted.instances[0].phase, 'running');
    assert.notEqual(restarted.instances[0].pid, before.pid);
    assert.equal(restarted.instances[0].generation, before.generation + 1);
    const completed = manager.restartIntent(item);
    assert.equal(completed.id, accepted.id);
    assert.equal(completed.phase, 'complete');
    const lifecycle = readFileSync(join(item.config.stateDir, 'lifecycle.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lifecycle.filter(row => row.event === 'ready').length, 2, 'only the accepted restart can create another running generation');
    const saved = await control.save(addition);
    assert.equal(saved.revision, configured.revision + 1, 'the exact original revision is valid after the restart completes');
    const after = manager.status();
    assert.deepEqual(after.instances[0], restarted.instances[0]);
    assert.equal(after.instances[1].phase, 'stopped');
    assert.equal(after.instances[1].generation, 0);
    assert.equal(after.instances[1].pid, null);
    await manager.stop('root');
    assert.equal(manager.status().instances[0].phase, 'stopped', 'normal stop remains usable after the additive save and restart');
    result = { before, restarted, after, originalIntent, completed, revision: saved.revision };
  } catch (error) {
    progress('failed', { error: error.stack, accepted });
    throw error;
  } finally {
    if (item) {
      clearTimeout(item.restartTimer);
      const file = join(item.config.stateDir, 'restart-intent.json');
      if (existsSync(file)) {
        const intent = JSON.parse(readFileSync(file, 'utf8'));
        if (['requested', 'restarting'].includes(intent.phase)) manager.saveRestart(item, { ...intent, phase: 'cancelled' });
      }
    }
    await control.close();
  }
  progress('complete', result);
});
