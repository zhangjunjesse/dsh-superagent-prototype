import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ProcessManager } from './manager.mjs';

export const name = 'superjarvis-process-runtime-fixture';
export const inject = ['agents', 'agentPresets', 'sessionController', 'sessionPersistence', 'llm', 'systemPrompt', 'tools', 'webServer'];
const prefix = '/__process_runtime_fixture';
const providerId = 'process-runtime-fixture';
const textOf = value => typeof value === 'string' ? value : (value || []).map(block => block.text || '').join('');
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const inside = (root, path) => { const value = relative(root, path); return value && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`); };
function checkedRoot(value) {
  const root = resolve(value || '');
  if (!/[\\/]\.artifacts[\\/]process-runtime[\\/]fixture$/.test(root)) throw new Error('Only the independent process runtime fixture directory is allowed');
  return root;
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) throw new Error('Fixture request exceeds limit'); }
  return JSON.parse(raw || '{}');
}

/** Controlled model responses; Session, tools, IPC, Gateway and Engine remain production implementations. */
function createProvider(config, trace) {
  const requests = [], holds = new Map(), holdRecords = [];
  const upstream = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 200, { object: 'list', data: [{ id: providerId }] });
      const input = await body(req), tools = (input.tools || []).map(tool => tool.function?.name);
      const system = input.messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n');
      const role = system.match(/ROLE:\s*(jarvis|router|worker)/)?.[1] ||
        (tools.includes('jarvis_work_submit') ? 'jarvis' : tools.includes('orchestrator_decide') ? 'router' : tools.includes('orchestrator_report') ? 'worker' : 'other');
      const user = [...input.messages].reverse().find(message => message.role === 'user' && textOf(message.content).includes('fixture:'));
      const userText = textOf(user?.content), match = userText.match(/fixture:(run|hold|deny-write|cross-read|junction-grep|terminal-read|smalltalk):([ab]):([a-z0-9-]+)/);
      const scenario = match?.[0] || '', mode = match?.[1] || '', instanceId = match?.[2];
      const last = input.messages.at(-1), toolText = last?.role === 'tool' ? textOf(last.content) : '';
      const lastToolName = last?.role === 'tool' ? [...input.messages].reverse().flatMap(message => message.tool_calls || []).find(call => call.id === last.tool_call_id)?.function?.name : undefined;
      const record = { at: new Date().toISOString(), role, scenario, tools, lastRole: last?.role, lastToolName, toolText };
      requests.push(record); trace('provider-requests.jsonl', record);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => { if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify({ id: 'process-fixture', object: 'chat.completion.chunk', created: 1,
        model: providerId, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'); };
      const finish = text => { chunk({ content: text }); chunk({}, 'stop'); if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n'); };
      const tool = (toolName, args) => {
        chunk({ tool_calls: [{ index: 0, id: 'process_call_' + randomUUID(), type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }, 'tool_calls');
        if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
      };
      if (role === 'jarvis') {
        if (toolText) return finish('FIXTURE-QUEUED:' + scenario + '\n' + toolText);
        if (mode === 'smalltalk') return finish('FIXTURE-CHAT:' + scenario);
        if (scenario) return tool('jarvis_work_submit', { operation: 'new', request: { quote: scenario, summary: 'Read the isolated workspace marker: ' + scenario } });
        return finish('FIXTURE-JARVIS-OK');
      }
      if (role === 'router') {
        if (toolText) return finish('FIXTURE-ROUTED:' + scenario + '\n' + toolText);
        return tool('orchestrator_decide', { decision: 'accept', title: 'Controlled read ' + scenario, reason: 'Explicit isolated fixture request' });
      }
      if (role === 'worker') {
        const workspace = config.instances.find(instance => instance.instanceId === instanceId)?.workspace;
        if (!workspace) throw new Error('Worker fixture scenario lacks its instance identity');
        const reported = input.messages.some(message => (message.tool_calls || []).some(call => call.function?.name === 'orchestrator_report'));
        if (lastToolName === 'orchestrator_report') {
          if (mode === 'terminal-read') return tool('read', { file_path: join(workspace, 'marker.txt') });
          return finish('FIXTURE-WORKER-REPORTED:' + scenario);
        }
        if (reported) return finish('FIXTURE-TERMINAL-DENIAL:' + scenario + '\n' + toolText);
        if (toolText) return tool('orchestrator_report', { state: 'ready', summary: 'FIXTURE-WORKER-RESULT:' + scenario + '\n' + toolText });
        const execute = () => {
          if (mode === 'deny-write') return tool('write', { file_path: join(workspace, 'must-not-exist.txt'), content: 'UNAUTHORIZED FIXTURE WRITE' });
          if (mode === 'junction-grep') return tool('grep', { pattern: `INSTANCE-(A|B)-READ-${config.runId}`, path: workspace });
          const readWorkspace = mode === 'cross-read' ? config.instances.find(instance => instance.instanceId !== instanceId).workspace : workspace;
          return tool('read', { file_path: join(readWorkspace, 'marker.txt') });
        };
        if (mode !== 'hold') return execute();
        const hold = { scenario, instanceId, status: 'holding', at: new Date().toISOString() };
        holdRecords.push(hold); trace('provider-holds.jsonl', hold);
        chunk({ content: 'FIXTURE-WORKER-WAITING:' + scenario });
        const complete = status => { if (hold.status !== 'holding') return; hold.status = status; clearTimeout(timer); holds.delete(scenario); trace('provider-holds.jsonl', hold); execute(); };
        const timer = setTimeout(() => complete('guard-timeout'), 20000);
        holds.set(scenario, () => complete('released'));
        res.on('close', () => { clearTimeout(timer); holds.delete(scenario); if (hold.status === 'holding') { hold.status = 'cancelled'; trace('provider-holds.jsonl', hold); } });
        return;
      }
      finish('FIXTURE-AUXILIARY-OK');
    } catch (error) { trace('provider-errors.jsonl', { error: error.message }); if (!res.headersSent) json(res, 500, { error: error.message }); else res.end(); }
  });
  return { upstream, requests, holdRecords, release(scenario) { const release = holds.get(scenario); if (!release) throw new Error('No held provider request'); release(); } };
}

export async function apply(ctx, config) {
  const root = checkedRoot(config.fixtureDir), run = resolve(config.runDir);
  if (!inside(join(root, 'runs'), run) || process.env.DSH_HOME !== join(run, 'home') || ctx.webServer.host !== '127.0.0.1' || ctx.webServer.port !== config.port) {
    throw new Error('This fixture requires its new isolated loopback DSH profile');
  }
  const trace = (file, value) => appendFileSync(join(run, file), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const provider = createProvider(config, trace);
  await new Promise((accept, reject) => { provider.upstream.once('error', reject); provider.upstream.listen(config.providerPort, '127.0.0.1', accept); });
  const manager = new ProcessManager(ctx, { rootDir: join(run, 'runtime'), instances: config.instances });
  let ready = false;
  ctx.effect(() => async () => { ready = false; await manager.close(); provider.upstream.closeAllConnections(); provider.upstream.close(); });
  const sessions = () => [...manager.instances.values()].flatMap(item => [...(item.bridge?.sessions || new Map())].map(([sessionKey, entry]) => ({
    instanceId: item.config.instanceId, sessionKey, role: entry.role, sessionId: entry.agent?.id || entry.handle?.agent?.id || entry.id,
  })));
  ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${config.port}` || req.headers.origin || req.headers['x-process-runtime-fixture'] !== 'controlled-test') throw new Error('Fixture request rejected');
      const url = new URL(req.url, 'http://fixture.invalid'), path = url.pathname.slice(prefix.length), input = req.method === 'POST' ? await body(req) : {};
      if (req.method === 'GET' && path === '/health') return json(res, 200, { app: name, ready, hostPid: process.pid, runId: config.runId });
      if (req.method === 'GET' && path === '/status') return json(res, 200, { ...manager.status(), sessions: sessions() });
      if (req.method === 'GET' && path === '/state') return json(res, 200, await manager.state(url.searchParams.get('instanceId')));
      if (req.method === 'GET' && path === '/provider') return json(res, 200, { requests: provider.requests, holds: provider.holdRecords });
      if (req.method === 'POST' && path === '/chat') return json(res, 200, await manager.chat(input.instanceId, input.input));
      if (req.method === 'POST' && path === '/restart') return json(res, 200, await manager.restart(input.instanceId));
      if (req.method === 'POST' && path === '/release') { provider.release(input.scenario); return json(res, 200, { released: input.scenario }); }
      if (req.method === 'POST' && path === '/probe') return json(res, 200, await isolationProbe(manager, input, trace));
      if (req.method === 'POST' && path === '/shutdown') {
        ready = false; await manager.close(); trace('fixture-lifecycle.jsonl', { event: 'shutdown', hostPid: process.pid, status: manager.status() });
        json(res, 200, { closed: true, status: manager.status() }); setTimeout(() => process.exit(0), 250); return;
      }
      return json(res, 404, { error: 'Unknown fixture route' });
    } catch (error) { trace('fixture-errors.jsonl', { error: error.message }); json(res, 400, { error: error.message }); }
  } });
  for (const instance of config.instances) await manager.start(instance.instanceId);
  ready = true;
  const runtime = { app: name, runId: config.runId, runDir: run, home: process.env.DSH_HOME, hostPid: process.pid, port: config.port, providerPort: config.providerPort,
    dshVersion: JSON.parse(readFileSync(join(config.dshPackage, 'package.json'), 'utf8')).version, node: process.versions.node, productionFiles: config.productionFiles,
    limits: ['Controlled local model responses', 'Shared OS account; process separation is not an operating-system sandbox', 'No live deployment, recursive delegation or external repository delivery'], status: manager.status() };
  writeFileSync(join(root, 'runtime.json'), JSON.stringify(runtime, null, 2)); writeFileSync(join(run, 'runtime.json'), JSON.stringify(runtime, null, 2));
  trace('fixture-lifecycle.jsonl', { event: 'ready', ...manager.status() });
}

