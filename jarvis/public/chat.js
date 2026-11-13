(async () => {
  const byId = id => document.getElementById(id);
  const thread = byId('thread');
  const input = byId('input');
  const feedback = byId('chat-feedback');
  const send = byId('send-message');
  const stop = byId('stop-generation');
  let turns = [], activeId = null, busy = false, pollTimer, notificationTimer, notificationCursor = 0, selection = null, viewRevision = 0;
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
        try { url = new URL(parts[2]); } catch {}
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
      const lastUser = turns.findLast(item => item.source !== 'gateway' && item.role !== 'assistant');
      if (turn.source !== 'gateway' && turn.id === lastUser?.id && turn.status !== 'complete' && turn.status !== 'streaming' && !busy) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'action secondary'; retry.textContent = '重新生成';
        retry.addEventListener('click', () => submit({ id: turn.id, retry: true })); node.body.append(retry);
      }
      nodes.set(turn.id, node);
    }
    if (bottom || turns.length <= 1) thread.scrollTop = thread.scrollHeight;
  }
  function controls() {
    byId('conversation-page').dataset.busy = String(busy);
    document.dispatchEvent(new Event('jarvis:activity'));
    send.disabled = busy || !input.value.trim();
    send.hidden = busy;
    // A running reply must not prevent the user from preparing their next message.
    input.disabled = false;
    stop.hidden = !busy;
    stop.disabled = !activeId;
    byId('reset').disabled = busy;
    resizeInput();
  }
  const replyContext = document.createElement('div'); replyContext.className = 'reply-context'; replyContext.hidden = true;
  byId('composer').prepend(replyContext);
  const notificationStatus = document.createElement('div'); notificationStatus.className = 'notification-status'; notificationStatus.hidden = true;
  notificationStatus.setAttribute('role', 'status');
  const notificationLabel = document.createElement('span'); notificationLabel.textContent = '有后台消息暂未送达。';
  const notificationRetry = document.createElement('button'); notificationRetry.type = 'button'; notificationRetry.textContent = '重试通知';
  notificationRetry.addEventListener('click', async () => {
    notificationRetry.disabled = true;
    try { syncNotificationStatus(await jarvis.api('/api/notifications/retry', 'POST', {})); await syncNotifications(); }
    catch { notificationLabel.textContent = '重试失败，请稍后再试。'; }
    finally { notificationRetry.disabled = false; }
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
  async function followActive() {
    clearTimeout(pollTimer);
    try {
      const state = await jarvis.api('/api/state');
      turns = state.turns;
      activeId = state.active;
      busy = Boolean(activeId && state.activeSource !== 'background');
      syncNotificationStatus(state);
      controls(); render();
      if (busy) pollTimer = setTimeout(followActive, 1200);
    } catch { feedback.textContent = '无法同步对话，请刷新重试'; }
  }
  async function submit(payload) {
    if (busy) return;
    viewRevision++;
    busy = true; activeId = null; feedback.textContent = ''; controls();
    const originalText = input.value;
    let gotStart = false, gotDone = false;
    try {
      const response = await fetch(jarvis.url('/api/chat'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis-CSRF': jarvis.state.csrf }, body: JSON.stringify(payload) });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || '发送失败'); }
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
          if (event.type === 'start') {
            gotStart = true; activeId = event.turn.id; replaceTurn(event.turn);
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
            if (event.turn.status === 'complete') byId('connection-status').textContent = '已连接';
          }
        }
        if (chunk.done) break;
      }
      if (!gotDone) throw new Error('回复连接中断');
    } catch (error) {
      feedback.textContent = error.message || '回复失败，请重试';
      // Before acceptance the field was never cleared; preserve any newer draft typed during the request.
      try {
        const state = await jarvis.api('/api/state'); turns = state.turns; activeId = state.activeSource === 'background' ? null : state.active;
        if (turns.some(turn => turn.id === payload.id) && !payload.retry && input.value === originalText) input.value = '';
      } catch {}
    } finally {
      if (gotDone) activeId = null;
      busy = Boolean(activeId); controls(); render();
      if (busy) pollTimer = setTimeout(followActive, 1000);
      else input.focus();
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
  input.addEventListener('input', () => { send.disabled = busy || !input.value.trim(); resizeInput(); });
  window.addEventListener('resize', resizeInput);
  if (typeof ResizeObserver !== 'undefined') {
    let previousWidth;
    new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width > 0 && width !== previousWidth) { previousWidth = width; resizeInput(); }
    }).observe(input);
  }
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try { await jarvis.api('/api/stop', 'POST', { id: activeId }); }
    catch (error) { feedback.textContent = error.message; stop.disabled = false; }
  });
  byId('reset').addEventListener('click', () => { if (!busy) byId('chat-confirm').hidden = false; });
  byId('clear-cancel').addEventListener('click', () => { byId('chat-confirm').hidden = true; });
  byId('clear-confirm').addEventListener('click', async () => {
    try { await jarvis.api('/api/conversation', 'DELETE'); viewRevision++; turns = []; clearSelection(); feedback.textContent = ''; byId('chat-confirm').hidden = true; render(); }
    catch (error) { feedback.textContent = error.message; }
  });
  turns = jarvis.state.turns; activeId = jarvis.state.active; busy = Boolean(activeId && jarvis.state.activeSource !== 'background');
  syncNotificationStatus(jarvis.state);
  controls(); render();
  if (busy) followActive();
  syncNotifications();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') syncNotifications(); });
})();
