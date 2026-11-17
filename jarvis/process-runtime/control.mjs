import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProcessManager } from './manager.mjs';
import { CapabilityApplications } from './capability-applications.mjs';
import { WORKER_TOOL_NAMES, WorkerSkillsSchema, effectiveWorkerTools, normalizeEngineConfig, defaultEngineConfig } from '../../lib/process-runtime.js';

const tools = ['read', 'glob', 'grep'];
// Read-only execution projections may round-trip with an organization form, but are never persisted or applied.
const nodeKeys = new Set(['id', 'parent', 'kind', 'name', 'brainName', 'description', 'capabilities', 'concurrency', 'workerTools', 'workerSkills', 'roleModels', 'workspace', 'redelegate', 'model', 'engine', 'execution', 'executionError']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const samePath = (first, second) => relative(first, second) === '';
const idPattern = /^[a-z][a-z0-9-]{0,47}$/;
const reservedId = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const clone = value => structuredClone(value);

/** Expected management error whose status may be returned by the host's authenticated HTTP route. */
export class SystemControlError extends Error {
  constructor(status, message, options) { super(message, options); this.name = 'SystemControlError'; this.status = status; }
}

function text(value, name, limit, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new SystemControlError(400, `${name}格式无效或超过长度限制`);
  return value.trim();
}

function modelReference(value) {
  if (value == null) throw new SystemControlError(400, '尚未配置可用模型，请先在模型设置中保存宿主模型');
  if (!object(value) || Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) {
    throw new SystemControlError(400, '只能选择宿主已有的 DSH 模型；模型凭据由宿主管理');
  }
  const provider = text(value.provider, '模型服务标识', 200), model = text(value.model, '模型标识', 200);
  if (!provider || !model) throw new SystemControlError(400, '请选择宿主已有的模型服务和模型');
  const reasoningEffort = value.reasoningEffort === undefined ? undefined : text(value.reasoningEffort, '推理强度', 80);
  if (reasoningEffort === '') throw new SystemControlError(400, '推理强度不能为空');
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

// Resolve existing ancestors before mkdir so a symlink cannot create directories outside the managed root.
function managedPath(root, value) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) throw new SystemControlError(400, '实例工作目录必须是绝对路径');
  const absolute = resolve(value);
  if (!within(root, absolute)) throw new SystemControlError(400, '实例目录必须位于当前运行服务的数据根目录内');
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  if (parts.some(part => /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) throw new SystemControlError(400, '实例目录包含无效路径字符');
  const missing = [];
  let ancestor = absolute;
  while (!existsSync(ancestor)) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  if (!statSync(ancestor).isDirectory()) throw new SystemControlError(400, '实例目录指向了文件，请选择目录');
  const canonical = resolve(realpathSync(ancestor), ...missing);
  if (!within(root, canonical)) throw new SystemControlError(400, '实例目录不能通过链接指向运行数据根目录之外');
  return canonical;
}

function atomicConfig(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function lifecycle(file, instanceId) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size, length = Math.min(size, 65536), buffer = Buffer.alloc(length), fd = openSync(file, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  const lines = buffer.toString('utf8').split('\n');
  if (size > length) lines.shift();
  return lines.flatMap(line => {
    let row;
    try { row = JSON.parse(line); } catch { return []; }
    if (!object(row) || row.instanceId !== instanceId || !['start', 'ready', 'stop', 'exit', 'initialization-failed'].includes(row.event)) return [];
    return [{ at: typeof row.at === 'string' ? row.at.slice(0, 80) : null, event: row.event,
      generation: Number.isSafeInteger(row.generation) ? row.generation : null,
      pid: Number.isSafeInteger(row.pid) ? row.pid : null,
      ...(row.event === 'exit' ? { code: Number.isSafeInteger(row.code) ? row.code : null,
        signal: typeof row.signal === 'string' && /^[A-Z0-9-]{1,30}$/i.test(row.signal) ? row.signal : null } : {}) }];
  }).slice(-50);
}

/** Explicitly saved local single-hop configuration; this owns one manager for the lifetime of its host. */
export class SystemControl {
  constructor(ctx, { rootDir, defaultModel, validateModel, capabilityCatalog, managerOptions } = {}) {
    if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) throw new SystemControlError(400, '运行服务的数据根目录必须是绝对路径');
    mkdirSync(rootDir, { recursive: true });
    this.rootDir = realpathSync(rootDir); this.file = join(this.rootDir, 'system-config.json');
    this.defaultModel = defaultModel; this.validateModel = validateModel;
    this.capabilityCatalog = capabilityCatalog; this.catalogCache = new Map();
    this.revision = 0; this.nodes = null; this.identities = {}; this.saving = false; this.actions = new Map(); this.closing = false;
    let capabilityApplications = [];
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!object(saved) || saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || !object(saved.identities)) throw new Error('Invalid format');
        this.nodes = this.normalizeNodes(saved.nodes, false); this.revision = saved.revision;
        capabilityApplications = saved.capabilityApplications ?? [];
        this.identities = Object.fromEntries(Object.entries(saved.identities).map(([id, workspace]) => {
          if (!idPattern.test(id) || reservedId.test(id)) throw new Error('Invalid identity');
          return [id, this.workspace(workspace)];
        }));
        for (const node of this.nodes) if (!Object.hasOwn(this.identities, node.id) || !samePath(this.identities[node.id], node.workspace)) throw new Error('Instance identity mismatch');
      } catch (cause) { throw new SystemControlError(500, '已保存的系统配置无效，原文件已保留，请检查服务日志', { cause }); }
    }
    try { this.capabilities = new CapabilityApplications(this, capabilityApplications); }
    catch (cause) { throw new SystemControlError(500, '已保存的 Worker 设置应用记录无效，原文件已保留，请检查服务日志', { cause }); }
    this.manager = new ProcessManager(ctx, { rootDir: this.rootDir, instances: this.nodes ? this.runtimeConfig(this.nodes) : [] },
      { ...managerOptions, initialCapabilityHolds: this.capabilities.initialHolds() });
    this.initialization = this.capabilities.recover().catch(error => { this.initializationError = error; });
  }
  commitConfiguration({ revision, nodes, identities, capabilityApplications = this.capabilities.records }) {
    atomicConfig(this.file, { version: 1, revision, nodes, identities, capabilityApplications });
    this.nodes = nodes; this.identities = identities; this.revision = revision;
  }
  async capabilityOperation(work) {
    try { return await work(); }
    catch (error) {
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 600) throw new SystemControlError(error.status, error.message, { cause: error });
      throw error;
    }
  }
  currentDefaultModel() {
    try {
      const value = typeof this.defaultModel === 'function' ? this.defaultModel() : this.defaultModel;
      return value == null ? null : modelReference(value);
    } catch { return null; }
  }
  workspace(value, id) {
    const workspace = managedPath(this.rootDir, value === undefined || value === '' ? join(this.rootDir, 'workspaces', id) : value);
    const reserved = ['instances', 'system-config.json', 'processes.json'].map(name => join(this.rootDir, name));
    if (samePath(workspace, this.rootDir) || reserved.some(path => within(path, workspace) || within(workspace, path))) throw new SystemControlError(400, '工作目录必须与服务托管的配置和实例状态分开');
    return workspace;
  }
  stateDirectory(id) {
    const expected = join(this.rootDir, 'instances', id, 'state'), directory = managedPath(this.rootDir, expected);
    if (!samePath(directory, expected)) throw new SystemControlError(400, '服务托管的状态目录不能通过链接改指其他位置');
    return directory;
  }
  initialNodes() {
    const model = this.currentDefaultModel();
    return [{ id: 'root', parent: null, kind: 'root', name: '集团中枢', brainName: '贾维斯', description: '统一接收目标，协调交付。',
      capabilities: '', concurrency: 3, workerTools: [...tools], workspace: this.workspace('', 'root'),
      model, roleModels: { router: clone(model), worker: clone(model) }, engine: defaultEngineConfig() }];
  }
  normalizeNodes(value, useDefault = true) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 60) throw new SystemControlError(400, '系统需要一个根实例，最多支持 59 个直属下级实例');
    const defaultModel = useDefault ? this.currentDefaultModel() : null, ids = new Set();
    const nodes = value.map(raw => {
      if (!object(raw) || Object.keys(raw).some(key => !nodeKeys.has(key))) throw new SystemControlError(400, '实例配置包含当前运行服务不支持的字段');
      if (typeof raw.id !== 'string' || !idPattern.test(raw.id) || reservedId.test(raw.id) || ids.has(raw.id)) throw new SystemControlError(400, '实例标识无效或重复');
      ids.add(raw.id);
      const root = raw.id === 'root';
      if (raw.kind !== (root ? 'root' : 'instance') || raw.parent !== (root ? null : 'root')) throw new SystemControlError(400, '当前只支持一个根实例及其直属下级');
      // Accept the retired field from saved configurations and older clients without treating it as policy.
      if (raw.redelegate !== undefined && typeof raw.redelegate !== 'boolean') throw new SystemControlError(400, '旧版委派配置格式无效');
      const name = text(raw.name, '组织名称', 200), brainName = text(raw.brainName, '大脑名称', 200, '贾维斯');
      if (!name || !brainName) throw new SystemControlError(400, '组织名称和大脑名称不能为空');
      const concurrency = raw.concurrency === undefined ? 3 : raw.concurrency;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new SystemControlError(400, '实例任务并发上限必须是 1–16 的整数');
      const workerTools = raw.workerTools === undefined ? tools : raw.workerTools;
      if (!Array.isArray(workerTools) || workerTools.some(tool => !WORKER_TOOL_NAMES.includes(tool))) throw new SystemControlError(400, '包含未接入的 Worker 工具');
      const roleModels = raw.roleModels ?? {};
      if (!object(roleModels) || Object.keys(roleModels).some(role => !['worker', 'router'].includes(role))) throw new SystemControlError(400, '模型角色无效');
      const skillResult = WorkerSkillsSchema.safeParse(raw.workerSkills ?? []);
      if (!skillResult.success) throw new SystemControlError(400, 'Worker 技能选择无效');
      const model = modelReference(raw.model ?? defaultModel), previous = this.nodes?.find(node => node.id === raw.id);
      let engine;
      try { engine = normalizeEngineConfig(raw.engine ?? previous?.engine); }
      catch { throw new SystemControlError(400, '任务引擎提示词格式无效，每段最多 20000 字符'); }
      // Resolve legacy inheritance once; later brain edits and older clients cannot change other roles implicitly.
      const independentModels = Object.fromEntries(['router', 'worker'].map(role => [role,
        modelReference(Object.hasOwn(roleModels, role) ? roleModels[role] : previous?.roleModels?.[role] ?? previous?.model ?? model)]));
      return { id: raw.id, parent: root ? null : 'root', kind: root ? 'root' : 'instance', name, brainName,
        description: text(raw.description, '职责说明', 1600), capabilities: text(raw.capabilities, '能力标签', 300), concurrency,
        workerTools: [...new Set(workerTools)], workspace: this.workspace(raw.workspace, raw.id),
        model, roleModels: independentModels, engine,
        ...(raw.workerSkills ? { workerSkills: [...new Set(skillResult.data)] } : {}) };
    });
    if (!ids.has('root')) throw new SystemControlError(400, '系统必须保留根实例');
    for (const node of nodes) this.stateDirectory(node.id);
    for (let first = 0; first < nodes.length; first++) for (let second = first + 1; second < nodes.length; second++) {
      if (within(nodes[first].workspace, nodes[second].workspace) || within(nodes[second].workspace, nodes[first].workspace)) throw new SystemControlError(400, '不同实例的工作目录不能相同或互相包含');
    }
    return nodes.sort((a, b) => a.id === 'root' ? -1 : b.id === 'root' ? 1 : a.id.localeCompare(b.id));
  }
  runtimeConfig(nodes) {
    const children = nodes.filter(node => node.parent === 'root').map(node => node.id);
    return nodes.map(node => ({ instanceId: node.id, organizationName: node.name, brainName: node.brainName,
      description: [node.description || node.name, node.capabilities && `能力标签：${node.capabilities}`].filter(Boolean).join('\n'),
      stateDir: this.stateDirectory(node.id), workspace: node.workspace, engine: clone(node.engine), model: { ...node.model }, roleModels: clone(node.roleModels ?? {}), workerSkills: [...node.workerSkills ?? []], workerTools: [...node.workerTools], maxWorkers: node.concurrency,
      children: node.id === 'root' ? children : [], parents: children.includes(node.id) ? ['root'] : [] }));
  }
  assertRevision(revision) {
    if (!Number.isSafeInteger(revision) || revision !== this.revision) throw new SystemControlError(409, '系统配置已更新，请重新读取后再保存或操作实例');
    if (this.closing) throw new SystemControlError(503, '系统管理服务正在关闭');
  }
  async checkModel(model) {
    if (this.validateModel) {
      try {
        if (await this.validateModel(clone(model)) === false) throw new SystemControlError(400, '所选模型在当前 DSH 宿主中不可用');
      } catch (cause) {
        if (cause instanceof SystemControlError) throw cause;
        throw new SystemControlError(400, '所选模型或推理强度在当前 DSH 宿主中不可用', { cause });
      }
    } else if (JSON.stringify(model) !== JSON.stringify(this.currentDefaultModel())) {
      throw new SystemControlError(400, '当前仅能选择助手已保存的宿主模型');
    }
  }
  async get() {
    const nodes = this.nodes ?? this.initialNodes(), catalogs = {};
    const projected = [];
    for (const node of nodes) {
      const view = await this.executionView(node);
      projected.push({ ...clone(node), ...view });
      if (this.capabilityCatalog) {
        try {
          if (view.executionError) throw new Error(view.executionError);
          catalogs[node.id] = await this.catalog(view.execution?.directory ?? node.workspace);
        } catch { catalogs[node.id] = { tools: [], skills: [], complete: false, error: '暂时无法读取当前执行目录的工具与技能，请重新连接后再试。' }; }
      }
    }
    return { available: true, revision: this.revision, configured: this.nodes !== null, rootId: 'root', nodes: projected,
      defaults: { model: this.currentDefaultModel(), workerTools: [...tools], engine: defaultEngineConfig() }, catalogs, runtime: this.manager.status() };
  }
  /** The original versioned settings remain the only authority after first initialization. */
  async executionView(node) {
    if (!this.nodes || !existsSync(join(this.stateDirectory(node.id), 'orchestrator.sqlite'))) return { execution: null };
    try {
      const response = await this.manager.management(node.id, { method: 'GET', path: 'settings' });
      const value = response.body, executor = value?.blocks?.executor, evaluation = value?.blocks?.eval;
      if (response.status !== 200 || !Number.isSafeInteger(executor?.value?.maxWorkers) || executor.value.maxWorkers < 1 || !evaluation || typeof value.environment?.root !== 'string') throw new Error('Incomplete original settings');
      return { execution: { evalModel: clone(evaluation.value.model), workerModel: clone(executor.value.model), maxWorkers: executor.value.maxWorkers,
        directory: value.environment.root, revisions: { eval: evaluation.revision, executor: executor.revision } } };
    } catch { return { execution: null, executionError: '任务引擎设置暂未同步，请重新读取。' }; }
  }
  async workerCapabilities(id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.revision;
      const value = await this.workerCapabilitiesSnapshot(id);
      if (revision === this.revision) return value;
    }
    throw new SystemControlError(503, 'Worker 设置正在应用，请稍后重新读取');
  }
  async workerCapabilitiesSnapshot(id) {
    const node = this.nodes?.find(item => item.id === id);
    if (!node) throw new SystemControlError(404, '请先保存当前组织');
    const view = await this.executionView(node);
    if (view.executionError && !this.capabilities.affected(id)) throw new SystemControlError(503, view.executionError);
    const catalog = view.executionError ? { tools: [], skills: [], complete: false, error: view.executionError }
      : this.capabilityCatalog ? await this.catalog(view.execution?.directory ?? node.workspace)
      : { tools: [], skills: [], complete: false, error: '暂时无法读取当前组织的工具与技能，请重试。' };
    const application = await this.capabilities.view(id);
    const current = this.nodes.find(item => item.id === id), pending = this.capabilities.pending(id);
    return { revision: this.revision, tools: [...pending?.tools ?? current.workerTools], skills: [...pending?.skills ?? current.workerSkills ?? []],
      applied: { tools: [...current.workerTools], skills: [...current.workerSkills ?? []] },
      effective: effectiveWorkerTools(current.workerTools), catalog: clone(catalog), ...(application ? { application } : {}) };
  }
  /** Scoped management delegates original Superagent operations to the process that owns this organization. */
  async management(id, request) {
    await this.initialization;
    if (this.closing) throw new SystemControlError(503, '组织管理服务正在关闭');
    const node = this.nodes?.find(item => item.id === id);
    if (!node) throw new SystemControlError(404, '请先保存当前组织');
    if (request.path === 'worker-capabilities') {
      if (request.method === 'GET') return { status: 200, body: await this.workerCapabilities(id) };
      if (request.method === 'PUT') {
        const input = request.body;
        if (!object(input) || Object.keys(input).some(key => !['revision', 'tools', 'skills'].includes(key))
          || !Array.isArray(input.tools) || !Array.isArray(input.skills)) throw new SystemControlError(400, 'Worker 工具与技能设置格式无效');
        this.assertRevision(input.revision);
        await this.capabilityOperation(() => this.capabilities.save(id, input));
        return { status: 200, body: await this.workerCapabilities(id) };
      }
    }
    if (request.path === 'worker-capabilities/application' && request.method === 'POST') {
      const input = request.body;
      if (!object(input) || Object.keys(input).some(key => !['revision', 'applicationId', 'action', 'confirmation'].includes(key))
        || typeof input.applicationId !== 'string' || !['cancel', 'retry', 'apply-now'].includes(input.action)
        || input.confirmation !== undefined && typeof input.confirmation !== 'string') throw new SystemControlError(400, 'Worker 设置应用请求格式无效');
      await this.capabilityOperation(() => this.capabilities.action(id, input));
      return { status: 200, body: await this.workerCapabilities(id) };
    }
    return this.manager.management(id, request);
  }
  previewPrompts(id, input) {
    throw new SystemControlError(410, '旧五段提示词预览已停用，请进入当前组织的任务引擎 → 提示词查看原 Superagent 完整提示词。');
  }
  async catalog(workspace, fresh = false) {
    const old = this.catalogCache.get(workspace);
    if (!fresh && old && Date.now() - old.at < 30000) return clone(old.value);
    const value = await this.capabilityCatalog(workspace);
    this.catalogCache.set(workspace, { at: Date.now(), value: clone(value) });
    return value;
  }
  async checkExecution(node) {
    const view = await this.executionView(node);
    if (view.executionError) throw new SystemControlError(503, view.executionError);
    const roleModels = view.execution ? [view.execution.evalModel, view.execution.workerModel] : Object.values(node.roleModels ?? {});
    for (const model of [node.model, ...roleModels].filter(Boolean)) await this.checkModel(model);
    if (!this.capabilityCatalog) {
      if (node.workerTools.some(name => !tools.includes(name)) || node.workerSkills?.length) throw new SystemControlError(400, '宿主未提供 Worker 能力目录');
      return;
    }
    const catalog = await this.catalog(view.execution?.directory ?? node.workspace, true);
    for (const name of node.workerTools) if (!catalog.tools.some(tool => tool.name === name && tool.available)) throw new SystemControlError(400, `Worker 工具 ${name} 在当前宿主不可用`);
    if (node.workerSkills?.length && !catalog.complete) throw new SystemControlError(400, '技能目录尚未完整读取，请稍后再试');
    for (const name of node.workerSkills ?? []) if (!catalog.skills.some(skill => skill.name === name)) throw new SystemControlError(400, `Worker 技能 ${name} 在当前工作目录不可用`);
  }
  async save(input) {
    await this.initialization;
    if (!object(input) || Object.keys(input).some(key => !['revision', 'nodes'].includes(key))) throw new SystemControlError(400, '系统配置请求格式无效');
    this.assertRevision(input.revision);
    if (this.saving || this.actions.size) throw new SystemControlError(409, '系统配置保存或实例启停正在进行，请稍后重试');
    this.saving = true;
    try {
      const nodes = this.normalizeNodes(input.nodes), identities = { ...this.identities };
      for (const node of nodes) {
        const stateDir = this.stateDirectory(node.id), hasState = existsSync(stateDir) && readdirSync(stateDir).length > 0;
        if (!Object.hasOwn(identities, node.id) && hasState) throw new SystemControlError(409, '该实例的状态目录已有未登记数据，请检查原配置，不能自动接管');
        if (Object.hasOwn(identities, node.id) && !samePath(identities[node.id], node.workspace) && hasState) {
          throw new SystemControlError(409, '该实例已有持久状态，不能改指其他工作目录');
        }
        identities[node.id] = node.workspace;
        await this.checkExecution(node);
      }
      this.assertRevision(input.revision);
      this.capabilities.assertUnrelated(this.manager.affectedInstances(this.runtimeConfig(nodes)));
      const revision = this.revision + 1;
      await this.manager.reconfigureManaged(this.runtimeConfig(nodes), { persist: () => this.commitConfiguration({ revision, nodes, identities }) });
      this.nodes = nodes; this.identities = identities; this.revision = revision;
      return this.get();
    } catch (error) {
      if (error instanceof SystemControlError) throw error;
      if (error.status) throw new SystemControlError(error.status, error.message, { cause: error });
      if (/must be stopped|already in progress/.test(error.message)) throw new SystemControlError(409, '请先停止所有受本次配置变更影响的实例，并等待会话清理完成', { cause: error });
      if (/Cannot reassign/.test(error.message)) throw new SystemControlError(409, '已有持久状态的目录不能改指其他实例或工作目录', { cause: error });
      throw new SystemControlError(500, '系统配置未能保存，已恢复原配置，请检查服务日志', { cause: error });
    } finally { this.saving = false; }
  }
  async action(id, action, revision) {
    await this.initialization;
    this.assertRevision(revision);
    if (!this.nodes?.some(node => node.id === id)) throw new SystemControlError(404, '未找到已保存的 SuperJarvis 实例');
    if (!['start', 'stop', 'restart'].includes(action)) throw new SystemControlError(400, '不支持此实例运行操作');
    await this.capabilityOperation(() => this.capabilities.assertUnrelated([id]));
    if (this.saving || this.actions.has(id)) throw new SystemControlError(409, '实例启停或系统配置保存正在进行，请稍后重试');
    this.actions.set(id, action);
    try {
      if (action !== 'stop') await this.checkExecution(this.nodes.find(node => node.id === id));
      await this.manager[action](id);
      const runtime = this.manager.status().instances.find(instance => instance.instanceId === id);
      if (runtime.phase !== (action === 'stop' ? 'stopped' : 'running') || runtime.cleanupPending || action === 'stop' && runtime.pid !== null) {
        throw new SystemControlError(503, '实例运行操作尚未完成，请查看运行状态和会话清理结果');
      }
      return this.get();
    } catch (error) {
      if (error instanceof SystemControlError) throw error;
      throw new SystemControlError(503, '实例运行操作失败，请查看运行状态和服务日志', { cause: error });
    } finally { this.actions.delete(id); }
  }
  async detail(id) {
    const node = this.nodes?.find(node => node.id === id);
    if (!node) throw new SystemControlError(404, '未找到已保存的 SuperJarvis 实例');
    let runtime = this.manager.status().instances.find(instance => instance.instanceId === id), stateAvailable = false, queryError;
    let counts = { workersRunning: null, tickets: null, openTickets: null };
    if (runtime.phase === 'running') {
      try {
        const state = await this.manager.state(id), current = this.manager.status().instances.find(instance => instance.instanceId === id);
        if (current.phase !== 'running' || current.generation !== runtime.generation) throw new Error('Instance generation changed');
        // Absent fields remain unknown; transport fixtures and old runtimes must not imply zero live work.
        counts = { workersRunning: Array.isArray(state.active) ? state.active.filter(request => request?.role === 'worker').length : null,
          tickets: Array.isArray(state.tickets) ? state.tickets.length : null,
          openTickets: Array.isArray(state.tickets) ? state.tickets.filter(ticket => !ticket.ended).length : null };
        stateAvailable = true; runtime = current;
      } catch { queryError = '暂时无法读取实例的实时运行数据'; runtime = this.manager.status().instances.find(instance => instance.instanceId === id); }
    }
    return { available: true, revision: this.revision, instanceId: id, node: { ...clone(node), ...await this.executionView(node) }, runtime, stateAvailable, counts,
      lifecycle: lifecycle(join(this.stateDirectory(id), 'lifecycle.jsonl'), id), ...(queryError ? { queryError } : {}) };
  }
  async close() {
    this.closing = true;
    await this.capabilities.close();
    return this.manager.close();
  }
}
