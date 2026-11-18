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
  const nodes = new Map();
  send.disabled = true;
  try { await jarvis.ready; } catch { return; }

  // Build readable model output from text nodes; model-supplied HTML is never executed.
  function inline(parent, source) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let offset = 0;
    for (const match of source.matchAll(pattern)) {
      parent.append(document.createTextNode(source.slice(offset, match.index)));
      const token = match[0];
      let node;
      if (token.startsWith('`')) {
        node = document.createElement('code'); node.textContent = token.slice(1, -1);
      } else if (token.startsWith('**')) {
        node = document.createElement('strong'); inline(node, token.slice(2, -2));
      } else {
        const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
        let url;
        try {
          // Local deliverables use authenticated routes; arbitrary relative links stay plain text.
          url = /^\/jarvis\/api\/system\/[a-z][a-z0-9-]*\/artifacts\//.test(parts[2])
            ? new URL(parts[2], location.origin) : new URL(parts[2]);
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
  function renderReply(content, source) {
    const fragment = document.createDocumentFragment();
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    let paragraph = [];
    const flush = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p'); inline(p, paragraph.join('\n')); fragment.append(p); paragraph = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush(); const codeLines = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) codeLines.push(lines[i]);
        const pre = document.createElement('pre'); const code = document.createElement('code');
        code.textContent = codeLines.join('\n'); pre.append(code); fragment.append(pre);
      } else if (/^#{1,4}\s+/.test(line)) {
        flush(); const heading = document.createElement('h3'); inline(heading, line.replace(/^#+\s+/, '')); fragment.append(heading);
      } else if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
        flush(); const ordered = /^\s*\d+[.)] /.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        if (ordered) list.start = parseInt(line.trim(), 10);
        const pattern = ordered ? /^\s*\d+[.)] (.*)$/ : /^\s*[-*+] (.*)$/;
        do {
          const item = document.createElement('li'); inline(item, pattern.exec(lines[i])[1]); list.append(item);
          i++;
        } while (i < lines.length && pattern.test(lines[i]));
        i--; fragment.append(list);
      } else if (!line.trim()) flush();
      else paragraph.push(line);
    }
    flush(); content.replaceChildren(fragment);
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
    thread.replaceChildren(); nodes.clear();
    byId('conversation-page').classList.toggle('is-empty', !turns.length);
    if (!turns.length) {
      const empty = document.createElement('div'); empty.className = 'chat-empty';
      const orb = document.createElement('div'); orb.className = 'assistant-orb'; orb.setAttribute('aria-hidden', 'true');
      const title = document.createElement('h2'); title.textContent = '今天想一起推进什么？';
      const action = document.createElement('button'); action.className = 'action secondary'; action.type = 'button'; action.textContent = '配置模型';
      action.addEventListener('click', () => { location.hash = 'settings/model'; });
      empty.append(orb, title);
      if (!jarvis.state.model.value.endpoint) empty.append(action);
      thread.append(empty);
    }
    for (const turn of turns) {
      if (turn.role !== 'assistant' && turn.source !== 'gateway') message('user', turn.user);
      const node = message('jarvis', turn.assistant || '');
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
      for (const ref of turn.gatewayReceipts || []) {
        if (!ref.workRef) continue;
        const action = document.createElement('button'); action.type = 'button'; action.className = 'work-reference';
        action.textContent = `继续此任务 · ${ref.workRef}`;
        action.addEventListener('click', () => selectWork(ref)); node.body.append(action);
      }
      for (const ref of turn.workRefs || []) {
        const value = typeof ref === 'string' ? { workRef: ref } : ref;
        if (!value.workRef || value.inactive) continue;
        const action = document.createElement('button'); action.type = 'button'; action.className = 'work-reference';
        action.textContent = value.questionId ? `回答问题 · ${value.workRef}` : `继续此任务 · ${value.workRef}`;
        action.addEventListener('click', () => selectWork(value)); node.body.append(action);
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
      if (turn.source !== 'gateway' && turn.id === lastUser?.id && turn.status !== 'complete' && turn.status !== 'streaming' && !busy && canChat()) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'action secondary'; retry.textContent = '重新生成';
        retry.addEventListener('click', () => submit({ id: turn.id, retry: true })); node.body.append(retry);
      }
      nodes.set(turn.id, node);
    }
    if (bottom || turns.length <= 1) thread.scrollTop = thread.scrollHeight;
  }
  function canChat() { return !startingInstance && (!instance || (instance.canChat === true && !stateSyncError)); }
  function canStopReply() { return !instance || instance.phase === 'running'; }
  function renderInstanceStatus() {
    instanceStatus.hidden = !instance || (canChat() && !startError);
    if (!instance) return;
    let label;
    if (stateSyncError) label = '无法同步实例状态，暂时不能发送消息，请稍后重试。';
    else if (startingInstance || instance.phase === 'starting') label = '实例正在启动，暂时不能对话。';
    else if (instance.cleanupPending) label = '实例的会话清理未完成，暂时不能对话，请在运行状态中重试停止实例。';
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
    stop.disabled = !activeId || !canStopReply();
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
    selection = { selectedWorkRef: ref.workRef, ...(ref.questionId ? { selectedQuestionId: ref.questionId } : {}) };
    const label = document.createElement('span'); label.textContent = `关于 ${ref.workRef}`;
    const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = '×'; clear.setAttribute('aria-label','取消任务关联');
    clear.addEventListener('click', clearSelection);
    replyContext.replaceChildren(label,clear); replyContext.hidden = false; input.focus();
  }
  function clearSelection() { selection = null; replyContext.hidden = true; replyContext.replaceChildren(); }
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
    const index = turns.findIndex(item => item.id === turn.id);
    if (index < 0) turns.push(turn); else turns[index] = turn;
  }
  function scheduleStatePoll() {
    clearTimeout(pollTimer);
    if (document.visibilityState !== 'hidden' && (instance || busy)) pollTimer = setTimeout(followActive, busy ? 1200 : 5000);
  }
  function syncState(state) {
    const availableBefore = canChat(), busyBefore = busy;
    instance = state.instance || null;
    jarvis.state.instance = instance;
    stateSyncError = false;
    if (instance?.canChat) startError = '';
    // Once the server closes this runtime, late data from its old stream cannot revive it.
    if (activeStream && instance && (instance.phase !== 'running' ||
      instance.generation !== activeStream.generation || instance.runtimeId !== activeStream.runtimeId)) activeStream.interrupted = true;
    let changed = false;
    if (!activeStream || activeStream.interrupted) {
      if (Array.isArray(state.turns) && JSON.stringify(turns) !== JSON.stringify(state.turns)) { turns = state.turns; changed = true; }
      activeId = state.activeSource === 'background' ? null : state.active;
      busy = Boolean(activeId);
    }
    syncNotificationStatus(state);
    controls();
    if (changed || busyBefore !== busy || availableBefore !== canChat()) render();
  }
  async function refreshChatState() {
    if (stateRequest?.revision === viewRevision) return stateRequest.promise;
    const request = { revision: viewRevision };
    stateRequest = request;
    request.promise = (async () => {
      const state = await jarvis.api('/api/state');
      if (request.revision === viewRevision) syncState(state);
    })();
    try { await request.promise; }
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
  async function submit(payload) {
    if (busy || !canChat()) return;
    viewRevision++;
    const stream = { revision: viewRevision, generation: instance?.generation, runtimeId: instance?.runtimeId, interrupted: false };
    activeStream = stream;
    busy = true; activeId = null; feedback.textContent = ''; controls();
    scheduleStatePoll();
    const originalText = input.value;
    let gotDone = false;
    try {
      const response = await fetch(jarvis.url('/api/chat'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis-CSRF': jarvis.state.csrf }, body: JSON.stringify(payload) });
      if (!response.ok) { const error = await response.json(); throw Object.assign(new Error(error.error || '发送失败'), { status: response.status }); }
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
            activeId = event.turn.id; replaceTurn(event.turn);
            if (!payload.retry) { if (input.value === originalText) input.value = ''; clearSelection(); } controls(); render();
          }
          if (event.type === 'delta' || event.type === 'replace') {
            const turn = turns.find(item => item.id === activeId);
            if (!turn) continue;
            const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
            turn.assistant = event.type === 'replace' ? event.text : turn.assistant + event.text;
            renderReply(nodes.get(turn.id).content, turn.assistant);
            if (bottom) thread.scrollTop = thread.scrollHeight;
          }
          if (event.type === 'done') {
            gotDone = true; replaceTurn(event.turn);
            if (event.turn.status === 'complete' && byId('connection-status')) byId('connection-status').textContent = '已连接';
          }
        }
        if (chunk.done) break;
      }
      if (!gotDone) throw new Error('回复连接中断');
    } catch (error) {
      if (activeStream !== stream || stream.revision !== viewRevision) return;
      feedback.textContent = error.message || '回复失败，请重试';
      stream.interrupted = true;
      // Before acceptance the field was never cleared; preserve any newer draft typed during the request.
      try {
        await refreshChatState();
        if (turns.some(turn => turn.id === payload.id) && !payload.retry && input.value === originalText) input.value = '';
      } catch {}
    } finally {
      if (activeStream === stream && stream.revision === viewRevision) {
        stream.interrupted = true;
        if (gotDone) activeId = null;
        if (instance) {
          try { await refreshChatState(); } catch { if (activeStream === stream && stream.revision === viewRevision) stateSyncError = true; }
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
    if (text) submit({ id: crypto.randomUUID(), text, ...selection });
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); byId('composer').requestSubmit(); }
  });
  input.addEventListener('input', () => { send.disabled = busy || !canChat() || !input.value.trim(); resizeInput(); });
  window.addEventListener('resize', resizeInput);
  if (typeof ResizeObserver !== 'undefined') {
    let previousWidth;
    new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width > 0 && width !== previousWidth) { previousWidth = width; resizeInput(); }
    }).observe(input);
  }
  stop.addEventListener('click', async () => {
    if (!activeId || !canStopReply()) return;
    stop.disabled = true;
    try { await jarvis.api('/api/stop', 'POST', { id: activeId }); }
    catch (error) { feedback.textContent = error.message; stop.disabled = !canStopReply(); }
    finally { if (instance) await followActive(); }
  });
  instanceStart.addEventListener('click', async () => {
    if (!instance || startingInstance || instanceStart.disabled || !['stopped', 'failed'].includes(instance.phase)) return;
    startingInstance = true; startError = ''; viewRevision++; controls(); render();
    try {
      const system = await jarvis.api('/api/system');
      if (!Number.isInteger(system.revision)) throw new Error('无法读取实例配置版本，请重试。');
      await jarvis.api('/api/system/root/start', 'POST', { revision: system.revision });
      await refreshChatState();
    } catch (error) {
      startError = error.message || '实例启动失败，请重试。';
      try { await refreshChatState(); } catch { stateSyncError = true; }
    } finally { startingInstance = false; controls(); render(); scheduleStatePoll(); }
  });
  byId('reset').addEventListener('click', () => { if (!busy) byId('chat-confirm').hidden = false; });
  byId('clear-cancel').addEventListener('click', () => { byId('chat-confirm').hidden = true; });
  byId('clear-confirm').addEventListener('click', async () => {
    try { await jarvis.api('/api/conversation', 'DELETE'); viewRevision++; turns = []; clearSelection(); feedback.textContent = ''; byId('chat-confirm').hidden = true; render(); }
    catch (error) { feedback.textContent = error.message; }
  });
  instance = jarvis.state.instance || null;
  turns = jarvis.state.turns; activeId = jarvis.state.activeSource === 'background' ? null : jarvis.state.active; busy = Boolean(activeId);
  syncNotificationStatus(jarvis.state);
  controls(); render();
  if (busy) followActive(); else scheduleStatePoll();
  syncNotifications();
  document.addEventListener('jarvis:instance-updated', () => { if (instance) followActive(); });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (document.visibilityState !== 'hidden') { syncNotifications(); if (instance || busy) followActive(); }
  });
})();
