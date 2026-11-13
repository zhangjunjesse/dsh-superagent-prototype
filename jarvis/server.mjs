import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { vault as systemVault } from './vault.mjs';
import { parseName, parseModel, UserError } from './config.mjs';
import { generate, makeRequest } from './model.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const assets = { '/model-picker.js': ['model-picker.js', 'text/javascript'], '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/ui.css': ['ui.css', 'text/css'], '/identity.js': ['identity.js', 'text/javascript'], '/layout.js': ['layout.js', 'text/javascript'], '/settings.js': ['settings.js', 'text/javascript'], '/chat.js': ['chat.js', 'text/javascript'], '/capabilities.js': ['capabilities.js', 'text/javascript'], '/capabilities.css': ['capabilities.css', 'text/css'] };
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new UserError('请求格式不正确', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new UserError('请求内容过长', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
  catch { throw new UserError('请求内容不是有效 JSON'); }
}
function publicModel(setting) {
  const { encryptedKey, ...value } = setting.value;
  return { revision: setting.revision, value, hasKey: Boolean(encryptedKey) };
}

export function createApp({ dataFile, vault = systemVault, fetcher = fetch }) {
  const store = new Store(dataFile);
  const csrf = randomBytes(32).toString('hex');
  let active = null;
  let origin;
  const state = () => ({ basic: store.setting('basic'), model: publicModel(store.setting('model')), turns: store.turns(), active: active?.id || null, csrf });
  function authorize(req) {
    if (req.headers.host !== new URL(origin).host) throw new UserError('不允许的访问地址', 403);
    if (req.headers.origin && req.headers.origin !== origin) throw new UserError('不允许跨站访问', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new UserError('不允许跨站访问', 403);
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-jarvis-csrf'] !== csrf) throw new UserError('页面会话已失效，请刷新页面', 403);
  }
  function saveModel(input) {
    const previous = store.setting('model');
    if (input.revision !== previous.revision) throw new UserError('设置已更新，请重新加载后保存', 409);
    const model = parseModel(input.value);
    let encryptedKey = model.endpoint === previous.value.endpoint ? previous.value.encryptedKey : '';
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new UserError('API Key 格式不正确');
      encryptedKey = input.apiKey.trim() ? vault.seal(input.apiKey.trim()) : '';
    }
    return publicModel(store.save('model', input.revision, { ...model, encryptedKey }));
  }
  function prepareTurn(input) {
    if (active) throw new UserError('当前回复尚未结束', 409);
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.id)) throw new UserError('请求标识不正确');
    const existing = store.turn(input.id);
    if (existing && !input.retry) return { existing };
    if (input.retry && (!existing || store.turns().at(-1)?.id !== input.id || existing.status === 'complete')) throw new UserError('只能重试最近一条未完成的回复', 409);
    const config = store.setting('model').value;
    if (!config.endpoint || !config.model) throw new UserError('请先在设置中配置模型');
    const apiKey = config.encryptedKey ? vault.open(config.encryptedKey) : '';
    if (!apiKey && new URL(config.endpoint).protocol === 'https:') throw new UserError('请先填写模型访问密钥');
    const user = existing?.user ?? input.text;
    if (typeof user !== 'string' || !user.trim() || user.length > 32000) throw new UserError('请输入 1–32000 个字符的消息');
    const turn = { id: input.id, user: user.trim(), assistant: '', status: 'streaming', error: '', createdAt: existing?.createdAt || new Date().toISOString(), attempt: (existing?.attempt || 0) + 1 };
    const context = [...store.turns().filter(row => row.id !== turn.id), turn];
    const body = makeRequest(config, store.setting('basic').value.assistantName, context);
    if (existing) store.updateTurn(turn); else store.addTurn(turn);
    return { turn, config, apiKey, body };
  }
  async function runChat(req, res, prepared) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const emit = value => { if (!res.destroyed) res.write(JSON.stringify(value) + '\n'); };
    if (prepared.existing) { emit({ type: 'done', turn: prepared.existing }); res.end(); return; }
    const { turn, config, apiKey, body } = prepared;
    const controller = new AbortController();
    const run = { id: turn.id, controller, promise: null };
    active = run;
    const disconnect = () => controller.abort('disconnect');
    res.on('close', disconnect);
    const timer = setTimeout(() => controller.abort('timeout'), Number(config.timeout) * 1000);
    emit({ type: 'start', turn });
    let lastWrite = Date.now();
    try {
      run.promise = generate({ config, apiKey, body, signal: controller.signal, fetcher, onDelta: delta => {
        turn.assistant += delta;
        emit({ type: 'delta', text: delta });
        if (Date.now() - lastWrite >= 250) { store.updateTurn(turn); lastWrite = Date.now(); }
      } });
      const result = await run.promise;
      Object.assign(turn, result);
    } catch (error) {
      if (controller.signal.aborted) {
        turn.status = controller.signal.reason === 'stop' ? 'stopped' : 'interrupted';
        turn.error = controller.signal.reason === 'timeout' ? '模型请求超时' : controller.signal.reason === 'stop' ? '已停止生成' : '连接中断，回复未完成';
      } else { turn.status = 'failed'; turn.error = error instanceof UserError ? error.message : '回复失败，请重试'; }
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
      turn.updatedAt = new Date().toISOString();
      store.updateTurn(turn);
      active = null;
      emit({ type: 'done', turn });
      res.end();
    }
  }
  async function route(req, res) {
    authorize(req);
    const path = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ready: true, app: 'jarvis', pid: process.pid });
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, state());
    if (req.method === 'PUT' && path === '/api/basic') {
      const input = await readJson(req);
      return json(res, 200, store.save('basic', input.revision, { assistantName: parseName(input.value?.assistantName) }));
    }
    if (req.method === 'PUT' && path === '/api/model') return json(res, 200, saveModel(await readJson(req)));
    if (req.method === 'POST' && path === '/api/chat') return runChat(req, res, prepareTurn(await readJson(req)));
    if (req.method === 'POST' && path === '/api/stop') {
      const input = await readJson(req);
      if (active && active.id === input.id) active.controller.abort('stop');
      return json(res, 200, { stopped: Boolean(active && active.id === input.id) });
    }
    if (req.method === 'DELETE' && path === '/api/conversation') {
      if (active) throw new UserError('请先停止当前回复', 409);
      store.clear(); return json(res, 200, { cleared: true });
    }
    if (req.method === 'GET' && assets[path]) {
      const [file, type] = assets[path];
      const content = readFileSync(publicDir + file);
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(content); return;
    }
    throw new UserError('未找到此页面', 404);
  }
  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) { res.end(); return; }
      json(res, error instanceof UserError ? error.status : 500, { error: error instanceof UserError ? error.message : '服务暂时无法处理请求' });
    });
  });
  return {
    store, server,
    async listen(port = 0) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
    async close() {
      if (active) { active.controller.abort('shutdown'); try { await active.promise; } catch {} }
      await new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      store.close();
    },
  };
}
