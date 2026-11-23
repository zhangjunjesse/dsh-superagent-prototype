/** Isolated installed-DSH fixture: real registry, loop, prompt, tool pipeline and JSONL persistence; no network/provider credentials. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installed = process.env.JARVIS_DSH_PACKAGE ?? join(homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh');
const installedRequire = createRequire(join(installed, 'package.json'));
const load = name => import(pathToFileURL(installedRequire.resolve(name)));
export const available = existsSync(join(installed, 'package.json'));

export async function nativeFixture(t, { managementOnly = false, role = 'worker', allowedTools = ['read', 'todo_write', 'subagent', 'send_message', 'list_agents', 'interrupt_agent'], local = ['subagent'], inherited = ['read', 'write', 'todo_write', 'send_message', 'list_agents', 'interrupt_agent'], nativeTools, realCapabilities = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'original-native-host-'));
  let rootContext, cleanup;
  t.after(async () => {
    if (cleanup) return cleanup();
    await rootContext?.fiber.dispose();
    const part = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(part.startsWith('original-native-host-') && !isAbsolute(part) && !part.includes('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  const modules = join(directory, 'module'), dependencyRoot = join(modules, 'node_modules'); mkdirSync(dependencyRoot, { recursive: true });
  copyFileSync(new URL('../../package.json', import.meta.url), join(modules, 'package.json'));
  symlinkSync(join(installed, 'node_modules/@deepseek-ai'), join(dependencyRoot, '@deepseek-ai'), 'junction');
  for (const name of ['proper-lockfile', 'zod']) symlinkSync(fileURLToPath(new URL('../../node_modules/' + name, import.meta.url)), join(dependencyRoot, name), 'junction');
  cpSync(new URL('../../lib/', import.meta.url), join(modules, 'lib'), { recursive: true });
  symlinkSync(fileURLToPath(new URL('../../prompts/', import.meta.url)), join(modules, 'prompts'), 'junction');
  symlinkSync(fileURLToPath(new URL('../../skills/', import.meta.url)), join(modules, 'skills'), 'junction');
  mkdirSync(join(modules, 'jarvis/process-runtime'), { recursive: true });
  for (const name of ['native-host.mjs', 'native-wire.mjs', 'native-transport.mjs', 'native-journal.mjs', 'native-environment.mjs', 'worker-execution.mjs', 'ipc.mjs',
    'manager.mjs', 'control.mjs', 'capability-applications.mjs', 'child.mjs', 'dsh-bridge.mjs', 'reply-progress.mjs', 'original-adoption.mjs', 'startup-progress.mjs']) copyFileSync(new URL(name, import.meta.url), join(modules, 'jarvis/process-runtime', name));
  const [cordis, scopeModule, promptModule, toolsModule, agentsModule, sessionModule, projectionModule, loopModule, llmModule, persistence, skillsModule, transportModule, hostModule, coreModule] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-agent-loop'),
    load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session-persistence-jsonl'), load('@deepseek-ai/dsh-skill'),
    import(pathToFileURL(join(modules, 'jarvis/process-runtime/native-transport.mjs'))), import(pathToFileURL(join(modules, 'jarvis/process-runtime/native-host.mjs'))),
    import(pathToFileURL(join(modules, 'lib/process-runtime.js'))),
  ]);
  const { Context, Service } = cordis, ctx = new Context();
  rootContext = ctx;
  new agentsModule.AgentRegistry(ctx); new sessionModule.SessionStore(ctx); new projectionModule.SessionProjectionRegistry(ctx);
  new promptModule.SystemPrompt(ctx, { personaPrefix: 'Original inherited coding persona' }); new toolsModule.ToolRuntime(ctx, { mode: 'native' });
  let skillsProvider = ctx.plugin({ name: 'fixture-skills-provider', apply(scope) { new skillsModule.SkillRegistry(scope); } });
  await skillsProvider; new llmModule.LlmRuntime(ctx);
  const modelCalls = [], toolCalls = [], errors = []; let responder;
  class Adapter extends llmModule.LlmAdapter {
    async *stream(options) {
      modelCalls.push(options);
      if (responder) { yield* responder(options); return; }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Native fixture reply' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native fixture reply' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  ctx.on('agent/error', value => errors.push(value.error));
  ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd);
  await persistence.apply(ctx, { root: join(directory, 'sessions'), compression: 'none' });
  new loopModule.AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 10 } });
  const controllerCalls = [], workspaceAccounts = new Map(), controllerHandles = [];
  class Workspaces extends Service {
    constructor(scope) { super(scope, 'workspaceRegistry'); }
    async create(cwd) {
      let workspace = workspaceAccounts.get(cwd);
      if (!workspace) {
        const sessionIds = [];
        workspace = { id: `fixture-workspace-${workspaceAccounts.size}`, path: cwd, sessionIds,
          async attachSession(id) {
            assert.equal(ctx.agents.get(id)?.session.header.cwd, cwd);
            if (!sessionIds.includes(id)) sessionIds.push(id);
          } };
        workspaceAccounts.set(cwd, workspace);
      }
      return workspace;
    }
  }
  await ctx.plugin({ name: 'fixture-workspace-provider', apply(scope) { new Workspaces(scope); } });
  class Permissions extends Service { constructor() { super(ctx, 'permissionPresets'); } set() {} }
  class Controller extends Service {
    constructor() { super(ctx, 'sessionController'); }
    async resolveAgent(id) {
      const live = ctx.agents.get(id); if (live) return { agent: live };
      const persisted = await ctx.sessionPersistence.stat(id);
      if (!persisted) return { error: { code: 'session/not-found' } };
      const handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'fixture', model: 'fixture' },
        setup: scope => ctx.agentPresets.mount(scope, persisted.header.agentPreset) });
      controllerHandles.push(handle); return { agent: handle.agent };
    }
    async create(request) {
      controllerCalls.push({ type: 'create', ...request });
      assert.ok(!request.cwd || !request.workspaceId, 'A controller request addresses one workspace source');
      const workspace = request.cwd ? await ctx.workspaceRegistry.create(request.cwd)
        : [...workspaceAccounts.values()].find(value => value.id === request.workspaceId);
      assert.ok(workspace);
      const handle = await ctx.agents.create({ sessionId: request.sessionId, meta: { cwd: workspace.path, agentPreset: request.agentPreset },
        agentOptions: { provider: 'fixture', model: 'fixture' }, setup: scope => ctx.agentPresets.mount(scope, request.agentPreset) });
      controllerHandles.push(handle); await workspace.attachSession(handle.agent.id);
      return { sessionId: handle.agent.id, agentPreset: request.agentPreset };
    }
    async prompt(request, signal) {
      signal.throwIfAborted();
      const resolved = await this.resolveAgent(request.sessionId);
      assert.ok(resolved.agent, 'A daily prompt needs its actual registered Agent');
      const agent = resolved.agent;
      if (agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source?.rpcId === request.requestId)) return { accepted: true };
      // Match installed SessionController's text-only admission boundary. The
      // actual registry, AgentLoop, tools and JSONL persistence own execution.
      const message = llmModule.createUserMessage({ content: request.content,
        source: { kind: 'user', rpcId: request.requestId, ...(request.clientTimeZone ? { clientTimeZone: request.clientTimeZone } : {}) } });
      request.mode === 'steer' ? agent.steer(message) : agent.followup(message);
      return { accepted: true };
    }
    async rename(request) { controllerCalls.push({ type: 'rename', ...request }); }
    async modelCatalog() { return { groups: [], default: { provider: 'fixture', model: 'fixture' } }; }
    async inspect(id) { const handle = await ctx.sessionPersistence.open(id, 'read'); try { return { meta: handle.header, events: (await handle.read(0)).events }; } finally { await handle.close(); } }
  }
  class Subprocess extends Service {
    constructor() { super(ctx, 'subprocess'); }
    spawn(spec) { toolCalls.push({ kind: 'spawn', spec }); return { completion: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) }; }
  }
  new Controller();
  let nativePlugins;
  if (realCapabilities) {
    const names = ['dsh-subprocess-local', 'dsh-working-directory', 'dsh-session-query-sqlite', 'dsh-subagent', 'dsh-subagent-spawn-in-process',
      'dsh-tool-subagent', 'dsh-tool-subagent-control', 'dsh-tool-todo', 'dsh-jobs-local', 'dsh-tool-jobs', 'dsh-pwsh-sandbox', 'dsh-tool-pwsh',
      'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-user-approval', 'dsh-permission-presets', 'dsh-fs-local', 'dsh-tool-fs', 'dsh-shell-env'];
    nativePlugins = Object.fromEntries(await Promise.all(names.map(async name => [name, await load('@deepseek-ai/' + name)])));
    // Installed DSH publishes services from sibling plugin fibers. Constructing
    // them on the root Context would accidentally permit undeclared reads in a
    // consumer plugin and miss its real Cordis injection boundary.
    await ctx.plugin({ name: 'fixture-subprocess-provider', apply(scope) { new nativePlugins['dsh-subprocess-local'].LocalSubprocessRuntime(scope); } });
    new nativePlugins['dsh-shell-env'].ShellEnvRegistry(ctx, { dshHome: join(directory, 'dsh-home') });
    new nativePlugins['dsh-fs-local'].LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 10485760 });
    new nativePlugins['dsh-working-directory'].WorkingDirectoryService(ctx, { defaultDirectory: directory });
    new nativePlugins['dsh-session-query-sqlite'].SqliteSessionQueryEngine(ctx, { path: ':memory:', openAt: 'never' });
    new nativePlugins['dsh-sandbox-policy'].SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: directory });
    new nativePlugins['dsh-sandbox-local'].LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 });
    const live = value => ({ get: () => value });
    const { SandboxPwshExecutor } = nativePlugins['dsh-pwsh-sandbox'];
    await ctx.plugin({ name: 'fixture-pwsh-provider', inject: SandboxPwshExecutor.inject, apply(scope) {
      new SandboxPwshExecutor(scope, { cwd: live(undefined), timeoutMs: live(5000), maxTimeoutMs: live(5000),
        maxOutputBytes: live(200000), maxSpillBytes: live(1000000), graceMs: live(1000), pwshPath: live(undefined) });
    } });
    new nativePlugins['dsh-user-approval'].ApprovalService(ctx, { policy: 'never' });
    const { PermissionPresetService } = nativePlugins['dsh-permission-presets'];
    await ctx.plugin({ name: 'fixture-permission-provider', inject: PermissionPresetService.inject, apply(scope) {
      new PermissionPresetService(scope, { defaultPreset: live('danger-full-access'),
        presets: { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } });
    } });
    new nativePlugins['dsh-jobs-local'].LocalJobRegistry(ctx, { pumpPollMs: 20 });
    new nativePlugins['dsh-subagent'].SubagentRuntime(ctx, { maxDepth: live(2), maxActiveSubagents: live(8) });
    nativePlugins['dsh-subagent-spawn-in-process'].apply(ctx, { providerName: 'spawn' });
  } else { new Permissions(); new Subprocess(); }
  const nativeScopes = [], definitions = new Map();
  const tool = name => toolsModule.defineTool({ name, description: `Real DSH tool registry fixture ${name}`, parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (_args, execution) => { toolCalls.push({ name, sessionId: execution.agent.id }); return { ok: true, name }; } });
  class Presets extends Service {
    selected = new WeakMap();
    constructor() { super(ctx, 'agentPresets'); }
    composedPreset() { return 'fixture-actual-plugins'; }
    presetForSession(session) { return this.selected.get(session) ?? session.header.agentPreset; }
    async select(agent, preset) { this.selected.set(agent.session, preset); await ctx.serial('agent-preset/selected', agent.id, preset); return preset; }
    async mount(scope) {
      const key = {}, preset = scopeModule.createScope(ctx, key); nativeScopes.push(preset);
      scopeModule.bindScopeParent(scopeModule.scopeOf(scope), key);
      for (const name of inherited) { const definition = tool(name); definitions.set(name, definition); preset.ctx.tools.register(definition); }
      preset.ctx.systemPrompt.section({ name: 'native-tool-guidance', order: 100, text: 'Original inherited tool guidance' });
      for (const name of local) scope.tools.register(tool(name));
      if (realCapabilities) {
        const install = (name, config) => preset.ctx.plugin({ name: `fixture-${name}`, inject: nativePlugins[name].inject,
          apply: child => nativePlugins[name].apply(child, config) });
        await install('dsh-tool-fs', cordis.resolveConfig(nativePlugins['dsh-tool-fs'], { readImage: false }));
        await install('dsh-tool-pwsh', {});
        await install('dsh-tool-jobs', { waitTimeoutMs: 1000, maxWaitTimeoutMs: 5000 });
        await install('dsh-tool-subagent-control');
        await install('dsh-tool-todo', { allowParallelInProgress: true });
        await nativePlugins['dsh-tool-subagent'].apply(scope, { provider: 'spawn', maxDepth: 2 }, scopeModule.scopeOf(scope).session);
      }
      await nativeTools?.(scope, preset.ctx, { ctx, load, modules, toolsModule, scopeModule });
    }
    composeFrom(child, parent) {
      scopeModule.bindScopeParent(scopeModule.scopeOf(child), scopeModule.scopeParentOf(scopeModule.scopeOf(parent)));
      if (realCapabilities) void nativePlugins['dsh-tool-subagent'].apply(child, { provider: 'spawn', maxDepth: 2 }, scopeModule.scopeOf(child).session);
      return 'standard';
    }
  }
  new Presets();
  const workspace = join(directory, 'workspace'), stateDir = join(directory, 'state'); mkdirSync(workspace); mkdirSync(stateDir);
  const config = { instanceId: 'native-fixture', workspace, stateDir, workerTools: ['read'], workerSkills: [], model: { provider: 'fixture', model: 'fixture' } };
  const a = new EventEmitter(), b = new EventEmitter(); a.connected = b.connected = true;
  a.send = (value, done) => { queueMicrotask(() => b.emit('message', structuredClone(value))); done?.(); };
  b.send = (value, done) => { queueMicrotask(() => a.emit('message', structuredClone(value))); done?.(); };
  const { ProcessPeer } = await import(pathToFileURL(join(modules, 'jarvis/process-runtime/ipc.mjs')));
  const hostPeer = new ProcessPeer(a), ownerPeer = new ProcessPeer(b);
  let transport = new transportModule.NativeTransport(ownerPeer, config, { managementOnly });
  const store = new coreModule.Store(join(stateDir, 'core.sqlite')); transport.bindStore(store);
  let current = true, ended = false, policy = { sessionId: 'fixture-worker', role, cwd: workspace, skillDirectory: workspace, ticketId: role === 'worker' ? 'fixture-ticket' : undefined,
    assignmentId: role === 'worker' ? 'assignment-one' : undefined, promptRevision: 1, prompt: 'Original full fixture policy', complete: role === 'orchestrator',
    skills: [], selectedSkills: [], tools: [], allowedTools, initialModel: config.model, environment: { ORG: config.instanceId, GH_TOKEN: undefined } };
  const authorizations = [], observed = [];
  const callbacks = {
    policy: (_id, bind) => { if (bind) store.set('prompt-bound', (store.get('prompt-bound') ?? 0) + 1); return policy; },
    authorize: (_id, operation, toolName) => { authorizations.push({ operation, toolName }); if (ended) throw new Error('Ticket ended'); },
    authorizeCapabilityStop: operationId => {
      if (host.capabilityHold?.operationId !== operationId || !host.capabilityHold.frozen || host.closed || host.closing) throw new Error('Native capability stop has no frozen maintenance owner');
    },
    capabilityFrozen: () => Boolean(host.capabilityHold?.frozen),
    tool: async (_id, name, args) => ({ name, args, business: true }), event: event => observed.push(event),
  };
  if (!managementOnly) transport.sessions.install(callbacks);
  let host = new hostModule.NativeHost(ctx, config, hostPeer, { managementOnly, isCurrent: () => current });
  let closed = false, expectedCloseFailure; const beforeClose = [];
  async function close() {
    if (closed) return; closed = true;
    for (const stop of beforeClose.reverse()) await stop();
    if (expectedCloseFailure) {
      // An uncertain upstream producer must remain a failed stop. Release only
      // the isolated fixture resources after asserting that production result.
      await assert.rejects(host.close(), expectedCloseFailure);
      for (const dispose of host.disposers.splice(0)) await dispose();
      host.wire.close(); await host.pumping; host.journal.close();
    } else await host.close();
    transport.close(); hostPeer.close(); ownerPeer.close(); store.close();
    for (const handle of controllerHandles.reverse()) await handle.dispose();
    for (const scope of nativeScopes.reverse()) await scope.dispose(); await ctx.fiber.dispose();
    const part = relative(resolve(tmpdir()), resolve(directory)); assert.ok(part.startsWith('original-native-host-') && !isAbsolute(part) && !part.includes('..'));
    rmSync(directory, { recursive: true, force: true });
  }
  cleanup = close;
  return { ctx, directory, modules, config, get host() { return host; }, get transport() { return transport; }, store, coreModule, scopeModule, promptModule, toolsModule, tool, toolCalls, modelCalls, authorizations, observed, errors, controllerCalls, workspaceAccounts,
    close, beforeClose: stop => beforeClose.push(stop), expectCloseFailure: error => { expectedCloseFailure = error; }, setPolicy: value => { policy = { ...policy, ...value }; }, policy: () => policy, end: () => { ended = true; }, obsolete: () => { current = false; },
    setResponder: value => { responder = value; },
    ensure: () => transport.sessions.ensure({ sessionId: policy.sessionId, role: policy.role, cwd: policy.cwd, title: 'Isolated original native fixture', model: config.model }),
    execute: (name, args = {}, agent = ctx.agents.get(policy.sessionId)) => ctx.tools.execute({ callId: `fixture-${name}-${Date.now()}`, name, arguments: args, agent, signal: new AbortController().signal }),
    assemble: (agent = ctx.agents.get(policy.sessionId), signal) => ctx.systemPrompt.assemble({ agent, scope: agent, ...(signal ? { signal } : {}) }),
    load,
    managerClass: async () => (await import(pathToFileURL(join(modules, 'jarvis/process-runtime/manager.mjs')))).ProcessManager,
    closeControllerSession: async id => {
      const index = controllerHandles.findIndex(handle => handle.agent.id === id);
      assert.notEqual(index, -1); await controllerHandles.splice(index, 1)[0].dispose();
    },
    restartSkills: async () => {
      await skillsProvider.dispose();
      skillsProvider = ctx.plugin({ name: 'fixture-skills-provider', apply(scope) { new skillsModule.SkillRegistry(scope); } });
      await skillsProvider;
    },
    restartNative: async (adoption) => {
      await host.close(); transport.close();
      transport = new transportModule.NativeTransport(ownerPeer, config, { managementOnly }); transport.bindStore(store);
      if (!managementOnly) transport.sessions.install(callbacks);
      host = new hostModule.NativeHost(ctx, config, hostPeer, { managementOnly, isCurrent: () => current, adoption });
    },
  };
}
