import { createHash, randomUUID } from 'node:crypto';

const active = item => !['applied', 'cancelled'].includes(item.state);
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });

/** Durable, organization-scoped transitions; the original runtime remains the work authority. */
export class CapabilityApplications {
  constructor(control, records = []) {
    this.control = control;
    if (!Array.isArray(records)) throw new Error('Invalid capability application records');
    const seen = new Set(), held = new Set();
    this.records = records.map(record => {
      if (!record || typeof record.id !== 'string' || seen.has(record.id)
        || typeof record.instanceId !== 'string'
        || !['waiting', 'applying', 'failed', 'applied', 'cancelled'].includes(record.state)
        || !['waiting', 'forcing', 'stopping', 'configuring', 'committed', 'releasing', 'cancelling', 'complete'].includes(record.stage)
        || !active(record) && record.stage !== 'complete'
        || active(record) && record.stage === 'complete'
        || record.state === 'waiting' && record.stage !== 'waiting'
        || !Array.isArray(record.affected) || !record.affected.includes(record.instanceId)
        || active(record) && record.affected.some(id => !control.nodes?.some(node => node.id === id))
        || !Array.isArray(record.desiredRunning) || record.desiredRunning.some(id => !record.affected.includes(id))
        || !Array.isArray(record.tools) || !Array.isArray(record.skills)
        || typeof record.savedAt !== 'string') throw new Error('Invalid capability application record');
      const proposed = clone(control.nodes), node = proposed?.find(node => node.id === record.instanceId);
      if (node) {
        node.workerTools = record.tools; node.workerSkills = record.skills;
        control.normalizeNodes(proposed, false);
      }
      seen.add(record.id);
      if (active(record)) for (const id of record.affected) {
        if (held.has(id)) throw new Error('Overlapping pending capability applications');
        held.add(id);
      }
      return clone(record);
    });
    this.busy = null; this.closed = false;
  }
  initialHolds() { return this.records.filter(active).flatMap(item => item.affected.map(instanceId =>
    ({ instanceId, operationId: item.id, frozen: item.stage === 'configuring' }))); }
  pending(id) { return this.records.find(item => active(item) && item.instanceId === id); }
  latest(id) { return this.pending(id) ?? this.records.findLast(item => item.instanceId === id); }
  affected(id) { return this.records.find(item => active(item) && item.affected.includes(id)); }
  assertUnrelated(ids) {
    const blocked = this.records.find(item => active(item) && item.affected.some(id => ids.includes(id)));
    if (blocked) throw failure(409, '相关组织正在应用 Worker 设置，请先完成或取消待生效设置');
  }
  persist(records = this.records, nodes = this.control.nodes) {
    this.control.commitConfiguration({ revision: this.control.revision + 1, nodes, identities: this.control.identities, capabilityApplications: records });
    this.records = records;
  }
  update(id, change, nodes) {
    const records = this.records.map(item => item.id === id ? { ...item, ...clone(change), updatedAt: now() } : item);
    this.persist(records, nodes);
    return this.records.find(item => item.id === id);
  }
  async exclusive(work) {
    if (this.closed) throw failure(503, '组织设置服务正在关闭');
    if (this.busy || this.control.saving || this.control.actions.size) throw failure(409, '组织设置正在应用，请稍后重试');
    this.control.saving = true;
    const operation = Promise.resolve().then(work); this.busy = operation;
    try { return await operation; }
    finally { if (this.busy === operation) this.busy = null; this.control.saving = false; this.schedule(); }
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.closed || !this.records.some(item => active(item) && item.state !== 'failed')) return;
    this.timer = setTimeout(() => { void this.tick().catch(() => this.schedule()); }, 1000);
    this.timer.unref?.();
  }
  async recover() {
    // Holds are installed in the manager constructor before its own restart recovery.
    await this.control.manager.initialization;
    await this.tick();
  }
  async tick() {
    if (this.closed) return;
    return this.exclusive(async () => {
      for (const record of this.records.filter(item => active(item) && item.state !== 'failed')) await this.advance(record.id);
    });
  }
  async save(instanceId, input) {
    return this.exclusive(async () => {
      const control = this.control;
      control.assertRevision(input.revision);
      const pending = this.pending(instanceId);
      if (pending) throw failure(409, '当前组织已有待生效设置，请先取消或完成应用');
      const original = control.nodes.find(item => item.id === instanceId);
      const proposed = clone(control.nodes), node = proposed.find(item => item.id === instanceId);
      node.workerTools = input.tools; node.workerSkills = input.skills;
      const normalized = control.normalizeNodes(proposed), target = normalized.find(item => item.id === instanceId);
      await control.checkExecution(target);
      control.assertRevision(input.revision);
      const affected = control.manager.affectedInstances(control.runtimeConfig(normalized));
      if (!affected.length) return;
      this.assertUnrelated(affected);
      const statuses = control.manager.status().instances;
      if (statuses.some(item => affected.includes(item.instanceId) && ['starting', 'stopping'].includes(item.phase))) throw failure(409, '相关组织正在启停，请稍后再保存');
      const record = { id: randomUUID(), instanceId, state: 'waiting', stage: 'waiting', savedAt: now(),
        tools: target.workerTools, skills: target.workerSkills ?? [],
        previous: { tools: clone(original.workerTools), skills: clone(original.workerSkills ?? []) },
        affected, desiredRunning: statuses.filter(item => affected.includes(item.instanceId) && item.phase === 'running').map(item => item.instanceId) };
      // Persist first. A host crash after this point restores the same holds and target.
      this.persist([...this.records, record]);
      await this.advance(record.id);
    });
  }
  async action(instanceId, input) {
    return this.exclusive(async () => {
      this.control.assertRevision(input.revision);
      let record = this.pending(instanceId);
      if (!record || input.applicationId !== record.id) throw failure(409, '待生效设置已变化，请重新读取');
      if (input.action === 'cancel') {
        if (['forcing', 'configuring', 'committed', 'releasing'].includes(record.stage)) throw failure(409, '配置正在执行已确认的变更，请重试应用');
        record = this.update(record.id, { state: 'applying', stage: 'cancelling', error: undefined });
      } else if (input.action === 'retry') {
        if (record.state !== 'failed') throw failure(409, '该设置无需重试，请重新读取');
        record = this.update(record.id, { state: record.stage === 'waiting' ? 'waiting' : 'applying', error: undefined });
      } else if (input.action === 'apply-now') {
        if (record.stage !== 'waiting' || record.state === 'applying') throw failure(409, '配置已在应用，请重新读取');
        const covered = await this.coverDelegationLimits(record);
        if (covered !== record) throw failure(409, '受影响的组织已更新，请重新查看并确认需要停止的工作');
        const activity = await this.control.manager.capabilityActivity(record.affected);
        const confirmation = this.confirmation(record, activity);
        if (!confirmation || input.confirmation !== confirmation) throw failure(409, '相关工作已变化，请重新查看并确认需要停止的工作');
        record = this.update(record.id, { state: 'applying', stage: 'forcing', forceActivity: activity, error: undefined });
      } else throw failure(400, '不支持此设置操作');
      await this.advance(record.id);
    });
  }
  confirmation(record, activity) {
    if (!activity || typeof activity.fingerprint !== 'string' || activity.instances.some(item => item.error || item.unknown
      || item.work?.some(work => work.kind === 'unknown' || work.kind === 'lifecycle'))) return undefined;
    return digest({ id: record.id, tools: record.tools, skills: record.skills, fingerprint: activity.fingerprint });
  }
  async restoreRunning(record) {
    for (const id of record.desiredRunning) {
      const current = this.control.manager.status().instances.find(item => item.instanceId === id);
      if (this.control.canRecoverInstance?.(id) === false) continue;
      if (current?.phase !== 'running') await this.control.manager.start(id, { capabilityOperationId: record.id });
    }
  }
  targetNodes(record) {
    const nodes = clone(this.control.nodes), node = nodes.find(item => item.id === record.instanceId);
    node.workerTools = clone(record.tools); node.workerSkills = clone(record.skills);
    return nodes;
  }
  async coverDelegationLimits(record) {
    const manager = this.control.manager, nodes = this.targetNodes(record);
    const additional = manager.affectedInstances(this.control.runtimeConfig(nodes)).filter(id => !record.affected.includes(id));
    if (!additional.length) return record;
    // A pending intent written by an older host may omit a child's incoming grant.
    this.assertUnrelated(additional);
    const running = manager.status().instances.filter(item => additional.includes(item.instanceId) && item.phase === 'running');
    record = this.update(record.id, { affected: [...record.affected, ...additional], desiredRunning: [...record.desiredRunning, ...running.map(item => item.instanceId)] });
    await manager.holdCapabilities(additional, record.id);
    return record;
  }
  async advance(id) {
    let record = this.records.find(item => item.id === id);
    if (!record || !active(record) || record.state === 'failed' || this.closed) return;
    const control = this.control, manager = control.manager;
    try {
      await manager.holdCapabilities(record.affected, record.id);
      if (record.stage === 'cancelling') {
        await this.restoreRunning(record);
        await manager.releaseCapabilities(record.affected, record.id);
        this.update(id, { state: 'cancelled', stage: 'complete', cancelledAt: now(), error: undefined });
        return;
      }
      if (record.stage === 'forcing') {
        const nodes = this.targetNodes(record);
        await control.checkExecution(nodes.find(item => item.id === record.instanceId));
        await manager.cancelCapabilityWork(record.affected, record.id, record.forceActivity);
        const needsNewScope = manager.affectedInstances(control.runtimeConfig(nodes)).some(instanceId => !record.affected.includes(instanceId));
        record = this.update(id, { state: 'applying', stage: needsNewScope ? 'stopping' : 'configuring', error: undefined });
      }
      // Older versions wrote this stage before stopping the instances. Resume an
      // ordinary drain under the new policy without stopping any remaining owners.
      if (record.stage === 'stopping') {
        await manager.unfreezeCapabilityWork(record.affected, id);
        record = this.update(id, { state: 'waiting', stage: 'waiting', forceActivity: undefined });
      }
      if (record.stage === 'waiting') {
        record = await this.coverDelegationLimits(record);
        await this.restoreRunning(record);
        const activity = await manager.capabilityActivity(record.affected);
        if (activity.busy) return;
        await control.checkExecution(this.targetNodes(record).find(item => item.id === record.instanceId));
        if (!await manager.freezeIdleCapabilities(record.affected, id)) return;
        try { record = this.update(id, { state: 'applying', stage: 'configuring', error: undefined }); }
        catch (error) { await manager.unfreezeCapabilityWork(record.affected, id); throw error; }
      }
      if (record.stage === 'configuring') {
        const nodes = this.targetNodes(record);
        await control.checkExecution(nodes.find(item => item.id === record.instanceId));
        await manager.configureCapabilities(record.affected, id, control.runtimeConfig(nodes), () => {
          record = this.update(id, { state: 'applying', stage: 'committed', committedAt: now(), error: undefined }, nodes);
        });
      }
      if (record.stage === 'committed' || record.stage === 'releasing') {
        // The acknowledged work has stopped and the new config is committed.
        // Keep admission held, but allow original Session attachment at startup.
        await manager.unfreezeCapabilityWork(record.affected, record.id);
        await this.restoreRunning(record);
        record = this.update(id, { state: 'applying', stage: 'releasing' });
        await manager.releaseCapabilities(record.affected, record.id);
        this.update(id, { state: 'applied', stage: 'complete', appliedAt: now(), error: undefined });
      }
    } catch (error) {
      const current = this.records.find(item => item.id === id);
      // Keep the durable stage: retry resumes exactly where the failure occurred.
      this.update(id, { state: 'failed', ...(current.stage === 'forcing' && error.status === 409 ? { stage: 'waiting', forceActivity: undefined } : {}),
        error: error.message || '配置应用失败，请重试' });
      if (!['configuring', 'committed', 'releasing', 'forcing'].includes(current.stage)) {
        try { await this.restoreRunning(current); } catch { /* Hold and failure remain visible; retry owns recovery. */ }
      }
    }
  }
  async view(instanceId) {
    const record = this.latest(instanceId);
    if (!record) return undefined;
    let activity;
    if (active(record)) {
      try { activity = await this.control.manager.capabilityActivity(record.affected); }
      catch (error) { activity = { busy: true, instances: record.affected.map(instanceId => ({ instanceId, busy: true, error: error.message })) }; }
    }
    const states = this.control.manager.status().instances;
    const affected = record.affected.map(instanceId => {
      const item = activity?.instances.find(value => value.instanceId === instanceId), status = states.find(value => value.instanceId === instanceId);
      return { instanceId, name: this.control.nodes.find(node => node.id === instanceId)?.name ?? instanceId,
        running: status?.phase === 'running', busy: item?.busy ?? false,
        work: clone(item?.work ?? []), ...(item?.error ? { error: item.error } : {}) };
    });
    const canApplyNow = active(record) && record.stage === 'waiting' && record.state !== 'applying';
    return { id: record.id, state: record.state, savedAt: record.savedAt,
      ...(record.appliedAt ? { appliedAt: record.appliedAt } : {}), ...(record.error ? { error: record.error } : {}), affected,
      canCancel: active(record) && !['configuring', 'committed', 'releasing', 'forcing'].includes(record.stage),
      canRetry: record.state === 'failed', canApplyNow,
      ...(canApplyNow ? { confirmation: this.confirmation(record, activity) } : {}) };
  }
  async close() { this.closed = true; clearTimeout(this.timer); if (this.busy) await this.busy.catch(() => {}); }
}
