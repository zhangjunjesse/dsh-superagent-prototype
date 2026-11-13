import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Creates a separate local DSH profile; never replaces an existing profile or copies credentials.
const [homeArg, dshPackageArg] = process.argv.slice(2);
if (!homeArg || !dshPackageArg) throw new Error('Usage: setup-local.mjs <new DSH_HOME> <installed dsh package directory>');
const home = resolve(homeArg), dshPackage = resolve(dshPackageArg);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const profile = join(home, 'profiles/jarvis');
if (existsSync(join(profile, 'cordis.patch.yml'))) throw new Error('Profile exists; refusing to replace it');
mkdirSync(profile, { recursive: true });
mkdirSync(join(home, 'workspace'), { recursive: true });
if (!existsSync(join(home, 'profiles/node_modules'))) symlinkSync(join(dshPackage, 'node_modules'), join(home, 'profiles/node_modules'), 'junction');
mkdirSync(join(profile, 'node_modules'), { recursive: true });
symlinkSync(repo, join(profile, 'node_modules/dsh-superagent'), 'junction');
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-jarvis', private: true,
  dependencies: { 'dsh-superagent': 'link:' + repo.replaceAll('\\', '/') },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
writeFileSync(join(profile, 'cordis.yml'), '[]\n');
const plugins = ['time-context', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill', process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash'].map(id => ({ id, name: '@deepseek-ai/dsh-' + id, ...(id === 'tool-fs-search' ? { config: { sampleOverCapGlobResults: false } } : {}) }));
const patch = [ { insert: [
  { id: 'preset-jarvis', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'jarvis', name: '贾维斯', plugins } },
  { id: 'jarvis', name: 'dsh-superagent/jarvis', config: { stateDir: join(home, 'jarvis-state'), workspace: join(home, 'workspace'), preset: 'jarvis' } },
  { id: 'jarvis-panel', name: './node_modules/dsh-superagent/jarvis/dsh/panel/index.mjs' },
] } ];
// Optional non-secret route from the existing local app. Its key is decrypted only in the launcher process.
const source = join(process.env.LOCALAPPDATA || '', 'Jarvis-superagent/jarvis.sqlite');
if (existsSync(source)) {
  const db = new DatabaseSync(source, { readOnly: true });
  const model = JSON.parse(db.prepare("SELECT value FROM settings WHERE id='model'").get().value);
  const basic = JSON.parse(db.prepare("SELECT value FROM settings WHERE id='basic'").get().value);
  db.close();
  if (model.endpoint && model.model) {
    if (model.sampling === 'topP') throw new Error('Existing Top P setting needs an explicit migration decision');
    patch.push({ id: 'llm-pi-ai', config: { providers: { 'jarvis-provider': { displayName: '自定义模型服务', api: 'openai-completions', baseURL: model.endpoint, apiKeyEnv: 'JARVIS_DSH_MODEL_KEY',
      retryPolicy: { mode: 'normal', maxRetries: Number(model.retries) },
      models: [{ id: model.model, name: model.model, ...(model.reasoning !== 'default' ? { reasoningEfforts: { [model.reasoning]: model.reasoning } } : {}) }] } } } });
    const target = patch[0].insert[1].config;
    if (new URL(model.endpoint).origin === 'https://api.deepseek.com') target.modelDiscovery = { provider: 'jarvis-provider', settingsNs: 'llm-pi-ai' };
    target.initialModel = { endpoint: 'jarvis-provider', model: model.model, temperature: model.sampling === 'temperature' ? model.temperature : '', maxTokens: model.maxTokens,
      reasoning: model.reasoning, timeout: model.timeout, stream: model.stream };
    target.initialName = basic.assistantName;
    writeFileSync(join(home, 'credential-source.json'), JSON.stringify({ dataFile: source, endpoint: model.endpoint }));
  }
}
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2));
writeFileSync(join(home, 'launch.json'), JSON.stringify({ home, dshPackage, profile: 'jarvis', port: 4318 }, null, 2));
console.log(JSON.stringify({ profile, port: 4318, workspace: join(home, 'workspace') }));