async function isolationProbe(manager, input, trace) {
  // This test-only seam never accepts arbitrary tool names or production Session IDs.
  const a = manager.instances.get('a'), b = manager.instances.get('b');
  if (!a?.bridge || !b?.bridge) throw new Error('Both fixture instances must run');
  const capture = async action => { try { await action(); return { refused: false }; } catch (error) { return { refused: true, error: error.message }; } };
  let result;
  const request = { sessionKey: 'fixture-role-probe', role: 'jarvis', requestId: randomUUID(), text: 'fixture', systemPrompt: 'fixture' };
  if (input.kind === 'foreign-chat-identity') result = await capture(() => manager.chat('a', { id: randomUUID(), text: 'fixture:smalltalk:a:identity-probe', instanceId: 'b' }));
  else if (input.kind === 'foreign-session-identity') {
    const foreign = [...b.bridge.sessions.values()][0]; if (!foreign) throw new Error('A B Session must exist for the probe');
    result = await capture(() => a.bridge.run({ ...request, sessionId: foreign.sessionId || foreign.agent.id }));
  } else if (input.kind === 'foreign-request-identity') result = await capture(() => a.bridge.run({ ...request, instanceId: 'b' }));
  else if (input.kind === 'foreign-active-tool') {
    const active = (await manager.state('b')).active.find(item => item.role === 'worker');
    if (!active) throw new Error('A real B Worker request must be active for the probe');
    result = await capture(() => a.peer.call('tool', { ...active, name: 'orchestrator_report', args: { state: 'ready', summary: 'UNAUTHORIZED-CROSS-INSTANCE-REPORT' } }, 5000));
  } else if (input.kind === 'immutable-session-role') {
    const entry = Object.values(a.bridge.state.sessions).find(item => item.role === 'jarvis');
    if (!entry) throw new Error('An A Jarvis Session must exist for the probe');
    result = await capture(() => a.bridge.run({ ...request, sessionKey: entry.sessionKey, role: 'worker' }));
  } else if (input.kind === 'reused-request-content') {
    const entry = Object.values(a.bridge.state.requests).find(item => item.role === 'jarvis');
    if (!entry) throw new Error('An A Jarvis request must exist for the probe');
    result = await capture(() => a.bridge.run({ ...request, sessionKey: entry.sessionKey, requestId: entry.requestId, text: 'Changed request content must be refused' }));
  } else if (input.kind === 'invalid-session-role') result = await capture(() => a.bridge.run({ ...request, role: 'administrator' }));
  else throw new Error('Unknown controlled isolation probe');
  trace('isolation-probes.jsonl', { kind: input.kind, ...result }); return result;
}

