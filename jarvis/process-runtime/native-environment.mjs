/** Per-async-operation subprocess environments; the host's process.env is never changed. */
import { AsyncLocalStorage } from 'node:async_hooks';

const contexts = new WeakMap();
export function encodeEnvironment(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([name, content]) => {
    if (!name || name.includes('=') || name.includes('\0') || content !== undefined && typeof content !== 'string') throw new Error('Invalid organization environment');
    return [name, content === undefined ? null : content];
  }));
}
export function decodeEnvironment(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([name, content]) => {
    if (!name || name.includes('=') || name.includes('\0') || content !== null && typeof content !== 'string') throw new Error('Invalid organization environment');
    return [name, content === null ? undefined : content];
  }));
}

export function scopedSubprocessEnvironment(subprocess) {
  let state = contexts.get(subprocess);
  if (!state) {
    const storage = new AsyncLocalStorage();
    for (const name of ['spawn', 'spawnTerminal']) if (typeof subprocess[name] === 'function') {
      const original = subprocess[name].bind(subprocess);
      subprocess[name] = spec => {
        const environment = storage.getStore();
        return original(environment ? { ...spec, env: { ...spec.env, ...environment } } : spec);
      };
    }
    if (typeof subprocess.resolveExecutable === 'function') {
      const original = subprocess.resolveExecutable.bind(subprocess);
      subprocess.resolveExecutable = (name, env, signal) => original(name, { ...env, ...storage.getStore() }, signal);
    }
    state = { run: (environment, operation) => storage.run(environment, operation) };
    contexts.set(subprocess, state);
  }
  return state;
}
