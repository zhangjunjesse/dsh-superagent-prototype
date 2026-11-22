import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JarvisRuntime } from './runtime.mjs';
import { captureConversationModel } from './conversation-model.mjs';
import { UserError } from '../config.mjs';
import { SystemControl, SystemControlError } from '../process-runtime/control.mjs';
import { workerCatalog } from '../process-runtime/worker-catalog.mjs';
import { handleConversationRequest } from '../process-runtime/conversation-http.mjs';
import { handleArtifactRequest } from '../process-runtime/artifact-http.mjs';
import { OperationLogs } from '../operation-logs/index.mjs';
import { readOriginalAdoption } from '../process-runtime/original-adoption.mjs';
import { registerOriginalManagement } from './original-management.mjs';
import { TaskVisibility } from './task-visibility.mjs';

export const name = 'dsh-superagent-jarvis';
export const inject = ['agents', 'agentPresets', 'sessionController', 'sessionPersistence', 'tools', 'systemPrompt', 'llm', 'webServer', 'connection',
  'subprocess', 'permissionPresets', 'workspaceRegistry'];
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const organizationBundle = fileURLToPath(new URL('../../lib/organization.js', import.meta.url));
const files = new Set(['index.html', 'identity.js', 'model-catalog.js', 'model-picker.js', 'layout.js', 'settings.js', 'chat.js', 'capabilities.js', 'capabilities.css', 'ui.css', 'dsh-tools.js', 'composition.html', 'composition.css', 'composition.js', 'operation-logs.js', 'operation-logs.css', 'prompts.js', 'prompts.css']);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req, limit = 100000) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new UserError('请求格式不正确', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new UserError('请求内容过长', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
  catch { throw new UserError('请求内容不是有效 JSON'); }
}

export async function apply(ctx, config) {
  if (!config || !isAbsolute(config.stateDir || '') || !isAbsolute(config.workspace || '')) throw new Error('Jarvis requires absolute stateDir and workspace');
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Jarvis requires a loopback DSH web server');
  const rootStateDir = join(config.systemManagement?.rootDir ?? join(config.stateDir, 'superjarvis'), 'instances', 'root', 'state');
  const adoption = config.systemManagement !== false ? readOriginalAdoption(rootStateDir) : undefined;
  const gatewayOptions = adoption ? { adoptedRoot: { stateDir: rootStateDir, identity: adoption.identity } } : {};
  let system, systemError;
  const readOrganizationDirectory = config.systemManagement === false ? undefined : () => {
    if (!system) throw new UserError('组织目录暂不可用，请检查实例管理状态', 503);
    return system.organizationDirectory();
  };
  const runtime = new JarvisRuntime(ctx, { ...config, lifecycleManaged: config.systemManagement !== false,
    dataFile: join(config.stateDir, 'jarvis-dsh.sqlite') }, { readOrganizationDirectory });
  const csrf = randomBytes(32).toString('hex');
  // Session-switch recovery needs its durable notification ledgers before optional engine management initializes.
  try {
    if (config.systemManagement !== false) runtime.gateway.connectOrganization(undefined, join(config.stateDir, 'organization-gateway.sqlite'), gatewayOptions);
    await runtime.ready();
  } catch (error) { await runtime.close(); throw error; }
  try {
    if (config.systemManagement !== false) system = new SystemControl(ctx, {
      rootDir: config.systemManagement?.rootDir ?? join(config.stateDir, 'superjarvis'),
      capabilityCatalog: workspace => workerCatalog(ctx, workspace, config.workspace, config.preset || 'jarvis'),
      // Daily conversation settings are captured per user turn, independently of instance execution models.
      managerOptions: { preset: config.preset || 'jarvis', conversationModel: () => captureConversationModel(runtime.store),
        modelCatalog: runtime.desktopModels ? () => runtime.desktopModels.catalog() : undefined,
        lifecycleParticipants: { root: runtime } },
      defaultModel: () => {
        const value = runtime.model().value;
        return value.endpoint && value.model ? { provider: value.endpoint, model: value.model,
          ...(value.reasoning !== 'default' ? { reasoningEffort: value.reasoning } : {}) } : null;
      },
      validateModel: async model => {
        try { await ctx.llm.resolveCallConfig(model); }
        catch { throw new SystemControlError(400, '该模型或思考级别不可用，请检查 DSH 模型配置'); }
      },
    });
  } catch (error) {
    // History/settings remain available; execution stays closed without an instance owner.
    systemError = '实例管理暂不可用，请检查已保存的系统配置与服务日志';
    ctx.logger.warn(error instanceof SystemControlError ? error.message : 'SuperJarvis 实例管理初始化失败');
  }
  if (config.systemManagement !== false) runtime.gateway.connectOrganization(system?.manager, join(config.stateDir, 'organization-gateway.sqlite'), gatewayOptions);
  if (adoption) ctx.effect(() => registerOriginalManagement(ctx, { adoption, system, systemError }));
  let logs;
  try {
    logs = new OperationLogs(ctx, { dataFile: join(config.stateDir, 'operation-logs.sqlite'), runtime, system });
    await logs.start();
  } catch {
    try { await logs?.close(); } catch { /* Optional log cleanup must not affect the conversation service. */ }
    logs = undefined;
    ctx.logger.warn('运行日志暂不可用，原对话和任务服务继续运行');
  }
  ctx.effect(() => async () => {
    try { await system?.close(); } finally {
      try { await runtime.close(); } finally { await logs?.close(); }
    }
  });
  const tasks = new TaskVisibility({ runtime, system });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/jarvis', handler: createJarvisHandler(ctx, runtime, { csrf, system, systemError, logs, tasks }) }));
  ctx.logger.info('Jarvis available at /jarvis/');
}

/** Log evidence and instance controls share the existing login and same-origin boundary. */
export function createJarvisHandler(ctx, runtime, { csrf, system, systemError, logs, tasks }) {
  return async (req, res) => {
    try {
      const host = req.headers.host;
      if (![ `127.0.0.1:${ctx.webServer.port}`, `localhost:${ctx.webServer.port}` ].includes(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new UserError('不允许跨站访问', 403);
      const path = new URL(req.url, `http://${host}`).pathname.slice('/jarvis'.length);
      const systemPath = path === '/api/system' || path.startsWith('/api/system/');
      const logsPath = path === '/api/logs' || path.startsWith('/api/logs/');
      const promptsPath = path === '/api/prompts' || path.startsWith('/api/prompts/');
      const tasksPath = path === '/api/tasks' || path.startsWith('/api/tasks/');
      if (systemPath || logsPath || promptsPath || tasksPath) {
        if (typeof ctx.connection?.requestRejection !== 'function') throw new UserError(promptsPath ? '提示词管理认证暂不可用' : logsPath ? '日志访问认证暂不可用' : '当前宿主未提供实例管理认证', 503);
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) throw new UserError(rejection === 401
          ? (logsPath || promptsPath ? '登录已失效，请重新登录后打开' : 'DSH 登录已失效，请通过宿主入口重新打开')
          : (promptsPath ? '不允许访问提示词管理' : logsPath ? '不允许访问运行日志' : '不允许访问实例管理'), rejection);
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-jarvis-csrf'] !== csrf) throw new UserError('页面会话已失效，请刷新页面', 403);
      if (tasksPath) {
        if (!tasks) throw new UserError('任务状态暂不可读取，请稍后重试', 503);
        if (req.method !== 'GET') throw new UserError('任务状态只支持读取', 405);
        const parameters = new URL(req.url, `http://${host}`).searchParams;
        if (path === '/api/tasks') return json(res, 200, tasks.list(parameters));
        const match = /^\/api\/tasks\/(JW-[A-Za-z0-9-]{1,196})$/.exec(path);
        if (match) return json(res, 200, tasks.detail(match[1], parameters));
        throw new UserError('未找到此任务', 404);
      }
      if (promptsPath) {
        if (path === '/api/prompts' && req.method === 'GET') return json(res, 200, await runtime.prompts());
        if (path === '/api/prompts' && req.method === 'PUT') return json(res, 200, await runtime.savePrompts(await body(req)));
        if (path === '/api/prompts/preview' && req.method === 'POST') return json(res, 200, await runtime.previewPrompts(await body(req)));
        throw new UserError('未找到此提示词操作', 404);
      }
      if (logsPath) {
        if (!logs) throw new UserError('运行日志暂不可用，请稍后重试', 503);
        if (req.method !== 'GET') throw new UserError('运行日志只支持读取', 405);
        if (path === '/api/logs') return json(res, 200, await logs.list(new URL(req.url, `http://${host}`).searchParams));
        const match = /^\/api\/logs\/([1-9][0-9]*)$/.exec(path);
        if (match && Number.isSafeInteger(Number(match[1]))) return json(res, 200, await logs.detail(Number(match[1])));
        throw new UserError('未找到此日志记录', 404);
      }
      if (systemPath) {
        if (!system) throw new UserError(systemError || '当前宿主尚未启用实例管理', 503);
        const managed = /^\/api\/system\/instances\/([a-z][a-z0-9-]{0,47})\/superagent\/(.+)$/.exec(path);
        if (managed) {
          const query = new URL(req.url, `http://${host}`).search;
          const response = await system.management(managed[1], { method: req.method, path: managed[2] + query,
            ...['GET', 'HEAD'].includes(req.method) ? {} : { body: await body(req, 4_004_096) } });
          return json(res, response.status, response.body);
        }
        if (await handleArtifactRequest({ path, req, res, system })) return;
        if (await handleConversationRequest({ path, req, res, system, readBody: body })) return;
        if (path === '/api/system' && req.method === 'GET') {
          const view = new URL(req.url, `http://${host}`).searchParams.get('view');
          return json(res, 200, await system.get(view === 'topology' ? { view } : undefined));
        }
        if (path === '/api/system' && req.method === 'PUT') return json(res, 200, await system.save(await body(req, 400000)));
        const promptPreview = /^\/api\/system\/([a-z][a-z0-9-]{0,47})\/prompts\/preview$/.exec(path);
        if (promptPreview && req.method === 'POST') return json(res, 200, await system.previewPrompts(promptPreview[1], await body(req, 400000)));
        const match = /^\/api\/system\/([a-z][a-z0-9-]{0,47})(?:\/(start|stop|restart))?$/.exec(path);
        if (match && !match[2] && req.method === 'GET') return json(res, 200, await system.detail(match[1]));
        if (match?.[2] && req.method === 'POST') {
          const input = await body(req);
          if (Object.keys(input).some(key => !['revision', 'view'].includes(key)) || !Number.isSafeInteger(input.revision)
            || input.revision < 0 || input.view !== undefined && input.view !== 'topology') throw new UserError('实例操作参数不正确');
          return json(res, 200, await system.action(match[1], match[2], input.revision, { view: input.view }));
        }
        throw new UserError('未找到此实例操作', 404);
      }
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ready: true, app: 'jarvis', runtime: 'dsh', pid: process.pid });
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, { ...await runtime.state(), csrf, ...(tasks ? { tasksAvailable: true } : {}) });
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
        if (file === 'organization.js') {
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(readFileSync(organizationBundle, 'utf8')); return;
        }
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
      const known = error instanceof UserError || error instanceof SystemControlError;
      json(res, known ? error.status : 500, { error: known ? error.message : '服务暂时无法处理请求' });
    }
  };
}