function redactStartupUrls(stream) {
  const write = stream.write.bind(stream); let pending = '';
  stream.write = (chunk, encoding, callback) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : undefined) : chunk;
    const newline = pending.lastIndexOf('\n');
    if (newline >= 0) { write(pending.slice(0, newline + 1).replace(/https?:\/\/[^\s]*[?&]token=[^\s]+/g, '[authenticated startup URL redacted]')); pending = pending.slice(newline + 1); }
    (typeof encoding === 'function' ? encoding : callback)?.(); return true;
  };
}

export async function launchProcessRuntimeFixture() {
  redactStartupUrls(process.stdout); redactStartupUrls(process.stderr);
  const root = checkedRoot(process.argv[2]), dshPackage = resolve(process.argv[3] || '');
  if (JSON.parse(readFileSync(join(dshPackage, 'package.json'), 'utf8')).name !== '@deepseek-ai/dsh') throw new Error('An installed DSH package is required');
  mkdirSync(root, { recursive: true });
  const repo = fileURLToPath(new URL('../..', import.meta.url)), runId = randomUUID(), runDir = join(root, 'runs', runId);
  const home = join(runDir, 'home'), profileName = 'process-runtime-fixture', profile = join(home, 'profiles', profileName);
  mkdirSync(profile, { recursive: true });
  const ports = [];
  for (let i = 0; i < 2; i++) { const server = createServer(); await new Promise(accept => server.listen(0, '127.0.0.1', accept)); ports.push(server.address().port); await new Promise(accept => server.close(accept)); }
  const instances = ['a', 'b'].map(instanceId => ({ instanceId, organizationName: 'Fixture organization ' + instanceId, brainName: 'Fixture brain ' + instanceId,
    stateDir: join(runDir, 'runtime', instanceId, 'state'), workspace: join(runDir, 'runtime', instanceId, 'workspace'),
    model: { provider: providerId, model: providerId }, workerTools: ['read', 'glob', 'grep'], maxWorkers: 3 }));
  for (const instance of instances) { mkdirSync(instance.workspace, { recursive: true }); writeFileSync(join(instance.workspace, 'marker.txt'), `INSTANCE-${instance.instanceId.toUpperCase()}-READ-${runId}\n`); }
  symlinkSync(instances[1].workspace, join(instances[0].workspace, 'foreign-instance'), process.platform === 'win32' ? 'junction' : 'dir');
  const config = { fixtureDir: root, dshPackage, runId, runDir, home, port: ports[0], providerPort: ports[1], instances,
    productionFiles: Object.fromEntries(['lib/process-runtime.js', 'jarvis/process-runtime/manager.mjs', 'jarvis/process-runtime/child.mjs', 'jarvis/process-runtime/ipc.mjs',
      'jarvis/process-runtime/dsh-bridge.mjs'].filter(file => existsSync(join(repo, file))).map(file => [file, createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')])) };
  writeFileSync(join(root, 'fixture-config.json'), JSON.stringify(config, null, 2)); writeFileSync(join(runDir, 'fixture-config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(root, 'launch.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), runId, runDir, home, port: config.port }, null, 2));
  symlinkSync(join(dshPackage, 'node_modules'), join(home, 'profiles', 'node_modules'), 'junction');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(profile, 'fixture.mjs'), `export * from ${JSON.stringify(import.meta.url)};\n`);
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'superjarvis-process-runtime-fixture-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
  writeFileSync(join(profile, 'cordis.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { [providerId]: { api: 'openai-completions', baseURL: `http://127.0.0.1:${config.providerPort}/v1`, apiKeyEnv: 'SUPERJARVIS_PROCESS_FIXTURE_KEY',
      retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: providerId, name: 'Controlled process runtime fixture' }] } } } },
    { id: 'agent-preset-registry', config: { default: providerId } }, { id: 'session-title-llm', disabled: true },
    { insert: [
      { id: 'process-runtime-fixture-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: providerId, name: 'Controlled read-only process fixture', plugins: [
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }, { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
      ] } },
      { id: 'process-runtime-fixture', name: './fixture.mjs', config },
    ] },
  ], null, 2));
  process.env.DSH_HOME = home; process.env.SUPERJARVIS_PROCESS_FIXTURE_KEY = 'controlled-local-fixture';
  process.argv = [process.execPath, join(dshPackage, 'lib/bin.js'), '--profile', profileName, '--host', '127.0.0.1', '--port', String(config.port), '--no-open'];
  const { runCli } = await import(pathToFileURL(join(dshPackage, 'lib/bin.js'))); await runCli();
}
