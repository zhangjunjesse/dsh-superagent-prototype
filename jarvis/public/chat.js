(async () => {
  const byId = id => document.getElementById(id);
  const thread = byId('thread');
  const input = byId('input');
  const feedback = byId('chat-feedback');
  const send = byId('send-message');
  const stop = byId('stop-generation');
  const instanceStatus = byId('instance-status');
  const instanceStart = byId('instance-start');
  const instanceStartError = byId('instance-start-error');
  let turns = [], activeId = null, busy = false, pollTimer, notificationTimer, notificationCursor = 0, selection = null, viewRevision = 0;
  let instance = null, startingInstance = false, startError = '', stateSyncError = false, stateRequest = null, activeStream = null;
  let chatRevision = 0;
  let draftRevision = 0, selectionRevision = 0, restoredDraftId = null;
  const outbox = new Map(), outboxKey = 'jarvis.chat.outbox:' + location.pathname;
  const nodes = new Map();
  const taskCards = new Map(), taskItems = new Map(), taskErrors = new Map(), taskDetails = new Map(), taskDetailRequests = new Map();
  const taskRecords = new Map(), taskRecordRequests = new Map(), taskRecordsRead = new Set();
  const taskStatuses = new Set(['queued', 'routing', 'running', 'waiting', 'blocked', 'failed', 'completed', 'stopped', 'rejected', 'unknown', 'unavailable']);
  let taskBinding = null, tasksAvailable = false, taskEpoch = 0, taskTimer, taskRequest = null, taskRequestedRefs = '';
  send.disabled = true;
  try { await jarvis.ready; } catch { return; }

  const taskNode = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const taskDate = value => {
    if (!value) return '时间未提供';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未提供' : date.toLocaleString('zh-CN', { hour12: false });
  };
  function taskExcerpt(value) {
    const line = String(value).replace(/\s+/g, ' ').trim();
    const chars = Array.from(line);
    if (chars.length <= 58) return line;
    const start = chars.slice(0, 58).join('');
    const sentence = start.match(/^.{12,}?[。！？](?=.)/u);
    return sentence ? sentence[0] : start.trimEnd() + '…';
  }
  const taskBindingKey = binding => binding ? JSON.stringify([binding.conversationId, binding.generation, binding.dshSessionId]) : '';
  const sendBinding = () => taskBinding ? { conversationId: taskBinding.conversationId, generation: taskBinding.generation } : undefined;
  const sendScope = () => JSON.stringify(sendBinding() || ['legacy', jarvis.state.csrf]);
  const visiblePending = () => [...outbox.values()].filter(entry => entry.scope === sendScope());
  function saveOutbox() {
    try { sessionStorage.setItem(outboxKey, JSON.stringify([...outbox.values()])); } catch { /* Sending still works when browser storage is unavailable. */ }
  }
  function restoreOutbox() {
    try {
      for (const entry of JSON.parse(sessionStorage.getItem(outboxKey) || '[]')) {
        if (!entry || typeof entry.scope !== 'string' || typeof entry.payload?.id !== 'string' || typeof entry.payload.text !== 'string' ||
          typeof entry.payload.submissionId !== 'string' || !['sending', 'uncertain', 'failed', 'cancelled'].includes(entry.phase)) continue;
        outbox.set(entry.payload.id, { ...entry, phase: entry.phase === 'sending' ? 'uncertain' : entry.phase });
      }
    } catch { /* A damaged local draft cannot authorize a server operation. */ }
  }
  function matchesSubmission(turn, entry, fromStream = false) {
    const payload = entry.payload;
    return turn?.id === payload.id && turn.user === payload.text &&
      ['selectedWorkRef', 'selectedQuestionId'].every(key => turn[key] === payload[key]) &&
      (!payload.binding || (turn.conversationId === undefined || turn.conversationId === payload.binding.conversationId) &&
        (turn.generation === undefined || turn.generation === payload.binding.generation)) &&
      (!payload.retry || turn.submissionId === payload.submissionId || turn.submissionIds?.includes(payload.submissionId) || fromStream && turn.submissionId === undefined);
  }
  function confirmSubmission(turn, fromStream = false) {
    const entry = outbox.get(turn?.id);
    if (!entry || entry.scope !== sendScope() || !matchesSubmission(turn, entry, fromStream)) return false;
    outbox.delete(turn.id); saveOutbox();
    if (restoredDraftId === turn.id) restoredDraftId = null;
    return true;
  }
  function projectedTurns() {
    const pending = new Map(visiblePending().map(entry => [entry.payload.id, entry]));
    const projection = turns.map(turn => ({ ...turn, pending: pending.get(turn.id) }));
    for (const [id, entry] of pending) if (!turns.some(turn => turn.id === id)) projection.push({ id, user: entry.payload.text, assistant: '', local: true, pending: entry });
    return projection;
  }
  const tasksVisible = () => !byId('conversation-page').hidden && !window.frameElement?.hidden && document.visibilityState !== 'hidden';
  function taskReferences(turn) {
    const refs = new Map();
    const bound = ref => ({ ...(turn.instanceId ? { instanceId: turn.instanceId } : {}), ...(turn.traceId ? { traceId: turn.traceId } : {}),
      ...(turn.conversationId ? { conversationId: turn.conversationId } : {}), ...ref });
    for (const ref of turn.gatewayReceipts || []) if (ref?.workRef) refs.set(ref.workRef, { ...bound(ref), actionable: true });
    for (const ref of turn.workRefs || []) {
      const value = typeof ref === 'string' ? { workRef: ref } : ref;
      if (!value?.workRef) continue;
      const previous = refs.get(value.workRef);
      if (value.inactive && previous?.actionable) continue;
      refs.set(value.workRef, { ...previous, ...bound(value), actionable: !value.inactive });
    }
    return [...refs.values()];
  }
  const currentTaskRefs = () => [...new Set(turns.flatMap(turn => taskReferences(turn).map(ref => ref.workRef)))];
  function resetTaskContext(binding = null) {
    taskEpoch++; clearTimeout(taskTimer); taskTimer = null; taskRequest = null; taskRequestedRefs = '';
    taskBinding = binding; taskItems.clear(); taskErrors.clear(); taskDetails.clear(); taskDetailRequests.clear();
    taskRecords.clear(); taskRecordRequests.clear(); taskRecordsRead.clear();
  }
  function syncTaskContext(state) {
    if (typeof state.tasksAvailable === 'boolean') { tasksAvailable = state.tasksAvailable; jarvis.state.tasksAvailable = tasksAvailable; }
    if (!Object.hasOwn(state, 'binding')) return false;
    const changed = taskBindingKey(taskBinding) !== taskBindingKey(state.binding);
    if (changed) {
      const hadBinding = !!taskBinding;
      resetTaskContext(state.binding || null);
      if (hadBinding) clearSelection();
    }
    jarvis.state.binding = state.binding;
    return changed;
  }
  function taskFields(fields) {
    return fields.flatMap(([label, value]) => [taskNode('dt', '', label), taskNode('dd', '', value)]);
  }
  function taskExecution(item, ref) {
    if (!item) return ref.status === 'queued' || ref.status === 'replayed' ? '等待确认接单与分派' : '执行方尚未同步';
    const execution = item.execution;
    if (execution?.kind === 'unassigned') return '尚未分派';
    if (!execution || execution.kind === 'unknown') return '执行方未获取';
    const organization = execution.name || execution.instanceId || '组织名称未提供';
    return execution.kind === 'delegated' ? `已委派给 ${organization}` : `${organization} · 本地执行`;
  }
  function taskProgressSource(source) {
    return ({ 'worker-report': '执行方最新回报', 'delegation-snapshot': '下级任务状态', question: '待回答问题', command: '交办回执' })[source] || '最近进展';
  }
  function taskReceiptTrace(ref) {
    // These identifiers come from persisted message receipts, never assistant prose.
    if (jarvis.state.runtime !== 'dsh' || !/^JW-[a-f0-9]{12}$/.test(ref.workRef)) return null;
    if (ref.instanceId !== undefined && !/^[a-z][a-z0-9-]*$/.test(ref.instanceId)) return null;
    if (ref.traceId !== undefined) {
      const trace = /^work:([a-z][a-z0-9-]*):(JW-[a-f0-9]{12})$/.exec(ref.traceId);
      return trace && trace[2] === ref.workRef && (!ref.instanceId || trace[1] === ref.instanceId) ? ref.traceId : null;
    }
    // The existing daily Gateway accepts work through the root organization.
    return `work:${ref.instanceId || 'root'}:${ref.workRef}`;
  }
  const reportStateText = value => ({ progress: '推进中', waiting: '等待事件', ready: '结果待验收', blocked: '受阻', failed: '失败', dropped: '已放弃' })[value] || value || '状态未提供';
  function taskLogCandidate(entry, traceId) {
    return entry && Number.isSafeInteger(entry.id) && entry.id > 0 && entry.traceId === traceId && /^[a-z][a-z0-9-]*$/.test(entry.organizationId) &&
      ['core/ticket/snapshot', 'instance/process-delegation/out/snapshot', 'gateway/command/snapshot'].includes(entry.event);
  }
  function taskLogDetail(value, entry, traceId) {
    return taskLogCandidate(value, traceId) && value.id === entry.id && value.organizationId === entry.organizationId && value.event === entry.event &&
      value.detail?.provenance === 'snapshot' && !value.detail.omitted && value.detail.record && typeof value.detail.record === 'object' ? value : null;
  }
  function recordedDelegation(entry) {
    const { request, snapshot } = entry.detail.record;
    if (!request || !snapshot || !/^[a-z][a-z0-9-]*$/.test(request.targetInstanceId) || request.path?.[0] !== entry.organizationId ||
      entry.refs?.ticketId !== request.parentTicketId || entry.refs?.assignmentId !== request.parentAssignmentId ||
      snapshot.delegationId !== request.delegationId || snapshot.parentTicketId !== request.parentTicketId ||
      snapshot.parentAssignmentId !== request.parentAssignmentId || snapshot.childInstanceId !== request.targetInstanceId) return null;
    return { entry, request, snapshot };
  }
  function recordedWorker(entry, delegation, ownerId, cores) {
    const ticket = entry.detail.record, assignment = Array.isArray(ticket.assignments) ? ticket.assignments.at(-1) : null;
    if (!ticket.id || ticket.id !== entry.refs?.ticketId || typeof assignment?.report?.summary !== 'string' || !assignment.report.summary) return null;
    const authority = ticket.mandate?.basis?.via === 'delegation' ? ticket.mandate.basis.delegation : null;
    if (delegation) {
      const { request, snapshot } = delegation;
      if (entry.organizationId !== request.targetInstanceId || ticket.id !== snapshot.ticketId || !authority ||
        authority.delegationId !== request.delegationId || authority.parentInstanceId !== delegation.entry.organizationId ||
        authority.parentTicketId !== request.parentTicketId || authority.parentAssignmentId !== request.parentAssignmentId || authority.parentDecisionId !== request.parentDecisionId) return null;
    } else if (entry.organizationId !== ownerId) {
      const parent = authority && cores?.find(core => core.organizationId === ownerId && core.detail.record.id === authority.parentTicketId)?.detail.record;
      if (authority?.parentInstanceId !== ownerId || !parent || parent.decisionId !== authority.parentDecisionId || parent.assignments?.at(-1)?.id !== authority.parentAssignmentId) return null;
    }
    const executionVerified = !!delegation || entry.organizationId !== ownerId && !!authority;
    return { organizationId: entry.organizationId, organizationName: entry.organizationName || entry.organizationId, executionVerified,
      ticketId: ticket.id, workerId: executionVerified && assignment.startedAt ? `worker-${ticket.id}` : null, assignmentId: assignment.id,
      summary: assignment.report.summary, reportState: assignment.report.state, at: assignment.report.at || null,
      observedAt: entry.detail.observedAt || null, source: 'worker-report', entryId: entry.id };
  }
  function selectTaskRecord(entries, ref, traceId) {
    const ownerId = traceId.split(':')[1];
    const original = entries.find(entry => entry.event === 'gateway/command/snapshot' && entry.detail.record.workRef === ref.workRef &&
      entry.detail.record.operation === 'new' && (!ref.conversationId || entry.detail.record.origin?.conversationId === ref.conversationId))?.detail.record;
    const cores = entries.filter(entry => entry.event === 'core/ticket/snapshot');
    const delegations = entries.filter(entry => entry.event === 'instance/process-delegation/out/snapshot' && entry.organizationId === ownerId).map(recordedDelegation).filter(Boolean)
      .filter(({ entry, request }) => {
        const parent = cores.find(core => core.organizationId === entry.organizationId && core.detail.record.id === request.parentTicketId)?.detail.record;
        return !parent || parent.decisionId === request.parentDecisionId && parent.assignments?.at(-1)?.id === request.parentAssignmentId;
      });
    let result;
    if (delegations.length) {
      const delegation = delegations[0];
      result = cores.map(entry => recordedWorker(entry, delegation, ownerId)).filter(Boolean)[0];
      if (!result && typeof delegation.snapshot.summary === 'string' && delegation.snapshot.summary) {
        const target = cores.find(entry => entry.organizationId === delegation.request.targetInstanceId);
        result = { organizationId: delegation.request.targetInstanceId, organizationName: target?.organizationName || delegation.request.targetInstanceId,
          executionVerified: true, workerId: null, assignmentId: delegation.snapshot.assignmentId || null, summary: delegation.snapshot.summary,
          reportState: delegation.snapshot.status, at: null, observedAt: delegation.entry.detail.observedAt || null, source: 'delegation-snapshot', entryId: delegation.entry.id };
      }
    } else {
      const reports = cores.map(entry => recordedWorker(entry, null, ownerId, cores)).filter(Boolean);
      reports.sort((first, second) => Number(second.executionVerified) - Number(first.executionVerified) || (Date.parse(second.at) || 0) - (Date.parse(first.at) || 0));
      result = reports[0];
    }
    return result || original ? { ...result, title: original?.summary || null, originalRequest: original?.quote || null } : null;
  }
  function taskSnapshotGroups(entries, ref) {
    const newest = new Map();
    for (const entry of [...entries].sort((first, second) => second.id - first.id)) {
      const identity = entry.event === 'gateway/command/snapshot' ? entry.refs?.commandId || entry.id
        : entry.event === 'core/ticket/snapshot' ? entry.refs?.ticketId || entry.id
          : JSON.stringify([entry.refs?.ticketId || entry.id, entry.refs?.assignmentId]);
      const key = JSON.stringify([entry.event, entry.organizationId, identity]);
      if (!newest.has(key)) newest.set(key, entry);
    }
    const distinct = [...newest.values()], commands = distinct.filter(entry => entry.event === 'gateway/command/snapshot');
    const initialCommands = [...new Map([commands.find(entry => entry.refs?.commandId === ref.commandId), commands.at(-1), commands[0]].filter(Boolean).map(entry => [entry.id, entry])).values()];
    return { initial: [...initialCommands, ...distinct.filter(entry => entry.event === 'instance/process-delegation/out/snapshot').slice(0, 3)],
      cores: distinct.filter(entry => entry.event === 'core/ticket/snapshot') };
  }
  async function taskSnapshotDetails(entries, traceId) {
    const results = await Promise.allSettled(entries.map(async entry => taskLogDetail(await jarvis.api('/api/logs/' + entry.id), entry, traceId)));
    return results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
  }
  function taskSnapshotCores(cores, initial, limit) {
    const delegations = initial.filter(entry => entry.event === 'instance/process-delegation/out/snapshot').map(recordedDelegation).filter(Boolean);
    const priority = entry => delegations.some(({ request, snapshot }) => entry.organizationId === request.targetInstanceId && entry.refs?.ticketId === snapshot.ticketId) ? 0
      : delegations.some(({ entry: parent, request }) => entry.organizationId === parent.organizationId && entry.refs?.ticketId === request.parentTicketId) ? 1 : 2;
    return [...cores].sort((first, second) => priority(first) - priority(second) || second.id - first.id).slice(0, limit);
  }
  async function readTaskRecords(ref) {
    const traceId = taskReceiptTrace(ref);
    if (tasksAvailable || !traceId || taskRecordsRead.has(ref.workRef) || taskRecordRequests.has(ref.workRef)) return;
    const request = { epoch: taskEpoch }; taskRecordRequests.set(ref.workRef, request); renderTaskCards();
    try {
      const pages = await Promise.allSettled(['worker', 'runtime', 'gateway'].map(role => jarvis.api('/api/logs?' + new URLSearchParams({ trace: traceId, role, limit: '50' }))));
      if (request.epoch !== taskEpoch) return;
      const readable = pages.filter(page => page.status === 'fulfilled' && Array.isArray(page.value?.items));
      if (!readable.length) throw new Error('暂时无法读取任务记录，请查看任务日志。');
      // The logs API may include shared Router turns. Only the exact persisted task trace is admissible here.
      const entries = [...new Map(readable.flatMap(page => page.value.items).filter(entry => taskLogCandidate(entry, traceId) &&
        (!entry.refs?.workRef || entry.refs.workRef === ref.workRef)).map(entry => [entry.id, entry])).values()];
      // Reserve original-command and delegation evidence before spending the detail budget on Core snapshots.
      const groups = taskSnapshotGroups(entries, ref), initial = await taskSnapshotDetails(groups.initial, traceId);
      if (request.epoch !== taskEpoch) return;
      const cores = await taskSnapshotDetails(taskSnapshotCores(groups.cores, initial, 12 - groups.initial.length), traceId);
      if (request.epoch !== taskEpoch) return;
      const record = selectTaskRecord([...initial, ...cores], ref, traceId);
      if (record) taskRecords.set(ref.workRef, record);
      taskRecordsRead.add(ref.workRef); taskErrors.delete(ref.workRef);
    } catch (failure) {
      if (request.epoch === taskEpoch) taskErrors.set(ref.workRef, failure.message || '暂时无法读取任务记录，请查看任务日志。');
    } finally {
      if (taskRecordRequests.get(ref.workRef) === request) { taskRecordRequests.delete(ref.workRef); renderTaskCards(); }
    }
  }
  function taskPart(name, label, ...children) {
    const part = taskNode('details', 'chat-task-part');
    part.dataset.taskPart = name;
    part.append(taskNode('summary', '', label), ...children);
    return part;
  }
  function taskRequirements(item, record) {
    const body = taskNode('div', 'chat-task-request-body');
    const title = item?.title || record?.title;
    const request = item?.originalRequest || record?.originalRequest;
    if (title && title !== request) body.append(taskNode('strong', '', title));
    body.append(taskNode('p', '', request || (title ? '原始请求正文暂不可读。' : '正在关联原始任务记录。')));
    if (item?.ticketTitle && item.ticketTitle !== title && item.ticketTitle !== request) body.append(taskNode('p', 'chat-task-note', `工单标题：${item.ticketTitle}`));
    return taskPart('request', '原始任务', body);
  }
  function taskExecutionRecord(item, ref, record) {
    const fields = taskNode('dl', 'chat-task-detail-meta');
    if (record?.summary) {
      fields.append(...taskFields([
        ['任务编号', ref.workRef], [record.executionVerified ? '执行组织' : '记录组织', record.organizationName || record.organizationId],
        ['Worker', record.workerId || '尚未取得实际 Worker 标识'], ['分派编号', record.assignmentId || '未提供'],
        ['记录时间', taskDate(record.at)], ['采集时间', taskDate(record.observedAt)],
      ]));
    } else {
      const execution = item?.execution;
      const actualAssignment = execution?.assignment || (execution?.kind === 'local' || item?.assignment?.id === execution?.assignmentId ? item?.assignment : null);
      const state = value => ({ pending: '等待执行', running: '执行中', ended: '已结束' })[value] || value || '尚未获取';
      fields.append(...taskFields([
        ['任务编号', ref.workRef], ['任务归属', item?.owner?.name || item?.owner?.instanceId || '未获取归属组织'], ['执行组织', taskExecution(item, ref)],
        ['Worker', execution?.workerId || (execution?.kind === 'unassigned' ? '尚未分配' : '未获取 Worker 标识')],
        ['分派状态', state(actualAssignment?.state)], ['分派编号', execution?.assignmentId || actualAssignment?.id || '未提供'],
        ['开始时间', taskDate(actualAssignment?.startedAt)], ['结束时间', taskDate(actualAssignment?.endedAt)], ['提交时间', taskDate(item?.receivedAt || ref.receivedAt)],
      ]));
      if (item?.assignment && item.assignment.id !== (execution?.assignmentId || actualAssignment?.id)) fields.append(...taskFields([
        ['归属组织派工', item.assignment.id], ['归属派工状态', state(item.assignment.state)],
      ]));
      if (item?.recordedStatus && item.recordedStatus !== item.status) fields.append(...taskFields([['最近留存状态', item.recordedStatus]]));
    }
    return taskPart('execution', '执行记录', fields);
  }
  function taskDetailContent(item, ref, record) {
    const content = document.createDocumentFragment();
    const archived = !!record?.summary;
    const report = archived ? { ...record, state: record.reportState } : item?.progress;
    const result = taskNode('section', 'chat-task-result');
    const heading = taskNode('div', 'chat-task-result-heading');
    const label = archived ? '历史回报' : report?.source === 'question' ? '待回答的问题' : item?.status === 'completed' ? '任务结果' : '任务进展';
    const icon = taskNode('span', 'chat-task-result-icon');
    icon.setAttribute('aria-hidden', 'true');
    heading.append(icon, taskNode('h4', '', label));
    if (report) {
      const via = taskProgressSource(report.source);
      const state = report.state ? ' · ' + reportStateText(report.state) : '';
      heading.append(taskNode('span', 'chat-task-result-source', via + state));
    }
    result.append(heading);
    content.append(result);
    if (report?.summary) {
      const context = archived ? { instanceId: record.organizationId, workerId: record.workerId, ticketId: record.ticketId }
        : report.organizationId && item.execution?.instanceId === report.organizationId ? item.execution : {};
      const view = taskReportView(report.summary, context);
      if (view.hasMore) {
        const preview = taskNode('div', 'chat-task-progress chat-task-report-body');
        if (view.preview) renderReply(preview, view.preview, context);
        else preview.append(taskNode('p', '', taskExcerpt(view.body.querySelector('p, li, pre, h3')?.textContent || '查看详细回报')));
        result.append(preview);
      } else if (view.body.textContent) {
        view.body.classList.add('chat-task-progress'); result.append(view.body);
      }
      if (report.at) {
        const time = taskNode('time', 'chat-task-report-time', `记录于 ${taskDate(report.at)}`);
        time.dateTime = report.at; result.append(time);
      }
      if (view.files) content.append(view.files);
      if (view.hasMore) content.append(taskPart('report', '详细回报', view.body));
    } else {
      result.append(taskNode('p', 'chat-task-progress', item ? '暂无可读取的进展记录。' : '提交回执仅确认入队，尚未确认接单或分派。'));
    }
    content.append(taskRequirements(item, record), taskExecutionRecord(item, ref, record));
    return content;
  }
  function taskControlKey(control) {
    const part = control.closest('[data-task-part]')?.dataset.taskPart || '';
    if (control.tagName === 'SUMMARY') return 'summary:' + part;
    if (control.tagName === 'A') return JSON.stringify([part, control.getAttribute('href')]);
    if (control.tagName === 'BUTTON') return 'button:' + control.className;
    return null;
  }
  function readCardView(element) {
    const focus = document.activeElement;
    return {
      parts: [...element.querySelectorAll('details[data-task-part][open]')].map(part => part.dataset.taskPart),
      focus: element.contains(focus) ? taskControlKey(focus) : null,
    };
  }
  function restoreCardView(element, view) {
    for (const part of element.querySelectorAll('details[data-task-part]')) part.open = view.parts.includes(part.dataset.taskPart);
    if (view.focus && !element.contains(document.activeElement)) {
      const target = [...element.querySelectorAll('summary,button:not(:disabled),a[href]')].find(control => !control.hidden && taskControlKey(control) === view.focus);
      (target || element.querySelector('summary')).focus({ preventScroll:true });
    }
  }
  function updateTaskCard(card) {
    const { ref, status, title, reference, execution, updated, freshness, error, refresh, detailBody, logs } = card;
    const saved = taskItems.get(ref.workRef), item = saved?.item, failure = taskErrors.get(ref.workRef), record = !item && taskRecords.get(ref.workRef);
    card.element.dataset.status = item?.status || (record?.summary ? 'unknown' : ['queued', 'replayed'].includes(ref.status) ? 'queued' : 'unknown');
    status.textContent = item?.statusLabel || (record?.summary ? '最近记录' : ['queued', 'replayed'].includes(ref.status) ? '已提交' : '状态尚未同步');
    const fullTitle = item?.title || record?.title || ref.workRef;
    title.textContent = taskExcerpt(fullTitle);
    reference.hidden = fullTitle === ref.workRef;
    execution.textContent = record?.summary ? `${record.executionVerified ? '执行组织' : '记录组织'}（最近记录）· ${record.organizationName || record.organizationId}` : taskExecution(item, ref);
    const timestamp = item?.updatedAt || record?.at || record?.observedAt || ref.receivedAt;
    updated.textContent = `${item ? '更新于' : record?.summary ? record.at ? '记录于' : '采集于' : '提交于'} ${taskDate(timestamp)}`;
    if (timestamp) updated.dateTime = timestamp; else updated.removeAttribute('datetime');
    const note = failure ? `${failure}${item ? ' 以下为上次读取的记录。' : ''}` : record?.summary ? '以下为已收录的最近记录，当前执行状态尚未同步。' : taskRecordsRead.has(ref.workRef) ? '尚未读取到完整的任务执行记录，请查看任务日志。' : item?.availability === 'stored' ? '当前展示已留存状态，执行服务尚未同步。' : item?.availability === 'unavailable' ? '任务执行状态暂不可用。' : '';
    error.textContent = note; error.hidden = !note;
    freshness.textContent = failure ? '状态未同步' : item?.availability === 'stored' ? '上次记录' : '';
    freshness.hidden = !freshness.textContent;
    refresh.hidden = tasksAvailable ? !taskBinding : !taskReceiptTrace(ref);
    refresh.disabled = tasksAvailable ? !!taskRequest || taskDetailRequests.has(ref.workRef) : taskRecordRequests.has(ref.workRef) || taskRecordsRead.has(ref.workRef);
    refresh.textContent = tasksAvailable ? refresh.disabled ? '正在更新…' : failure ? '重试状态' : '刷新状态' : taskRecordRequests.has(ref.workRef) ? '正在读取记录…' : taskRecordsRead.has(ref.workRef) ? '已读取最近记录' : failure ? '重试读取记录' : '读取最近记录';
    const surface = JSON.stringify([item, record, ref]);
    if (surface !== card.detailSurface) {
      const view = card.detailSurface && readCardView(card.element);
      card.detailSurface = surface;
      detailBody.replaceChildren(taskDetailContent(item, ref, record));
      if (view) restoreCardView(card.element, view);
    }
    const traceId = item?.logs?.traceId || (!tasksAvailable ? taskReceiptTrace(ref) : null);
    logs.hidden = !traceId;
    if (traceId) logs.href = '#logs?trace=' + encodeURIComponent(traceId);
  }
  function renderTaskCards() {
    const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
    for (const cards of taskCards.values()) for (const card of cards) updateTaskCard(card);
    if (bottom && !document.activeElement?.closest('.chat-task-card')) thread.scrollTop = thread.scrollHeight;
  }
  function createTaskCard(turn, ref) {
    const key = JSON.stringify([turn.id, ref.workRef]), epoch = taskEpoch;
    const element = taskNode('section', 'chat-task-card'); element.dataset.workRef = ref.workRef; element.setAttribute('aria-label', `关联任务 ${ref.workRef}`);
    element.dataset.turnId = turn.id; element.dataset.epoch = epoch;
    const detail = taskNode('details', 'chat-task-details'), header = taskNode('summary', 'chat-task-heading');
    const glyph = taskNode('span', 'chat-task-glyph'), chevron = taskNode('span', 'chat-task-chevron');
    glyph.setAttribute('aria-hidden', 'true'); chevron.setAttribute('aria-hidden', 'true');
    const label = taskNode('span', 'chat-task-label', '关联任务'), reference = taskNode('code', 'chat-task-reference', ref.workRef);
    label.append(reference);
    const title = taskNode('strong', 'chat-task-title'), status = taskNode('span', 'chat-task-state');
    const meta = taskNode('span', 'chat-task-caption'), execution = taskNode('span', 'chat-task-execution');
    const updated = taskNode('time', 'chat-task-updated'), freshness = taskNode('span', 'chat-task-freshness');
    meta.append(execution, updated, freshness);
    header.append(glyph, label, status, title, meta, chevron);
    const panel = taskNode('div', 'chat-task-panel'), detailBody = taskNode('div', 'chat-task-detail-body');
    const error = taskNode('p', 'chat-task-note'); error.setAttribute('role', 'status');
    detail.open = !!taskDetails.get(key);
    detail.addEventListener('toggle', () => {
      if (epoch !== taskEpoch || !element.isConnected) return;
      const wasOpen = taskDetails.get(key); taskDetails.set(key, detail.open);
      if (detail.open && !wasOpen) { if (tasksAvailable) refreshTask(ref.workRef); else readTaskRecords(ref); }
    });
    const actions = taskNode('div', 'chat-task-actions');
    if (ref.actionable) {
      const action = taskNode('button', 'work-reference', ref.questionId ? `回答问题 · ${ref.workRef}` : `继续此任务 · ${ref.workRef}`); action.type = 'button';
      action.addEventListener('click', () => { if (epoch === taskEpoch && element.isConnected) selectWork(ref); }); actions.append(action);
    }
    const refresh = taskNode('button', 'chat-task-refresh', '刷新状态'); refresh.type = 'button';
    refresh.addEventListener('click', () => { if (tasksAvailable) refreshTask(ref.workRef); else readTaskRecords(ref); });
    const logs = taskNode('a', 'chat-task-logs', '查看任务日志'); actions.append(refresh, logs);
    panel.append(error, detailBody, actions);
    detail.append(header, panel); element.append(detail);
    const card = { element, ref, title, status, reference, execution, updated, freshness, error, detailBody, refresh, logs };
    if (!taskCards.has(ref.workRef)) taskCards.set(ref.workRef, new Set());
    taskCards.get(ref.workRef).add(card); updateTaskCard(card);
    return element;
  }
  function validTaskResponse(value, binding, refs, single = false) {
    const items = single ? [value?.item] : value?.items;
    if (!value || value.conversationId !== binding.conversationId || taskBindingKey(value.binding) !== taskBindingKey(binding) || !Array.isArray(items) ||
      items.some(item => !item || !refs.includes(item.workRef) || item.conversationId !== binding.conversationId || !taskStatuses.has(item.status) || typeof item.statusLabel !== 'string' ||
        !['live', 'stored', 'unavailable'].includes(item.availability)) || new Set(items.map(item => item.workRef)).size !== items.length) throw new Error('任务状态与当前会话不匹配，请重试。');
    return items;
  }
  function saveTaskItems(items, observedAt) {
    for (const item of items) {
      const old = taskItems.get(item.workRef);
      if (!old || !old.observedAt || !observedAt || new Date(observedAt).getTime() >= new Date(old.observedAt).getTime()) taskItems.set(item.workRef, {
        item: item.originalRequest == null && old?.item.originalRequest ? { ...item, originalRequest: old.item.originalRequest } : item, observedAt,
      });
      taskErrors.delete(item.workRef);
    }
  }
  function scheduleTasks() {
    clearTimeout(taskTimer);
    if (tasksAvailable && taskBinding && tasksVisible() && taskCards.size && !taskRequest) taskTimer = setTimeout(refreshTasks, 5000);
  }
  function queueTasks() {
    if (!tasksAvailable || !taskBinding || !tasksVisible() || !taskCards.size) return;
    const signature = JSON.stringify(currentTaskRefs().sort());
    if (!taskRequest && signature !== taskRequestedRefs) refreshTasks();
    else if (!taskTimer && !taskRequest) scheduleTasks();
  }
  async function refreshTasks() {
    if (!tasksAvailable || !taskBinding || !tasksVisible() || taskRequest || !taskCards.size) return;
    clearTimeout(taskTimer); taskTimer = null;
    const request = { epoch: taskEpoch, binding: taskBinding }, refs = currentTaskRefs(); taskRequest = request;
    taskRequestedRefs = JSON.stringify([...refs].sort()); renderTaskCards();
    try {
      for (let offset = 0; offset < refs.length; offset += 20) {
        const batch = refs.slice(offset, offset + 20), query = new URLSearchParams({ conversationId: request.binding.conversationId, limit: '20' });
        for (const ref of batch) query.append('workRef', ref);
        const value = await jarvis.api('/api/tasks?' + query);
        if (request.epoch !== taskEpoch) return;
        const items = validTaskResponse(value, request.binding, batch);
        saveTaskItems(items, value.observedAt);
        for (const ref of batch) if (!items.some(item => item.workRef === ref)) taskErrors.set(ref, '尚未读取到此任务的状态。');
      }
    } catch (failure) {
      if (request.epoch !== taskEpoch) return;
      for (const ref of refs) taskErrors.set(ref, failure.message || '暂时无法读取任务状态，请重试。');
    } finally {
      if (request === taskRequest) { taskRequest = null; renderTaskCards(); scheduleTasks(); queueTasks(); }
    }
  }
  async function refreshTask(workRef) {
    if (!tasksAvailable || !taskBinding || !tasksVisible() || taskDetailRequests.has(workRef)) return;
    const request = { epoch: taskEpoch, binding: taskBinding }; taskDetailRequests.set(workRef, request); renderTaskCards();
    try {
      const value = await jarvis.api('/api/tasks/' + encodeURIComponent(workRef) + '?' + new URLSearchParams({ conversationId: request.binding.conversationId }));
      if (request.epoch !== taskEpoch) return;
      saveTaskItems(validTaskResponse(value, request.binding, [workRef], true), value.observedAt);
    } catch (failure) {
      if (request.epoch === taskEpoch) taskErrors.set(workRef, failure.message || '暂时无法读取任务状态，请重试。');
    } finally {
      if (taskDetailRequests.get(workRef) === request) { taskDetailRequests.delete(workRef); renderTaskCards(); }
    }
  }

  // Build readable model output from text nodes; model-supplied HTML is never executed.
  function inline(parent, source, executionContext) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      parent.append(document.createTextNode(source.slice(offset, match.index)));
      const token = match[0];
      let node;
      if (token.startsWith('`')) {
        node = document.createElement('code'); node.textContent = token.slice(1, -1);
      } else if (token.startsWith('**')) {
        node = document.createElement('strong'); inline(node, token.slice(2, -2), executionContext);
      } else {
        const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
        let url;
        try {
          // Local deliverables use authenticated routes; arbitrary relative links stay plain text.
          url = /^\/jarvis\/api\/system\/[a-z][a-z0-9-]*\/artifacts\//.test(parts[2])
            ? new URL(parts[2], location.origin) : new URL(parts[2]);
          if (executionContext && url.origin === location.origin) {
            const local = parts[2].startsWith('/') ? parts[2] : parts[2].replace(/^https?:\/\/[^/]+/i, '');
            if ((local.startsWith('/jarvis/api/system/') || url.pathname.startsWith('/jarvis/api/system/'))
              && !taskReportArtifactUrl(local, executionContext)) url = null;
          }
        } catch {}
        if (url && ['http:', 'https:'].includes(url.protocol)) {
          node = document.createElement('a'); node.href = url.href;
          node.target = '_blank'; node.rel = 'noopener noreferrer'; node.textContent = parts[1];
        } else node = document.createTextNode(token);
      }
      parent.append(node); offset = match.index + token.length;
    }
    parent.append(document.createTextNode(source.slice(offset)));
  }
  function renderReply(content, source, executionContext) {
    const fragment = document.createDocumentFragment();
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    let paragraph = [];
    const flush = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p'); inline(p, paragraph.join('\n'), executionContext); fragment.append(p); paragraph = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush(); const codeLines = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) codeLines.push(lines[i]);
        const pre = document.createElement('pre'); const code = document.createElement('code');
        code.textContent = codeLines.join('\n'); pre.append(code); fragment.append(pre);
      } else if (/^#{1,4}\s+/.test(line)) {
        flush(); const heading = document.createElement('h3'); inline(heading, line.replace(/^#+\s+/, ''), executionContext); fragment.append(heading);
      } else if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
        flush(); const ordered = /^\s*\d+[.)] /.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        if (ordered) list.start = parseInt(line.trim(), 10);
        const pattern = ordered ? /^\s*\d+[.)] (.*)$/ : /^\s*[-*+] (.*)$/;
        do {
          const item = document.createElement('li'); inline(item, pattern.exec(lines[i])[1], executionContext); list.append(item);
          i++;
        } while (i < lines.length && pattern.test(lines[i]));
        i--; fragment.append(list);
      } else if (!line.trim()) flush();
      else paragraph.push(line);
    }
    flush(); content.replaceChildren(fragment);
  }

  function taskReportArtifactUrl(value, context) {
    if (typeof value !== 'string' || !context || !/^[a-z][a-z0-9-]{0,47}$/.test(context.instanceId || '')) return null;
    const match = /^\/jarvis\/api\/system\/([a-z][a-z0-9-]{0,47})\/artifacts\/([^/?#]+)\/([^?#]+)(\?download=1)?$/.exec(value);
    if (!match || match[1] !== context.instanceId) return null;
    const workerTicket = typeof context.workerId === 'string' && context.workerId.startsWith('worker-') ? context.workerId.slice(7) : null;
    const ticketId = context.ticketId || workerTicket;
    // Assignment IDs and JW references are different identities; neither binds an artifact's Core ticket.
    if (typeof ticketId !== 'string' || !ticketId || context.workerId && workerTicket !== ticketId) return null;
    try {
      if (decodeURIComponent(match[2]) !== ticketId || encodeURIComponent(ticketId) !== match[2]
        || /[\u0000-\u001f\u007f/\\:]/.test(ticketId) || ['.', '..'].includes(ticketId)) return null;
      const parts = match[3].split('/').map(part => {
        const decoded = decodeURIComponent(part);
        if (!decoded || ['.', '..'].includes(decoded) || /[\u0000-\u001f\u007f/\\:]/.test(decoded) || encodeURIComponent(decoded) !== part) throw new Error('Invalid artifact path');
        return decoded;
      });
      const url = value.replace(/\?download=1$/, '');
      return { url, downloadUrl: url + '?download=1', name: parts.join('/'), download: !!match[4] };
    } catch { return null; }
  }
  function taskReportFiles(artifacts) {
    if (!artifacts.length) return null;
    const section = taskNode('section', 'chat-task-files');
    const list = taskNode('ul', 'chat-task-file-list');
    section.append(taskNode('h4', '', '交付文件'), list);
    for (const artifact of artifacts) {
      const row = taskNode('li', 'chat-task-file');
      const extension = /\.([a-z0-9]{1,5})$/i.exec(artifact.name)?.[1].toUpperCase() || 'FILE';
      const icon = taskNode('span', 'chat-task-file-icon', extension); icon.setAttribute('aria-hidden', 'true');
      const info = taskNode('div', 'chat-task-file-info');
      info.append(taskNode('strong', 'chat-task-file-title', artifact.title));
      if (artifact.title !== artifact.name) info.append(taskNode('span', 'chat-task-file-name', artifact.name));
      const actions = taskNode('div', 'chat-task-file-actions');
      for (const [label, href, kind] of [['打开', artifact.url, 'open'], ['下载', artifact.downloadUrl, 'download']]) {
        const link = taskNode('a', `chat-task-file-${kind}`, label);
        link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `${label} ${artifact.name}`); actions.append(link);
      }
      row.append(icon, info, actions); list.append(row);
    }
    return section;
  }
  function registeredTaskFile(entry, context) {
    const file = taskReportArtifactUrl(entry?.url, context);
    if (!file || file.download || entry.downloadUrl !== file.downloadUrl || typeof entry.title !== 'string') return null;
    return { ...file, title: entry.title.trim() || file.name };
  }
  function taskReportView(summary, executionContext = {}, registered = []) {
    const lines = (typeof summary === 'string' ? summary : '').replace(/\r\n?/g, '\n').split('\n');
    const remaining = [], artifacts = [], seen = new Set();
    let fence = null;
    for (const line of lines) {
      const delimiter = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
      if (delimiter) {
        if (!fence) fence = delimiter[1];
        else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
        remaining.push(line); continue;
      }
      // Only the owner's generated, complete open/download row is promoted. Descriptive prose stays in the report.
      const row = !fence && /^- ([^\[\]\\\u0000-\u001f]+)：\[打开\]\((\S+)\) · \[下载\]\((\S+)\)$/.exec(line);
      const file = row && taskReportArtifactUrl(row[2], executionContext);
      if (!file || file.download || row[3] !== file.downloadUrl) { remaining.push(line); continue; }
      const title = row[1].trim() || file.name, identity = JSON.stringify([file.url, title]);
      if (!seen.has(identity)) { seen.add(identity); artifacts.push({ ...file, title }); }
    }
    const urls = new Set(artifacts.map(file => file.url));
    for (const entry of registered || []) {
      const file = registeredTaskFile(entry, executionContext);
      if (file && !urls.has(file.url)) { urls.add(file.url); artifacts.push(file); }
    }
    const body = taskNode('div', 'chat-task-report-body');
    renderReply(body, remaining.join('\n'), executionContext);
    const first = body.firstElementChild;
    let preview = '', hasMore = body.textContent.length > 420 || body.childElementCount > 4;
    if (body.childElementCount > 1 && first.tagName === 'P' && !first.childElementCount) {
      const paragraph = first.textContent.trim();
      if (paragraph && Array.from(paragraph).length <= 180 && !/^[>#|]/.test(paragraph)
        && !/[`*_[\]<>]|https?:\/\/|\/jarvis\//i.test(paragraph)) {
        preview = paragraph; first.remove(); hasMore = true;
      }
    }
    return { preview, body, files: taskReportFiles(artifacts), hasMore };
  }

  function message(role, text) {
    const article = document.createElement('article');
    article.className = `message ${role}`;
    const avatar = document.createElement('div');
    avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true');
    if (role === 'jarvis') avatar.setAttribute('data-assistant-initial', '');
    avatar.textContent = role === 'jarvis' ? Array.from(assistantIdentity.name)[0] : '你';
    const body = document.createElement('div');
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    const content = document.createElement(role === 'jarvis' ? 'div' : 'p');
    if (role === 'jarvis') renderReply(content, text); else content.textContent = text;
    bubble.append(content);
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const author = document.createElement('span');
    if (role === 'jarvis') author.setAttribute('data-assistant-name', '');
    author.textContent = role === 'jarvis' ? assistantIdentity.name : '你';
    meta.append(author); body.append(bubble, meta); article.append(avatar, body);
    thread.append(article);
    return { article, body, content, meta };
  }
  function statusLabel(turn) {
    if (turn.status === 'streaming') return '正在回复…';
    if (turn.status === 'complete') return '';
    return turn.error || '回复未完成';
  }
  function render() {
    const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
    const views = new Map();
    const cardFocused = !!document.activeElement?.closest('.chat-task-card');
    for (const cards of taskCards.values()) for (const { element } of cards) {
      if (element.dataset.epoch !== String(taskEpoch)) continue;
      const view = readCardView(element);
      if (view.parts.length || view.focus) views.set(JSON.stringify([element.dataset.turnId, element.dataset.workRef]), view);
    }
    thread.replaceChildren(); nodes.clear(); taskCards.clear();
    const projection = projectedTurns();
    byId('conversation-page').classList.toggle('is-empty', !projection.length);
    if (!projection.length) {
      const empty = document.createElement('div'); empty.className = 'chat-empty';
      const orb = document.createElement('div'); orb.className = 'assistant-orb'; orb.setAttribute('aria-hidden', 'true');
      const title = document.createElement('h2'); title.textContent = '今天想一起推进什么？';
      const action = document.createElement('button'); action.className = 'action secondary'; action.type = 'button'; action.textContent = '配置模型';
      action.addEventListener('click', () => { location.hash = 'settings/model'; });
      empty.append(orb, title);
      if (!jarvis.state.model.value.endpoint) empty.append(action);
      thread.append(empty);
    }
    for (const turn of projection) {
      let delivery;
      if (turn.role !== 'assistant' && turn.source !== 'gateway') {
        const user = message('user', turn.user);
        user.article.dataset.turnId = turn.id;
        delivery = document.createElement('span'); delivery.className = 'send-status'; delivery.setAttribute('role', 'status');
        delivery.textContent = turn.pending ? turn.pending.cancelled ? '已取消，发送状态待确认' : ({ sending: '发送中…', uncertain: '发送状态待确认', failed: '发送失败', cancelled: '已取消，发送状态待确认' })[turn.pending.phase]
          : turn.status === 'streaming' && !turn.assistant ? '已发送，等待回复' : '';
        delivery.hidden = !turn.pending && (turn.status !== 'streaming' || Boolean(turn.assistant));
        user.body.append(delivery);
        if (turn.pending && turn.pending.phase !== 'sending' && !busy && canChat()) {
          const entry = turn.pending, retry = document.createElement('button');
          retry.type = 'button'; retry.className = 'action secondary'; retry.textContent = '重试发送';
          retry.addEventListener('click', () => {
            // User edits or task changes retire this marker, even for identical text.
            if (outbox.get(turn.id) === entry && entry.scope === sendScope()) submit(entry.payload, { consumeDraft: restoredDraftId === turn.id });
          });
          user.body.append(retry);
        }
      }
      if (turn.local) continue;
      const node = message('jarvis', turn.assistant || '');
      node.delivery = delivery;
      const status = document.createElement('span'); status.className = 'turn-status'; status.textContent = statusLabel(turn); node.meta.append(status);
      if (turn.status === 'complete' && turn.assistant) {
        const actions = document.createElement('div'); actions.className = 'message-tools';
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-reply'; copy.setAttribute('aria-label', '复制回复'); copy.title = '复制回复';
        copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 4H7a3 3 0 0 0-3 3v8"/></svg>';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(turn.assistant); copy.title = '已复制'; copy.setAttribute('aria-label', '已复制');
            copy.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
          }
          catch { copy.title = '复制失败，请选择文字复制'; copy.setAttribute('aria-label', copy.title); }
        });
        actions.append(copy); node.body.append(actions);
      }
      for (const ref of taskReferences(turn)) {
        const element = createTaskCard(turn, ref);
        node.body.append(element);
        const view = views.get(JSON.stringify([element.dataset.turnId, ref.workRef]));
        if (view) restoreCardView(element, view);
      }
      for (const artifact of turn.artifacts || []) {
        if (!artifact || typeof artifact.title !== 'string' || !/^\/jarvis\/api\/system\/[a-z][a-z0-9-]*\/artifacts\//.test(artifact.url || '') || artifact.downloadUrl !== artifact.url + '?download=1') continue;
        const row = document.createElement('div'); row.className = 'task-artifact';
        const title = document.createElement('strong'); title.textContent = artifact.title; row.append(title);
        for (const [label, href] of [['打开', artifact.url], ['下载', artifact.downloadUrl]]) {
          const link = document.createElement('a'); link.textContent = label; link.href = href;
          link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'work-reference'; row.append(link);
        }
        node.body.append(row);
      }
      const lastUser = turns.findLast(item => item.source !== 'gateway' && item.role !== 'assistant');
      if (!turn.pending && turn.source !== 'gateway' && turn.id === lastUser?.id && turn.status !== 'complete' && turn.status !== 'streaming' && !busy && canChat()) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'action secondary'; retry.textContent = '重新生成';
        retry.addEventListener('click', () => submit({ id: turn.id, text: turn.user, retry: true,
          ...(turn.selectedWorkRef ? { selectedWorkRef: turn.selectedWorkRef } : {}), ...(turn.selectedQuestionId ? { selectedQuestionId: turn.selectedQuestionId } : {}) })); node.body.append(retry);
      }
      nodes.set(turn.id, node);
    }
    if (!cardFocused && (bottom || turns.length <= 1)) thread.scrollTop = thread.scrollHeight;
    queueTasks();
  }
  function canChat() { return !startingInstance && (!instance || (instance.phase === 'running' && instance.canChat === true && !stateSyncError &&
    !instance.cleanupPending && !instance.capabilityHold?.frozen && !instance.capabilityTransitioning)); }
  function canStopReply() { return !instance || instance.phase === 'running'; }
  function renderInstanceStatus() {
    instanceStatus.hidden = !instance || (canChat() && !startError);
    if (!instance) return;
    let label;
    if (stateSyncError) label = '无法同步实例状态，暂时不能发送消息，请稍后重试。';
    else if (startingInstance || instance.phase === 'starting') label = '实例正在启动，暂时不能对话。';
    else if (instance.cleanupPending) label = '实例的会话清理未完成，暂时不能对话，请在运行状态中重试停止实例。';
    else if (instance.phase === 'running' && (instance.capabilityHold?.frozen || instance.capabilityTransitioning)) label = 'Worker 设置正在切换，暂时不能发送新消息。';
    else label = ({
      stopping: '实例正在停止，聊天、任务路由和 Worker 正在结束。',
      stopped: '实例已停止，聊天、任务路由和 Worker 均已停止。历史记录可继续查看。',
      failed: '实例运行失败，暂时不能对话，可以重新启动。',
    })[instance.phase] || '实例暂时不能接收消息。';
    const reason = !stateSyncError && typeof instance.reason === 'string' ? instance.reason.trim() : '';
    byId('instance-status-label').textContent = label + (reason ? ' ' + reason : '');
    instanceStart.hidden = !['stopped', 'failed'].includes(instance.phase) && !startingInstance;
    instanceStart.disabled = startingInstance || stateSyncError || !!instance.cleanupPending || !!instance.capabilityHold;
    instanceStart.textContent = startingInstance ? '正在启动…' : '启动实例';
    instanceStartError.textContent = startError;
    instanceStartError.hidden = !startError;
  }
  function controls() {
    byId('conversation-page').dataset.busy = String(busy);
    document.dispatchEvent(new Event('jarvis:activity'));
    send.disabled = busy || !canChat() || !input.value.trim();
    send.hidden = busy && canStopReply();
    // A running reply must not prevent the user from preparing their next message.
    input.disabled = false;
    stop.hidden = !busy || !canStopReply();
    stop.disabled = !canStopReply() || !activeId && (!activeStream || activeStream.interrupted || activeStream.accepted);
    byId('reset').disabled = busy;
    notificationRetry.disabled = !canChat();
    renderInstanceStatus();
    resizeInput();
  }
  const replyContext = document.createElement('div'); replyContext.className = 'reply-context'; replyContext.hidden = true;
  byId('composer').prepend(replyContext);
  const notificationStatus = document.createElement('div'); notificationStatus.className = 'notification-status'; notificationStatus.hidden = true;
  notificationStatus.setAttribute('role', 'status');
  const notificationLabel = document.createElement('span'); notificationLabel.textContent = '有后台消息暂未送达。';
  const notificationRetry = document.createElement('button'); notificationRetry.type = 'button'; notificationRetry.textContent = '重试通知';
  notificationRetry.addEventListener('click', async () => {
    if (!canChat()) return;
    notificationRetry.disabled = true;
    try { syncNotificationStatus(await jarvis.api('/api/notifications/retry', 'POST', {})); await syncNotifications(); }
    catch (error) { notificationLabel.textContent = '重试失败，请稍后再试。'; if (error.status === 503 && instance) await followActive(); }
    finally { notificationRetry.disabled = !canChat(); }
  });
  notificationStatus.append(notificationLabel, notificationRetry); feedback.after(notificationStatus);
  function syncNotificationStatus(state) {
    if (typeof state.notificationRetryable !== 'boolean') return;
    notificationStatus.hidden = !state.notificationRetryable;
    if (state.notificationRetryable) notificationLabel.textContent = '有后台消息暂未送达。';
  }
  function selectWork(ref) {
    selectionRevision++; restoredDraftId = null;
    selection = { selectedWorkRef: ref.workRef, ...(ref.questionId ? { selectedQuestionId: ref.questionId } : {}) };
    const label = document.createElement('span'); label.textContent = `关于 ${ref.workRef}`;
    const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = '×'; clear.setAttribute('aria-label','取消任务关联');
    clear.addEventListener('click', clearSelection);
    replyContext.replaceChildren(label,clear); replyContext.hidden = false; input.focus();
  }
  // The overview spans conversations. Only the current chat can supply a reply target.
  jarvis.taskReportView = taskReportView;
  jarvis.taskFilesFor = row => {
    if (!row?.workRef || !taskBinding || row.conversationId !== taskBinding.conversationId) return [];
    const files = new Map();
    for (const turn of turns) {
      if (!turn.artifacts?.length || !taskReferences(turn).some(ref => ref.workRef === row.workRef &&
        (!ref.conversationId || ref.conversationId === row.conversationId))) continue;
      for (const entry of turn.artifacts) {
        const file = registeredTaskFile(entry, row.executionContext);
        if (file) files.set(file.url, file);
      }
    }
    return [...files.values()];
  };
  jarvis.taskFollowUp = (row, { select = false } = {}) => {
    if (!row?.workRef || !taskBinding || taskBinding.conversationId !== row.conversationId || busy || !canChat() ||
      row.availability !== 'live' || !['queued', 'routing', 'running', 'waiting', 'blocked', 'failed'].includes(row.status)) return null;
    const current = taskItems.get(row.workRef)?.item;
    if (current && ['completed', 'stopped', 'rejected'].includes(current.status)) return null;
    const refs = turns.flatMap(taskReferences).filter(ref => ref.actionable && ref.workRef === row.workRef &&
      (!ref.conversationId || ref.conversationId === row.conversationId));
    const question = row.action === 'answer';
    if ((question || row.stage?.action === 'answer') && !(question && row.actionEvidence?.human === true &&
      row.actionEvidence.ticketId === row.ticketId && row.actionEvidence.organizationId === row.organization?.instanceId && row.questionId)) return null;
    const target = question ? refs.findLast(ref => ref.questionId === row.questionId)
      : refs.findLast(ref => !ref.questionId);
    if (!target) return null;
    if (select) selectWork(target);
    return { label: question ? '回答问题' : '继续此任务' };
  };
  function clearSelection() { selectionRevision++; restoredDraftId = null; selection = null; replyContext.hidden = true; replyContext.replaceChildren(); }
  function syncQuestions(states) {
    if (!Array.isArray(states)) return false;
    const current = new Map(states.map(item => [item.workRef, item.questionId]));
    let changed = false;
    for (const turn of turns) {
      for (const ref of turn.workRefs || []) {
        if (typeof ref !== 'object' || !ref.questionId) continue;
        const inactive = current.get(ref.workRef) !== ref.questionId;
        if (Boolean(ref.inactive) !== inactive) { ref.inactive = inactive; changed = true; }
      }
    }
    if (selection?.selectedQuestionId && current.get(selection.selectedWorkRef) !== selection.selectedQuestionId) {
      clearSelection();
      feedback.textContent = '问题状态已更新，请重新选择要回答的问题。';
    }
    return changed;
  }
  async function syncNotifications() {
    clearTimeout(notificationTimer);
    // The optional Gateway may become available after this page was opened.
    if (jarvis.state.runtime !== 'dsh' || typeof jarvis.state.gateway !== 'boolean') return;
    try {
      if (!busy && document.visibilityState !== 'hidden') {
        const revision = viewRevision;
        const page = await jarvis.api(`/api/notifications?cursor=${notificationCursor}&limit=20`);
        // A response requested before a send or clear must not restore stale chat projection.
        if (busy || revision !== viewRevision) return;
        syncNotificationStatus(page);
        if (Array.isArray(page.items)) {
          for (const item of page.items) replaceTurn(item.turn);
          notificationCursor = page.nextCursor ?? notificationCursor;
          const questionsChanged = syncQuestions(page.questionStates);
          if (page.items.length || questionsChanged) render();
        }
      }
    } catch { /* Durable cursor remains unchanged; the next visible poll recovers. */ }
    finally { notificationTimer = setTimeout(syncNotifications,2500); }
  }
  function resizeInput() {
    // Measure again after wrapping, deletion or sending; empty placeholders never grow the field.
    const style = getComputedStyle(input);
    const minimum = parseFloat(style.minHeight) || 36;
    const maximum = parseFloat(style.maxHeight) || 240;
    input.style.height = 'auto';
    const contentHeight = input.value ? input.scrollHeight : minimum;
    input.style.height = Math.max(minimum, Math.min(maximum, contentHeight)) + 'px';
    input.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
  }
  function replaceTurn(turn) {
    chatRevision++;
    const index = turns.findIndex(item => item.id === turn.id);
    if (index < 0) turns.push(turn); else turns[index] = turn;
  }
  function scheduleStatePoll() {
    clearTimeout(pollTimer);
    if (document.visibilityState !== 'hidden' && (instance || busy || visiblePending().some(entry => entry.phase === 'uncertain'))) pollTimer = setTimeout(followActive, busy ? 1200 : 5000);
  }
  function syncState(state) {
    chatRevision++;
    const availableBefore = canChat(), busyBefore = busy;
    const taskContextChanged = syncTaskContext(state);
    instance = state.instance || null;
    jarvis.state.instance = instance;
    stateSyncError = false;
    if (instance?.canChat) startError = '';
    // Once the server closes this runtime, late data from its old stream cannot revive it.
    if (activeStream && (activeStream.scope !== sendScope() || taskContextChanged || instance && (instance.phase !== 'running' ||
      instance.generation !== activeStream.generation || instance.runtimeId !== activeStream.runtimeId))) activeStream.interrupted = true;
    // A lost final frame must not leave an already completed reply busy forever.
    const final = activeStream?.accepted && state.active !== activeStream.payload.id && state.turns?.find(turn =>
      turn.status !== 'streaming' && matchesSubmission(turn, { payload: activeStream.payload }));
    if (final) { activeStream.interrupted = true; activeStream.controller.abort(); }
    let changed = taskContextChanged;
    for (const turn of state.turns || []) {
      if (!confirmSubmission(turn)) continue;
      changed = true;
      if (activeStream?.payload.id === turn.id && !activeStream.interrupted) {
        if (!activeStream.accepted) replaceTurn(turn);
        activeStream.accepted = true; activeId = state.activeSource === 'background' ? null : state.active;
      }
    }
    if (!activeStream || activeStream.interrupted) {
      if (Array.isArray(state.turns) && JSON.stringify(turns) !== JSON.stringify(state.turns)) { turns = state.turns; changed = true; }
      activeId = state.activeSource === 'background' ? null : state.active;
      busy = Boolean(activeId);
    }
    syncNotificationStatus(state);
    controls();
    if (changed || busyBefore !== busy || availableBefore !== canChat()) render();
  }
  async function refreshChatState({ fresh = false } = {}) {
    if (!fresh && stateRequest?.revision === viewRevision && stateRequest.chatRevision === chatRevision) return stateRequest.promise;
    const request = { revision: viewRevision, chatRevision };
    stateRequest = request;
    const current = () => stateRequest === request && request.revision === viewRevision && request.chatRevision === chatRevision;
    request.promise = (async () => {
      let state;
      try { state = await jarvis.api('/api/state'); }
      catch (error) { if (!current()) return false; throw error; }
      // A stream receipt, newer text or another applied snapshot supersedes this read.
      if (!current()) return false;
      syncState(state); return true;
    })();
    try { return await request.promise; }
    finally { if (stateRequest === request) stateRequest = null; }
  }
  async function followActive() {
    clearTimeout(pollTimer);
    const revision = viewRevision;
    try { await refreshChatState(); }
    catch {
      if (revision !== viewRevision) return;
      stateSyncError = !!instance;
      if (!instance) feedback.textContent = '无法同步对话，请刷新重试';
      controls(); render();
    } finally { scheduleStatePoll(); }
  }
  async function readChatReply(response, stream, entry) {
    let gotDone = false;
    const acceptTurn = turn => {
      if (!matchesSubmission(turn, entry, true)) throw new Error('消息回执不匹配，请核对当前对话');
      confirmSubmission(turn, true); stream.accepted = true;
      activeId = turn.status === 'streaming' ? turn.id : null; replaceTurn(turn);
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (activeStream !== stream || stream.revision !== viewRevision || stream.interrupted) { if (event.type === 'done') gotDone = true; continue; }
        if (event.type === 'start') {
          acceptTurn(event.turn); controls(); render();
        }
        if (event.type === 'delta' || event.type === 'replace') {
          if (!stream.accepted) throw new Error('尚未确认消息已发送，请核对当前对话');
          const turn = turns.find(item => item.id === activeId);
          if (!turn) continue;
          const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
          chatRevision++;
          turn.assistant = event.type === 'replace' ? event.text : turn.assistant + event.text;
          const node = nodes.get(turn.id);
          renderReply(node.content, turn.assistant);
          if (node.delivery) { node.delivery.hidden = Boolean(turn.assistant); node.delivery.textContent = turn.assistant ? '' : '已发送，等待回复'; }
          if (bottom) thread.scrollTop = thread.scrollHeight;
        }
        if (event.type === 'done') {
          acceptTurn(event.turn); gotDone = true;
          if (event.turn.status === 'complete' && byId('connection-status')) byId('connection-status').textContent = '已连接';
        }
      }
      if (chunk.done) break;
    }
    return gotDone;
  }
  async function submit(inputPayload, { consumeDraft = false } = {}) {
    if (busy || !canChat()) return;
    const previous = outbox.get(inputPayload.id);
    if (previous && previous.scope !== sendScope()) return;
    const payload = previous?.payload || { ...inputPayload, submissionId: crypto.randomUUID(), ...(sendBinding() ? { binding: sendBinding() } : {}) };
    const originalText = input.value, originalSelection = selection, originalDraftRevision = draftRevision;
    const entry = { payload, scope: sendScope(), phase: 'sending' };
    outbox.set(payload.id, entry); saveOutbox();
    // Consume only this submission. A later receipt never clears a newer draft or task selection.
    if (consumeDraft) { input.value = ''; clearSelection(); restoredDraftId = null; }
    const submittedSelectionRevision = selectionRevision;
    viewRevision++;
    const stream = { revision: viewRevision, scope: entry.scope, payload, controller: new AbortController(), generation: instance?.generation, runtimeId: instance?.runtimeId, interrupted: false, accepted: false };
    activeStream = stream;
    busy = true; activeId = null; feedback.textContent = ''; controls(); render();
    scheduleStatePoll();
    let gotDone = false, synchronized = false;
    try {
      const response = await fetch(jarvis.url('/api/chat'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis-CSRF': jarvis.state.csrf }, body: JSON.stringify(payload), signal: stream.controller.signal });
      if (!response.ok) { const error = await response.json(); throw Object.assign(new Error(error.error || '发送失败'), { status: response.status }); }
      gotDone = await readChatReply(response, stream, entry);
      if (!gotDone) throw new Error('回复连接中断');
    } catch (error) {
      if (activeStream !== stream || stream.revision !== viewRevision || stream.scope !== sendScope() || stream.interrupted) return;
      const failureText = stream.cancelled ? '已取消发送' : error.message || '回复失败，请重试';
      stream.interrupted = true;
      try {
        synchronized = await refreshChatState({ fresh: true });
      } catch {}
      if (stream.scope === sendScope() && outbox.get(payload.id) === entry) {
        // A timeout, disconnect, conflict or server failure can follow admission. An absent snapshot is not a rejection receipt.
        const rejected = [400, 401, 403, 404, 405, 413, 415, 422].includes(error.status);
        entry.phase = rejected && synchronized && activeId !== payload.id ? 'failed' : 'uncertain';
        entry.cancelled = Boolean(stream.cancelled); saveOutbox();
        if (rejected && consumeDraft && draftRevision === originalDraftRevision && selectionRevision === submittedSelectionRevision && !input.value && !selection) {
          input.value = originalText;
          if (originalSelection) selectWork({ workRef: originalSelection.selectedWorkRef, questionId: originalSelection.selectedQuestionId });
          restoredDraftId = payload.id;
        }
      }
      if (stream.scope === sendScope()) feedback.textContent = outbox.get(payload.id) === entry ? failureText : '';
      controls(); render();
    } finally {
      if (outbox.get(payload.id) === entry && entry.phase === 'sending') { entry.phase = 'uncertain'; saveOutbox(); }
      if (activeStream === stream && stream.revision === viewRevision) {
        stream.interrupted = true;
        if (!synchronized && (instance || activeId || !gotDone)) {
          try { await refreshChatState({ fresh: true }); } catch { if (activeStream === stream && stream.revision === viewRevision) stateSyncError = true; }
        }
        if (activeStream === stream && stream.revision === viewRevision) {
          activeStream = null;
          busy = Boolean(activeId); controls(); render();
          scheduleStatePoll();
          if (!busy && !byId('conversation-page').hidden) input.focus();
        }
      } else if (activeStream === stream) activeStream = null;
    }
  }
  byId('composer').addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const restored = outbox.get(restoredDraftId);
    submit(restored?.scope === sendScope() && restored.payload.text === text ? restored.payload : { id: crypto.randomUUID(), text, ...selection }, { consumeDraft: true });
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); byId('composer').requestSubmit(); }
  });
  input.addEventListener('input', () => { draftRevision++; restoredDraftId = null; send.disabled = busy || !canChat() || !input.value.trim(); resizeInput(); });
  window.addEventListener('resize', resizeInput);
  if (typeof ResizeObserver !== 'undefined') {
    let previousWidth;
    new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width > 0 && width !== previousWidth) { previousWidth = width; resizeInput(); }
    }).observe(input);
  }
  stop.addEventListener('click', async () => {
    if (!canStopReply()) return;
    if (!activeId) {
      if (activeStream && !activeStream.interrupted && !activeStream.accepted) { activeStream.cancelled = true; activeStream.controller.abort(); }
      return;
    }
    stop.disabled = true;
    try { await jarvis.api('/api/stop', 'POST', { id: activeId }); }
    catch (error) { feedback.textContent = error.message; stop.disabled = !canStopReply(); }
    finally { if (instance) await followActive(); }
  });
  instanceStart.addEventListener('click', async () => {
    if (!instance || startingInstance || instanceStart.disabled || !['stopped', 'failed'].includes(instance.phase)) return;
    startingInstance = true; startError = ''; viewRevision++; controls(); render();
    try {
      const system = await jarvis.api('/api/system?view=topology');
      if (!Number.isInteger(system.revision)) throw new Error('无法读取实例配置版本，请重试。');
      await jarvis.api('/api/system/root/start', 'POST', { revision: system.revision, view: 'topology' });
      await refreshChatState();
    } catch (error) {
      startError = error.message || '实例启动失败，请重试。';
      try { await refreshChatState(); } catch { stateSyncError = true; }
    } finally { startingInstance = false; controls(); render(); scheduleStatePoll(); }
  });
  byId('reset').addEventListener('click', () => { if (!busy) byId('chat-confirm').hidden = false; });
  byId('clear-cancel').addEventListener('click', () => { byId('chat-confirm').hidden = true; });
  byId('clear-confirm').addEventListener('click', async () => {
    try {
      await jarvis.api('/api/conversation', 'DELETE'); viewRevision++;
      for (const entry of visiblePending()) outbox.delete(entry.payload.id);
      saveOutbox(); restoredDraftId = null; turns = []; clearSelection(); resetTaskContext();
      feedback.textContent = ''; byId('chat-confirm').hidden = true; render();
      if (jarvis.state.binding || tasksAvailable) await refreshChatState();
    }
    catch (error) { feedback.textContent = error.message; }
  });
  instance = jarvis.state.instance || null;
  turns = jarvis.state.turns; activeId = jarvis.state.activeSource === 'background' ? null : jarvis.state.active; busy = Boolean(activeId);
  syncTaskContext(jarvis.state);
  restoreOutbox();
  for (const turn of turns) confirmSubmission(turn);
  syncNotificationStatus(jarvis.state);
  controls(); render();
  if (busy || visiblePending().length) followActive(); else scheduleStatePoll();
  syncNotifications();
  document.addEventListener('jarvis:instance-updated', () => { if (instance) followActive(); });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer); clearTimeout(taskTimer); taskTimer = null;
    if (document.visibilityState !== 'hidden') { syncNotifications(); if (instance || busy) followActive(); refreshTasks(); }
  });
  window.addEventListener('hashchange', () => { clearTimeout(taskTimer); taskTimer = null; if (tasksVisible()) refreshTasks(); });
})();
