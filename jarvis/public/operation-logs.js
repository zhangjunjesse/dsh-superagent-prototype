/* Read-only operational evidence shares the persistent Jarvis document and authenticated API. */
(() => {
  'use strict';
  const page = document.getElementById('operation-logs-page');
  if (!page) return;
  const byId = id => page.querySelector('#' + id);
  const client = () => window.jarvis || (typeof jarvis === 'undefined' ? null : jarvis);
  const frame = window.frameElement;
  const roles = new Map([['jarvis', '贾维斯'], ['router', '任务路由'], ['worker', 'Worker'], ['gateway', '交办与反馈'], ['runtime', '运行服务'], ['system', '系统']]);
  const levels = new Map([['info', '信息'], ['warn', '警告'], ['error', '错误'], ['debug', '调试']]);
  const sourceLabels = { ready: '已接入', partial: '部分记录', unavailable: '暂不可用' };
  const filters = { organization: '', role: '', level: '', q: '', trace: '' };
  let ready = false, supported = false, active = false, automatic = true, timer;
  let items = [], nextCursor = null, total = 0, loaded = false, historyLoaded = false, loading = false, listError = '';
  let listRequest = 0, selectedId = null, selectedDetail = null, detailRequest = 0, detailLoading = false, detailError = '';
  let renderedList = '', renderedCoverage = '';
  let linkedTrace = '';
  const visible = () => active && !page.hidden && !frame?.hidden && document.visibilityState !== 'hidden';
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value ?? '');
    return element;
  };
  const dateText = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '时间未提供') : date.toLocaleString('zh-CN', { hour12: false });
  };
  const historyLabel = item => item.detail?.provenance === 'snapshot' || /snapshot/i.test(item.event) ? '状态快照' : item.historical ? '历史记录' : '';

  function options(select, entries, emptyLabel) {
    const selected = select.value;
    const choices = [['', emptyLabel], ...entries];
    if (selected && !choices.some(([id]) => id === selected)) choices.push([selected, selected]);
    if (JSON.stringify([...select.options].map(option => [option.value, option.textContent])) === JSON.stringify(choices)) return;
    select.replaceChildren(...choices.map(([id, name]) => new Option(name, id)));
    select.value = selected;
  }
  options(byId('logs-role'), roles, '全部角色');
  options(byId('logs-level'), levels, '全部级别');

  function schedule() {
    clearTimeout(timer);
    if (ready && supported && visible() && automatic && !historyLoaded && !loading) {
      timer = setTimeout(() => loadList(), 5000);
    }
  }
  function renderControls() {
    byId('logs-count').textContent = !supported && ready ? '运行日志不可用' : loading && !loaded ? '正在读取运行日志…' : loaded ? `匹配 ${total} 条 · 已显示 ${items.length} 条` : '准备读取运行日志';
    byId('logs-refresh').disabled = !supported || loading;
    byId('logs-refresh').textContent = historyLoaded ? '返回最新' : '刷新';
    byId('logs-toggle-refresh').disabled = !supported;
    byId('logs-toggle-refresh').textContent = automatic ? '暂停更新' : '恢复更新';
    byId('logs-toggle-refresh').setAttribute('aria-pressed', String(automatic));
    byId('logs-refresh-status').textContent = !supported ? '' : historyLoaded ? '正在查看历史' : automatic ? '自动刷新中' : '已暂停更新';
    byId('logs-more').hidden = !supported || !loaded || nextCursor === null;
    byId('logs-more').disabled = loading;
    byId('logs-more').textContent = loading ? '正在加载…' : '加载更多';
    byId('logs-list').setAttribute('aria-busy', String(loading));
    byId('logs-error').hidden = !listError;
    byId('logs-error-message').textContent = listError;
    byId('logs-retry').hidden = !supported;
    byId('logs-trace-filter').hidden = !filters.trace;
    byId('logs-trace-label').textContent = filters.trace ? `流程：${filters.trace}` : '';
    byId('logs-empty').hidden = !supported || !loaded || loading || !!listError || items.length > 0;
    byId('logs-empty').textContent = Object.values(filters).some(Boolean) ? '没有符合筛选条件的记录。' : '当前还没有运行记录。';
  }
  function renderList() {
    const surface = JSON.stringify([selectedId, items.map(item => [item.id, item.at, item.organizationName, item.organizationId, item.role, item.level, item.title, item.summary, historyLabel(item)])]);
    if (surface === renderedList) { renderControls(); return; }
    renderedList = surface;
    const focusedId = document.activeElement?.closest('[data-log-id]')?.dataset.logId;
    const rows = items.map(item => {
      const row = node('li'), button = node('button', 'logs-event');
      button.type = 'button'; button.dataset.logId = item.id;
      if (item.id === selectedId) button.setAttribute('aria-current', 'true');
      const meta = node('span', 'logs-event-meta'), time = node('time', '', dateText(item.at));
      time.dateTime = item.at;
      meta.append(time, node('span', '', item.organizationName || item.organizationId || '系统'), node('span', '', roles.get(item.role) || item.role),
        node('span', 'logs-level' + (item.level === 'warn' ? ' logs-level-warn' : item.level === 'error' ? ' logs-level-error' : ''), levels.get(item.level) || item.level));
      if (historyLabel(item)) meta.append(node('span', 'logs-history', historyLabel(item)));
      button.append(meta, node('strong', 'logs-event-title', item.title), node('span', 'logs-event-summary', item.summary));
      row.append(button); return row;
    });
    byId('logs-list').replaceChildren(...rows);
    if (focusedId) [...byId('logs-list').querySelectorAll('[data-log-id]')].find(button => button.dataset.logId === focusedId)?.focus({ preventScroll: true });
    renderControls();
  }
  function renderCoverage(coverage) {
    const surface = JSON.stringify(coverage);
    if (surface === renderedCoverage) return;
    renderedCoverage = surface;
    byId('logs-coverage').hidden = !coverage;
    if (!coverage) return;
    const sources = Array.isArray(coverage.sources) ? coverage.sources : [];
    const incomplete = sources.filter(source => source.status !== 'ready').length;
    byId('logs-coverage-summary').textContent = `记录范围 · ${sources.length} 项来源${incomplete ? ` · ${incomplete} 项记录不完整` : ''}`;
    byId('logs-coverage-since').textContent = `开始收录：${dateText(coverage.since)}。同一流程仅展示已收录事件。`;
    byId('logs-coverage-sources').replaceChildren(...sources.map(source => {
      const row = node('li'); row.append(node('strong', '', source.label || source.id));
      const status = ['ready', 'partial', 'unavailable'].includes(source.status) ? source.status : 'partial';
      row.append(node('span', `source-status source-${status}`, sourceLabels[status]));
      if (source.detail) row.append(node('span', '', ` · ${source.detail}`));
      return row;
    }));
  }
  function pageData(value) {
    if (!value || !Array.isArray(value.items) || value.items.some(item => !item || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.title !== 'string') ||
      !(value.nextCursor === null || Number.isSafeInteger(value.nextCursor) && value.nextCursor > 0) || !Number.isSafeInteger(value.total) || value.total < 0) {
      throw new Error('日志数据格式无效，请重试。');
    }
    return value;
  }
  async function loadList({ older = false } = {}) {
    if (!ready || !supported || !visible() || older && (loading || nextCursor === null)) return;
    clearTimeout(timer);
    const request = ++listRequest, before = older ? nextCursor : null;
    loading = true; listError = ''; renderControls();
    const query = new URLSearchParams({ limit: '50' });
    if (before !== null) query.set('before', String(before));
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    try {
      const value = pageData(await client().api('/api/logs?' + query));
      if (request !== listRequest || !visible()) return;
      items = [...new Map((older ? [...items, ...value.items] : value.items).map(item => [item.id, item])).values()];
      nextCursor = value.nextCursor; total = value.total; loaded = true; historyLoaded = older;
      for (const item of value.items) {
        if (item.role && !roles.has(item.role)) roles.set(item.role, item.role);
        if (item.level && !levels.has(item.level)) levels.set(item.level, item.level);
      }
      options(byId('logs-role'), roles, '全部角色'); options(byId('logs-level'), levels, '全部级别');
      const organizations = new Map((Array.isArray(value.organizations) ? value.organizations : []).map(item => [item.id, item.name]));
      options(byId('logs-organization-filter'), organizations, '全部组织');
      renderCoverage(value.coverage); renderList();
    } catch (error) {
      if (request !== listRequest || !visible()) return;
      listError = error.message || '暂时无法读取运行日志，请重试。';
    } finally {
      if (request === listRequest) { loading = false; renderControls(); schedule(); }
    }
  }
  const hasReadableValue = value => value !== undefined && value !== null && value !== '' && (typeof value !== 'object' || Object.keys(value).length > 0);
  function readableValue(value, depth = 0) {
    if (value === null || typeof value !== 'object') return node('p', 'logs-record-text', value === null ? 'null' : value);
    if (depth >= 2) return node('pre', '', JSON.stringify(value, null, 2));
    if (Array.isArray(value)) {
      const list = node('ul', 'logs-readable-list');
      for (const item of value) { const row = node('li'); row.append(readableValue(item, depth + 1)); list.append(row); }
      return list;
    }
    const fields = node('dl', 'logs-readable-fields');
    for (const [key, item] of Object.entries(value).filter(([, item]) => hasReadableValue(item))) { const content = node('dd'); content.append(readableValue(item, depth + 1)); fields.append(node('dt', '', key), content); }
    return fields;
  }
  function messageContent(content) {
    if (!Array.isArray(content)) return readableValue(content);
    const body = node('div', 'logs-readable-section');
    for (const block of content) {
      if (block?.type === 'text') body.append(node('p', '', block.text));
      else if (block?.type === 'reasoning') {
        const disclosure = node('details'); disclosure.append(node('summary', '', '推理内容'), node('p', '', block.text)); body.append(disclosure);
      } else body.append(readableValue(block));
    }
    return body;
  }
  function renderReadable() {
    const sections = [], detail = selectedDetail?.detail;
    const add = (title, value, content = false) => {
      if (!hasReadableValue(value)) return;
      const section = node('section', 'logs-readable-section'); section.append(node('h3', '', title), content ? messageContent(value) : readableValue(value)); sections.push(section);
    };
    if (detail?.omitted) {
      add('详情未完整收录', detail.reason);
      add('原始数据标识', { 字节数: detail.originalBytes, SHA256: detail.sha256 });
    } else if (detail?.sessionEvent) {
      const { type } = detail.sessionEvent, data = detail.sessionEvent.data ?? {};
      if (type === 'user/message') add('输入', data.content, true);
      else if (type === 'assistant/message') { add('输出', data.message?.content, true); add('用量', data.usage); }
      else if (type === 'tool/call') {
        add('工具', { 工具名称: data.name, 调用标识: data.callId });
        let args = data.arguments; try { args = JSON.parse(args); } catch { /* Preserve invalid or non-JSON arguments verbatim. */ }
        add('输入', args);
      } else if (type === 'tool/result') {
        add('工具', { 调用标识: data.message?.callId ?? data.message?.toolCallId, 结果: data.message?.isError ? '执行失败' : '已返回' });
        add('输出', data.message?.content, true); add('错误', data.error); add('工具补充信息', data.meta);
      } else if (type === 'request/header') {
        add('模型', data.header?.config); add('可用工具', data.header?.tools); add('请求原因', data.reason);
      } else add('事件数据', data);
    } else if (detail?.record !== undefined) add(historyLabel(selectedDetail) === '状态快照' ? '状态快照内容' : '运行记录', detail.record);
    else add('事件数据', detail);
    byId('logs-readable').hidden = !sections.length;
    byId('logs-readable').replaceChildren(...sections);
    const works = typeof selectedDetail?.organizationId === 'string' && Array.isArray(selectedDetail?.refs?.relatedWorkRefs)
      ? [...new Set(selectedDetail.refs.relatedWorkRefs.filter(work => typeof work === 'string' && work))] : [];
    byId('logs-related-work').hidden = !works.length;
    byId('logs-related-work').replaceChildren(...(works.length ? [node('h3', '', '关联任务'), ...works.map(work => {
      const button = node('button', 'action secondary', `查看任务流程 · ${work}`); button.type = 'button'; button.dataset.workRef = work; return button;
    })] : []));
  }
  function renderDetail() {
    const selected = selectedDetail || items.find(item => item.id === selectedId);
    byId('logs-detail-title').textContent = selected?.title || '事件详情';
    byId('logs-close-detail').hidden = selectedId === null;
    byId('logs-detail-status').hidden = !!selectedDetail && !selectedDetail.detail?.omitted && !detailLoading && !detailError;
    byId('logs-detail-status').textContent = detailLoading ? '正在读取记录详情…' : detailError || (selectedDetail?.detail?.omitted ? '该事件的详情未完整收录，原因如下。' : '选择一条事件，查看记录详情。');
    byId('logs-detail-status').classList.toggle('error', !!detailError);
    byId('logs-detail-summary').hidden = !selectedDetail;
    byId('logs-detail-summary').textContent = selectedDetail?.summary || '';
    byId('logs-detail-meta').hidden = !selectedDetail;
    byId('logs-detail-actions').hidden = selectedId === null;
    byId('logs-show-trace').hidden = !selectedDetail?.traceId;
    byId('logs-detail-retry').hidden = !detailError;
    byId('logs-export').disabled = !selectedDetail || detailLoading;
    byId('logs-detail-raw').hidden = !selectedDetail;
    byId('logs-detail-data').textContent = selectedDetail ? JSON.stringify(selectedDetail, null, 2) : '';
    const fields = selectedDetail ? [['时间', dateText(selectedDetail.at)], ['组织', selectedDetail.organizationName || selectedDetail.organizationId || '系统'],
      ['角色', roles.get(selectedDetail.role) || selectedDetail.role], ['级别', levels.get(selectedDetail.level) || selectedDetail.level]] : [];
    byId('logs-detail-meta').replaceChildren(...fields.flatMap(([name, value]) => [node('dt', '', name), node('dd', '', value)]));
    const note = selectedDetail ? [historyLabel(selectedDetail), selectedDetail.detail?.timeBasis === 'observed-fallback' ? '来源未提供发生时间，按采集时间显示' : ''].filter(Boolean).join(' · ') : '';
    byId('logs-record-note').hidden = !note; byId('logs-record-note').textContent = note;
    renderReadable();
  }
  async function selectDetail(id) {
    if (!supported || !visible()) return;
    const request = ++detailRequest;
    selectedId = id; selectedDetail = null; detailLoading = true; detailError = '';
    byId('logs-detail-raw').open = false;
    renderList(); renderDetail();
    if (window.matchMedia?.('(max-width:720px)').matches) {
      byId('logs-detail-title').focus({ preventScroll: true });
      byId('logs-detail').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth' });
    }
    try {
      const value = await client().api('/api/logs/' + id);
      if (request !== detailRequest) return;
      if (!value || value.id !== id || !Object.hasOwn(value, 'detail')) throw new Error('日志详情暂不可用，请重试。');
      selectedDetail = value;
    } catch (error) {
      if (request === detailRequest) detailError = error.message || '暂时无法读取事件详情，请重试。';
    } finally {
      if (request === detailRequest) { detailLoading = false; renderDetail(); }
    }
  }
  function resetFilterPage() {
    historyLoaded = false; items = []; total = 0; loaded = false; nextCursor = null;
    renderList(); loadList();
  }
  function showTrace(trace) {
    if (routeTrace(location.hash) && routeTrace(location.hash) !== trace) {
      history.replaceState(null, '', '#logs?trace=' + encodeURIComponent(trace));
      linkedTrace = trace;
    }
    filters.trace = trace;
    for (const key of ['q', 'organization', 'role', 'level']) filters[key] = '';
    for (const id of ['logs-query', 'logs-organization-filter', 'logs-role', 'logs-level']) byId(id).value = '';
    resetFilterPage();
  }
  function routeTrace(hash) {
    if (!hash.startsWith('#logs?')) return '';
    const params = new URLSearchParams(hash.slice(6)), value = params.get('trace');
    return params.size === 1 && value && value.length <= 500 && !/[\u0000-\u001f]/.test(value) ? value : '';
  }
  function applyFilters() {
    filters.q = byId('logs-query').value.trim();
    filters.organization = byId('logs-organization-filter').value;
    filters.role = byId('logs-role').value; filters.level = byId('logs-level').value;
    resetFilterPage();
  }
  function updateVisibility() {
    clearTimeout(timer);
    if (!visible()) { listRequest++; loading = false; return; }
    if (ready && supported && (!loaded || automatic && !historyLoaded)) loadList();
    else schedule();
  }

  byId('logs-filters').addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
  for (const id of ['logs-organization-filter', 'logs-role', 'logs-level']) byId(id).addEventListener('change', applyFilters);
  byId('logs-query').addEventListener('search', () => { if (!byId('logs-query').value) applyFilters(); });
  byId('logs-refresh').addEventListener('click', () => { historyLoaded = false; loadList(); });
  byId('logs-retry').addEventListener('click', () => loadList());
  byId('logs-more').addEventListener('click', () => loadList({ older: true }));
  byId('logs-toggle-refresh').addEventListener('click', () => { automatic = !automatic; renderControls(); schedule(); });
  byId('logs-list').addEventListener('click', event => {
    const button = event.target.closest('[data-log-id]');
    if (button) selectDetail(Number(button.dataset.logId));
  });
  byId('logs-detail-retry').addEventListener('click', () => { if (selectedId !== null) selectDetail(selectedId); });
  byId('logs-close-detail').addEventListener('click', () => {
    const previous = selectedId; detailRequest++; selectedId = null; selectedDetail = null; detailLoading = false; detailError = '';
    renderDetail(); renderList();
    [...byId('logs-list').querySelectorAll('[data-log-id]')].find(button => button.dataset.logId === String(previous))?.focus();
  });
  byId('logs-show-trace').addEventListener('click', () => {
    if (!selectedDetail?.traceId) return;
    showTrace(selectedDetail.traceId);
  });
  byId('logs-related-work').addEventListener('click', event => {
    const work = event.target.closest('[data-work-ref]')?.dataset.workRef;
    if (work && selectedDetail?.organizationId) showTrace(`work:${selectedDetail.organizationId}:${work}`);
  });
  byId('logs-clear-trace').addEventListener('click', () => {
    if (routeTrace(location.hash)) history.replaceState(null, '', '#logs');
    linkedTrace = '';
    filters.trace = ''; resetFilterPage();
  });
  byId('logs-export').addEventListener('click', () => {
    if (!selectedDetail) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(selectedDetail, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `operation-event-${selectedDetail.id}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  document.addEventListener('visibilitychange', updateVisibility);
  const visibilityObserver = new MutationObserver(() => { if (!visible()) { clearTimeout(timer); listRequest++; loading = false; } else schedule(); });
  visibilityObserver.observe(page, { attributes: true, attributeFilter: ['hidden'] });
  if (frame) visibilityObserver.observe(frame, { attributes: true, attributeFilter: ['hidden'] });

  // The settings router is the sole owner of accepted navigation and draft guards.
  window.operationLogsUI = {
    isRoute: hash => hash === '#logs' || Boolean(routeTrace(hash)),
    enter(returnRoute) {
      active = true;
      byId('logs-organization').href = typeof returnRoute === 'string' && returnRoute.startsWith('#settings') ? returnRoute : '#settings/organization';
      const trace = routeTrace(location.hash);
      const clearPreviousLink = !trace && linkedTrace && filters.trace === linkedTrace;
      linkedTrace = trace;
      if (clearPreviousLink || trace && trace !== filters.trace) {
        detailRequest++; selectedId = null; selectedDetail = null; detailLoading = false; detailError = ''; renderDetail();
        showTrace(trace); return;
      }
      updateVisibility(); renderControls();
    },
    leave() { active = false; clearTimeout(timer); listRequest++; loading = false; },
  };
  Promise.resolve(client()?.ready).then(() => {
    ready = true; supported = client()?.state?.runtime === 'dsh';
    document.querySelectorAll('[data-operation-logs-link]').forEach(link => { link.hidden = !supported; });
    if (!supported) listError = '当前运行环境暂不支持运行日志。';
    renderControls(); if (visible()) updateVisibility();
  }).catch(() => {
    ready = true; listError = '无法连接工作区，请刷新页面重试。'; renderControls();
  });
})();
