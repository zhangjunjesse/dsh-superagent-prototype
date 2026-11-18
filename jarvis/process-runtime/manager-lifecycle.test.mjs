import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';

const artifacts = resolve('.artifacts/process-runtime/lifecycle');
mkdirSync(artifacts, { recursive: true });
const entry = fileURLToPath(new URL('./manager-fixture-child.mjs', import.meta.url));
const bridgeFactory = () => ({ run: async () => ({ text: 'OK', status: 'complete' }), cancel: async () => {}, close: async () => {},
  setCapabilityHold() {}, capabilityActivity: () => ({ busy: false, work: [], fingerprint: 'idle' }), cancelCapabilityWork: async () => {} });
const config = () => {
  const rootDir = mkdtempSync(join(artifacts, 'manager-'));
  return { rootDir, instances: ['alpha', 'beta'].map(instanceId => ({ instanceId, stateDir: join(rootDir, instanceId, 'state'), workspace: join(rootDir, instanceId, 'work'),
    model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read'] })) };
};
const deferred = () => Promise.withResolvers();
function participant() {
  return { binding: undefined, lease: undefined, resumes: [], suspensions: [], hold: undefined, work: [], gate: undefined, failure: undefined,
    bindLifecycle(binding) { this.binding = binding; this.lease = undefined; },
    resumeInstance(lease) { assert.equal(this.binding.state().phase, 'running'); assert.equal(lease.isCurrent(), true); this.lease = lease; this.resumes.push(lease); },
    async suspendInstance(reason) { this.lease = undefined; this.suspensions.push(reason); await this.gate; if (this.failure) throw this.failure; },
    setCapabilityHold(hold) { this.hold = hold ? { ...hold } : undefined; },
    capabilityActivity() { return { busy: this.work.length > 0, work: structuredClone(this.work), fingerprint: JSON.stringify(this.work.map(work => [work.kind, work.id])) }; },
    async cancelCapabilityWork(operationId, confirmed) { assert.equal(this.hold.operationId, operationId); assert.equal(this.hold.frozen, true); this.confirmed = confirmed; this.work = []; },
  };
}
function manager(options, daily) { return new ProcessManager({}, options, { entry, nativeFactory: () => null, bridgeFactory, lifecycleParticipants: { alpha: daily } }); }
async function until(check) { for (let i = 0; i < 150; i++) { if (check()) return; await delay(10); } assert.fail('Lifecycle did not settle'); }

test('unconfigured and manually stopped instances keep participants closed through management and host recreation', { timeout: 10000 }, async () => {
  const options = config(), daily = participant(), first = manager({ ...options, instances: [] }, daily);
  try {
    await first.initialization; assert.equal(daily.binding.state().configured, false); assert.equal(daily.binding.state().phase, 'stopped'); assert.equal(daily.resumes.length, 0);
    first.reconfigure(options.instances); assert.equal(daily.binding.state().configured, true);
    await first.management('alpha', { method: 'GET', path: 'prompts' }); assert.equal(daily.resumes.length, 0);
    await first.start('alpha'); await first.stop('alpha'); assert.equal(daily.lease, undefined);
  } finally { await first.close(); }
  const recovered = participant(), second = manager(options, recovered);
  try { await second.initialization; assert.equal(second.status().instances[0].phase, 'stopped'); assert.equal(recovered.resumes.length, 0); assert.equal(recovered.lease, undefined); }
  finally { await second.close(); }
});

test('stop immediately revokes the participant and waits for its real cleanup while an unrelated instance continues', { timeout: 10000 }, async () => {
  const daily = participant(), runtime = manager(config(), daily), gate = deferred();
  try {
    await runtime.start('alpha'); await runtime.start('beta'); const prior = daily.lease, beta = runtime.status().instances[1].pid;
    daily.gate = gate.promise;
    let complete = false; const stopping = runtime.stop('alpha').then(() => { complete = true; });
    assert.equal(daily.lease, undefined); assert.equal(prior.isCurrent(), false); assert.equal(runtime.status().instances[0].phase, 'stopping');
    await delay(30); assert.equal(complete, false); assert.equal((await runtime.chat('beta', { text: 'still available' })).text, 'still available');
    gate.resolve(); await stopping; assert.equal(runtime.status().instances[0].phase, 'stopped'); assert.equal(runtime.status().instances[1].pid, beta);
    await runtime.start('alpha'); assert.notEqual(daily.lease.generation, prior.generation); assert.equal(prior.isCurrent(), false);
  } finally { gate.resolve(); daily.gate = undefined; await runtime.close(); }
});

test('participant cleanup failure is visible and prevents a new generation until a successful retry', { timeout: 10000 }, async () => {
  const daily = participant(), runtime = manager(config(), daily);
  try {
    await runtime.start('alpha'); const generation = runtime.status().instances[0].generation; daily.failure = new Error('Native daily turn has not drained');
    await assert.rejects(runtime.stop('alpha'), /has not drained/);
    assert.equal(runtime.status().instances[0].phase, 'failed'); assert.equal(runtime.status().instances[0].cleanupPending, true);
    await assert.rejects(runtime.start('alpha'), /has not drained/); assert.equal(runtime.status().instances[0].generation, generation); assert.equal(daily.lease, undefined);
    daily.failure = undefined; await runtime.start('alpha'); assert.equal(runtime.status().instances[0].phase, 'running'); assert.equal(runtime.status().instances[0].generation, generation + 1);
  } finally { daily.failure = undefined; await runtime.close(); }
});

test('manager close revokes immediately before accepted management operations drain and failed close can be retried', { timeout: 10000 }, async () => {
  const daily = participant(), options = config(), runtime = manager(options, daily);
  await runtime.start('alpha'); const lease = daily.lease;
  const pending = runtime.management('alpha', { method: 'GET', path: 'wait' }).catch(error => ({ error }));
  await delay(10);
  daily.failure = new Error('Daily persistence flush failed');
  const closing = runtime.close(); assert.equal(daily.lease, undefined); assert.equal(lease.isCurrent(), false);
  const rejected = assert.rejects(closing, /flush failed/);
  const accepted = await pending; assert.match(accepted.error?.message ?? '', /Instance changed/); await rejected;
  assert.throws(() => manager(options, participant()), /already being held/);
  daily.failure = undefined; await runtime.close();
  const next = manager(options, participant()); await next.close();
});

test('failed resume cleans up the child and a crash revokes the old lease before cleanup resolves', { timeout: 10000 }, async () => {
  const daily = participant(), runtime = manager(config(), daily), normalResume = daily.resumeInstance;
  try {
    daily.resumeInstance = function (lease) { normalResume.call(this, lease); throw new Error('Daily resume rejected'); };
    await assert.rejects(runtime.start('alpha'), /resume rejected/); assert.equal(daily.lease, undefined); assert.equal(runtime.status().instances[0].pid, null);
    daily.resumeInstance = normalResume; await runtime.start('alpha'); const prior = daily.lease, gate = deferred(); daily.gate = gate.promise;
    await assert.rejects(runtime.chat('alpha', { text: 'crash' }), /disconnected|exited|not connected/);
    await until(() => daily.lease === undefined); assert.equal(prior.isCurrent(), false); assert.equal(runtime.status().instances[0].cleanupPending, true);
    gate.resolve(); daily.gate = undefined; await until(() => runtime.status().instances[0].pid === null);
    await runtime.start('alpha'); assert.equal(prior.isCurrent(), false); assert.equal(daily.lease.isCurrent(), true);
  } finally { daily.gate = undefined; await runtime.close(); }
});

test('capability holds include exact daily work, reject stale force confirmation and retain the hold across restart', { timeout: 10000 }, async () => {
  const daily = participant(), runtime = manager(config(), daily);
  try {
    await runtime.start('alpha'); daily.work = [{ id: 'daily:one', kind: 'conversation', title: 'Exact daily turn', deliveryHash: 'original-input' }];
    const confirmed = await runtime.holdCapabilities(['alpha'], 'daily-maintenance'); assert.equal(confirmed.busy, true); assert.equal(daily.hold.frozen, false);
    daily.work.push({ id: 'daily:two', kind: 'conversation', title: 'Later turn' });
    await assert.rejects(runtime.cancelCapabilityWork(['alpha'], 'daily-maintenance', confirmed), error => error.status === 409); assert.equal(daily.confirmed, undefined); assert.equal(daily.hold.frozen, false);
    daily.work.pop(); await runtime.cancelCapabilityWork(['alpha'], 'daily-maintenance', confirmed);
    assert.equal(daily.confirmed.work[0].deliveryHash, 'original-input'); assert.equal(daily.hold.frozen, true);
    const before = daily.lease; await runtime.restart('alpha', { capabilityOperationId: 'daily-maintenance' });
    assert.equal(before.isCurrent(), false); assert.equal(daily.hold.operationId, 'daily-maintenance');
    await runtime.releaseCapabilities(['alpha'], 'daily-maintenance'); assert.equal(daily.hold, undefined);
  } finally { await runtime.close(); }
});

test('explicit stop cancels a queued durable restart and host recovery keeps the instance stopped', { timeout: 10000 }, async () => {
  const options = config(), daily = participant(), runtime = manager(options, daily);
  try {
    await runtime.start('alpha'); const item = runtime.instance('alpha'), generation = item.generation;
    runtime.requestRestart(item, generation);
    await runtime.stop('alpha'); await delay(20);
    assert.equal(runtime.status().instances[0].phase, 'stopped'); assert.equal(item.generation, generation); assert.equal(daily.lease, undefined);
    assert.equal(JSON.parse(readFileSync(join(item.config.stateDir, 'restart-intent.json'), 'utf8')).phase, 'cancelled');
  } finally { await runtime.close(); }
  const nextDaily = participant(), next = manager(options, nextDaily);
  try { await next.initialization; assert.equal(next.status().instances[0].phase, 'stopped'); assert.equal(nextDaily.resumes.length, 0); }
  finally { await next.close(); }
});

test('explicit stop supersedes an in-flight restart before another participant lease is resumed', { timeout: 10000 }, async () => {
  const daily = participant(), runtime = manager(config(), daily), gate = deferred();
  try {
    await runtime.start('alpha'); const generation = runtime.status().instances[0].generation, resumes = daily.resumes.length;
    daily.gate = gate.promise;
    const restarting = runtime.restart('alpha'); const rejected = assert.rejects(restarting, /superseded/);
    await delay(10); const stopping = runtime.stop('alpha'); gate.resolve(); daily.gate = undefined;
    await Promise.all([rejected, stopping]); assert.equal(runtime.status().instances[0].phase, 'stopped');
    assert.equal(runtime.status().instances[0].generation, generation); assert.equal(daily.resumes.length, resumes);
  } finally { gate.resolve(); daily.gate = undefined; await runtime.close(); }
});
