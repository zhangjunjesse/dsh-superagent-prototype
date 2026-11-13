import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JarvisRuntime } from './runtime.mjs';
import { UserError } from '../config.mjs';

export const name = 'dsh-superagent-jarvis';
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'tools', 'systemPrompt', 'llm', 'webServer'];
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const files = new Set(['index.html', 'identity.js', 'model-picker.js', 'layout.js', 'settings.js', 'chat.js', 'capabilities.js', 'capabilities.css', 'ui.css', 'dsh-tools.js']);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new UserError('请求格式不正确', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new UserError('请求内容过长', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
  catch { throw new UserError('请求内容不是有效 JSON'); }
}

export async function apply(ctx, config) {
  if (!config || !isAbsolute(config.stateDir || '') || !isAbsolute(config.workspace || '')) throw new Error('Jarvis requires absolute stateDir and workspace');
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Jarvis requires a loopback DSH web server');
  const runtime = new JarvisRuntime(ctx, { ...config, dataFile: join(config.stateDir, 'jarvis-dsh.sqlite') });
  const csrf = randomBytes(32).toString('hex');
  try { await runtime.ready(); } catch (error) { await runtime.close(); throw error; }
  ctx.effect(() => async () => runtime.close());
  ctx.webServer.register({ kind: 'prefix', path: '/jarvis', handler: async (req, res) => {
    try {
      const host = req.headers.host;
      if (![ `127.0.0.1:${ctx.webServer.port}`, `localhost:${ctx.webServer.port}` ].includes(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new UserError('不允许跨站访问', 403);
      const path = new URL(req.url, `http://${host}`).pathname.slice('/jarvis'.length);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-jarvis-csrf'] !== csrf) throw new UserError('页面会话已失效，请刷新页面', 403);
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ready: true, app: 'jarvis', runtime: 'dsh', pid: process.pid });
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, { ...await runtime.state(), csrf });
      if (req.method === 'GET' && path === '/api/notifications') {
        const parameters = new URL(req.url, `http://${host}`).searchParams;
        return json(res, 200, runtime.notifications(Number(parameters.get('cursor') || 0), Number(parameters.get('limit') || 20)));
      }
      if (req.method === 'POST' && path === '/api/notifications/retry') return json(res, 200, await runtime.retryNotifications(await body(req)));
      if (req.method === 'GET' && path === '/api/tools') return json(res, 200, runtime.tools());
      if (req.method === 'PUT' && path === '/api/tools') return json(res, 200, runtime.saveTool(await body(req)));
      if (req.method === 'PUT' && path === '/api/basic') return json(res, 200, runtime.saveBasic(await body(req)));
      if (req.method === 'PUT' && path === '/api/model') return json(res, 200, await runtime.saveModel(await body(req)));
      if (req.method === 'POST' && path === '/api/models/refresh') return json(res, 200, await runtime.refreshModels((await body(req)).force === true));
      if (req.method === 'POST' && path === '/api/stop') return json(res, 200, { stopped: runtime.stop((await body(req)).id) });
      if (req.method === 'DELETE' && path === '/api/conversation') { await runtime.clear(); return json(res, 200, { cleared: true }); }
      if (req.method === 'POST' && path === '/api/chat') {
        const input = await body(req);
        const controller = new AbortController();
        const disconnect = () => controller.abort();
        res.on('close', disconnect);
        try {
          await runtime.chat(input, event => {
            if (res.destroyed) return;
            if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
            res.write(JSON.stringify(event) + '\n');
          }, controller.signal);
        } finally { res.off('close', disconnect); if (res.headersSent) res.end(); }
        return;
      }
      if (req.method === 'GET') {
        if (path === '') { res.writeHead(302, { Location: '/jarvis/' }); res.end(); return; }
        const file = path === '/' ? 'index.html' : path.slice(1);
        if (files.has(file)) {
          let content = readFileSync(join(publicDir, file), 'utf8');
          if (file === 'index.html') content = content.replaceAll('href="/', 'href="/jarvis/').replaceAll('src="/', 'src="/jarvis/').replace('<script src="/jarvis/settings.js">', '<script src="/jarvis/dsh-tools.js"></script>\n<script src="/jarvis/settings.js">');
          res.writeHead(200, { 'Content-Type': (file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript') + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" });
          res.end(content); return;
        }
      }
      throw new UserError('未找到此页面', 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error instanceof UserError ? error.status : 500, { error: error instanceof UserError ? error.message : '服务暂时无法处理请求' });
    }
  } });
  ctx.logger.info('Jarvis available at /jarvis/');
}
