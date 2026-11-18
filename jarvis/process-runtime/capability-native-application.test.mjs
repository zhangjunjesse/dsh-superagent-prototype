import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { available, nativeFixture } from './native-host-fixture.mjs';

test('installed DSH applies Worker changes after pending prompt notices and retains full history and stopped organization state', { skip: !available, timeout: 55000 }, async t => {
  mkdirSync('.artifacts/worker-capability-apply', { recursive: true });
  const note = value => appendFileSync('.artifacts/worker-capability-apply/native-application-progress.log', `${new Date().toISOString()} ${value}\n`);
  note('begin');
  const f = await nativeFixture(t, { realCapabilities: true, inherited: [], local: [], allowedTools: [] });
  const { SystemControl } = await import(pathToFileURL(join(f.modules, 'jarvis/process-runtime/control.mjs')));
  const control = new SystemControl(f.ctx, { rootDir: join(f.directory, 'organizations'), defaultModel: f.config.model, validateModel: async () => true,
    capabilityCatalog: async () => ({ tools: ['read', 'glob', 'grep'].map(name => ({ name, available: true, label: name, group: 'files' })), skills: [], complete: true }),
    managerOptions: { bridgeFactory: () => ({ run: async () => ({ text: 'Controlled', status: 'complete' }), cancel: async () => {}, close: async () => {},
      setCapabilityHold() {}, capabilityActivity: async () => ({ work: [], fingerprint: 'idle' }), cancelCapabilityWork: async () => {} }) } });
  f.beforeClose(() => control.close());
  const initial = await control.get(); await control.save({ revision: initial.revision, nodes: initial.nodes });
  const prompts = await control.management('root', { method: 'GET', path: 'prompts' }); assert.equal(prompts.status, 200);
  const config = { ...prompts.body.current.config, communication: 'Native application preservation marker' };
  const saved = await control.management('root', { method: 'PUT', path: 'prompts', body: { baseRevision: prompts.body.current.revision, config } });
  assert.equal(saved.status, 200); note('full prompts saved');
  await control.action('root', 'start', control.revision); note('original runtime started');
  const old = control.manager.status().instances[0];
  let response = await control.management('root', { method: 'PUT', path: 'worker-capabilities', body: { revision: control.revision, tools: ['read'], skills: [] } });
  note('capability save returned ' + response.body.application?.state);
  if (response.body.application?.state !== 'applied') note(JSON.stringify({
    deliveries: control.manager.instance('root').native?.journal.deliveries(), errors: f.errors.map(error => String(error)) }));
  // Original prompt notices can still be acknowledging when start returns.
  // They must finish through real delivery before the persisted change applies.
  const deadline = Date.now() + 10000;
  while (['waiting', 'applying'].includes(response.body.application?.state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    response = await control.management('root', { method: 'GET', path: 'worker-capabilities' });
  }
  assert.equal(response.status, 200); assert.equal(response.body.application.state, 'applied', JSON.stringify(response.body.application));
  assert.deepEqual(response.body.applied.tools, ['read']);
  const current = control.manager.status().instances[0]; assert.equal(current.phase, 'running'); assert.equal(current.generation, old.generation);
  assert.equal(current.pid, old.pid);
  assert.equal(current.cleanupPending, undefined); assert.equal(current.capabilityHold, undefined);
  const retained = await control.management('root', { method: 'GET', path: 'prompts' });
  assert.equal(retained.body.current.config.communication, config.communication); assert.equal(retained.body.current.revision, saved.body.revision);
  assert.ok(retained.body.parts.some(part => part.key === 'runtime/worker')); assert.ok(retained.body.revisions.length >= 2);
  await control.action('root', 'stop', control.revision);
  const stopped = await control.management('root', { method: 'PUT', path: 'worker-capabilities', body: { revision: control.revision, tools: ['read', 'glob'], skills: [] } });
  assert.equal(stopped.status, 200); assert.equal(stopped.body.application.state, 'applied', JSON.stringify(stopped.body.application));
  assert.equal(control.manager.status().instances[0].phase, 'stopped', 'saving does not start an organization that was stopped');
  await control.action('root', 'start', control.revision);
  const started = await control.manager.capabilityActivity(['root']);
  assert.equal(started.instances[0].runtime.held, false, 'later original business startup does not restore a stale durable hold');
  note('stopped organization updated and subsequently started without stale hold');
  assert.equal(f.modelCalls.length, 0, 'idle configuration application does not invent model work');
  note('complete');
});
