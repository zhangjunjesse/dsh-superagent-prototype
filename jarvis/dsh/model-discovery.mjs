import { UserError } from '../config.mjs';

// pi-ai's generic discovery currently drops /models.effort. Keep its execution
// adapter and update only the explicitly opted-in provider's model descriptors.
const supportedByAdapter = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export function deepSeekModels(body, previous = []) {
  if (!Array.isArray(body?.data) || body.data.length > 500) throw new UserError('模型服务返回了无效的能力信息');
  const models = [], defaults = {}, seen = new Set();
  for (const row of body.data) {
    if (typeof row?.id !== 'string' || !row.id || row.id.length > 200 || seen.has(row.id)) continue;
    const levels = row.effort?.supported_levels;
    if (!Array.isArray(levels) || !levels.length || levels.some(level => typeof level !== 'string')) continue;
    const available = [...new Set(levels)].filter(level => supportedByAdapter.has(level));
    if (!available.length) continue;
    seen.add(row.id);
    const old = previous.find(model => model.id === row.id);
    models.push({ ...old, id: row.id, name: typeof row.name === 'string' ? row.name.slice(0, 200) : row.id,
      reasoningEfforts: Object.fromEntries(available.map(level => [level, level])) });
    if (available.includes(row.effort.default_level)) defaults[row.id] = row.effort.default_level;
  }
  if (!models.length) throw new UserError('模型服务未返回可用的思考级别，已保留原配置');
  return { models, defaults };
}

export class ModelDiscovery {
  constructor(ctx, route, fetcher = fetch) { this.ctx = ctx; this.route = route; this.fetcher = fetcher; this.defaults = {}; this.status = ''; }
  async refresh(force = false) {
    if (!this.route) return;
    const { provider, settingsNs } = this.route;
    const settings = this.ctx.get('settings');
    const descriptor = settings?.describe().find(item => item.ns === settingsNs);
    const config = descriptor?.value?.providers?.[provider];
    // Never send a credential to a guessed, redirected, or newly edited endpoint.
    let base;
    try { base = new URL(config?.baseURL); } catch { /* rejected below */ }
    if (!base || base.origin !== 'https://api.deepseek.com' || !['/', '/v1', '/v1/'].includes(base.pathname) || base.search || base.hash || base.username || base.password || config.api !== 'openai-completions') {
      throw new UserError('当前模型服务不支持自动读取思考级别，已保留 DSH 配置');
    }
    if (!config.apiKeyEnv) throw new UserError('模型服务未配置凭据引用');
    const connection = base.href + '\n' + config.apiKeyEnv;
    if (!force && connection === this.connection && this.updatedAt && Date.now() - this.updatedAt < 600000) return;
    const credentials = this.ctx.get('credentials');
    const key = credentials ? (await credentials.resolve(config.apiKeyEnv))?.value : process.env[config.apiKeyEnv];
    if (!key) throw new UserError('无法读取模型服务凭据，请检查 DSH 模型配置');
    const url = base.href.replace(/\/$/, '') + '/models';
    let response, body;
    try {
      response = await this.fetcher(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { throw new UserError('暂时无法刷新模型能力，已保留上次配置'); }
    const result = deepSeekModels(body, config.models);
    if (JSON.stringify(result.models) !== JSON.stringify(config.models)) {
      try {
        await settings.mutate(settingsNs, [{ op: 'set', path: ['providers', provider, 'models'], value: result.models }], descriptor.revision);
      } catch { throw new UserError('模型服务配置发生变化，请重新刷新'); }
    }
    this.defaults = result.defaults;
    this.connection = connection;
    this.updatedAt = Date.now();
    this.status = '已从模型服务更新';
  }
  async catalog() {
    const catalog = await this.ctx.sessionController.modelCatalog();
    for (const group of catalog.groups) {
      if (group.id !== this.route?.provider) continue;
      for (const model of group.models) {
        const level = this.defaults[model.id];
        if (level && model.reasoning?.efforts.some(item => item.id === level)) model.reasoning.defaultEffort = level;
      }
    }
    return { ...catalog, refreshable: Boolean(this.route), status: this.status };
  }
}
