import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
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
const clientTools = ['read', 'pwsh'];
const reminder = '研发已交付修复版本，但界面验收仍缺客户端组。请在管理部下创建客户端组，配置读取文件和 PowerShell 权限并启动。';
const repairOnly = process.env.JARVIS_EXPORT_STAGE === 'repair';
const configurationOnly = process.env.JARVIS_EXPORT_STAGE === 'configuration';
const driver = process.env.JARVIS_PLAYWRIGHT_MODULE ?? 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core';
const chrome = process.env.JARVIS_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('');
const fileText = message => textOf(message).split('\n').filter(line => /^\d+: /.test(line)).map(line => line.replace(/^\d+: /, '')).join('\n') + '\n';
const ps = value => `'${String(value).replaceAll("'", "''")}'`;
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
  const codeRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const dshPackage = process.env.JARVIS_DSH_PACKAGE ?? join(homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh');
  const dshVersion = JSON.parse(readFileSync(join(dshPackage, 'package.json'), 'utf8')).version;
  t.diagnostic(`Durable isolated acceptance evidence: ${evidence}`);
  const trace = value => appendFileSync(join(evidence, 'trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const f = await nativeFixture(t, { managementOnly: true, realCapabilities: true, searchCapabilities: true, inherited: [], local: [], allowedTools: [], pwshTimeoutMs: 15000 });
  const { SystemControl } = await import(pathToFileURL(join(f.modules, 'jarvis/process-runtime/control.mjs')));
  let system, server, browser, browserPage, logs, states, before, repaired, clientId, observedVerification;
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
    const value = { phase, at: new Date().toISOString(), codeRevision, nodeVersion: process.version, dshPackage, dshVersion,
      mode: 'Installed DSH AgentLoop and native filesystem/PowerShell tools; real Core/Gateway/SQLite/IPC business processes; controlled deterministic model adapter, no external model quality claim.',
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
      const workRef = /任务 (JW-[A-Za-z0-9-]+)；/.exec(text)?.[1];
      if (!step && workRef) return yield* invoke('jarvis_work_query', { operation: 'get', workRef });
      if (text.includes('客户端组')) return yield* reply(reminder);
      if (JSON.stringify(lastResult).includes('"completed"') || /类型 result/.test(text)) return yield* reply('导出修复和界面验收已完成：客户端实际点击导出，下载文件中的 A-017／蓝色样品、B-042／绿色样品均已逐条核对，修复版本和导出文件可从原任务查看。');
      return yield* reply('原任务已接纳，后台正在按原目标推进。');
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
      if (input.kind === 'department_ready') {
        assert.equal(instanceId, 'management');
        const resources = [input.read, input.original_request, input.original_assignment, input.inputs, input.history];
        if (step < resources.length) return yield* invoke('orchestrator_read', { resource: resources[step], offset: 0, limit: 8000 });
        const client = input.execution_targets.find(target => target.organizationName === '客户端组' && target.description.includes('浏览器界面验收'));
        if (step === resources.length) {
          if (!client) return yield* invoke('orchestrator_department_defer', { ticket_id: input.ticket_id, assignment_id: input.assignment_id,
            review_id: input.review_id, ready_attempt_id: input.ready_attempt_id, summary: '研发部的职责不包括客户端界面验收。' });
          assert.ok(clientTools.every(name => client.tools.includes(name)));
          return yield* invoke('orchestrator_department_resume', { ticket_id: input.ticket_id, assignment_id: input.assignment_id,
            review_id: input.review_id, target_instance_id: client.instanceId,
            summary: '客户端组职责和读取文件、PowerShell 权限满足剩余界面验收；让其核验同一修复版本的两条真实导出记录。' });
        }
        return yield* reply(client ? '原工单已自动续派给就绪的客户端组。' : '原工单继续等待具备界面验收职责的客户端组。');
      }
      if (input.kind === 'result_review') {
        const resources = [input.read, input.original_request, input.original_assignment, input.inputs, input.history];
        if (step < resources.length) return yield* invoke('orchestrator_read', { resource: resources[step], offset: 0, limit: 8000 });
        if (instanceId === 'management') {
          if (input.summary.includes('双记录核验通过')) {
            if (step === resources.length) {
              assert.match(JSON.stringify(request.messages), /A-017/); assert.match(JSON.stringify(request.messages), /B-042/);
              return yield* invoke('orchestrator_result_review', { ticket_id: input.ticket_id, assignment_id: input.assignment_id, review_id: input.review_id,
                decision: { kind: 'accept', summary: '已对照集团原目标核验：研发修复版本经客户端真实 Chrome 点击下载；双记录核验通过，A-017／蓝色样品及 B-042／绿色样品内容逐条一致，版本哈希与导出文件证据已登记。' } });
            }
            return yield* reply('管理部已依据实际客户端证据完成原目标验收。');
          }
          if (repairOnly || configurationOnly) { repairSeen.resolve(); return yield* reply('研发已提交修复文件。原目标仍需客户端实际点击下载并核对两条记录；保持本工单未完成。'); }
          assert.ok(tools.includes('orchestrator_department_wait'), 'Missing department must use the normal persistent wait tool');
          if (step === resources.length) return yield* invoke('orchestrator_department_wait', { ticket_id: input.ticket_id, assignment_id: input.assignment_id, review_id: input.review_id,
            summary: '研发已提交修复版本，集团原目标仍缺客户端实际下载和双记录核对，不能完成。', responsibility: '客户端组', required_tools: clientTools,
            instructions: '接手已登记的同一修复版本，先核实交接文件SHA256，实际启动 Chrome 打开该页面，点击导出取得 records.json；逐条核对 A-017／蓝色样品、B-042／绿色样品，并注册导出文件与核验记录。' });
          repairSeen.resolve();
          return yield* reply('修复成果已保留，原工单等待管理部下具备权限的客户端组。');
        }
        if (step === resources.length) {
          assert.ok(input.summary.includes('双记录核验通过'), 'The group cannot accept before the actual client proof is returned');
          return yield* invoke('orchestrator_result_review', { ticket_id: input.ticket_id, assignment_id: input.assignment_id, review_id: input.review_id,
          decision: { kind: 'accept', summary: '管理部已对照最初目标完成验收：同一修复版本由客户端实际点击 Chrome 下载并逐条核对两条记录，双记录核验通过，原交办全部完成。' } });
        }
        return yield* reply('集团已核验管理部的原目标交付。');
      }
      if (input.kind !== 'candidate' || routed.has(input.trigger_id)) return yield* reply('原工单状态保持。');
      const target = instanceId === 'root' ? 'management' : instanceId === 'management' ? 'development' : undefined;
      if (instanceId !== clientId) assert.deepEqual(input.execution_targets.map(target => target.instanceId), target ? [target] : []);
      routed.add(input.trigger_id);
      return yield* invoke('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: input.trigger_id,
        title: `${instanceId}：${goal}`, worktree_name: 'export-two-records', acknowledgement: '已接纳原始导出修复与双记录验证目标。',
        ...(target ? { target_instance_id: target } : {}) }] });
    }
    if (instanceId === clientId) {
      const handoff = input.execution?.handoff?.[0];
      assert.ok(handoff?.path && handoff.version?.sha256, 'The actual launch card must contain a program-verified local version handoff');
      assert.equal(handoff.instanceId, 'development'); assert.ok(handoff.assignmentId);
      assert.ok(!/^[A-Za-z]:|^[/\\]/.test(handoff.path), 'Client reads its own relative handoff path');
      assert.ok(tools.includes('read') && tools.includes('pwsh')); assert.equal(tools.includes('write'), false); assert.equal(tools.includes('edit'), false);
      if (!step) return yield* invoke('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 });
      if (step === 1) return yield* invoke('read', { file_path: handoff.path });
      if (step === 2) {
        assert.match(fileText(lastResult), /const records = rows.map/);
        const command = '& ' + [process.execPath, resolve('tests/fixtures/export-page/verify.mjs'), handoff.path,
          handoff.version.sha256, '.', driver, chrome].map(ps).join(' ');
        return yield* invoke('pwsh', { description: '实际点击 Chrome 导出并逐条核对两条记录', command });
      }
      if (step === 3) return yield* invoke('read', { file_path: 'verification.json' });
      if (step === 4) {
        observedVerification = JSON.parse(fileText(lastResult));
        assert.equal(observedVerification.version, handoff.version.sha256);
        assert.deepEqual(observedVerification.downloaded, [{ id: 'A-017', name: '蓝色样品' }, { id: 'B-042', name: '绿色样品' }]);
        return yield* invoke('read', { file_path: 'records.json' });
      }
      if (step === 5) {
        assert.deepEqual(JSON.parse(fileText(lastResult)), observedVerification.downloaded);
        return yield* invoke('orchestrator_report', { state: 'ready', summary: `双记录核验通过。真实 Chrome ${observedVerification.browser} 已打开交接版本 ${handoff.version.sha256}，实际点击导出并下载 records.json；A-017／蓝色样品、B-042／绿色样品逐条一致。导出SHA256 ${observedVerification.sha256}。`,
          artifacts: [{ path: 'records.json', title: '实际浏览器导出双记录' }, { path: 'verification.json', title: '同版双记录核验结果' }, { path: 'verification.png', title: '实际核验页面截图' }] });
      }
      return yield* reply('客户端已把真实双记录下载与核验结果回报管理部。');
    }
    assert.equal(instanceId, 'development', 'Only the development leaf runs the repair Worker');
    assert.ok(tools.includes('read') && tools.includes('edit') && tools.includes('pwsh'));
    if (!step) { leafEntered.resolve(); await holdLeaf.promise; return yield* invoke('orchestrator_read', { resource: input.trigger.delegation.original_source.read, offset: 0 }); }
    if (step === 1) return yield* invoke('read', { file_path: 'index.html' });
    if (step === 2) {
      assert.match(JSON.stringify(request.messages), /rows.slice\(0, 1\)/, 'the Worker reads the faulty implementation through the actual native tool');
      const original = fileText(lastResult);
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
    browserPage = page; page.setDefaultTimeout(8000);
    page.on('pageerror', error => trace({ event: 'browser-error', error: error.stack }));
    page.on('response', async response => { if (response.status() >= 400) trace({ event: 'http-error', url: response.url(), status: response.status(), body: await response.text().catch(String) }); });
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
    await page.screenshot({ path: join(evidence, 'original-conversation.png'), fullPage: true, animations: 'disabled' });
    await save('repair-stage-complete', { repairHash, repairedFile, taskDetail, logRecords });
    assert.notEqual(taskDetail.item.status, 'completed');
    assert.equal(daily.store.turns().filter(turn => turn.user === goal).length, 1);
    if (repairOnly) return;
    if (!configurationOnly) {
    assert.equal(middle.delegations.outgoing[0].snapshot.artifacts[0].version.sha256, repairHash, 'The trusted business registration binds the observed repaired bytes');
    await until(() => daily.state(), state => state.turns.some(turn => turn.source === 'gateway' && turn.assistant === reminder), 'The original group conversation must receive the missing client reminder');
    const waiting = await manager.state('management');
    assert.equal(waiting.departmentWaits.length, 1, 'The state projection lists only active original department waits');
    assert.equal(waiting.tickets[0].id, middle.tickets[0].id);
    assert.equal(waiting.tickets[0].ended, undefined);
    await daily.gateway.poll(); await daily.gateway.poll();
    assert.equal(daily.store.turns().filter(turn => turn.source === 'gateway' && turn.assistant === reminder).length, 1, 'Repeated normal feedback reconciliation cannot remind twice');
    await save('waiting-for-client-department', { repairHash, taskDetail: tasks.detail(workRef, new URLSearchParams({ conversationId: binding.conversationId })) });
    }
    // The only additional user actions are ordinary organization configuration:
    // create a direct child of management, set tools, and start that child.
    const userRequests = [];
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) userRequests.push({ method: request.method(), url: request.url(), body: request.postData() }); });
    await page.goto(`${origin}/jarvis/#settings/organization`);
    await page.locator('[data-action="enter-instance"][data-id="management"]').click();
    await page.locator('[data-action="add-instance"]').click();
    await page.locator('#field-name').fill('客户端组');
    await page.locator('#field-description').fill('负责浏览器界面验收，实际点击导出，取得下载文件并逐条核对已知数据。');
    await page.locator('#field-capabilities').fill('客户端、Chrome、导出按钮、下载、双记录核验');
    const [response] = await Promise.all([page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/system')),
      page.getByRole('button', { name: '保存并添加', exact: true }).click()]);
    const created = await response.json();
    assert.equal(response.status(), 200, `Normal organization creation failed: ${JSON.stringify(created)}`);
    const client = created.nodes.find(node => node.name === '客户端组');
    assert.ok(client); clientId = client.id; assert.equal(client.parent, 'management');
    assert.equal(created.runtime.instances.find(item => item.instanceId === clientId).phase, 'stopped');
    await page.goto(`${origin}/jarvis/#settings/organization/${clientId}/engine/execution`);
    const capabilities = page.locator('.dt-worker-capabilities');
    await capabilities.waitFor();
    const options = capabilities.locator('.dt-capability-option').filter({ has: page.locator('input[type="checkbox"]') });
    for (const option of await options.all()) {
      const name = await option.locator('small').first().innerText();
      await option.locator('input[type="checkbox"]').setChecked(clientTools.includes(name));
    }
    const [permissionsResponse] = await Promise.all([page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/worker-capabilities')),
      capabilities.getByRole('button', { name: '保存', exact: true }).click()]);
    const permissions = await permissionsResponse.json();
    assert.deepEqual(new Set(permissions.tools), new Set(clientTools));
    assert.equal(permissions.application?.state, 'applied', 'A never-started client must configure normally while unrelated parent work remains');
    await until(async () => await capabilities.locator('.dt-savebar').count() === 0
      && await capabilities.locator('fieldset[disabled]').count() === 0, Boolean, 'The normal settings form must finish its saved-state readback before navigation');
    await page.goto(`${origin}/jarvis/#settings/organization/${clientId}/runtime`);
    await page.getByRole('button', { name: '查看运行状态', exact: true }).click();
    const [startResponse] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/system/${clientId}/start`)),
      page.getByRole('button', { name: '启动实例', exact: true }).click()]);
    assert.equal(startResponse.status(), 200);
    if (configurationOnly) { await save('client-configured-through-normal-ui', { userRequests }); return; }
    await until(() => manager.state('root'), state => state.tickets[0]?.ended?.outcome === 'completed', 'The same original group ticket must finish only after client proof and management acceptance');
    await until(() => daily.state(), state => state.turns.some(turn => turn.source === 'gateway' && turn.assistant.includes('导出修复和界面验收已完成')), 'The group must report completion in the original conversation');
    const completedRoot = await manager.state('root'), completedMiddle = await manager.state('management'), completedClient = await manager.state(clientId);
    assert.equal(completedRoot.tickets.length, 1); assert.equal(completedMiddle.tickets.length, 1); assert.equal(completedClient.tickets.length, 1);
    assert.equal(completedRoot.tickets[0].id, root.tickets[0].id); assert.equal(completedMiddle.tickets[0].id, middle.tickets[0].id);
    assert.equal(completedMiddle.tickets[0].assignments.length, 2);
    assert.equal(completedClient.tickets[0].mandate.basis.delegation.parentInstanceId, 'management');
    const clientDirectory = completedClient.tickets[0].execution.directory;
    for (const name of ['records.json', 'verification.json', 'verification.png']) cpSync(join(clientDirectory, name), join(evidence, name));
    const verification = JSON.parse(readFileSync(join(clientDirectory, 'verification.json'), 'utf8'));
    assert.equal(verification.version, repairHash);
    assert.deepEqual(verification.displayed, verification.downloaded);
    assert.equal(hash(readFileSync(join(clientDirectory, 'records.json'))), verification.sha256);
    assert.equal(daily.store.sessionBinding().conversationId, binding.conversationId);
    assert.equal(daily.store.turns().filter(turn => turn.user === goal).length, 1);
    assert.equal(daily.store.turns().filter(turn => turn.source === 'gateway' && turn.assistant === reminder).length, 1);
    assert.ok(userRequests.every(request => request.url.includes('/api/system')), 'User configuration cannot resubmit, append to, resume, or copy an execution task');
    const finishedDetail = tasks.detail(workRef, new URLSearchParams({ conversationId: binding.conversationId }));
    assert.equal(finishedDetail.item.status, 'completed');
    assert.ok(finishedDetail.item.delegations.some(link => link.to.instanceId === clientId));
    await logs.refresh();
    await page.goto(`${origin}/jarvis/`);
    await page.getByText('导出修复和界面验收已完成', { exact: false }).first().waitFor();
    await page.screenshot({ path: join(evidence, 'completed-original-conversation.png'), fullPage: true, animations: 'disabled' });
    const originalCard = page.locator(`.chat-task-card[data-work-ref="${workRef}"]`).first();
    await originalCard.locator('summary.chat-task-heading').click();
    await originalCard.locator('[data-task-part="delegations"] > summary').click();
    for (const label of ['集团 → 管理部', '管理部 → 研发部', '管理部 → 客户端组']) await originalCard.getByText(label, { exact: true }).waitFor();
    await originalCard.locator('[data-task-part="execution"] > summary').click();
    await originalCard.getByText(`worker-${completedClient.tickets[0].id}`, { exact: true }).waitFor();
    const renderedCard = await originalCard.innerText();
    assert.ok(renderedCard.includes('双记录核验通过') && renderedCard.includes('实际浏览器导出双记录'));
    assert.match(await originalCard.locator('.chat-task-result-source').innerText(), /结果已验收/);
    assert.ok(renderedCard.includes(finishedDetail.item.acceptance.summary));
    writeFileSync(join(evidence, 'rendered-original-task-card.txt'), renderedCard);
    await originalCard.screenshot({ path: join(evidence, 'original-task-card-details.png'), animations: 'disabled' });
    await originalCard.getByRole('link', { name: '查看任务日志', exact: true }).click();
    await page.locator('#logs-list .logs-event').first().waitFor();
    await page.locator('#logs-query').fill('双记录核验通过');
    await page.locator('#logs-filters').getByRole('button', { name: '搜索', exact: true }).click();
    await page.locator('#logs-list .logs-event').filter({ hasText: '客户端组' }).filter({ hasText: 'orchestrator_report' }).first().click();
    await page.locator('#logs-detail-meta').waitFor({ state: 'visible' });
    await page.locator('#logs-detail-raw > summary').click();
    await page.locator('#logs-detail-data').getByText('双记录核验通过', { exact: false }).waitFor();
    writeFileSync(join(evidence, 'rendered-task-logs.txt'), await page.locator('#operation-logs-page').innerText());
    await page.screenshot({ path: join(evidence, 'original-task-logs.png'), fullPage: true, animations: 'disabled' });
    await save('complete', { repairHash, verification, taskDetail: finishedDetail, logRecords: await logs.list(new URLSearchParams({ limit: '100' })),
      relatedResultLogs: await logs.list(new URLSearchParams({ limit: '100', trace: finishedDetail.item.logs.traceId, q: '双记录核验通过' })), userRequests });
    for (const error of f.errors) assert.equal(error.message, 'Ticket ended; new work needs a new authorized ticket', 'Only the original native post-completion guard is expected');
  } catch (error) {
    trace({ event: 'failure', error: error.stack });
    if (browserPage) {
      await browserPage.screenshot({ path: join(evidence, 'failure-page.png'), fullPage: true }).catch(() => {});
      writeFileSync(join(evidence, 'failure-page.html'), await browserPage.content().catch(String));
    }
    await save('failed', { error: error.stack, before, repaired }).catch(snapshotError => trace({ event: 'snapshot-failed', error: snapshotError.stack }));
    throw error;
  } finally {
    holdLeaf.resolve();
    await browser?.close();
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await system.close(); await logs?.close(); await daily.close();
  }
});
