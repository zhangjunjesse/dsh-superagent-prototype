import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { GatewayDelivery } from './gateway-delivery.mjs';

export const name = 'jarvis-gateway-delivery-fixture';
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'llm', 'systemPrompt', 'tools', 'webServer'];
const prefix = '/__gateway_delivery_fixture';
const textOf = content => typeof content === 'string' ? content : (content || []).map(block => block.text || '').join('');
const fixturePath = value => {
  const result = resolve(value || '');
  if (!/[\\/]\.artifacts[\\/]jarvis-gateway-implementation[\\/]dsh-fixture$/.test(result)) throw new Error('Only the dedicated Gateway fixture directory is allowed');
  return result;
};
const sessionIdOf = value => {
  if (typeof value !== 'string' || !/^gateway-feedback-[a-z0-9-]{1,80}$/.test(value)) throw new Error('Invalid fixture Session ID');
  return value;
};

export async function apply(ctx, config) {
  const fixtureDir = fixturePath(config.fixtureDir);
  if (process.env.DSH_HOME !== join(fixtureDir, 'home') || ctx.webServer.host !== '127.0.0.1') throw new Error('Gateway fixture must use its isolated loopback DSH_HOME');
  const delivery = new GatewayDelivery(ctx), holds = new Map(), requests = [];
  const workspace = join(fixtureDir, 'workspace');
  const decorate = agent => {
    if (!agent.id.startsWith('gateway-feedback-') || agent.__gatewayFixture) return;
    agent.__gatewayFixture = true;
    const names = agent.ctx.tools.schemas(agent).map(tool => tool.name);
    const inherited = names.filter(toolName => ctx.tools.get(toolName, agent));
    if (inherited.length) agent.ctx.tools.restrict({ deny: inherited });
    agent.ctx.tools.guard(() => 'Controlled Gateway fixture tools are disabled');
    agent.ctx.systemPrompt.section({ name: 'gateway-fixture', order: 9999, interpolate: false,
      text: 'You only summarize controlled fixture data. You cannot authorize or execute work. No tools are installed.' });
    agent.ctx.on('agent/request', async (_payload, next) => { await next(); return { provider: 'gateway-fixture', model: 'gateway-fixture' }; }, { prepend: true });
  };
  ctx.on('agent/created', ({ agent }) => decorate(agent));
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const text = textOf([...input.messages].reverse().find(item => item.role === 'user' && textOf(item.content).includes('fixture:'))?.content);
    requests.push({ text, toolCount: input.tools?.length || 0, toolNames: (input.tools || []).map(tool => tool.function?.name) });
    const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'gateway-fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
    const end = () => { if (!res.destroyed && !res.writableEnded) { chunk({ content: `fixture-result:${text}` }); chunk({}, 'stop'); res.end('data: [DONE]\n\n'); } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (text.includes('fixture:hold')) {
      chunk({ content: 'fixture-partial' });
      const timer = setTimeout(end, 30000);
      holds.set(text, end); res.on('close', () => { clearTimeout(timer); holds.delete(text); });
    } else end();
  });
  await new Promise((accept, reject) => { upstream.once('error', reject); upstream.listen(config.providerPort, '127.0.0.1', accept); });
  ctx.effect(() => () => { upstream.closeAllConnections(); upstream.close(); });
  const agentOf = async id => {
    const result = await ctx.sessionController.resolveAgent(sessionIdOf(id));
    if ('error' in result) throw new Error('Fixture Session not found');
    decorate(result.agent); return result.agent;
  };
  const historyOf = async id => {
    await ctx.sessionPersistence.flush();
    const handle = await ctx.sessionPersistence.open(id, 'read');
    const events = [];
    try {
      for (let offset = 0; ; ) {
        const page = await handle.read(offset, 512); if (!page.events.length) break;
        events.push(...page.events); offset += page.events.length;
      }
    } finally { await handle[Symbol.asyncDispose](); }
    return events;
  };
  const sendJson = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  ctx.webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${ctx.webServer.port}` || req.headers.origin || req.headers['x-gateway-fixture'] !== 'controlled-test') throw new Error('Fixture request rejected');
      const path = new URL(req.url, 'http://fixture.invalid').pathname.slice(prefix.length);
      let input = {};
      if (req.method === 'POST') {
        let raw = ''; for await (const part of req) { raw += part; if (raw.length > 80000) throw new Error('Fixture request too large'); }
        input = JSON.parse(raw || '{}');
      }
      if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ready: true, app: name, pid: process.pid });
      if (req.method === 'GET' && path === '/provider') return sendJson(res, 200, { requests });
      if (req.method === 'POST' && path === '/create') {
        const id = sessionIdOf(input.sessionId);
        await ctx.sessionController.create({ sessionId: id, cwd: workspace, agentPreset: 'gateway-fixture' });
        const agent = await agentOf(id); await ctx.sessionPersistence.flush();
        return sendJson(res, 200, { sessionId: agent.id });
      }
      if (req.method === 'POST' && path === '/inspect') {
        const target = input.diskOnly ? sessionIdOf(input.sessionId) : await agentOf(input.sessionId);
        const receipt = await delivery.inspect(target, input.deliveryId);
        return sendJson(res, 200, { ...receipt, ...(typeof target === 'string' ? {} : { agentStatus: target.status,
          livePending: [...target.inbox.nextTurn, ...target.inbox.nextStep].some(message => message.id === receipt.messageId) }) });
      }
      if (req.method === 'POST' && path === '/send') return sendJson(res, 200, await delivery.send(await agentOf(input.sessionId), input));
      if (req.method === 'POST' && path === '/inspect-resume') {
        const target = input.diskOnly ? sessionIdOf(input.sessionId) : await agentOf(input.sessionId);
        return sendJson(res, 200, await delivery.inspectResume(target, input.deliveryId, input.recoveryId));
      }
      if (req.method === 'POST' && path === '/resume-notice') {
        return sendJson(res, 200, await delivery.resume(await agentOf(input.sessionId), input));
      }
      if (req.method === 'POST' && path === '/enqueue-foreign') {
        const agent = await agentOf(input.sessionId);
        const message = Object.freeze({ id: `fixture-foreign:${input.foreignId}`, role: 'user',
          content: Object.freeze([Object.freeze({ type: 'text', text: 'fixture:unrelated-input' })]),
          source: Object.freeze({ kind: 'gateway-fixture-foreign', form: 'relay' }) });
        agent.send(message, 'next-turn', false); await ctx.sessionPersistence.flush();
        return sendJson(res, 200, { messageId: message.id });
      }
      if (req.method === 'POST' && path === '/retire-owned') {
        const agent = await agentOf(input.sessionId), primary = await delivery.inspect(agent, input.deliveryId);
        if (!Array.isArray(input.recoveryIds) || input.recoveryIds.length > 10) throw new Error('Invalid recovery identity set');
        const controls = [];
        for (const recoveryId of input.recoveryIds) controls.push(await delivery.inspectResume(agent, input.deliveryId, recoveryId));
        const known = new Map([primary, ...controls].filter(receipt => receipt.admitted).map(receipt => [receipt.messageId, receipt]));
        const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
        const owned = pending.every(message => {
          const receipt = known.get(message.id);
          return receipt && message.source?.kind === 'jarvis-gateway' &&
            Object.entries(receipt.source).every(([key, value]) => message.source[key] === value) &&
            createHash('sha256').update(textOf(message.content)).digest('hex') === receipt.payloadHash;
        });
        if (!primary.pending || agent.status !== 'idle' || !pending.some(message => message.id === primary.messageId) || !owned) {
          return sendJson(res, 200, { retired: false, reason: 'pending-input-not-exclusively-owned', original: primary });
        }
        // The test caller owns its isolated write gate. Any foreign pending item
        // prevents this cancellation; no private inbox mutator is used.
        agent.cancel({ kind: 'user' }); await agent.whenIdle(); await ctx.sessionPersistence.flush();
        const original = await delivery.inspect(agent, input.deliveryId), retiredControls = [];
        for (const recoveryId of input.recoveryIds) retiredControls.push(await delivery.inspectResume(agent, input.deliveryId, recoveryId));
        return sendJson(res, 200, { retired: !original.pending && retiredControls.every(item => !item.pending), original, controls: retiredControls });
      }
      if (req.method === 'POST' && path === '/delivery-counts') {
        const events = await historyOf(sessionIdOf(input.sessionId));
        return sendJson(res, 200, { consumed: events.filter(event => event.type === 'user/message').map(event => ({ messageId: event.data.id, source: event.data.source })) });
      }
      if (req.method === 'POST' && path === '/cancel') {
        const agent = await agentOf(input.sessionId);
        agent.cancel({ kind: 'user' }, { keepInbox: input.keepInbox === true });
        await agent.whenIdle(); await ctx.sessionPersistence.flush();
        return sendJson(res, 200, { cancelled: true });
      }
      if (req.method === 'POST' && path === '/maintenance') {
        const agent = await agentOf(input.sessionId);
        agent.runMaintenance(signal => new Promise(resolveJob => {
          const timer = setTimeout(resolveJob, 30000); signal.addEventListener('abort', () => { clearTimeout(timer); resolveJob(); }, { once: true });
        })).catch(error => ctx.logger.error('fixture maintenance: %s', error.message));
        return sendJson(res, 200, { held: true });
      }
      if (req.method === 'POST' && path === '/release') { holds.get(input.text)?.(); return sendJson(res, 200, { released: true }); }
      return sendJson(res, 404, { error: 'Fixture route not found' });
    } catch (error) { sendJson(res, 400, { error: error.message }); }
  } });
  writeFileSync(join(fixtureDir, 'runtime.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(),
    home: process.env.DSH_HOME, port: ctx.webServer.port, providerPort: config.providerPort, app: name }, null, 2));
}

function redactStartupUrls(stream) {
  const write = stream.write.bind(stream); let pending = '';
  stream.write = (chunk, encoding, callback) => {
    pending += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : undefined) : chunk;
    const newline = pending.lastIndexOf('\n');
    if (newline >= 0) {
      const ready = pending.slice(0, newline + 1).replace(/https?:\/\/[^\s]*[?&]token=[^\s]+/g, '[authenticated startup URL redacted]');
      pending = pending.slice(newline + 1); write(ready);
    }
    (typeof encoding === 'function' ? encoding : callback)?.(); return true;
  };
}

export async function launchGatewayFixture() {
  redactStartupUrls(process.stdout); redactStartupUrls(process.stderr);
  const fixtureDir = fixturePath(process.argv[2]), dshPackage = resolve(process.argv[3]);
  const fixtureConfig = join(fixtureDir, 'fixture-config.json');
  const home = join(fixtureDir, 'home'), profileName = 'gateway-feedback-p0', profile = join(home, 'profiles', profileName);
  mkdirSync(profile, { recursive: true }); mkdirSync(join(fixtureDir, 'workspace'), { recursive: true });
  let config;
  if (existsSync(fixtureConfig)) config = JSON.parse(readFileSync(fixtureConfig, 'utf8'));
  else {
    const ports = [];
    for (let i = 0; i < 2; i++) {
      const socket = createServer(); await new Promise(accept => socket.listen(0, '127.0.0.1', accept)); ports.push(socket.address().port);
      await new Promise(accept => socket.close(accept));
    }
    config = { fixtureDir, dshPackage, port: ports[0], providerPort: ports[1] };
    writeFileSync(fixtureConfig, JSON.stringify(config, null, 2));
  }
  if (config.fixtureDir !== fixtureDir || config.dshPackage !== dshPackage) throw new Error('Fixture identity mismatch');
  const modules = join(home, 'profiles/node_modules');
  if (!existsSync(modules)) symlinkSync(join(dshPackage, 'node_modules'), modules, 'junction');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  // A file proxy avoids registering the repository's unrelated client manifest,
  // which requires the parent task's not-yet-built lib/client.js.
  writeFileSync(join(profile, 'gateway-probe.mjs'), `export * from ${JSON.stringify(import.meta.url)};\n`);
  if (!existsSync(join(profile, 'cordis.patch.yml'))) {
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'gateway-delivery-fixture', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
    writeFileSync(join(profile, 'cordis.yml'), '[]\n');
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'llm-pi-ai', config: { providers: { 'gateway-fixture': { api: 'openai-completions', baseURL: `http://127.0.0.1:${config.providerPort}/v1`,
        apiKeyEnv: 'JARVIS_GATEWAY_FIXTURE_KEY', retryPolicy: { mode: 'normal', maxRetries: 0 }, models: [{ id: 'gateway-fixture', name: 'Gateway controlled fixture' }] } } } },
      { insert: [
        { id: 'gateway-fixture-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'gateway-fixture', name: 'Gateway controlled fixture', plugins: [] } },
        { id: 'gateway-fixture-probe', name: './gateway-probe.mjs', config: { fixtureDir, providerPort: config.providerPort } },
      ] },
    ], null, 2));
  }
  process.env.DSH_HOME = home;
  process.env.JARVIS_GATEWAY_FIXTURE_KEY = 'controlled-local-fixture';
  process.argv = [process.execPath, join(dshPackage, 'lib/bin.js'), '--profile', profileName, '--host', '127.0.0.1', '--port', String(config.port), '--no-open'];
  const { runCli } = await import(pathToFileURL(join(dshPackage, 'lib/bin.js')));
  await runCli();
}
