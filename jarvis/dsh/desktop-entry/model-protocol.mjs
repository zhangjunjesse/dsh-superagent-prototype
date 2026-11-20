import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const MODEL_BRIDGE_PROTOCOL = 'superjarvis-dsh-model-bridge-v1';
export const MODEL_BRIDGE_HEADER = 'X-SuperJarvis-Generation';
export const MODEL_BRIDGE_MAX_BODY_BYTES = 128 * 1024 * 1024;

/** Machine-local authentication state must never be stored with repository or profile backups. */
export function registryPath(environment = process.env, home = homedir()) {
  const base = process.platform === 'win32' ? environment.LOCALAPPDATA
    : environment.XDG_RUNTIME_DIR || join(home, '.local', 'state');
  if (typeof base !== 'string' || !isAbsolute(base)) throw new Error('The desktop model bridge needs an absolute local application directory.');
  return join(base, 'DSH', 'SuperJarvis', 'model-bridge', 'bridge.json');
}

/** Only the registered loopback origin can carry this process's private bearer. */
export function validBridgeRegistry(value) {
  if (!value || value.protocol !== MODEL_BRIDGE_PROTOCOL || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !/^[A-Za-z0-9_-]{43}$/.test(value.token ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(value.generation ?? '')
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) return false;
  try {
    const origin = new URL(value.origin);
    return origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Boolean(origin.port)
      && origin.origin === value.origin && origin.pathname === '/' && !origin.search && !origin.hash
      && !origin.username && !origin.password;
  } catch { return false; }
}
