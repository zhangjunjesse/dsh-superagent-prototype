/** Test-only deadlines and OS-process cleanup for the real handoff scenario. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export const HANDOFF_TIMEOUT_MS = 30000;
// Closing also reopens management owners to verify durable delegation bindings.
// The two review runs took 33.1s and 42.5s after business assertions had passed.
export const SHUTDOWN_TIMEOUT_MS = 60000;
const CLEANUP_TIMEOUT_MS = 5000;

async function phase(name, timeoutMs, operation, checkpoint) {
  const started = performance.now(), controller = new AbortController();
  checkpoint(`${name}-started`, { timeoutMs });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${name} timed out after ${timeoutMs}ms`);
      controller.abort(error); reject(error);
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]);
    checkpoint(`${name}-finished`, { timeoutMs, elapsedMs: performance.now() - started });
    return value;
  } catch (cause) {
    controller.abort(cause);
    const error = Object.assign(new Error(`${name}: ${cause.message}`, { cause }), { phase: name });
    checkpoint(`${name}-failed`, { timeoutMs, elapsedMs: performance.now() - started, error: error.stack });
    throw error;
  } finally { clearTimeout(timer); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Keep handles for every business and temporary management process, including owners opened during close. */
export function handoffLifecycle(manager, checkpoint, {
  handoffTimeoutMs = HANDOFF_TIMEOUT_MS, shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
} = {}) {
  const processes = new Map(), cleanupErrors = [], event = manager.event, openManagement = manager.openManagement;
  let forcing = false;
  const snapshot = () => [...processes.values()].map(({ child, ...row }) => ({ ...row, alive: alive(row.pid) }));
  const exited = row => row.exit !== undefined && !alive(row.pid);
  function kill(row) {
    if (row.exit !== undefined) return;
    row.forced = true;
    try { if (row.child.connected) row.child.disconnect(); } catch (error) { cleanupErrors.push(error.message); }
    try { row.child.kill('SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error.message); }
  }
  function remember(item, child, owner) {
    if (!child?.pid || processes.has(child)) return;
    const row = { child, instanceId: item.config.instanceId, owner, pid: child.pid };
    processes.set(child, row);
    child.once('exit', (code, signal) => {
      row.exit = { code, signal };
      checkpoint('process-exits', { processes: snapshot() });
    });
    if (child.exitCode !== null || child.signalCode !== null) row.exit = { code: child.exitCode, signal: child.signalCode };
    checkpoint('process-exits', { processes: snapshot() });
    if (forcing) kill(row);
  }
  function capture() {
    for (const item of manager.instances.values()) {
      remember(item, item.child, 'business'); remember(item, item.management?.child, 'management');
    }
  }
  manager.event = function (item, ...args) {
    capture();
    return event.call(this, item, ...args);
  };
  if (openManagement) manager.openManagement = function (...args) {
    // A timed-out close may still be unwinding. It must not spawn another recovery owner after cleanup was verified.
    if (forcing) return Promise.reject(new Error('Forced test cleanup forbids opening another management owner'));
    return openManagement.apply(this, args);
  };
  async function forceCleanup() {
    forcing = true;
    try {
      await phase('forced-cleanup', cleanupTimeoutMs, async signal => {
        for (;;) {
          capture();
          for (const item of manager.instances.values()) { item.peer?.close(); item.management?.peer?.close(); }
          for (const row of processes.values()) kill(row);
          if ([...processes.values()].every(exited)) return;
          await delay(10, undefined, { signal });
        }
      }, checkpoint);
    } finally {
      capture(); for (const row of processes.values()) kill(row);
      checkpoint('forced-cleanup-result', { processes: snapshot(), cleanupErrors });
      if ([...processes.values()].every(exited)) { manager.releaseLock?.(); manager.releaseLock = null; }
    }
  }
  return {
    async run(handoff, beforeShutdown = () => {}) {
      const failures = [];
      try { await phase('handoff', handoffTimeoutMs, handoff, checkpoint); }
      catch (error) { failures.push(error); }
      finally {
        beforeShutdown();
        try {
          await phase('shutdown', shutdownTimeoutMs, async () => {
            capture(); await manager.close(); capture();
            const rows = snapshot();
            assert.deepEqual(rows.filter(row => !row.exit || row.alive), [], 'shutdown must wait for actual OS-process exits');
            assert.ok(rows.every(row => row.exit.code === 0 && row.exit.signal === null), 'shutdown must exit its children cleanly');
            for (const item of manager.instances.values()) {
              assert.equal(item.phase, 'stopped'); assert.equal(item.cleanupPending, false);
              assert.ok(!item.child && !item.management && !item.native && !item.bridge, 'shutdown must release every owner');
            }
            checkpoint('shutdown-verified', { processes: rows, state: manager.status() });
          }, checkpoint);
        } catch (error) {
          failures.push(error);
          try { await forceCleanup(); } catch (cleanupError) { failures.push(cleanupError); }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
      manager.event = event; if (openManagement) manager.openManagement = openManagement;
      return { processes: snapshot() };
    },
  };
}
