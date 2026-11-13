import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const name = 'jarvis-gateway-flow-fixture';
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'llm', 'systemPrompt', 'tools', 'webServer'];
const prefix = '/__gateway_flow_fixture';
const textOf = content => typeof content === 'string' ? content : (content || []).map(block => block.text || '').join('');
const checkedRoot = value => {
  const root = resolve(value || '');
  if (!/[\\/]\.artifacts[\\/]jarvis-gateway-implementation[\\/]p3-fixture$/.test(root)) throw new Error('Only the independent P3 fixture directory is allowed');
  return root;
};
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };

/** A real Engine behind the public SourceContext seam; Router/Worker transitions are test-controlled. */
export async function apply(ctx, config) {
  const root = checkedRoot(config.fixtureDir), run = resolve(config.runDir);
  if (process.env.DSH_HOME !== join(root, 'home') || !run.startsWith(join(root, 'runs') + (process.platform === 'win32' ? '\\' : '/')) || ctx.webServer.host !== '127.0.0.1') {
    throw new Error('The flow fixture requires its isolated loopback profile');
  }
  const core = await import(config.coreModule);
  const repo = new core.MemoryRepositories(), kinds = new Map(), health = new Map(), queued = new Map();
  const submissions = [], effects = [], requests = [], sent = [], sourceErrors = [];
  const holds = new Map(), holdRecords = [], releasedMarkers = new Set();
  const trace = (file, value) => appendFileSync(join(run, file), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const identity = { deploymentId: 'controlled-p3-flow', principalId: 'fixture-owner' };
  const scope = { scope(input) {
    const kind = kinds.get(input.source);
    return kind ? kind.scope(input, identity) : { listened: false, reason: 'fixture_source_not_loaded' };
  } };
  const policy = {
    version: 'controlled-p3-v1', paused: false, evalTimeoutMs: 60000,
    gate(trigger) {
      return trigger.human && trigger.actor.source === 'jarvis' && trigger.actor.id === identity.principalId && trigger.addressed
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: trigger.addressed, source: trigger.source, scope: trigger.meta } }
        : { admissible: false, reason: 'controlled_user_required' };
    },
    revalidate: mandate => mandate.actor.source === 'jarvis' && mandate.actor.id === identity.principalId,
    admitsInferred: () => false,
  };
  const engine = new core.Engine({ repo, scope, policy: () => policy,
    assessor: { request: candidate => trace('core-trace.jsonl', { kind: 'eval', evalId: candidate.evalId }), release: () => {} },
    executor: Object.fromEntries(['start', 'deliver', 'stop'].map(kind => [kind, (ticket, assignment) => {
      const effect = { kind, ticketId: ticket.id, assignmentId: assignment.id }; effects.push(effect); trace('core-trace.jsonl', effect);
    }])),
    outbox: {
      send: message => { if (!queued.has(message.id)) queued.set(message.id, { message, status: 'pending' }); },
      status: id => queued.get(id)?.status,
      withdraw: id => { const item = queued.get(id); if (item?.status === 'pending') item.status = 'dropped'; },
    },
  });
  const receive = trigger => {
    const outcome = engine.receive(trigger);
    if (!submissions.some(item => item.id === trigger.id)) submissions.push(trigger);
    trace('core-trace.jsonl', { kind: 'receive', triggerId: trigger.id, commandId: trigger.dispatch?.commandId, outcome });
    return outcome;
  };
  const context = kind => ({
    configured: () => true,
    config: source => source === 'jarvis' ? identity : undefined,
    report: (id, value) => { health.set(id, value); },
    receive,
    submitConstrained: trigger => {
      if (!trigger.dispatch || trigger.source !== kind.kind || trigger.actor.source !== kind.kind) throw new Error('Fixture source identity mismatch');
      return receive(trigger);
    },
    commandReceipt: id => repo.triggers.get(id)?.source === kind.kind ? engine.commandReceipt(id) : undefined,
    tickets: { get: id => repo.tickets.get(id), open: () => repo.tickets.open() },
    triggers: { get: id => repo.triggers.get(id) },
  });
  ctx.provide('orchestrator', {
    sources: { register(kind) { if (kinds.has(kind.kind)) throw new Error('Fixture source already registered'); kinds.set(kind.kind, kind); return () => kinds.delete(kind.kind); } },
    context,
  });
  const decorated = new WeakSet();
  ctx.on('agent/created', ({ agent }) => {
    if (!agent.id.startsWith('jarvis-') || decorated.has(agent)) return;
    decorated.add(agent);
    // Gateway tools are registered in this Session's own scope. rc.5 restrict()
    // accepts inherited global names only, while get(name, agent) also sees own tools.
    const inherited = agent.ctx.tools.schemas(agent).map(tool => tool.name)
      .filter(toolName => !['jarvis_work_query', 'jarvis_work_submit'].includes(toolName) && ctx.tools.get(toolName, agent));
    if (inherited.length) agent.ctx.tools.restrict({ deny: inherited });
    agent.ctx.tools.guard(call => ['jarvis_work_query', 'jarvis_work_submit'].includes(call.name) ? undefined : 'Only the two controlled Gateway tools are available in this fixture');
  });
  const upstream = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') return json(res, 200, { object: 'list', data: [{ id: 'gateway-flow-fixture' }] });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) throw new Error('Fixture provider request too large'); }
      const input = JSON.parse(raw);
      const scenario = textOf([...input.messages].reverse().find(item => item.role === 'user' && textOf(item.content).includes('fixture:'))?.content);
      const last = input.messages.at(-1), toolText = last?.role === 'tool' ? textOf(last.content) : '';
      const record = { scenario, lastRole: last?.role, toolText, tools: (input.tools || []).map(tool => tool.function?.name),
        forcedSubmit: !toolText && scenario.includes('fixture:force-background-submit:') };
      requests.push(record); trace('provider-requests.jsonl', record);
      const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'flow-fixture', object: 'chat.completion.chunk', created: 1,
        model: 'gateway-flow-fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
      const finish = text => {
        if (res.destroyed || res.writableEnded) return;
        chunk({ content: text }); chunk({}, 'stop'); res.end('data: [DONE]\n\n');
      };
      const submit = quote => { chunk({ tool_calls: [{ index: 0, id: 'flow_call_' + randomUUID(), type: 'function',
        function: { name: 'jarvis_work_submit', arguments: JSON.stringify({ operation: 'new', request: { quote, summary: '受控异步交办' } }) } }] }, 'tool_calls'); res.end('data: [DONE]\n\n'); };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (toolText) return finish(`FIXTURE-TOOL-RESULT:${toolText}`);
      if (scenario.includes('fixture:preempt-user:')) return finish('FIXTURE-PREEMPTING-USER-OK:' + scenario);
      const holdMarker = scenario.match(/fixture:preemption-hold:([a-z0-9-]+)/)?.[1];
      if (holdMarker) {
        if (releasedMarkers.has(holdMarker)) return finish('FIXTURE-PREEMPTION-RECOVERED:' + holdMarker);
        const hold = { id: randomUUID(), marker: holdMarker, status: 'holding', startedAt: new Date().toISOString() };
        holdRecords.push(hold); trace('provider-holds.jsonl', hold);
        chunk({ content: 'FIXTURE-BACKGROUND-PARTIAL:' + holdMarker });
        const complete = status => {
          if (hold.status !== 'holding') return;
          hold.status = status; holds.delete(hold.id); clearTimeout(timer);
          trace('provider-holds.jsonl', hold);
          finish('FIXTURE-PREEMPTION-RECOVERED:' + holdMarker);
        };
        const timer = setTimeout(() => complete('guard-timeout'), 30000);
        holds.set(hold.id, { hold, complete });
        res.on('close', () => {
          clearTimeout(timer); holds.delete(hold.id);
          if (hold.status === 'holding') { hold.status = 'cancelled'; trace('provider-holds.jsonl', hold); }
        });
        return;
      }
      if (scenario.includes('fixture:force-background-submit:')) return submit('fixture:force-background-submit');
      if (scenario.includes('fixture:result-after-clear:')) return finish('FIXTURE-RESULT-AFTER-CLEAR:' + scenario);
      if (scenario.includes('fixture:handoff:')) return submit(scenario.match(/fixture:handoff:[a-z0-9-]+ 请修复受控登录问题/)?.[0] || scenario.match(/fixture:handoff:[a-z0-9-]+/)?.[0]);
      if (scenario.includes('fixture:smalltalk:')) return finish('FIXTURE-SECOND-TURN-OK:' + scenario);
      return finish('FIXTURE-NOTIFICATION:' + scenario);
    } catch (error) { trace('provider-errors.jsonl', { error: error.message }); if (!res.headersSent) json(res, 500, { error: error.message }); else res.end(); }
  });
  await new Promise((accept, reject) => { upstream.once('error', reject); upstream.listen(config.providerPort, '127.0.0.1', accept); });
  let flushing = false;
  const flushOutbox = async () => {
    if (flushing) return; flushing = true;
    try {
      for (const item of [...queued.values()].filter(item => item.status === 'pending')) {
        try {
          const channel = kinds.get(item.message.channel.source)?.channel;
          if (!channel) continue;
          const status = await channel.send(context(kinds.get(item.message.channel.source)), item.message);
          if (status === 'sent') { item.status = 'sent'; sent.push(item.message); trace('outbox-trace.jsonl', { kind: 'sent', message: item.message }); }
        } catch (error) {
          if (!sourceErrors.some(itemError => itemError.messageId === item.message.id && itemError.error === error.message)) {
            sourceErrors.push({ messageId: item.message.id, error: error.message }); trace('outbox-trace.jsonl', sourceErrors.at(-1));
          }
        }
      }
    } finally { flushing = false; }
  };
  const timer = setInterval(flushOutbox, 100);
  ctx.effect(() => () => { clearInterval(timer); upstream.closeAllConnections(); upstream.close(); });
  const service = () => ctx.get('jarvisGateway');
  const snapshot = () => ({ sourceKinds: [...kinds.keys()], submissions, receipts: submissions.map(trigger => engine.commandReceipt(trigger.id)),
    tickets: repo.tickets.list(), works: service()?.ledger.works('', 0, 20) || [], effects, sent, sourceErrors, health: [...health],
    deliveries: [...new Set(submissions.map(trigger => trigger.meta.conversationId))].flatMap(id => service()?.ledger.deliveries(id) || []) });
  ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${ctx.webServer.port}` || req.headers.origin || req.headers['x-gateway-flow-fixture'] !== 'controlled-test') throw new Error('Fixture request rejected');
      const path = new URL(req.url, 'http://fixture.invalid').pathname.slice(prefix.length);
      let input = {};
      if (req.method === 'POST') { let raw = ''; for await (const part of req) { raw += part; if (raw.length > 80000) throw new Error('Fixture request too large'); } input = JSON.parse(raw || '{}'); }
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ready: Boolean(service()), app: name, pid: process.pid, runId: config.runId });
      if (req.method === 'GET' && path === '/snapshot') return json(res, 200, snapshot());
      if (req.method === 'GET' && path === '/provider') return json(res, 200, { requests, holds: holdRecords });
      if (req.method === 'POST' && path === '/release-preemption') {
        if (typeof input.marker !== 'string' || !/^[a-z0-9-]{8,80}$/.test(input.marker)) throw new Error('Invalid preemption marker');
        releasedMarkers.add(input.marker);
        for (const { hold, complete } of [...holds.values()]) if (hold.marker === input.marker) complete('released');
        return json(res, 200, { released: input.marker });
      }
      if (req.method === 'POST' && path === '/accept') {
        const record = service().ledger.command(input.commandId); if (!record) throw new Error('Unknown controlled command');
        const decision = engine.decide(record.command.triggerId, { kind: 'accept', title: '受控工作', scope: '只在Memory受控验收', reason: 'explicit fixture Router decision', acknowledgement: '受控底座已接纳' });
        const ticket = repo.tickets.get(decision.ticketId);
        engine.assignmentStarted(ticket.id, ticket.assignments.at(-1).id);
        trace('core-trace.jsonl', { kind: 'accepted', commandId: input.commandId, ticketId: ticket.id });
        return json(res, 200, { decision, ticket: repo.tickets.get(ticket.id) });
      }
      if (req.method === 'POST' && path === '/report') {
        const ticket = engine.report(input.ticketId, input.report);
        if (input.report.question) engine.reply({ purpose: 'attention', ticketId: ticket.id, question: input.report.question, text: input.report.question });
        if (input.report.state === 'ready') engine.reply({ purpose: 'result', ticketId: ticket.id, text: input.report.summary });
        trace('core-trace.jsonl', { kind: 'report', ticketId: ticket.id, state: input.report.state });
        return json(res, 200, { ticket });
      }
      if (req.method === 'POST' && path === '/history') {
        if (typeof input.sessionId !== 'string' || !/^jarvis-[a-z0-9-]+$/.test(input.sessionId)) throw new Error('Not a fixture Jarvis Session');
        const resolved = await ctx.sessionController.resolveAgent(input.sessionId); if ('error' in resolved) throw new Error('Session not found');
        await ctx.sessionPersistence.flush();
        return json(res, 200, { agentStatus: resolved.agent.status, events: resolved.agent.session.snapshotEvents() });
      }
      return json(res, 404, { error: 'Fixture route not found' });
    } catch (error) { json(res, 400, { error: error.message }); }
  } });
  const dshPackage = JSON.parse(readFileSync(join(config.dshPackage, 'package.json'), 'utf8'));
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ app: name, pid: process.pid, startedAt: new Date().toISOString(),
    runId: config.runId, runDir: run, home: process.env.DSH_HOME, port: ctx.webServer.port, providerPort: config.providerPort,
    node: process.versions.node, dshVersion: dshPackage.version, coreModule: config.coreModule,
    jarvisModule: config.jarvisModule, gatewayModule: config.gatewayModule,
    productionFiles: config.productionFiles,
    limitations: ['Engine uses MemoryRepositories', 'Router and Worker transitions are controlled by tests', 'No external GitHub or Feishu delivery', 'Not full host or Issue-to-PR acceptance'] }, null, 2));
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

/** Starts only the dedicated fixture profile; every fresh launch retains prior run directories. */
export async function launchGatewayFlowFixture() {
  redactStartupUrls(process.stdout); redactStartupUrls(process.stderr);
  const root = checkedRoot(process.argv[2]), dshPackage = resolve(process.argv[3]);
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const home = join(root, 'home'), profileName = 'jarvis-gateway-flow', profile = join(home, 'profiles', profileName);
  mkdirSync(profile, { recursive: true });
  const runId = randomUUID(), runDir = join(root, 'runs', runId); mkdirSync(runDir, { recursive: true }); mkdirSync(join(root, 'workspace'), { recursive: true });
  const ports = [];
  for (let i = 0; i < 2; i++) { const server = createServer(); await new Promise(accept => server.listen(0, '127.0.0.1', accept)); ports.push(server.address().port); await new Promise(accept => server.close(accept)); }
  const config = { fixtureDir: root, dshPackage, runId, runDir, port: ports[0], providerPort: ports[1],
    coreModule: pathToFileURL(join(repo, 'lib/index.js')).href, jarvisModule: pathToFileURL(join(repo, 'jarvis/dsh/index.mjs')).href,
    gatewayModule: pathToFileURL(join(repo, 'lib/jarvis-gateway.js')).href,
    productionFiles: Object.fromEntries(['lib/index.js', 'lib/jarvis-gateway.js', 'jarvis/dsh/index.mjs',
      'jarvis/dsh/runtime.mjs', 'jarvis/dsh/gateway.mjs', 'jarvis/dsh/gateway-delivery.mjs', 'jarvis/store.mjs'].map(file =>
      [file, createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')])) };
  writeFileSync(join(root, 'fixture-config.json'), JSON.stringify(config, null, 2));
  const modules = join(home, 'profiles/node_modules'); if (!existsSync(modules)) symlinkSync(join(dshPackage, 'node_modules'), modules, 'junction');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  for (const [file, module] of [['flow-probe.mjs', import.meta.url], ['jarvis-production.mjs', config.jarvisModule], ['gateway-production.mjs', config.gatewayModule]]) {
    writeFileSync(join(profile, file), `export * from ${JSON.stringify(module)};\n`);
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'jarvis-gateway-flow-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
  writeFileSync(join(profile, 'cordis.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { 'gateway-flow-fixture': { api: 'openai-completions', baseURL: `http://127.0.0.1:${config.providerPort}/v1`,
      apiKeyEnv: 'JARVIS_GATEWAY_FLOW_FIXTURE_KEY', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'gateway-flow-fixture', name: 'Controlled P3 integration fixture' }] } } } },
    { insert: [
      { id: 'flow-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'jarvis-flow-fixture', name: 'Controlled Jarvis flow', plugins: [] } },
      { id: 'flow-fixture', name: './flow-probe.mjs', config },
      { id: 'flow-gateway', name: './gateway-production.mjs', config: { stateDir: join(runDir, 'gateway-state'), deploymentId: 'controlled-p3-flow', principalId: 'fixture-owner' } },
      { id: 'flow-jarvis', name: './jarvis-production.mjs', config: { stateDir: join(runDir, 'jarvis-state'), workspace: join(root, 'workspace'), preset: 'jarvis-flow-fixture',
        initialModel: { endpoint: 'gateway-flow-fixture', model: 'gateway-flow-fixture', temperature: '0.1', maxTokens: '1024', reasoning: 'default', timeout: '10', stream: true } } },
    ] },
  ], null, 2));
  process.env.DSH_HOME = home; process.env.JARVIS_GATEWAY_FLOW_FIXTURE_KEY = 'controlled-local-fixture';
  process.argv = [process.execPath, join(dshPackage, 'lib/bin.js'), '--profile', profileName, '--host', '127.0.0.1', '--port', String(config.port), '--no-open'];
  const { runCli } = await import(pathToFileURL(join(dshPackage, 'lib/bin.js'))); await runCli();
}
