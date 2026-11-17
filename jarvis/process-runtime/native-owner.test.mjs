import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { available, nativeFixture } from './native-host-fixture.mjs';

test('real original business child owns full offline prompt history and the same running settings Store without offline model work', { skip: !available, timeout: 32000 }, async t => {
  const progress = resolveEvidence();
  const note = value => appendFileSync(progress, `${new Date().toISOString()} ${value}\n`);
  note('begin');
  const f = await nativeFixture(t, { realCapabilities: true, inherited: [], local: [], allowedTools: [] });
  const ProcessManager = await f.managerClass(), rootDir = join(f.directory, 'organizations'); mkdirSync(rootDir);
  const manager = new ProcessManager(f.ctx, { rootDir, instances: [{ instanceId: 'root', model: f.config.model, maxWorkers: 2, workerTools: ['read'],
    stateDir: join(rootDir, 'root/state'), workspace: join(rootDir, 'root/work') }] },
    { bridgeFactory: () => ({ run: async () => ({ text: 'Controlled daily conversation', status: 'complete' }), cancel: async () => {}, close: async () => {} }) });
  f.beforeClose(() => manager.close());
  await manager.initialization;
  const first = await manager.management('root', { method: 'GET', path: 'prompts' });
  note('offline GET complete');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.parts.some(part => part.key === 'runtime/worker'));
  assert.equal(f.modelCalls.length, 0); assert.equal(f.ctx.agents.list().length, 0);
  const ownerPid = manager.status().instances[0].managementPid;
  const simultaneous = await Promise.all([
    { method: 'GET', path: 'state' }, { method: 'GET', path: 'settings' }, { method: 'GET', path: 'models' },
    { method: 'POST', path: 'prompts/preview', body: first.body.current.config }, { method: 'GET', path: 'configuration-migrations' },
  ].map(request => manager.management('root', request)));
  assert.deepEqual(simultaneous.map(reply => reply.status), [200, 200, 200, 200, 200], JSON.stringify(simultaneous));
  assert.equal(manager.status().instances[0].managementPid, ownerPid, 'complete original UI parallel reads share the locked offline owner');
  const saved = await manager.management('root', { method: 'PUT', path: 'prompts', body: { baseRevision: first.body.current.revision,
    config: { ...first.body.current.config, communication: 'Exact complete original setting from offline owner' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const conflict = await manager.management('root', { method: 'PUT', path: 'prompts', body: { baseRevision: first.body.current.revision,
    config: { ...first.body.current.config, communication: 'Conflicting unsaved client text' } } });
  assert.equal(conflict.status, 409); assert.equal(manager.status().instances[0].managementPid, ownerPid);
  note('offline PUT complete');
  assert.equal(manager.status().instances[0].phase, 'stopped');
  const tracing = setTimeout(() => {
    const item = manager.instances.get('root');
    note(JSON.stringify({ duringStart: manager.status(), nativeSessions: item.native?.journal?.sessions(), peerPending: item.peer?.pending?.size,
      stderr: readFileSync(join(rootDir, 'root/state/stderr.log'), 'utf8') }));
  }, 6000);
  try { await manager.start('root'); } finally { clearTimeout(tracing); }
  note('running start complete');
  const running = await manager.management('root', { method: 'GET', path: 'prompts' });
  assert.equal(running.status, 200, JSON.stringify(running.body));
  assert.equal(running.body.current.config.communication, 'Exact complete original setting from offline owner');
  assert.equal(manager.status().instances[0].managementPid, undefined, 'offline Store writer exits before the business owner starts');
  assert.ok(running.body.revisions.length >= 2);
  const fullState = await manager.state('root'); assert.equal(fullState.instanceId, 'root');
  await manager.stop('root');
  note('running stop complete');
  const stopped = await manager.management('root', { method: 'GET', path: 'prompts' });
  assert.equal(stopped.body.current.revision, running.body.current.revision);
  assert.equal(manager.status().instances[0].phase, 'stopped');
});

function resolveEvidence() {
  const directory = '.artifacts/full-superagent-integration'; mkdirSync(directory, { recursive: true });
  return join(directory, 'native-owner-checkpoint.log');
}
