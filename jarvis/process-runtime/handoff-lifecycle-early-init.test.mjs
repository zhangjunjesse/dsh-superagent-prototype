import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager } from './manager.mjs';
import { handoffLifecycle, handoffStep } from './handoff-lifecycle-fixture.mjs';

const artifacts = resolve('.artifacts/handoff/lifecycle');
mkdirSync(artifacts, { recursive: true });
const entry = fileURLToPath(new URL('./manager-fixture-child.mjs', import.meta.url));

for (const owner of ['business', 'management']) {
  test(`an early ${owner} initializer failure retains its real process and waits for exit`, { timeout: 10000 }, async t => {
    const evidence = mkdtempSync(join(artifacts, `early-${owner}-`)), records = [];
    const record = (phase, data = {}) => {
      const row = { at: new Date().toISOString(), phase, ...structuredClone(data) };
      records.push(row); appendFileSync(join(evidence, 'trace.jsonl'), JSON.stringify(row) + '\n');
    };
    let child, actualExit, exited, failure;
    const failInitialization = () => {
      const item = manager.instance('fixture');
      child = owner === 'business' ? item.child : item.management.child;
      record('initializer-failed', { pid: child.pid, owner });
      exited = new Promise(resolveExit => child.once('exit', (code, signal) => {
        actualExit = { code, signal }; record('actual-exit', { pid: child.pid, ...actualExit }); resolveExit();
      }));
      throw new Error(`controlled ${owner} initializer failed before its first event`);
    };
    const manager = new ProcessManager({}, { rootDir: join(evidence, 'manager'), instances: [{ instanceId: 'fixture',
      stateDir: join(evidence, 'manager', 'fixture', 'state'), workspace: join(evidence, 'manager', 'fixture', 'work'),
      model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read'] }] }, {
      entry,
      bridgeFactory: failInitialization,
      nativeFactory: failInitialization,
    });
    const lifecycle = handoffLifecycle(manager, record,
      { handoffTimeoutMs: 1000, shutdownTimeoutMs: 1000, cleanupTimeoutMs: 1000 });
    const result = { complete: false, owner };
    t.diagnostic(`early initializer evidence: ${evidence}`);
    try {
      try {
        await lifecycle.run(signal => handoffStep(signal, () => owner === 'business'
          ? manager.start('fixture') : manager.management('fixture', { method: 'GET', path: 'fixture' })));
      } catch (error) {
        failure = error; record('run-rejected', { message: error.message, phases: (error.errors ?? [error]).map(row => row.phase) });
      }
    } finally {
      // The test itself must leave no child behind even when a regression loses its handle.
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (exited) await Promise.race([exited, delay(1000).then(() => { throw new Error('early initializer child did not exit'); })]);
      await manager.close();
      Object.assign(result, { pid: child?.pid, actualExit, records });
      writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    }
    assert.ok(failure, 'the actual initializer error must remain a handoff failure');
    assert.match(failure.message, new RegExp(`controlled ${owner} initializer failed before its first event`));
    const failedAt = records.findIndex(row => row.phase === 'initializer-failed');
    assert.ok(records.slice(0, failedAt).some(row => row.phase === 'process-exits' && row.processes.some(process => process.pid === child.pid)),
      'the actual fork must be registered before its initializer can fail');
    const exitAt = records.findIndex(row => row.phase === 'actual-exit');
    assert.ok(exitAt >= 0, 'the real early child must emit an exit record');
    const verification = records.find(row => row.phase === 'shutdown-verified' || row.phase === 'forced-cleanup-result');
    assert.ok(verification, 'shutdown must record either verified exits or its forced cleanup result');
    const observed = verification.processes.find(row => row.pid === child.pid);
    assert.ok(observed, 'exit verification must include the actual early child instead of an empty list');
    assert.deepEqual(observed.exit, actualExit);
    assert.equal(observed.owner, owner); assert.equal(observed.alive, false);
    assert.ok(records.indexOf(verification) > exitAt, 'exit verification must follow the actual child exit event');
    if (actualExit.code !== 0 || actualExit.signal !== null) {
      assert.equal(records.some(row => row.phase === 'shutdown-verified'), false, 'an abnormal exit must not pass clean shutdown');
      assert.ok((failure.errors ?? [failure]).some(error => error.phase === 'shutdown'));
    }
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    result.complete = true; writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  });
}

for (const owner of ['business', 'management']) {
  test(`a throwing ${owner} creation observer still notifies later observers and cleans before test fallback`, { timeout: 10000 }, async t => {
    const evidence = mkdtempSync(join(artifacts, `observer-${owner}-`)), records = [];
    const record = (phase, data = {}) => {
      const row = { at: new Date().toISOString(), phase, ...data };
      records.push(row); appendFileSync(join(evidence, 'trace.jsonl'), JSON.stringify(row) + '\n');
    };
    let child, exited, actualExit, laterObservation;
    const result = { complete: false, owner, fallbackKill: false };
    const manager = new ProcessManager({}, { rootDir: join(evidence, 'manager'), instances: [{ instanceId: 'fixture',
      stateDir: join(evidence, 'manager', 'fixture', 'state'), workspace: join(evidence, 'manager', 'fixture', 'work'),
      model: { provider: 'controlled', model: 'controlled' }, workerTools: ['read'] }] }, {
      entry, bridgeFactory: () => ({ close: async () => {} }), nativeFactory: () => null,
    });
    const stopObserving = manager.observeProcesses((_item, processChild, actualOwner) => {
      child = processChild;
      record('observer-failed', { pid: child.pid, owner: actualOwner });
      exited = new Promise(resolveExit => child.once('exit', (code, signal) => {
        actualExit = { code, signal }; record('actual-exit', { pid: child.pid, ...actualExit }); resolveExit();
      }));
      throw new Error('controlled creation observer failed');
    });
    const stopLaterObserving = manager.observeProcesses((_item, processChild, actualOwner) => {
      laterObservation = { pid: processChild.pid, owner: actualOwner };
      record('later-observer-captured', laterObservation);
    });
    t.diagnostic(`throwing observer evidence: ${evidence}`);
    try {
      await assert.rejects(async () => owner === 'business' ? manager.start('fixture')
        : manager.management('fixture', { method: 'GET', path: 'fixture' }), /controlled creation observer failed/);
      await Promise.race([exited, delay(1000).then(() => { throw new Error('observer failure must exit its real child before test fallback'); })]);
      assert.ok(actualExit);
      assert.deepEqual(laterObservation, { pid: child.pid, owner }, 'an earlier observer error must not hide the child from later observers');
      assert.ok(!manager.instance('fixture').child && !manager.instance('fixture').management,
        'the existing initializer failure cleanup must release its owner handle');
      await manager.close();
      assert.equal(manager.status().instances[0].phase, 'stopped');
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
      result.complete = true;
    } finally {
      stopObserving();
      stopLaterObserving();
      if (child && child.exitCode === null && child.signalCode === null) { result.fallbackKill = true; child.kill('SIGKILL'); }
      if (exited) await Promise.race([exited, delay(1000).then(() => { throw new Error('observer child survived test safety cleanup'); })]);
      await manager.close().catch(error => {
        record('safety-close-failed', { error: error.message });
        manager.releaseLock?.(); manager.releaseLock = null;
      });
      Object.assign(result, { pid: child?.pid, actualExit, laterObservation, records });
      writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    }
  });
}
