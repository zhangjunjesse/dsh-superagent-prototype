import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { JarvisRuntime } from '../dsh/runtime.mjs';
import { createJarvisHandler } from '../dsh/index.mjs';
import { TaskVisibility } from '../dsh/task-visibility.mjs';
import { OperationLogs } from '../operation-logs/index.mjs';
import { workerCatalog } from './worker-catalog.mjs';
import { available, nativeFixture } from './native-host-fixture.mjs';

const goal = '修复导出按钮，并验证页面上的两条记录都能导出。';
const chatWhileWaiting = '你好，今天工作怎么样？';
const required = ['read', 'write', 'edit', 'pwsh'];
const driver = process.env.JARVIS_PLAYWRIGHT_MODULE ?? 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core';
const chrome = process.env.JARVIS_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('');
function* reply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
function* invoke(name, args) {
  const id = `export-acceptance-${crypto.randomUUID()}`, raw = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

// The controlled model chooses normal tools. It never directly calls a manager
// command, writes a repaired file, copies a result, or manufactures a report.
test('export acceptance uses the original group conversation and installed DSH through two real departments',
  { skip: !available, timeout: 55000 }, async t => {
  const evidence = mkdtempSync(resolve('..', 'ticket-13-native-'));
  t.diagnostic(`Durable isolated acceptance evidence: ${evidence}`);
  const trace = value => appendFileSync(join(evidence, 'trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const f = await nativeFixture(t, { managementOnly: true, realCapabilities: true, inherited: [], local: [], allowedTools: [] });
  const { SystemControl } = await import(pathToFileURL(join(f.modules, 'jarvis/process-runtime/control.mjs')));
  let system, server, browser, logs, states, before, repaired;
  const repairSeen = Promise.withResolvers(), holdLeaf = Promise.withResolvers(), leafEntered = Promise.withResolvers();
  const daily = new JarvisRuntime(f.ctx, { lifecycleManaged: true, dataFile: join(f.directory, 'daily.sqlite'), workspace: f.config.workspace,
    preset: 'fixture', timeZone: 'Asia/Shanghai' }, { readOrganizationDirectory: () => system.organizationDirectory() });
  const model = f.config.model, rootDir = join(f.directory, 'organizations');
  system = new SystemControl(f.ctx, { rootDir, defaultModel: model,
    validateModel: async value => value.provider === model.provider && value.model === model.model,
    capabilityCatalog: workspace => workerCatalog(f.ctx, workspace, f.config.workspace, 'fixture'),
    managerOptions: { lifecycleParticipants: { root: daily } } });
  const manager = system.manager;
  daily.gateway.connectOrganization(manager, join(f.directory, 'organization-gateway.sqlite'));
  const tasks = new TaskVisibility({ runtime: daily, system });
  const started = [], stages = new Map(), routed = new Set();
  const save = async (phase, extra = {}) => {
    await f.ctx.sessionPersistence.flush();
    states = await Promise.all([...manager.instances.keys()].map(id => manager.state(id).catch(error => ({ instanceId: id, error: error.message }))));
    const value = { phase, at: new Date().toISOString(), mode: 'Installed DSH AgentLoop and native filesystem/PowerShell tools; real Core/Gateway/SQLite/IPC business processes; controlled deterministic model adapter, no external model quality claim.',
      started, states, daily: await daily.state(), errors: f.errors.map(error => error.stack), ...extra };
    writeFileSync(join(evidence, `${phase}.json`), JSON.stringify(value, null, 2));
    cpSync(join(f.directory, 'sessions'), join(evidence, 'sessions'), { recursive: true });
    writeFileSync(join(evidence, 'progress.json'), JSON.stringify({ phase, at: value.at }));
    trace({ event: 'checkpoint', phase });
    return value;
  };
  const until = async (read, predicate, message) => {
    const end = Date.now() + 13000;
    while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(25); }
    assert.fail(message);
  };
  f.setResponder(async function* (request) {
    const tools = (request.tools ?? []).map(tool => tool.name), sessionId = request.sessionId;
    const item = [...manager.instances.values()].find(owner => owner.native?.bindings.has(sessionId)
      || [...owner.bridge?.sessions.values() ?? []].some(binding => binding.agent?.id === sessionId || binding.sessionId === sessionId));
    const instanceId = sessionId === daily.sessionId() ? 'daily-group' : item?.config.instanceId;
    assert.ok(instanceId, `Every native request belongs to its actual organization: ${sessionId}`);
    const last = [...request.messages].reverse().find(message => {
      if (message.role !== 'user') return false;
      const text = textOf(message);
      if (text === goal || text === chatWhileWaiting || text.includes('以下是后台已交办任务的反馈资料')) return true;
      try { const value = JSON.parse(text); return value.kind || value.ticket_id || value.parent_scope; } catch { return false; }
    });
    const text = textOf(last), stepKey = `${sessionId}:${text}`, step = stages.get(stepKey) ?? 0;
    const lastResult = [...request.messages].reverse().find(message => message.role === 'tool');
    assert.notEqual(lastResult?.isError, true, `Actual tool failed: ${textOf(lastResult)}`);
    assert.doesNotMatch(textOf(lastResult), /\[exit code: [1-9]/, 'A failed real command cannot become a successful model report');
    trace({ event: 'model', instanceId, sessionId, tools, step, text });
    stages.set(stepKey, step + 1);
    if (instanceId === 'daily-group') {
      if (text === chatWhileWaiting) return yield* reply('你好！原任务仍在后台跟进，你可以继续和我聊天。');
      if (text === goal) {
        if (!step) return yield* invoke('jarvis_work_submit', { operation: 'new', request: { quote: goal, summary: goal } });
        return yield* reply('已按原目标交办：修复导出，并逐条验证页面上的两条记录。');
      }
      // Background expression only reports the actual supplied durable event.
      return yield* reply(text);
    }
    let input;
    try { input = JSON.parse(text); } catch { return yield* reply('已保留原通知。'); }
    if (tools.includes('delegation_prepare')) {
      if (!step) return yield* invoke('delegation_context_read', { section: 'source', offset: 0 });
      const ancestors = input.ancestor_constraints ?? [];
      if (step <= ancestors.length) return yield* invoke('delegation_context_read', { section: 'ancestor_assignment', ancestorIndex: step - 1, offset: 0 });
      if (step === ancestors.length + 1) {
        assert.ok(JSON.stringify(request.messages).includes(goal));
        return yield* invoke('delegation_prepare', { summary: goal });
      }
      return yield* reply('已阅读并准备原始集团目标及逐级授权。');
    }
    if (tools.includes('orchestrator_route')) {
      if (input.kind === 'result_review') {
        const resources = [input.read, input.original_request, input.original_assignment, input.inputs, input.history];
        if (step < resources.length) return yield* invoke('orchestrator_read', { resource: resources[step], offset: 0, limit: 8000 });
        if (instanceId === 'management') {
          repairSeen.resolve();
          return yield* reply('研发已提交修复文件。原目标仍需客户端实际点击下载并核对两条记录；保持本工单未完成。');
        }
        return yield* reply('管理部尚未完成两条记录的界面核验，原工单保持未完成。');
      }
      if (input.kind !== 'candidate' || routed.has(input.trigger_id)) return yield* reply('原工单状态保持。');
      const target = instanceId === 'root' ? 'management' : instanceId === 'management' ? 'development' : undefined;
      assert.deepEqual(input.execution_targets.map(target => target.instanceId), target ? [target] : []);
      routed.add(input.trigger_id);
      return yield* invoke('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: input.trigger_id,
        title: `${instanceId}：${goal}`, worktree_name: 'export-two-records', acknowledgement: '已接纳原始导出修复与双记录验证目标。',
        ...(target ? { target_instance_id: target } : {}) }] });
    }
    assert.equal(instanceId, 'development', 'Only the development leaf runs the repair Worker');
    assert.ok(tools.includes('read') && tools.includes('edit') && tools.includes('pwsh'));
    if (!step) { leafEntered.resolve(); await holdLeaf.promise; return yield* invoke('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 }); }
    if (step === 1) return yield* invoke('read', { file_path: 'index.html' });
    if (step === 2) {
      assert.match(JSON.stringify(request.messages), /rows.slice\(0, 1\)/, 'the Worker reads the faulty implementation through the actual native tool');
      const original = textOf(lastResult).split('\n').filter(line => /^\d+: /.test(line)).map(line => line.replace(/^\d+: /, '')).join('\n') + '\n';
      assert.match(original, /rows.slice\(0, 1\)/);
      return yield* invoke('write', { file_path: 'index.html', content: original });
    }
    if (step === 3) {
      return yield* invoke('edit', { file_path: 'index.html', old_string: 'rows.slice(0, 1).map', new_string: 'rows.map' });
    }
    if (step === 4) return yield* invoke('read', { file_path: 'index.html' });
    if (step === 5) return yield* invoke('pwsh', { description: '核实修复页面的版本', command: "(Get-FileHash -LiteralPath 'index.html' -Algorithm SHA256).Hash.ToLowerInvariant()" });
    if (step === 6) return yield* invoke('orchestrator_report', { state: 'ready', summary: '已修复只导出首条的切片错误。index.html 已通过真实编辑工具修改并读取复核、PowerShell 核实SHA256；尚需客户端实际点击导出并逐条核对两条记录。',
      artifacts: [{ path: 'index.html', title: '双记录导出修复页面' }] });
    return yield* reply('修复版本已按原工单回报管理部，界面验收仍待完成。');
  });
  try {
    await daily.ready();
    const initial = await system.get({ view: 'topology' });
    const configured = await system.save({ revision: initial.revision, nodes: [
      { ...initial.nodes[0], name: '集团', description: '统筹原目标并统一回报。', workerTools: required, concurrency: 1 },
      { id: 'management', parent: 'root', kind: 'instance', name: '管理部', description: '安排研发修复，再安排客户端验证；对照原始目标验收。', workerTools: required, concurrency: 1, model },
      { id: 'development', parent: 'management', kind: 'instance', name: '研发部', description: '使用真实文件工具修复导出错误，注册修复版本；不替客户端完成界面验收。', workerTools: required, concurrency: 1, model },
    ] });
    // Fixture setup creates the deliberately faulty source. All repairs and
    // subsequent produced files must come from the actual authorized Worker.
    const development = configured.nodes.find(node => node.id === 'development');
    cpSync(new URL('../../tests/fixtures/export-page/index.html', import.meta.url), join(development.workspace, 'index.html'));
    for (const id of ['root', 'management', 'development']) {
      await system.action(id, 'start', configured.revision, { view: 'topology' });
      started.push(structuredClone(manager.status().instances.find(item => item.instanceId === id)));
    }
    assert.equal(new Set(started.map(item => item.pid)).size, 3);
    assert.ok(started.every(item => item.pid !== process.pid && item.phase === 'running'));
    assert.equal(daily.instanceState().canChat, true);
    const http = { webServer: { port: 0 }, connection: { requestRejection: () => undefined } };
    logs = new OperationLogs(f.ctx, { dataFile: join(f.directory, 'operation-logs.sqlite'), runtime: daily, system }); await logs.start();
    server = createServer(createJarvisHandler(http, daily, { csrf: 'isolated-ticket-13', system, tasks, logs }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); http.webServer.port = server.address().port;
    const origin = `http://127.0.0.1:${http.webServer.port}`, { chromium } = createRequire(import.meta.url)(driver);
    browser = await chromium.launch({ executablePath: chrome });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.on('pageerror', error => trace({ event: 'browser-error', error: error.stack }));
    await page.goto(`${origin}/jarvis/`);
    await page.locator('#input').fill(goal);
    await page.locator('#send-message').click();
    await Promise.race([leafEntered.promise, delay(13000).then(() => assert.fail('The actual native development Worker did not start'))]);
    before = await save('original-conversation-two-real-hops');
    assert.equal(before.daily.turns.filter(turn => turn.user === goal).length, 1);
    assert.equal(before.states.find(state => state.instanceId === 'root')?.tickets?.length ?? before.states[0].tickets.length, 1);
    await page.locator('#input').fill(chatWhileWaiting);
    await page.locator('#send-message').click();
    await until(() => daily.state(), state => state.turns.some(turn => turn.user === chatWhileWaiting && turn.status === 'complete'), 'Daily conversation must complete while the repair is held');
    holdLeaf.resolve();
    await Promise.race([repairSeen.promise, delay(13000).then(() => assert.fail('The actual repair result did not reach management'))]);
    repaired = await manager.state('development');
    assert.equal(repaired.tickets.length, 1);
    const repairedFile = join(repaired.tickets[0].execution.directory, 'index.html'), bytes = readFileSync(repairedFile);
    assert.match(bytes.toString('utf8'), /const records = rows.map/);
    const repairHash = hash(bytes);
    // Preserve the observed output as evidence only. Department transport must
    // use the production handoff; this archive is never an execution input.
    writeFileSync(join(evidence, 'observed-repaired-page.html'), bytes);
    assert.equal(repaired.tickets[0].ended?.outcome, 'completed');
    const middle = await manager.state('management'), root = await manager.state('root');
    assert.equal(root.tickets[0].ended, undefined);
    assert.equal(middle.tickets[0].ended, undefined);
    assert.deepEqual(middle.delegations.outgoing[0].request.path, ['root', 'management']);
    assert.equal(middle.delegations.outgoing[0].snapshot.artifacts[0].instanceId, 'development');
    const binding = daily.store.sessionBinding();
    const workRef = (await daily.gateway.service().query({ operation: 'search', query: '', cursor: 0, limit: 20 })).items[0].workRef;
    const taskDetail = tasks.detail(workRef, new URLSearchParams({ conversationId: binding.conversationId }));
    await logs.refresh();
    const logRecords = await logs.list(new URLSearchParams({ limit: '100' }));
    await page.screenshot({ path: join(evidence, 'original-conversation.png'), fullPage: true });
    await save('repair-stage-complete', { repairHash, repairedFile, taskDetail, logRecords });
    assert.notEqual(taskDetail.item.status, 'completed');
    assert.equal(daily.store.turns().filter(turn => turn.user === goal).length, 1);
    for (const error of f.errors) assert.equal(error.message, 'Ticket ended; new work needs a new authorized ticket', 'Only the original native post-completion guard is expected');
  } catch (error) {
    trace({ event: 'failure', error: error.stack });
    await save('failed', { error: error.stack, before, repaired }).catch(snapshotError => trace({ event: 'snapshot-failed', error: snapshotError.stack }));
    throw error;
  } finally {
    holdLeaf.resolve();
    await browser?.close();
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await system.close(); await logs?.close(); await daily.close();
  }
});
