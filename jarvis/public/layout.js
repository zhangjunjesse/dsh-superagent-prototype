(() => {
  const organizationId = /^[a-z][a-z0-9-]{0,47}$/;
  const workReference = /^JW-[A-Za-z0-9-]{1,196}$/;
  const states = new Set(['queued', 'routing', 'running', 'waiting', 'blocked', 'failed', 'completed', 'stopped', 'rejected', 'unknown', 'unavailable']);
  const terminals = new Set(['completed', 'stopped']);
  const stageLabels = { answer: '等待答复', review: '等待审阅', blocked: '执行受阻', failed: '执行失败', delivery: '任务输入投递受阻', queued: '等待执行' };
  const loads = new WeakMap(), details = new WeakMap();
  const string = value => typeof value === 'string' && value ? value : null;
  const time = value => string(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const latestTime = (...values) => values.map(time).filter(Boolean).sort().at(-1) || null;
  const organization = value => value && organizationId.test(value.instanceId || '')
    ? { instanceId: value.instanceId, name: string(value.name) || value.instanceId } : null;
  const issue = (code, message, organizationId = null) => ({ code, message, organizationId });
  const abort = () => { const error = new Error('经营概览读取已取消'); error.name = 'AbortError'; return error; };
  function check(request) {
    if (request?.signal?.aborted || request?.kind === 'load' && loads.get(request.client) !== request
      || request?.kind === 'detail' && details.get(request.client)?.get(request.key) !== request) throw abort();
  }
  async function read(client, path, request) {
    check(request);
    const result = await client.api(path);
    check(request);
    return result;
  }
  async function parallel(items, visit, request, concurrency = 4) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) { check(request); const index = next++; await visit(items[index], index); }
    }));
  }
  function stage(value) {
    if (!value || !['person', 'working', 'idle', 'ended'].includes(value.stage)) return null;
    return { stage: value.stage, ...(string(value.action) ? { action: value.action } : {}),
      label: stageLabels[value.action] || ({ working: '推进中', idle: '等待后续事件', ended: '已结束' })[value.stage] || '等待处理' };
  }

  function organizationsFrom(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.nodes) || snapshot.available === false) throw new Error('组织清单暂不可读取');
    const rootId = organizationId.test(snapshot.rootId || '') ? snapshot.rootId : 'root';
    const nodes = snapshot.nodes.filter(node => node && (node.id === rootId || node.kind === 'instance'));
    if (!nodes.some(node => node.id === rootId) || nodes.length > 60 || nodes.some(node => !organizationId.test(node.id || ''))
      || new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('组织清单不完整或标识无效');
    const byId = new Map(nodes.map(node => [node.id, node]));
    return nodes.map(node => {
      const path = [], seen = new Set();
      let current = node;
      while (current) {
        if (seen.has(current.id)) throw new Error('组织关系无法核实');
        seen.add(current.id); path.unshift(current.id);
        if (current.id === rootId) break;
        current = byId.get(current.parent);
        if (!current) throw new Error('组织的上级记录缺失');
      }
      return { id: node.id, instanceId: node.id, name: string(node.name) || node.id,
        parentId: node.id === rootId ? null : node.parent, depth: path.length - 1, path,
        availability: 'unavailable', phase: 'unknown', partial: false, observedAt: null, items: [] };
    }).sort((first, second) => first.depth - second.depth || first.name.localeCompare(second.name));
  }
  function taskFrom(item, source, observedAt) {
    const own = organization(item?.organization);
    if (!item || !string(item.id) || own?.instanceId !== source.instanceId || !states.has(item.status)
      || !['live', 'stored', 'unavailable'].includes(item.availability) || !string(item.statusLabel)) return null;
    const owner = organization(item.owner) || own;
    const workRef = workReference.test(item.workRef || '') ? item.workRef : null;
    const conversationId = string(item.conversationId);
    const workTrace = workRef ? `work:${owner.instanceId}:${workRef}` : null;
    const traceId = string(item.logs?.traceId);
    // The task service verifies these work identities. A title, a conversation alone, and a Worker name never join tasks.
    const verifiedWork = !!workRef && !!conversationId && traceId === workTrace;
    return { ...item, organization: own, owner, workRef, conversationId, traceId,
      observedAt: time(observedAt), stage: stage(item.stage), _verifiedWork: verifiedWork, _depth: source.depth,
      _sourcePartial: source.partial, _sourceId: source.instanceId, _sourceAvailability: source.availability };
  }
  async function taskInventory(client, organizations, request, issues) {
    const pending = new Map(organizations.map(org => [org.instanceId, 0])), seen = new Map(organizations.map(org => [org.instanceId, new Set()]));
    const byId = new Map(organizations.map(org => [org.instanceId, org]));
    let pages = 0;
    while (pending.size) {
      check(request);
      if (++pages > 1000) {
        for (const id of pending.keys()) { byId.get(id).partial = true; issues.push(issue('pagination-limit', '任务较多，本次尚未读完全部记录。', id)); }
        break;
      }
      const batches = new Map();
      for (const [id, cursor] of pending) { if (!batches.has(cursor)) batches.set(cursor, []); batches.get(cursor).push(id); }
      await parallel([...batches], async ([cursor, ids]) => {
        const query = new URLSearchParams({ limit: '20', cursor: String(cursor) });
        ids.forEach(id => query.append('organizationId', id));
        let response;
        try { response = await read(client, '/api/tasks?' + query, request); }
        catch (error) {
          if (error.name === 'AbortError') throw error;
          for (const id of ids) { byId.get(id).partial = true; pending.delete(id); issues.push(issue('task-source', '该组织的任务记录暂不可读取。', id)); }
          return;
        }
        const pages = Array.isArray(response?.organizations) ? response.organizations
          : ids.length === 1 && response?.organization ? [response.organization] : [];
        for (const id of ids) {
          const org = byId.get(id), matches = pages.filter(page => page?.instanceId === id), page = matches[0];
          pending.delete(id);
          if (matches.length !== 1 || !Array.isArray(page.items) || !['live', 'stored', 'unavailable'].includes(page.availability)) {
            org.partial = true; issues.push(issue('task-response', '该组织的任务清单不完整。', id)); continue;
          }
          org.availability = page.availability; org.phase = string(page.phase) || org.phase;
          org.observedAt = latestTime(org.observedAt, response.observedAt);
          if (page.availability === 'unavailable') {
            org.partial = true; issues.push(issue('task-source', '该组织的任务来源未能完整读取。', id));
          }
          for (const item of page.items) {
            const task = taskFrom(item, org, response.observedAt);
            if (!task) { org.partial = true; issues.push(issue('task-identity', '有任务记录的身份或状态无法核实。', id)); continue; }
            if (!seen.get(id).has(task.id)) { seen.get(id).add(task.id); org.items.push(task); }
          }
          if (page.nextCursor != null) {
            if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor || page.nextCursor > 1000000) {
              org.partial = true; issues.push(issue('task-cursor', '任务分页无法继续，当前记录尚未读全。', id));
            } else pending.set(id, page.nextCursor);
          }
        }
      }, request);
    }
    return organizations.flatMap(org => org.items.map(task => ({ ...task, _sourcePartial: org.partial })));
  }

  function groupTasks(tasks, organizations) {
    const index = new Map(tasks.map((task, position) => [JSON.stringify([task.organization.instanceId, task.ticketId]), position]));
    const parent = tasks.map((_, position) => position);
    const root = index => { while (parent[index] !== index) index = parent[index]; return index; };
    const join = (first, second) => { parent[root(second)] = root(first); };
    const works = new Map(), byOrg = new Map(organizations.map(org => [org.instanceId, org]));
    tasks.forEach((task, position) => {
      if (task._verifiedWork) {
        const key = JSON.stringify([task.owner.instanceId, task.workRef, task.conversationId]);
        if (works.has(key)) join(works.get(key), position); else works.set(key, position);
      }
      const execution = task.execution;
      if (execution?.kind !== 'delegated' || !string(execution.ticketId)
        || byOrg.get(execution.instanceId)?.parentId !== task.organization.instanceId) return;
      const child = index.get(JSON.stringify([execution.instanceId, execution.ticketId]));
      if (child === undefined) return;
      const target = tasks[child];
      if (task._verifiedWork && target._verifiedWork && (task.workRef !== target.workRef || task.conversationId !== target.conversationId
        || task.owner.instanceId !== target.owner.instanceId)) return;
      join(position, child);
    });
    const groups = new Map();
    tasks.forEach((task, position) => { const id = root(position); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(task); });
    return [...groups.values()].map(members => {
      members.sort((a, b) => Number(b.organization.instanceId === b.owner.instanceId) - Number(a.organization.instanceId === a.owner.instanceId)
        || a._depth - b._depth || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      return makeRow(members[0], members.slice(1));
    });
  }
  function reportContext(item, report) {
    const execution = item.execution;
    if (!['local', 'delegated'].includes(execution?.kind) || execution.kind === 'local'
      && (execution.instanceId !== item.organization.instanceId || execution.ticketId !== item.ticketId)) return {};
    if (execution?.workerId && execution.workerId !== `worker-${execution.ticketId}`) return {};
    if ((!report || report.organizationId === execution?.instanceId) && organizationId.test(execution?.instanceId || '') && string(execution.ticketId)) return {
      instanceId: execution.instanceId, ticketId: execution.ticketId,
      workerId: execution.workerId || null,
    };
    if (report?.organizationId === item.organization.instanceId && string(item.ticketId)) return {
      instanceId: item.organization.instanceId, ticketId: item.ticketId,
      workerId: item.execution?.kind === 'local' && item.execution.workerId === `worker-${item.ticketId}` ? item.execution.workerId : null,
    };
    return {};
  }
  function makeRow(item, children = []) {
    const report = item.progress && string(item.progress.summary) && ['worker-report', 'delegation-snapshot'].includes(item.progress.source)
      ? { ...item.progress } : null;
    const key = item._verifiedWork ? JSON.stringify(['work', item.owner.instanceId, item.workRef, item.conversationId])
      : JSON.stringify(['task', item.organization.instanceId, item.id]);
    return { ...item, key, id: key, sourceId: item.id, status: item.status, executionStatus: item.status,
      summary: string(item.progress?.summary) || '尚未读取到工作回报。', report, result: report?.summary || null,
      executionContext: reportContext(item, report), files: [], originalRequest: string(item.originalRequest),
      question: null, questionId: null, action: null, actionEvidence: null,
      children: children.map(child => makeRow(child)), issues: [], partial: !!item._sourcePartial,
      observedAt: latestTime(item.observedAt, ...children.map(child => child.observedAt)),
      updatedAt: latestTime(item.updatedAt, ...children.map(child => child.updatedAt)),
      acceptance: 'unconfirmed', group: null, archived: false, _primary: item };
  }

  const snapshotEvents = new Set(['core/ticket/snapshot', 'core/trigger/snapshot', 'gateway/command/snapshot', 'instance/process-delegation/out/snapshot']);
  function logCandidate(entry, row) {
    return entry && Number.isSafeInteger(entry.id) && entry.id > 0 && entry.traceId === row.traceId
      && organizationId.test(entry.organizationId || '') && snapshotEvents.has(entry.event)
      && (!entry.refs?.workRef || entry.refs.workRef === row.workRef);
  }
  function logIdentity(entry) {
    return JSON.stringify([entry.organizationId, entry.event, entry.event === 'gateway/command/snapshot' ? entry.refs?.commandId
      : entry.event === 'core/trigger/snapshot' ? entry.refs?.triggerId : entry.refs?.ticketId,
    entry.event === 'instance/process-delegation/out/snapshot' ? entry.refs?.assignmentId : null]);
  }
  async function logEvidence(client, row, request, full = false) {
    if (!string(row.traceId)) return { entries: [], issues: [issue('trace-missing', '该记录缺少可核实的任务来源。')] };
    const roles = full ? ['worker', 'runtime', 'gateway'] : ['worker', 'gateway'];
    const entries = new Map(), problems = [];
    await parallel(roles, async role => {
      let before = null;
      for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
        const query = new URLSearchParams({ trace: row.traceId, role, q: '状态快照', limit: '100' });
        if (before) query.set('before', String(before));
        let response;
        try { response = await read(client, '/api/logs?' + query, request); }
        catch (error) { if (error.name === 'AbortError') throw error; problems.push(issue('log-source', '任务的部分来源记录暂不可读取。')); return; }
        if (!Array.isArray(response?.items)) { problems.push(issue('log-response', '任务来源清单不完整。')); return; }
        for (const entry of response.items) {
          if (!logCandidate(entry, row)) continue;
          const identity = logIdentity(entry);
          if (!entries.has(identity) || entries.get(identity).id < entry.id) entries.set(identity, entry);
        }
        // A current ticket snapshot is sufficient to decide whose intervention an API action refers to.
        if (!full && (role === 'worker' && [...entries.values()].some(entry => entry.event === 'core/ticket/snapshot'
          && entry.organizationId === row.organization.instanceId && entry.refs?.ticketId === row.ticketId)
          || role === 'gateway' && row.userMessageId && [...entries.values()].some(entry => entry.event === 'gateway/command/snapshot'
            && entry.organizationId === row.owner.instanceId && entry.refs?.userMessageId === row.userMessageId))) break;
        if (response.nextCursor == null) break;
        if (!Number.isSafeInteger(response.nextCursor) || response.nextCursor <= 0 || before && response.nextCursor >= before) {
          problems.push(issue('log-cursor', '任务来源分页无法继续。')); break;
        }
        before = response.nextCursor;
        if (pageNumber === 7) problems.push(issue('log-limit', '该任务的来源记录尚未读全。'));
      }
    }, request, 3);
    const relevant = [...entries.values()].filter(entry => entry.event === 'core/ticket/snapshot'
      ? entry.organizationId === row.organization.instanceId && entry.refs?.ticketId === row.ticketId
        || entry.organizationId === row.execution?.instanceId && entry.refs?.ticketId === row.execution.ticketId
        || row.children.some(child => child.organization.instanceId === entry.organizationId && child.ticketId === entry.refs?.ticketId)
      : entry.event === 'instance/process-delegation/out/snapshot'
        && entry.organizationId === row.organization.instanceId && entry.refs?.ticketId === row.ticketId
          && entry.refs?.assignmentId === row.assignment?.id);
    const found = [];
    const fetchDetail = async entry => {
      let value;
      try { value = await read(client, '/api/logs/' + entry.id, request); }
      catch (error) { if (error.name === 'AbortError') throw error; problems.push(issue('log-detail', '有一条任务来源明细暂不可读取。')); return; }
      if (!logCandidate(value, row) || value.id !== entry.id || value.organizationId !== entry.organizationId || value.event !== entry.event
        || logIdentity(value) !== logIdentity(entry) || value.detail?.provenance !== 'snapshot' || value.detail.omitted
        || !value.detail.record || typeof value.detail.record !== 'object' || Array.isArray(value.detail.record)) {
        problems.push(issue('log-identity', '有来源明细的身份或正文无法核实。')); return;
      }
      found.push(value);
    };
    await parallel(relevant, fetchDetail, request);
    const own = ticketRecord(found, row.organization.instanceId, row.ticketId)?.detail.record;
    const commands = [...entries.values()].filter(entry => entry.event === 'gateway/command/snapshot'
      && entry.organizationId === row.owner.instanceId && (!row.conversationId || entry.refs?.conversationId === row.conversationId)
      && (!row.userMessageId || entry.refs?.userMessageId === row.userMessageId)).sort((a, b) => a.id - b.id);
    const initialCommands = row.userMessageId ? commands : [...new Map([commands[0], commands.at(-1)].filter(Boolean).map(entry => [entry.id, entry])).values()];
    const triggers = [...entries.values()].filter(entry => entry.event === 'core/trigger/snapshot' && entry.organizationId === row.organization.instanceId
      && own?.origin?.triggerId && entry.refs?.triggerId === own.origin.triggerId);
    await parallel([...initialCommands.slice(0, 6), ...triggers], fetchDetail, request);
    if (initialCommands.length > 6) problems.push(issue('command-source', '原始交办来源尚未读取完整。'));
    return { entries: found, issues: problems };
  }
  function ticketRecord(entries, org, id) {
    return entries.find(entry => entry.event === 'core/ticket/snapshot' && entry.organizationId === org && entry.refs?.ticketId === id
      && entry.detail.record.id === id && Array.isArray(entry.detail.record.assignments) && Array.isArray(entry.detail.record.inputs));
  }
  function ticketStage(ticket) {
    if (ticket.ended) return stage({ stage: 'ended' });
    if (ticket.delivery) return stage({ stage: 'person', action: 'delivery' });
    if (ticket.attention && !ticket.attention.answeredBy) return stage({ stage: 'person', action: 'answer' });
    const assignment = ticket.assignments.at(-1), report = assignment?.report;
    if (report?.state === 'ready') return stage({ stage: 'person', action: 'review' });
    if (['blocked', 'failed'].includes(report?.state) && !ticket.inputs.some(input => input.kind === 'trigger' && (input.human || input.delegated)
      && !input.context && time(input.at) && time(report.at) && Date.parse(input.at) > Date.parse(report.at))) return stage({ stage: 'person', action: report.state });
    if (!assignment || assignment.state === 'pending') return stage({ stage: 'working', action: 'queued' });
    if (report?.state === 'waiting' || assignment.state === 'ended') return stage({ stage: 'idle' });
    return stage({ stage: 'working' });
  }
  function applyEvidence(row, evidence) {
    row.issues.push(...evidence.issues);
    const entries = evidence.entries, own = ticketRecord(entries, row.organization.instanceId, row.ticketId), ticket = own?.detail.record;
    const command = entries.filter(entry => entry.event === 'gateway/command/snapshot' && entry.organizationId === row.owner.instanceId
      && entry.detail.record.workRef === row.workRef && entry.detail.record.operation === 'new'
      && entry.detail.record.origin?.conversationId === row.conversationId).sort((a, b) => a.id - b.id)[0]?.detail.record;
    const trigger = ticket && entries.find(entry => entry.event === 'core/trigger/snapshot' && entry.organizationId === row.organization.instanceId
      && entry.refs?.triggerId === ticket.origin?.triggerId && entry.detail.record.id === ticket.origin.triggerId)?.detail.record;
    if (string(command?.quote)) row.originalRequest = command.quote;
    else if (!row.originalRequest && string(trigger?.text)) row.originalRequest = trigger.text;
    if (ticket && (!row.assignment?.id || ticket.assignments.at(-1)?.id === row.assignment.id)) {
      const originId = ticket.origin?.triggerId;
      const human = ticket.mandate?.basis?.via !== 'delegation' && (trigger?.human === true
        || command?.origin?.source === 'user' && command.consumption?.ticketId === row.ticketId
        || ticket.inputs.some(input => input.kind === 'trigger' && input.human === true && !input.context
          && (input.triggerId === originId || input.trigger?.human === true)));
      const confirmedStage = ticketStage(ticket);
      // A matching read timestamp is necessary: logs are sampled history, and the same assignment can ask or answer later.
      const ownerCurrent = !!time(ticket.updatedAt) && time(ticket.updatedAt) === time(row._primary.updatedAt)
        && row._primary._sourceAvailability === 'live' && row.availability === 'live';
      row.ownerStage = confirmedStage;
      if (ownerCurrent || terminals.has(row.status)) row.stage = confirmedStage;
      else if (row.execution?.kind === 'delegated') row.stage = null;
      row.ownerRecord = { id: own.id, organizationId: row.organization.instanceId, source: 'log-snapshot', current: ownerCurrent,
        observedAt: time(own.detail.observedAt), updatedAt: time(ticket.updatedAt) };
      if (!terminals.has(row.status) && ['answer', 'review'].includes(confirmedStage.action)) {
        const machine = ['delegation', 'bot'].includes(ticket.mandate?.basis?.via) || trigger?.human === false || command?.origin?.source === 'background';
        if (!ownerCurrent || !human && !machine) {
          row.partial = true;
          row.issues.push(issue(!ownerCurrent ? 'owner-stale' : 'human-source', !ownerCurrent
            ? '归属工单与当前执行记录尚未同步，暂不判定为待你处理。' : '尚未取得明确的人工请求来源，暂不判定为待你处理。'));
        }
      }
      if (ownerCurrent && !terminals.has(row.status) && !ticket.ended && human
        && confirmedStage?.stage === 'person' && ['answer', 'review'].includes(confirmedStage.action)) {
        row.action = confirmedStage.action;
        row.actionEvidence = { entryId: own.id, organizationId: row.organization.instanceId, ticketId: ticket.id,
          human: true, source: 'task-and-log', observedAt: time(own.detail.observedAt) };
        if (confirmedStage.action === 'answer' && string(ticket.attention?.id) && string(ticket.attention?.question)) {
          row.questionId = ticket.attention.id; row.question = ticket.attention.question;
        } else if (confirmedStage.action === 'answer') { row.action = null; row.actionEvidence = null; }
      }
    }
    // A child snapshot can only supply an execution report after the task service has verified its exact ticket binding.
    const context = row.executionContext;
    const worker = ticketRecord(entries, context.instanceId, context.ticketId);
    const reported = worker?.detail.record.assignments.findLast(assignment => assignment.report)?.report;
    const sameReport = row.report ? row.report.state === reported?.state && time(row.report.at) === time(reported?.at)
      && (row.report.summary === reported?.summary || row.report.summary.endsWith('…') && reported?.summary?.startsWith(row.report.summary.slice(0, -1)))
      : worker && time(worker.detail.record.updatedAt) === time(row._primary.updatedAt);
    if (sameReport && reported && string(reported.summary)) {
      row.report = { ...reported, source: 'worker-report', organizationId: worker.organizationId,
        entryId: worker.id, observedAt: time(worker.detail.observedAt) };
      row.result = reported.summary; row.summary = reported.summary;
    }
    if (row.action) { row.status = 'waiting'; row.statusLabel = row.action === 'answer' ? '等待你的答复' : '等待你的审阅'; }
    else if (!terminals.has(row.status) && row.execution?.kind === 'delegated' && ['answer', 'review'].includes(row._primary.stage?.action)) {
      row.statusLabel = row.report?.state === 'ready' ? '执行方已回报，等待任务汇总' : '执行方等待后续处理';
    }
    row.partial ||= evidence.issues.length > 0;
    return row;
  }
  function classify(client, row) {
    try { const files = typeof client.taskFilesFor === 'function' ? client.taskFilesFor(row) : []; row.files = Array.isArray(files) ? files : []; }
    catch { row.files = []; row.issues.push(issue('file-source', '已登记的交付文件暂不可读取。')); row.partial = true; }
    let reportFiles = false;
    if (row.status !== 'stopped' && row.report?.state !== 'ready' && !row.files.length
      && /\[打开\]\(\/jarvis\/api\/system\//.test(row.report?.summary || '') && typeof client.taskReportView === 'function') {
      try { reportFiles = !!client.taskReportView(row.report.summary, row.executionContext, row.files)?.files; }
      catch { row.issues.push(issue('report-files', '报告中的交付文件暂不可读取。')); row.partial = true; }
    }
    row.hasDeliverable = !!row.report && row.report.state === 'ready' || row.files.length > 0 || reportFiles;
    row.archived = row.status === 'stopped' || row.status === 'completed' && !row.hasDeliverable;
    row.group = row.archived ? null : row.actionEvidence && row.action ? 'awaiting'
      : ['blocked', 'failed', 'rejected', 'unknown', 'unavailable'].includes(row.status) ? 'attention'
        : row.hasDeliverable ? 'delivered' : 'active';
    if (row.status === 'completed' && !row.hasDeliverable) {
      row.issues.push(issue('delivery-unverified', '该任务已结束，但尚未读取到可核实的成果或交付报告。'));
      row.partial = true;
    }
    if (['unknown', 'unavailable'].includes(row.status)) row.partial = true;
    row.deliveryLabel = row.hasDeliverable && !row.archived ? row.status === 'completed' ? '成果已回报，验收状态未记录'
      : row.execution?.kind === 'delegated' ? '执行方已回报成果' : '已有成果回报' : null;
    return row;
  }
  function emptyResult(problems) {
    return { rows: [], archived: [], groups: { awaiting: [], active: [], attention: [], delivered: [] },
      counts: { awaiting: 0, active: 0, attention: 0, delivered: 0 }, organizations: [], partial: true,
      issues: problems, observedAt: null, updatedAt: null, countComplete: false };
  }
  async function load(client, options = {}) {
    if (!client || typeof client.api !== 'function') return emptyResult([issue('connection', '经营记录尚未连接。')]);
    const request = { kind: 'load', client, signal: options.signal }; loads.set(client, request);
    const issues = [];
    let organizations;
    try { organizations = organizationsFrom(await read(client, '/api/system', request)); }
    catch (error) { if (error.name === 'AbortError') throw error; return emptyResult([issue('organization-source', '组织经营记录暂不可读取，请重新连接。')]); }
    const tasks = await taskInventory(client, organizations, request, issues), rows = groupTasks(tasks, organizations);
    // Only open, potentially human actions need log verification during inventory; history detail is read when expanded.
    await parallel(rows.filter(row => !terminals.has(row.status) && string(row.ticketId)
      && (row.execution?.kind === 'delegated' || row.stage?.stage === 'person' && ['answer', 'review'].includes(row.stage.action))), async row => {
      const evidence = await logEvidence(client, row, request);
      applyEvidence(row, evidence);
      if (!row.ownerRecord) { row.partial = true; row.issues.push(issue('owner-stage', '未取得归属工单的最新记录，暂不判定为待你处理。')); }
    }, request);
    rows.forEach(row => classify(client, row));
    rows.sort((a, b) => (Date.parse(b.updatedAt || b.receivedAt) || 0) - (Date.parse(a.updatedAt || a.receivedAt) || 0) || a.key.localeCompare(b.key));
    const groups = { awaiting: [], active: [], attention: [], delivered: [] };
    rows.forEach(row => { if (row.group) groups[row.group].push(row); });
    const partial = issues.length > 0 || rows.some(row => row.partial) || organizations.some(org => org.partial);
    return { rows, archived: rows.filter(row => row.archived), groups,
      counts: Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, items.length])),
      organizations: organizations.map(({ items, ...org }) => ({ ...org, taskRecords: items.length })), partial,
      issues: [...issues, ...rows.flatMap(row => row.issues)], countComplete: !partial,
      observedAt: latestTime(...organizations.map(org => org.observedAt)), updatedAt: latestTime(...rows.map(row => row.updatedAt)) };
  }
  async function detail(client, row, options = {}) {
    if (!row || !row._primary || !client || typeof client.api !== 'function') throw new Error('任务详情不可读取');
    const request = { kind: 'detail', client, key: row.key, signal: options.signal };
    if (!details.has(client)) details.set(client, new Map()); details.get(client).set(row.key, request);
    let primary = row._primary;
    const problems = [];
    if (row.workRef && row.conversationId && client.state?.binding?.conversationId === row.conversationId) {
      try {
        const response = await read(client, '/api/tasks/' + encodeURIComponent(row.workRef) + '?' + new URLSearchParams({ conversationId: row.conversationId }), request);
        const item = response?.item;
        if (response?.conversationId !== row.conversationId || item?.workRef !== row.workRef || item.conversationId !== row.conversationId
          || item.ticketId !== row.ticketId || item.organization?.instanceId !== row.organization.instanceId || item.logs?.traceId !== row.traceId)
          throw new Error('任务详情身份不一致');
        const updated = taskFrom(item, { instanceId: row.organization.instanceId, depth: primary._depth,
          availability: primary._sourceAvailability, partial: primary._sourcePartial }, response.observedAt);
        if (!updated) throw new Error('任务详情状态无效'); primary = updated;
      } catch (error) { if (error.name === 'AbortError') throw error; problems.push(issue('task-detail', '精确任务详情暂不可读取，以下保留已核实记录。')); }
    }
    const result = makeRow(primary, row.children.map(child => child._primary));
    result.issues.push(...problems); result.partial ||= problems.length > 0;
    const evidence = await logEvidence(client, result, request, true);
    applyEvidence(result, evidence);
    if (!result.originalRequest) { result.partial = true; result.issues.push(issue('original-request', '原始请求正文尚未读取完整。')); }
    if (!result.ownerRecord && result.ticketId) { result.partial = true; result.issues.push(issue('owner-record', '归属工单的来源明细尚未读取完整。')); }
    result.detailsLoaded = true;
    return classify(client, result);
  }
  window.jarvisBusinessOverview = Object.freeze({ load, detail, cancel(client) { if (client) { loads.delete(client); details.delete(client); } } });
})();

