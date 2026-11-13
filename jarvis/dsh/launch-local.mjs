import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { vault } from '../vault.mjs';
import { parseProfilePatch } from './profile.mjs';

const home = resolve(process.argv[2]);
const config = JSON.parse(readFileSync(join(home, 'launch.json'), 'utf8'));
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
writeFileSync(join(home, 'runtime.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), url: `http://127.0.0.1:${config.port}/`, jarvisUrl: `http://127.0.0.1:${config.port}/jarvis/` }));
process.argv = [process.execPath, join(config.dshPackage, 'lib/bin.js'), '--profile', config.profile, '--host', '127.0.0.1', '--port', String(config.port), '--no-open'];
const { runCli } = await import(pathToFileURL(join(config.dshPackage, 'lib/bin.js')));
await runCli();
