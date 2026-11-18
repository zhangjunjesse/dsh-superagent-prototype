import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';

const artifacts = resolve('.artifacts/delegation/transport');
mkdirSync(artifacts, { recursive: true });
const entry = join(artifacts, 'delegation-fixture-child.mjs');
writeFileSync(entry, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessPeer } from ${JSON.stringify(new URL('./ipc.mjs', import.meta.url).href)};
let config, release;
const received = [];
const peer = new ProcessPeer(process, {
  initialize(input) { config = input; return { pid: process.pid, instanceId: config.instanceId }; },
  chat(input) {
    if (input.release) { release?.(); return { released: true }; }
    return peer.call('delegation.send', input);
  },
  async delegation(envelope) {
    received.push(envelope);
    writeFileSync(join(config.stateDir, 'delegations.json'), JSON.stringify(received));
    if (envelope.request.text === 'hold') await new Promise(resolveHeld => { release = resolveHeld; });
    return { delegationId: envelope.request.delegationId, parentTicketId: envelope.request.parentTicketId,
      parentAssignmentId: envelope.request.parentAssignmentId, childInstanceId: config.instanceId,
      status: 'completed', summary: 'source:' + envelope.sourceInstanceId, receipts: { [envelope.request.commandId]: 'applied' } };
  },
  async 'lifecycle.delegation'(envelope) { return peer.handlers.delegation(envelope); },
  'lifecycle.drain'() { return { stopped: true }; },
  state() { return { config, received }; },
  close() { release?.(); return { stopped: true }; },
});
process.on('disconnect', () => process.exit(0));
`);

function config() {
  const rootDir = mkdtempSync(join(artifacts, 'manager-'));
  return { rootDir, instances: ['alpha', 'beta', 'gamma'].map(instanceId => ({ instanceId,
    stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read', 'glob'],
    ...(instanceId === 'alpha' ? { children: ['beta'] } : instanceId === 'beta' ? { parents: ['alpha'], organizationName: 'Beta org', description: 'Read beta workspace', workerTools: ['read', 'grep'] } : {}) })) };
}
const idleBridge = () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {} });
const request = (changes = {}) => ({ targetInstanceId: 'beta', delegationId: 'delegation-1', parentTicketId: 'ticket-1',
  parentAssignmentId: 'assignment-1', parentDecisionId: 'decision-1', operation: 'submit', commandId: 'command-1', text: 'Read the requested file', tools: ['read'], path: ['alpha'], ...changes });
async function received(manager, id) {
  for (let i = 0; i < 150; i++) {
    if ((await manager.state(id)).received.length) return;
    await delay(10);
  }
  assert.fail('Delegation did not reach the target process');
}

test('normalization derives capabilities only from mutual raw relations and tool intersections', async () => {
  const options = config();
  options.instances[0].delegationTargets = [{ instanceId: 'gamma', tools: ['read'] }];
  options.instances[2].allowedParents = ['alpha'];
  const manager = new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  try {
    await manager.start('alpha'); await manager.start('beta'); await manager.start('gamma');
    const alpha = (await manager.state('alpha')).config, beta = (await manager.state('beta')).config, gamma = (await manager.state('gamma')).config;
    assert.deepEqual(alpha.delegationTargets, [{ instanceId: 'beta', organizationName: 'Beta org', description: 'Read beta workspace', tools: ['read'] }]);
    assert.deepEqual(beta.allowedParents, ['alpha']); assert.deepEqual(gamma.allowedParents, []);
    assert.deepEqual(gamma.delegationTargets, []); assert.equal(alpha.maxWorkers, 3);
    assert.equal(Object.hasOwn(alpha, 'children'), false); assert.equal(Object.hasOwn(beta, 'parents'), false);
  } finally { await manager.close(); }
});

test('unknown references, self references and cycles fail before an instance can run', () => {
  for (const change of [
    options => { options.instances[0].children = ['missing']; },
    options => { options.instances[1].parents = ['missing']; },
    options => { options.instances[0].children = ['alpha']; },
    options => { options.instances[0].parents = ['alpha']; },
    options => { options.instances[1].children = ['alpha']; options.instances[0].parents = ['beta']; },
    options => { options.instances[0].children = []; options.instances[0].parents = ['beta']; },
  ]) {
    const options = config(); change(options);
    assert.throws(() => new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry }), /Unknown instance|itself|cycle/);
  }
  const options = config(); options.instances[1].parents = [];
  const manager = new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  assert.deepEqual(manager.instance('alpha').config.delegationTargets, []);
  return manager.close();
});

test('two actual child processes authenticate the source and enforce one hop, mutual relation and tools', async () => {
  const manager = new ProcessManager({}, config(), { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  try {
    await manager.start('alpha');
    await assert.rejects(manager.chat('alpha', request()), /generation is no longer active/);
    assert.equal(manager.status().instances.find(item => item.instanceId === 'beta').phase, 'stopped');
    await manager.start('beta'); await manager.start('gamma');
    assert.notEqual(manager.status().instances[0].pid, manager.status().instances[1].pid);
    await assert.rejects(manager.chat('alpha', request({ sourceInstanceId: 'gamma' })), /Unrecognized key/);
    await assert.rejects(manager.chat('alpha', request({ path: ['gamma'] })), /authenticated source/);
    await assert.rejects(manager.chat('alpha', request({ path: ['alpha', 'beta'] })), /Too big/);
    await assert.rejects(manager.chat('alpha', request({ targetInstanceId: 'gamma' })), /not mutually allowed/);
    await assert.rejects(manager.chat('gamma', request({ path: ['gamma'] })), /not mutually allowed/);
    await assert.rejects(manager.chat('alpha', request({ tools: ['glob'] })), /intersection/);
    await assert.rejects(manager.chat('alpha', request({ tools: [] })), /shared read-only tools/);
    const value = await manager.chat('alpha', request());
    assert.equal(value.status, 'completed'); assert.equal(value.summary, 'source:alpha');
    const target = await manager.state('beta');
    assert.equal(target.received.length, 1); assert.equal(target.received[0].sourceInstanceId, 'alpha');
    assert.deepEqual(target.received[0].request, request());
  } finally { await manager.close(); }
});

test('empty parent-child tool intersection rejects submit without running a target task', async () => {
  const options = config(); options.instances[0].workerTools = ['glob'];
  const manager = new ProcessManager({}, options, { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  try {
    await manager.start('alpha'); await manager.start('beta');
    await assert.rejects(manager.chat('alpha', request({ tools: [] })), /shared read-only tools/);
    assert.equal((await manager.state('beta')).received.length, 0);
  } finally { await manager.close(); }
});

test('target stopping during a pending delegation cannot return its late success', async () => {
  const manager = new ProcessManager({}, config(), { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  try {
    await manager.start('alpha'); await manager.start('beta');
    const pending = manager.chat('alpha', request({ text: 'hold' }));
    const rejected = assert.rejects(pending, /generation is no longer active|closed|disconnected|exited/);
    await received(manager, 'beta'); await manager.stop('beta'); await rejected;
    await manager.start('beta');
    assert.equal((await manager.chat('alpha', request({ commandId: 'query-after-restart', operation: 'query' }))).status, 'completed');
  } finally { await manager.close(); }
});

test('source restart rejects its pending call and late target replies cannot satisfy the new generation', async () => {
  const manager = new ProcessManager({}, config(), { bridgeFactory: idleBridge, nativeFactory: () => null, entry });
  try {
    await manager.start('alpha'); await manager.start('beta');
    const pending = manager.chat('alpha', request({ text: 'hold' }));
    const rejected = assert.rejects(pending, /closed|disconnected|exited/);
    await received(manager, 'beta'); await manager.restart('alpha'); await rejected;
    await manager.chat('beta', { release: true });
    const next = await manager.chat('alpha', request({ commandId: 'query-new-generation', operation: 'query' }));
    assert.equal(next.receipts['query-new-generation'], 'applied');
    const record = JSON.parse(readFileSync(join(manager.rootDir, 'processes.json'), 'utf8'));
    assert.equal(record.instances.find(item => item.instanceId === 'alpha').generation, 2);
  } finally { await manager.close(); }
});
