import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { vault } from '../vault.mjs';
import { parseProfilePatch } from './profile.mjs';

const home = resolve(process.argv[2]);
const config = JSON.parse(readFileSync(join(home, 'launch.json'), 'utf8'));
async function claimStartup() {
  if (process.platform !== 'win32') return;
  const inheritedNonce = process.argv[3] === '--launcher-nonce' ? process.argv[4] : undefined;
  const nonce = inheritedNonce ?? randomUUID().replaceAll('-', '');
  let helper, result, helperError;
  const startHelper = () => {
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    helper = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./start.ps1', import.meta.url)),
      '-HomePath', home, '-NodePath', process.execPath, '-Desktop', '-BootProcessId', String(process.pid), '-BootNonce', nonce],
    { windowsHide: true, cwd: dirname(shell), stdio: 'ignore' });
    helper.once('exit', code => { result = code ?? 1; });
    helper.once('error', error => { helperError = error; });
    helper.unref();
  };
  if (!inheritedNonce) startHelper();
  for (let attempt = 0; attempt < 700; attempt++) {
    try {
      const record = JSON.parse(readFileSync(join(home, 'launcher-state.json'), 'utf8'));
      if (record.pid === process.pid && record.bootNonce === nonce) return;
    } catch {}
    if (helperError) throw new Error('The local Jarvis startup coordinator could not run.');
    if (result !== undefined) process.exit(result);
    // A managed boot can recover if its PowerShell caller died before recording it.
    if (inheritedNonce && !helper && attempt >= 10) startHelper();
    await delay(50);
  }
  throw new Error('The local Jarvis startup claim timed out.');
}
await claimStartup();
process.env.DSH_HOME = home;
if (existsSync(join(home, 'credential-source.json'))) {
  const source = JSON.parse(readFileSync(join(home, 'credential-source.json'), 'utf8'));
  const db = new DatabaseSync(source.dataFile, { readOnly: true });
  const model = JSON.parse(db.prepare("SELECT value FROM settings WHERE id='model'").get().value); db.close();
  const patch = await parseProfilePatch(readFileSync(join(home, 'profiles', config.profile, 'cordis.patch.yml'), 'utf8'), config.dshPackage);
  const route = patch.find(item => item.id === 'llm-pi-ai')?.config?.providers?.['jarvis-provider'];
  if (!source.endpoint || source.endpoint !== model.endpoint || route?.baseURL !== source.endpoint) throw new Error('Model endpoint changed; review the credential binding before restarting Jarvis');
  process.env.JARVIS_DSH_MODEL_KEY = model.encryptedKey ? vault.open(model.encryptedKey) : '';
}
const registration = {
  pid: process.pid, startedAt: new Date().toISOString(),
  url: `http://127.0.0.1:${config.port}/`, jarvisUrl: `http://127.0.0.1:${config.port}/jarvis/`,
};
const runFile = promisify(execFile);
async function ownsListener() {
  if (process.platform !== 'win32') return true;
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await runFile(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./listener-identity.ps1', import.meta.url)), '-QueryPort', String(config.port)],
  // PowerShell's compiler inspects its working directory. A selected package
  // can live in a directory that the helper may read but cannot enumerate.
  { windowsHide: true, cwd: dirname(shell), timeout: 5000, maxBuffer: 1024 * 1024 });
  const owners = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  return Array.isArray(owners) && owners.length > 0 && owners.every(pid => pid === process.pid);
}

async function publishRuntime() {
  const response = await fetch(registration.jarvisUrl + 'api/health', { redirect: 'error', signal: AbortSignal.timeout(1000) });
  try {
    if (response.status !== 200) return;
    const health = await response.json();
    if (health.ready !== true || health.app !== 'jarvis' || health.runtime !== 'dsh' || health.pid !== process.pid || !await ownsListener()) return;
  } finally { await response.body?.cancel().catch(() => {}); }
  const file = join(home, 'runtime.json'), temporary = file + '.' + randomUUID() + '.tmp';
  try {
    // This process alone publishes ready identity, including for direct boot callers.
    try {
      const pending = JSON.parse(readFileSync(join(home, 'launcher-state.json'), 'utf8'));
      if (pending.pid === process.pid && typeof pending.processStartedAt === 'string') registration.processStartedAt = pending.processStartedAt;
    } catch {}
    writeFileSync(temporary, JSON.stringify(registration), { flag: 'wx' });
    renameSync(temporary, file);
    clearInterval(registrationTimer);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// An unreferenced watcher never keeps a failed/finished CLI alive, and survives the
// PowerShell caller's timeout while the actual host continues booting.
let checking = false;
const registrationTimer = setInterval(() => {
  if (checking) return;
  checking = true;
  void publishRuntime().catch(() => {}).finally(() => { checking = false; });
}, 200);
registrationTimer.unref();
process.argv = [process.execPath, join(config.dshPackage, 'lib/bin.js'), '--profile', config.profile, '--host', '127.0.0.1', '--port', String(config.port), '--no-open'];
const { runCli } = await import(pathToFileURL(join(config.dshPackage, 'lib/bin.js')));
await runCli();