(() => {
  const byId = id => document.getElementById(id);
  const sidebar = byId('context-sidebar'), page = byId('conversation-page'), toggle = byId('context-toggle');
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const groups = [
    { key: 'awaiting', title: '待我处理', emptyMessage: '目前没有需要你处理的事项。' },
    { key: 'active', title: '推进中', emptyMessage: '目前没有正在推进的任务。' },
    { key: 'attention', title: '需关注', emptyMessage: '目前没有需要关注的异常。' },
    { key: 'delivered', title: '交付成果', emptyMessage: '目前没有可读取的交付成果。' },
  ];
  const heading = node('div', 'side-heading'), title = node('h2', '', '经营概览'); title.id = 'business-title';
  const close = node('button', 'icon-button', '×'); close.id = 'context-close'; close.type = 'button';
  close.setAttribute('aria-label', '收起经营概览'); heading.append(title, close);
  const toolbar = node('div', 'business-toolbar'), scope = node('span', '', '集团工作');
  const refresh = node('button', 'business-refresh', '刷新'); refresh.type = 'button'; refresh.id = 'business-refresh';
  toolbar.append(scope, refresh);
  const tabs = node('div', 'context-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '集团工作分类');
  const status = node('p', 'business-status', '展开后读取集团工作记录。'); status.id = 'business-status'; status.setAttribute('role', 'status');
  const warning = node('p', 'business-warning'); warning.id = 'business-warning'; warning.hidden = true;
  const notice = node('p', 'business-notice'); notice.id = 'business-notice'; notice.setAttribute('role', 'status'); notice.hidden = true;
  const scroll = node('div', 'business-scroll'); scroll.id = 'business-scroll';
  const archive = node('details', 'business-archive'); archive.id = 'business-archive'; archive.hidden = true;
  const archiveHeading = node('summary', '', '已结束与已停止'), archiveList = node('div', 'business-organizations');
  archive.append(archiveHeading, archiveList);
  const archiveGroup = { key: 'archived', list: archiveList, organizations: new Map() };
  const cards = new Map();
  let ready = false, chatReady = false, snapshot = null, error = '', sourceFailure = false, request = null, timer, changeTimer;
  function frameVisible() {
    const frame = window.frameElement;
    if (!frame) return true;
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    return !frame.hidden && !frame.closest('[hidden]') && style?.display !== 'none' && style?.visibility !== 'hidden' && frame.getClientRects().length > 0;
  }
  const visible = () => !sidebar.hidden && !page.hidden && frameVisible() && document.visibilityState !== 'hidden';
  const readable = () => ready && chatReady && visible();
  const date = value => {
    const timestamp = value && new Date(value);
    return timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toLocaleString('zh-CN', { hour12: false }) : '';
  };
  const excerpt = value => {
    const line = String(value || '').replace(/\s+/g, ' ').trim(), chars = Array.from(line);
    return chars.length > 86 ? chars.slice(0, 86).join('').trimEnd() + '…' : line;
  };
  const questionText = row => typeof row.question === 'string' ? row.question : row.question?.text || row.question?.question || '';
  const reportText = row => row.report?.summary || row.result || (typeof row.summary === 'string' ? row.summary : '');
  const humanAction = row => row.actionEvidence?.human === true ? row.action : null;
  const rowKey = row => row.key || row.id;
  const executionKey = row => JSON.stringify([row.organization?.instanceId, row.ticketId || row.sourceId || row.id]);
  // Sampling times and private source copies change on every read without changing the work itself.
  const businessSignature = value => JSON.stringify(value, (key, item) => key === 'observedAt' || key.startsWith('_') ? undefined : item);
  const unreadableSources = value => value?.partial && !value.rows?.length && !value.organizations?.some(org => ['live', 'stored'].includes(org.availability));
  function summaryText(row) {
    if (questionText(row)) return questionText(row);
    const summary = reportText(row);
    if (!summary) return '';
    const view = jarvis.taskReportView?.(summary, row.executionContext || {}, row.files || []);
    return view ? view.preview || view.body?.querySelector('p,li,h3,pre')?.textContent || (view.files ? '交付文件已留存，展开查看。' : '') : summary;
  }
  function select(index, focus = false) {
    groups.forEach((group, i) => {
      group.panel.hidden = i !== index; group.tab.setAttribute('aria-selected', String(i === index));
      group.tab.tabIndex = i === index ? 0 : -1;
    });
    if (focus) groups[index].tab.focus();
    if (snapshot) renderRows();
  }
  groups.forEach((group, i) => {
    group.tab = node('button', 'context-tab'); group.tab.type = 'button'; group.tab.id = 'context-tab-' + i;
    group.tab.setAttribute('role', 'tab'); group.tab.setAttribute('aria-controls', 'context-panel-' + i);
    group.count = node('strong', '', '—'); group.tab.append(node('span', '', group.title), group.count);
    group.tab.addEventListener('click', () => select(i));
    group.tab.addEventListener('keydown', event => {
      const next = { ArrowRight: (i + 1) % groups.length, ArrowLeft: (i + groups.length - 1) % groups.length, Home: 0, End: groups.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); select(next, true);
    });
    group.panel = node('section', 'panel business-panel'); group.panel.id = 'context-panel-' + i;
    group.panel.setAttribute('role', 'tabpanel'); group.panel.setAttribute('aria-labelledby', group.tab.id); group.panel.tabIndex = 0;
    group.empty = node('p', 'business-empty', '正在等待读取记录。'); group.empty.setAttribute('role', 'status');
    group.list = node('div', 'business-organizations'); group.organizations = new Map();
    group.panel.append(group.empty, group.list); tabs.append(group.tab); scroll.append(group.panel);
  });
  scroll.append(archive);
  sidebar.replaceChildren(heading, toolbar, tabs, status, warning, notice, scroll);
  sidebar.setAttribute('aria-labelledby', title.id); select(0);

  function updateStatus() {
    const previous = !!snapshot && !unreadableSources(snapshot);
    sidebar.setAttribute('aria-busy', String(!!request));
    text(refresh, request ? '正在刷新…' : error || sourceFailure ? '重试读取' : '刷新'); refresh.setAttribute('aria-disabled', String(!!request));
    text(status, request ? previous ? '正在更新，保留上次读取的记录…' : '正在读取集团工作…'
      : error ? (previous ? '更新失败，以下保留上次读取的记录。' : '暂时无法读取集团工作。')
        : snapshot ? (snapshot.partial ? '已读取部分记录 ' : '更新于 ') + (date(snapshot.observedAt || snapshot.updatedAt) || '时间未提供')
          : ready && chatReady ? '展开后读取集团工作记录。' : '正在连接工作区…');
    warning.hidden = !error && !snapshot?.partial;
    text(warning, error || (snapshot?.partial ? '部分组织或任务暂未同步，分类数量仅包含已读取的记录。' : ''));
    warning.title = (snapshot?.issues || []).map(issue => typeof issue === 'string' ? issue : issue.message || issue.reason || '').filter(Boolean).join('\n');
    for (const group of groups) {
      const count = sourceFailure ? null : snapshot?.counts?.[group.key];
      text(group.count, Number.isSafeInteger(count) ? String(count) + (snapshot.partial ? '+' : '') : '—');
      group.tab.title = Number.isSafeInteger(count) ? group.title + ' · ' + (snapshot.partial ? '已读取至少 ' : '') + count + ' 项' : group.title;
      const rows = snapshot?.groups?.[group.key] || [];
      group.empty.hidden = rows.length > 0 || !!group.list.querySelector('.business-card');
      text(group.empty, !snapshot || sourceFailure ? request ? '正在读取记录…' : error ? '读取失败，请重试。' : '尚未读取工作记录。'
        : snapshot.partial ? '已读取的记录中暂无' + group.title + '事项，其余记录尚未同步。' : group.emptyMessage);
    }
  }
  function section(title, className = '') {
    const element = node('section', 'business-section ' + className); element.append(node('h4', '', title)); return element;
  }
  function report(row) {
    const element = section('实际结果与最近回报'), summary = reportText(row);
    const context = row.executionContext || {}, files = row.files || jarvis.taskFilesFor?.(row) || [];
    const view = jarvis.taskReportView?.(summary, context, files);
    if (view?.preview) element.append(node('p', 'business-report-preview', view.preview));
    if (view?.body?.textContent) element.append(view.body);
    else if (!view?.preview) element.append(node('p', 'business-muted', summary || '暂无可读取的结果记录。'));
    if (view?.files) element.append(view.files);
    const labels = { 'worker-report': '执行方回报', 'delegation-snapshot': '下级任务状态', question: '待回答问题', command: '交办回执' };
    const source = row.report?.source ? labels[row.report.source] || '已留存的回报' : '';
    const at = date(row.report?.at);
    if (source || at) element.append(node('p', 'business-record-time', [source, at && '记录于 ' + at].filter(Boolean).join(' · ')));
    return element;
  }
  function executionText(row) {
    const execution = row.execution;
    if (execution?.kind === 'unassigned') return '尚未分派';
    if (!execution || execution.kind === 'unknown') return '执行组织尚未同步';
    const name = execution.name || execution.instanceId;
    return name ? name + (execution.kind === 'delegated' ? ' · 委派执行' : execution.kind === 'local' ? ' · 本地执行' : '') : '执行组织尚未同步';
  }
  function executionRecord(row) {
    const element = section('执行组织'), metadata = node('dl', 'business-meta');
    const fields = [['交办组织', row.organization?.name || row.organization?.instanceId || '组织尚未同步'], ['当前执行', executionText(row)],
      ['当前状态', row.statusLabel || '状态尚未同步']];
    if (row.execution?.workerId) fields.push(['执行 Worker', row.execution.workerId]);
    if (row.workRef) fields.push(['任务编号', row.workRef]);
    if (row.updatedAt) fields.push(['最近更新', date(row.updatedAt) || '时间未提供']);
    for (const [label, value] of fields) metadata.append(node('dt', '', label), node('dd', '', value));
    element.append(metadata); return element;
  }
  function childrenRecord(rows, seen = new Set()) {
    const list = node('div', 'business-children');
    for (const row of rows || []) {
      const key = executionKey(row);
      if (seen.has(key)) continue;
      const next = new Set(seen); next.add(key);
      const child = node('details', 'business-child'); child.dataset.businessPart = 'child:' + key;
      const summary = node('summary'); summary.append(node('strong', '', row.title || row.organization?.name || '下级执行'), node('span', '', row.statusLabel || '状态尚未同步'));
      child.append(summary, node('p', 'business-child-owner', executionText(row)), report(row));
      if (row.traceId) { const logs = node('a', 'business-logs', '查看下级日志'); logs.href = '#logs?trace=' + encodeURIComponent(row.traceId); child.append(logs); }
      if (row.children?.length) child.append(childrenRecord(row.children, next));
      list.append(child);
    }
    return list;
  }
  function content(row) {
    const element = node('div', 'business-detail-content'), question = questionText(row);
    element.append(node('h3', 'business-detail-title', row.title || row.workRef || '任务记录'));
    if (row.deliveryLabel) element.append(node('p', 'business-delivery-label', row.deliveryLabel));
    if (row.partial || row.issues?.length) {
      const missing = section('记录尚未完整同步', 'business-question');
      missing.append(node('p', '', '部分要求、执行记录或结果暂未读取到。'));
      const issues = node('ul', 'business-detail-issues');
      for (const issue of row.issues || []) {
        const value = typeof issue === 'string' ? issue : issue.message || issue.reason || '';
        if (value) issues.append(node('li', '', value));
      }
      if (issues.children.length) missing.append(issues);
      element.append(missing);
    }
    if (question) { const pending = section(humanAction(row) === 'answer' ? '需要你回答' : '记录中的问题', 'business-question'); pending.append(node('p', '', question)); element.append(pending); }
    if (humanAction(row) === 'review') { const review = section('等待你验收', 'business-question'); review.append(node('p', '', row.stage?.label || '请对照原始要求检查实际结果。')); element.append(review); }
    const requirements = section('原始要求'); requirements.append(node('p', 'business-original', row.originalRequest || '原始要求暂未读取到。'));
    element.append(requirements, report(row), executionRecord(row));
    if (row.children?.length) { const children = section('下级执行'); children.append(childrenRecord(row.children, new Set([executionKey(row)]))); element.append(children); }
    return element;
  }
  function controlKey(control) {
    if (control.tagName === 'A') return ['link', control.getAttribute('href'), control.textContent].join(':');
    if (control.tagName === 'SUMMARY') return 'summary:' + (control.closest('[data-business-part]')?.dataset.businessPart || '');
    return control.tagName === 'BUTTON' ? 'button:' + control.className : '';
  }
  function updateContent(card, row) {
    const signature = businessSignature(row);
    if (signature === card.contentSignature) return;
    card.contentSignature = signature;
    const open = [...card.body.querySelectorAll('[data-business-part][open]')].map(part => part.dataset.businessPart);
    const focused = card.body.contains(document.activeElement) ? controlKey(document.activeElement) : '';
    card.body.replaceChildren(content(row));
    for (const part of card.body.querySelectorAll('[data-business-part]')) part.open = open.includes(part.dataset.businessPart);
    if (focused) {
      const target = [...card.body.querySelectorAll('a[href],summary,button')].find(control => controlKey(control) === focused);
      (target || card.heading).focus({ preventScroll: true });
    }
  }
  function updateAction(card) {
    const action = jarvis.taskFollowUp?.(card.row), focused = document.activeElement === card.follow;
    card.follow.hidden = !action; if (action) text(card.follow, action.label);
    if (focused && !action) card.heading.focus({ preventScroll: true });
  }
  function updateCard(card, row) {
    card.row = row;
    card.element.dataset.status = row.status || 'unknown';
    text(card.title, excerpt(row.title || row.workRef || '任务记录'));
    text(card.state, (humanAction(row) && row.stage?.label) || row.statusLabel || '状态尚未同步');
    text(card.organization, executionText(row));
    const summarySignature = businessSignature([row.question, row.report, row.result, row.summary, row.executionContext, row.files]);
    if (card.summarySignature !== summarySignature) { card.summarySignature = summarySignature; text(card.summary, excerpt(summaryText(row))); }
    card.summary.hidden = !card.summary.textContent;
    const at = date(row.updatedAt); text(card.time, at ? '更新于 ' + at : '更新时间未提供');
    if (at) card.time.dateTime = row.updatedAt; else card.time.removeAttribute('datetime');
    const note = card.detailError || (row.partial ? '部分任务记录尚未同步，展开后可查看已读取内容。' : row.availability === 'live' ? '' : row.availability === 'stored' ? '当前为已留存记录，执行状态尚未同步。' : '当前执行状态暂不可用。');
    text(card.note, note); card.note.hidden = !note;
    card.logs.hidden = !row.traceId;
    if (row.traceId) card.logs.href = '#logs?trace=' + encodeURIComponent(row.traceId);
    updateAction(card);
    text(card.refresh, card.detailRequest ? '正在读取…' : card.detailError ? '重试详情' : '刷新详情');
    card.refresh.setAttribute('aria-disabled', String(!!card.detailRequest));
    const value = card.detail && card.detailFor === businessSignature(row) ? { ...row, ...card.detail } : row;
    if (card.element.open) updateContent(card, value);
  }
  function createCard(row) {
    const element = node('details', 'business-card'); element.dataset.businessKey = rowKey(row);
    const heading = node('summary', 'business-card-heading');
    const title = node('strong', 'business-card-title'), state = node('span', 'business-card-state');
    const organization = node('span', 'business-card-organization'), summary = node('span', 'business-card-summary'), time = node('time', 'business-card-time');
    heading.append(state, title, organization, summary, time);
    const panel = node('div', 'business-card-panel'), note = node('p', 'business-card-note'), body = node('div', 'business-card-body'); note.setAttribute('role', 'status');
    const actions = node('div', 'business-card-actions'), follow = node('button', 'business-follow'), refresh = node('button', 'business-refresh', '刷新详情');
    follow.type = refresh.type = 'button'; const logs = node('a', 'business-logs', '查看任务日志'); actions.append(follow, refresh, logs);
    panel.append(note, body, actions); element.append(heading, panel);
    const card = { element, heading, title, state, organization, summary, time, note, body, follow, refresh, logs, row };
    element.addEventListener('toggle', () => { if (element.open && element.isConnected && visible()) { updateCard(card, card.row); readDetail(card); } });
    refresh.addEventListener('click', () => readDetail(card, true));
    follow.addEventListener('click', () => {
      const action = jarvis.taskFollowUp?.(card.row, { select: true });
      if (action) { notice.hidden = true; if (matchMedia('(max-width:1100px)').matches) setOverview(false, false); }
      else { text(notice, '任务或当前对话状态已变化，请刷新后重试。'); notice.hidden = false; updateAction(card); }
    });
    updateCard(card, row); return card;
  }
  function organizationGroup(group, row) {
    const id = row.organization?.instanceId || 'unavailable';
    if (!group.organizations.has(id)) {
      const element = node('section', 'business-organization'), title = node('h3'), list = node('div', 'business-task-list');
      element.dataset.organizationId = id; element.append(title, list); group.list.append(element); group.organizations.set(id, { element, title, list });
    }
    const section = group.organizations.get(id), org = snapshot.organizations?.find(item => (item.instanceId || item.id) === id);
    const path = org?.path?.map(item => typeof item === 'string' ? snapshot.organizations.find(organization => (organization.instanceId || organization.id) === item)?.name || item : item.name || item.instanceId);
    text(section.title, path?.length ? path.join(' / ') : row.organization?.name || id);
    section.element.style.setProperty('--organization-depth', String(Math.min(Math.max(org?.depth || 0, 0), 4)));
    return section;
  }
  function renderRows() {
    const retained = new Set(), allGroups = [...groups, archiveGroup], ordering = new Map();
    const remember = (parent, element) => { if (!ordering.has(parent)) ordering.set(parent, []); if (!ordering.get(parent).includes(element)) ordering.get(parent).push(element); };
    for (const group of allGroups) {
      const rows = group === archiveGroup ? snapshot.archived || [] : snapshot.groups?.[group.key] || [];
      for (const row of rows) {
        const key = rowKey(row); if (!key) continue; retained.add(key);
        let card = cards.get(key); if (!card) { card = createCard(row); cards.set(key, card); } else updateCard(card, row);
        const organization = organizationGroup(group, row), destination = organization.list;
        remember(group.list, organization.element); remember(destination, card.element);
        // A refreshed task can change category. Keep the focused card in place until the user leaves it.
        if (!card.element.contains(document.activeElement) || card.element.parentElement === destination) {
          if (card.element.parentElement !== destination) destination.append(card.element);
        }
        if (card.element.open) readDetail(card);
      }
    }
    for (const [key, card] of cards) if (!retained.has(key) && !card.element.contains(document.activeElement)) { card.element.remove(); cards.delete(key); }
    for (const [parent, elements] of ordering) {
      if (parent.contains(document.activeElement)) continue;
      elements.filter(element => element.parentElement === parent).forEach((element, index) => {
        if (parent.children[index] !== element) parent.insertBefore(element, parent.children[index] || null);
      });
    }
    for (const group of allGroups) for (const section of group.organizations.values()) section.element.hidden = section.list.children.length === 0;
    for (const group of groups) group.empty.hidden = !!group.list.querySelector('.business-card');
    archive.hidden = !archiveList.querySelector('.business-card');
    text(archiveHeading, '已结束与已停止 · ' + (snapshot.archived?.length || 0) + ' 项');
  }
  async function readDetail(card, force = false) {
    if (!readable() || !card.element.open || card.detailRequest || !window.jarvisBusinessOverview?.detail) return;
    const signature = businessSignature(card.row);
    if (!force && (card.detailFor === signature && card.detail || card.detailError && card.attemptFor === signature)) return;
    const token = { row: card.row, signature }; card.detailRequest = token; card.attemptFor = signature; card.detailError = ''; updateCard(card, card.row);
    try {
      const detail = await window.jarvisBusinessOverview.detail(jarvis, token.row);
      if (card.detailRequest !== token || businessSignature(card.row) !== signature) return;
      card.detail = detail; card.detailFor = signature;
    } catch {
      if (card.detailRequest === token) card.detailError = '详情读取失败，已保留现有记录，请重试。';
    } finally {
      if (card.detailRequest === token) {
        card.detailRequest = null; updateCard(card, card.row);
        if (businessSignature(card.row) !== signature) readDetail(card);
      }
    }
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (readable() && !request) timer = setTimeout(load, 15000);
  }
  async function load() {
    clearTimeout(timer); timer = null;
    if (!readable() || request) return;
    const token = {}; request = token; error = ''; updateStatus();
    try {
      if (!window.jarvisBusinessOverview?.load) throw new Error('当前服务未提供集团工作记录。');
      const value = await window.jarvisBusinessOverview.load(jarvis);
      if (request !== token) return;
      sourceFailure = !!unreadableSources(value);
      if (sourceFailure) error = '集团工作记录暂不可读取，请重试。';
      if (!sourceFailure || !snapshot) snapshot = value;
      renderRows();
    } catch (failure) {
      if (request === token) error = failure?.message || '工作记录读取失败，请重试。';
    } finally {
      if (request === token) { request = null; updateStatus(); schedule(); }
    }
  }
  function setOverview(open, moveFocus = true) {
    sidebar.hidden = !open; page.classList.toggle('overview-open', open); toggle.setAttribute('aria-expanded', String(open));
    if (moveFocus) (open ? close : toggle).focus();
    clearTimeout(timer); clearTimeout(changeTimer);
    if (open) load();
  }
  toggle.addEventListener('click', () => setOverview(sidebar.hidden)); close.addEventListener('click', () => setOverview(false));
  refresh.addEventListener('click', () => {
    if (request) return;
    for (const card of cards.values()) { card.detailFor = null; card.attemptFor = null; }
    load();
  });
  sidebar.addEventListener('focusout', () => queueMicrotask(() => { if (snapshot && visible()) renderRows(); }));
  const menu = byId('conversation-menu');
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
  byId('reset').addEventListener('click', () => { menu.open = false; });
  window.addEventListener('hashchange', () => { menu.open = false; if (!sidebar.hidden) setOverview(false, false); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
    else if (!sidebar.hidden) { event.preventDefault(); setOverview(false); }
  });
  function visibilityChanged() {
    clearTimeout(timer); clearTimeout(changeTimer);
    if (readable()) { load(); for (const card of cards.values()) if (card.element.open) readDetail(card); }
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  if (window.frameElement) {
    let wasVisible = frameVisible();
    const observer = new MutationObserver(() => {
      const current = frameVisible();
      if (current !== wasVisible) { wasVisible = current; visibilityChanged(); }
    });
    for (let container = window.frameElement; container; container = container.parentElement) observer.observe(container, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
  }
  document.addEventListener('jarvis:activity', () => {
    const first = !chatReady; chatReady = true;
    for (const card of cards.values()) updateAction(card);
    if (first && readable()) load();
  });
  for (const event of ['jarvis:business-updated', 'jarvis:instance-updated']) document.addEventListener(event, () => {
    if (!readable()) return;
    clearTimeout(changeTimer); changeTimer = setTimeout(load, 250);
  });
  Promise.resolve(jarvis.ready).then(() => { ready = true; updateStatus(); if (readable()) load(); }, () => { error = '无法连接工作区，请刷新页面重试。'; updateStatus(); });
})();
