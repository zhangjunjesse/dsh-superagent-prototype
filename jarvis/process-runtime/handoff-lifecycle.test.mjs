import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { handoffLifecycle } from './handoff-lifecycle-fixture.mjs';

async function fixture(t, closeMode = 'normal', closeDelay = 0, timeouts = {}) {
  function launchChild() {
    const child = spawn(process.execPath, ['-e', "process.on('message', () => process.exit(0)); process.send('ready');"],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return { child, ready: once(child, 'message'), exited: once(child, 'exit') };
  }
  const children = [launchChild(), launchChild()];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(row => row.exited));
  });
  await Promise.all(children.map(row => row.ready));
  const item = { config: { instanceId: 'fixture' }, child: children[0].child, management: { child: children[1].child },
    phase: 'running', cleanupPending: true };
  const manager = {
    instances: new Map([['fixture', item]]), event() {},
    status: () => ({ instances: [{ instanceId: 'fixture', phase: item.phase, pid: item.child?.pid ?? null }] }),
    async openManagement() {
      const next = launchChild(); children.push(next); item.management = { child: next.child };
      this.event(item, 'management-open'); await next.ready; return item.management;
    },
    async close() {
      if (closeMode === 'hang') return new Promise(() => {});
      if (closeMode === 'reject') throw new Error('close acknowledgement failed');
      if (closeMode === 'premature') return;
      await delay(closeDelay);
      for (const { child } of children) child.send('close');
      await Promise.all(children.map(row => row.exited));
      item.child = null; item.management = undefined; item.phase = 'stopped'; item.cleanupPending = false;
    },
  };
  const records = [];
  const lifecycle = handoffLifecycle(manager, (phase, data) => records.push({ phase, ...structuredClone(data) }),
    { handoffTimeoutMs: 1000, shutdownTimeoutMs: closeMode === 'hang' ? 30 : 1000, cleanupTimeoutMs: 3000, ...timeouts });
  return { lifecycle, records, children, manager };
}

function assertExited(children) {
  for (const { child } of children) {
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'an actual exit must have occurred');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  }
}

test('handoff and shutdown have separate deadlines and verify both real process owners', { timeout: 10000 }, async t => {
  const { lifecycle, records, children } = await fixture(t, 'normal', 80, { handoffTimeoutMs: 50 });
  const result = await lifecycle.run(async () => { await delay(10); });
  assert.equal(result.processes.length, 2);
  assert.deepEqual(result.processes.map(row => row.owner).sort(), ['business', 'management']);
  assert.ok(records.some(row => row.phase === 'shutdown-verified'));
  assert.equal(records.some(row => row.phase === 'forced-cleanup-started'), false);
  assertExited(children);
});

test('a handoff timeout retains its phase while the real children still close normally', { timeout: 10000 }, async t => {
  const { lifecycle, records, children } = await fixture(t);
  let released = false;
  await assert.rejects(lifecycle.run(signal => delay(2000, undefined, { signal }), () => { released = true; }),
    error => error.phase === 'handoff' && /handoff timed out after 1000ms/.test(error.message));
  assert.equal(released, true);
  assert.ok(records.some(row => row.phase === 'handoff-failed'));
  assert.ok(records.some(row => row.phase === 'shutdown-verified'));
  assertExited(children);
});

for (const closeMode of ['hang', 'reject', 'premature']) {
  test(`a ${closeMode} shutdown fails its phase and forcibly cleans both real child owners`, { timeout: 10000 }, async t => {
    const { lifecycle, records, children } = await fixture(t, closeMode);
    await assert.rejects(lifecycle.run(async () => {}), error => error.phase === 'shutdown' &&
      (closeMode !== 'hang' || /shutdown timed out after 30ms/.test(error.message)));
    assert.ok(records.some(row => row.phase === 'shutdown-failed'));
    const cleaned = records.find(row => row.phase === 'forced-cleanup-result');
    assert.equal(cleaned.processes.length, 2);
    assert.ok(cleaned.processes.every(row => row.forced && row.exit && !row.alive));
    assertExited(children);
  });
}

test('a handoff assertion and failed shutdown both remain visible after successful forced cleanup', { timeout: 10000 }, async t => {
  const { lifecycle, children } = await fixture(t, 'reject');
  await assert.rejects(lifecycle.run(async () => { assert.fail('the registered version did not match'); }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(row => row.phase), ['handoff', 'shutdown']);
    assert.match(error.message, /registered version did not match/); assert.match(error.message, /close acknowledgement failed/);
    return true;
  });
  assertExited(children);
});

test('forced cleanup fences later recovery-owner spawns from a still-pending close', { timeout: 10000 }, async t => {
  const { lifecycle, manager, children } = await fixture(t, 'hang');
  await assert.rejects(lifecycle.run(async () => {}), error => error.phase === 'shutdown');
  await assert.rejects(manager.openManagement(), /Forced test cleanup forbids opening another management owner/);
  assert.equal(children.length, 2, 'no additional OS process may be spawned after cleanup');
  assertExited(children);
});
