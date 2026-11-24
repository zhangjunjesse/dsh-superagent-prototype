/* System configuration and process controls share the existing Jarvis settings workspace. */
(() => {
  'use strict';
  const STORAGE = 'superjarvis.composition.draft.v1';
  const symbols = {
    network: '<rect x="8" y="3" width="8" height="6" rx="1.5"/><rect x="2" y="16" width="7" height="5" rx="1.5"/><rect x="15" y="16" width="7" height="5" rx="1.5"/><path d="M12 9v4M5.5 16v-3h13v3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
    brain: '<path d="M12 6a3 3 0 0 0-5.8-1 4 4 0 0 0-2.4 6.8A4 4 0 0 0 6 19a3 3 0 0 0 6 0V6Zm0 0a3 3 0 0 1 5.8-1 4 4 0 0 1 2.4 6.8A4 4 0 0 1 18 19a3 3 0 0 1-6 0"/><path d="M8 8a3 3 0 0 0 4 3m4-3a3 3 0 0 1-4 3M7 15a3 3 0 0 1 5 2m5-2a3 3 0 0 0-5 2"/>',
    bot: '<rect x="5" y="7" width="14" height="13" rx="4"/><path d="M12 3v4M2 12v4m20-4v4M9 16h6"/><circle cx="9" cy="12" r=".8"/><circle cx="15" cy="12" r=".8"/><circle cx="12" cy="3" r="1"/>',
    bots: '<path d="M8 3h9a4 4 0 0 1 4 4v9M9 6V3"/><rect x="3" y="8" width="14" height="13" rx="4"/><path d="M10 5v3M7 17h6"/><circle cx="7" cy="13" r=".8"/><circle cx="13" cy="13" r=".8"/>',
    portal: '<path d="M10 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M14 3h4a2 2 0 0 1 2 2v2m0 10v2a2 2 0 0 1-2 2h-4M9 12h12m-4-4 4 4-4 4"/>',
    message: '<path d="M20 14a4 4 0 0 1-4 4H9l-5 3V7a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4Z"/>',
    'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    box: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5"/>',
    settings: '<path d="M3 7h6m4 0h8M3 17h10m4 0h4"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
    link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" transform="translate(1 0) scale(.9)"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-2L20 8M4 16l1.5 3a8 8 0 0 0 13-2"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3V7Z"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name] || symbols.box}</svg>`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const emptyDraft = () => ({ version: 1, nodes: [
    { id: 'root', parent: null, kind: 'root', name: 'SuperJarvis', description: '', capabilities: '', mode: 'local', concurrency: 3, model: 'follow', workspace: '', endpoint: '', credential: '', scope: '', recovery: false, autostart: false },
  ] });
  function hasParentCycle(nodes) {
    const parents = new Map(nodes.map(n => [n?.id, n?.parent]));
    for (const id of parents.keys()) {
      const visited = new Set([id]);
      let parent = parents.get(id);
      while (parent) {
        if (visited.has(parent)) return true;
        visited.add(parent);
        parent = parents.get(parent);
      }
    }
    return false;
  }
  function load() {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORAGE));
      if (value?.version !== 1 || !Array.isArray(value.nodes) || !value.nodes.some(n => n.id === 'root')) return emptyDraft();
      if (value.nodes.some(n => !n || typeof n.id !== 'string' || !['root', 'instance', 'worker'].includes(n.kind) || typeof n.name !== 'string')) return emptyDraft();
      if (value.nodes.filter(n => n.kind !== 'worker').length > 60 || value.nodes.filter(n => n.kind === 'worker').length > 59) return emptyDraft();
      const ids = new Set(value.nodes.map(n => n.id));
      if (ids.size !== value.nodes.length || value.nodes.some(n => n.id !== 'root' && !ids.has(n.parent))) return emptyDraft();
      if (hasParentCycle(value.nodes)) return emptyDraft();
      return value;
    } catch { return emptyDraft(); }
  }
  let state = load(), currentInstanceId = 'root', currentView = 'overview', search = '';
  const collapsedInstances = new Set();
  const expandedPools = new Set();
  let topologyZoom = 1;
  let topologyObserver = null;
  const taskPages = new Map();
  const taskRequests = new Map();
  let editor = null, editorTab = 'basic', engineTab = 'source', editorReturn = 'overview', pendingDestination = null, toastTimer;
  let engineMount = null, engineMountEpoch = 0, engineQuery = {};
  const modelPickers = new Map();
  let savedWindowDraft; try { savedWindowDraft=sessionStorage.getItem(STORAGE); } catch { /* unavailable browser storage remains a recoverable save error */ }
  const service = { phase:'idle', snapshot:null, error:'', busy:false, details:new Map(), pollTimer:null, request:null, conflict:null, epoch:0, draftRevision:null,
    clientReady:false, readiness:null, readinessError:'' };
  const page = document.getElementById('composition-page');
  const main = document.getElementById('composition-main');
  if (!page || !main) return;
  const containingFrame=window.frameElement;
  const byId = id => page.querySelector('#' + id);
  const node = id => state.nodes.find(n => n.id === id);
  const children = id => state.nodes.filter(n => n.parent === id);
  const nameOf = id => node(id)?.name || '集团中枢';
  const brainNameOf = n => n.kind === 'root' && apiClient()?.state?.basic?.value?.assistantName
    ? apiClient().state.basic.value.assistantName : typeof n.brainName === 'string' && n.brainName.trim()
    ? n.brainName : n.kind === 'root' ? document.querySelector('[data-assistant-name]')?.textContent?.trim() || '贾维斯' : '贾维斯';
  const symbolOf = n => n.kind === 'root' ? 'layers' : n.id === 'quality' ? 'shield' : 'box';
  const tile = n => `<span class="icon-tile ${n.kind}">${icon(symbolOf(n))}</span>`;
  const apiClient = () => window.jarvis || (typeof jarvis === 'undefined' ? null : jarvis);
  const connected = () => !!service.snapshot;
  const settingsPending = () => connected() && (!service.clientReady || service.snapshot.view === 'topology');
  const organizationMode = () => apiClient()?.state?.runtime === 'dsh' || (apiClient()?.state === null && location.pathname.startsWith('/jarvis/'));
  const organizationBase = '#settings/organization';
  const savedConfigurationText = () => organizationMode()?'组织配置已保存':'系统配置已保存';
  const rolePaths = { basic:'organization', brain:'jarvis', router:'engine/eval', access:'engine/execution', workspace:'engine/execution', prompts:'engine/prompts', connections:'connections', runtime:'runtime' };
  const engineGroups = new Set(['source','eval','execution','prompts','deployment']);
  const engineAliases = {sources:'source',routing:'eval',worker:'execution',workspace:'execution'};
  let requestedEditorRoute = null, lastRequestedRoute = null;
  const editorRoute = (id, tab) => `${organizationBase}/${encodeURIComponent(id)}/${tab==='engine'?'engine/'+engineTab:rolePaths[tab] || tab}${id===rootId() && tab==='brain'?'/model':''}`;
  function selectEditorTab(tab, section = 'source') {
    const legacy = {router:'eval',access:'execution',workspace:'execution',prompts:'prompts'};
    if (organizationMode() && legacy[tab]) { editorTab='engine'; engineTab=legacy[tab]; }
    else { editorTab=tab; if (tab==='engine') engineTab=engineAliases[section] || (engineGroups.has(section)?section:'source'); }
  }
  function requestEditor(id, tab = 'basic') {
    if (organizationMode()) location.hash = editorRoute(id,tab);
    else openTopologyEditor(id,tab);
  }
  const rootId = () => service.snapshot?.rootId || 'root';
  const visible = () => !page.hidden && !document.getElementById('settings-page')?.hidden && !containingFrame?.hidden && document.visibilityState !== 'hidden';
  const runtimeOf = id => service.snapshot?.runtime?.instances?.find(item => item.instanceId === id);
  const phaseName = phase => ({ ready:'运行中', running:'运行中', starting:'启动中', stopping:'停止中', stopped:'已停止', failed:'启动失败', exited:'已退出', created:'未启动' }[phase] || phase || '未启动');
  function runtimeLabel(id) {
    if (!connected()) return '运行状态未同步';
    if (service.error) return '状态未同步';
    if (!service.snapshot.configured) return '尚未注册';
    const runtime=runtimeOf(id);
    if (runtime?.cleanupPending && !['starting','stopping'].includes(runtime.phase)) return '停止未完成';
    if (runtime?.phase==='running' && runtime.startup?.state==='starting') return '启动中';
    if (runtime?.phase==='running' && runtime.startup?.state==='blocked') return '等待设置';
    return phaseName(runtime?.phase);
  }
  function workerStatus(id) {
    if (!connected()) return '运行状态未同步';
    const detail=service.details.get(id), count=detail?.counts?.workersRunning;
    const live=service.snapshot.configured && ['ready','running'].includes(runtimeOf(id)?.phase) && detail?.stateAvailable && !service.error;
    return runtimeLabel(id)+(live && Number.isInteger(count)?` · 执行中 ${count} 个 Worker`:' · Worker 数量未获取');
  }
  function maxWorkersOf(n) {
    if (!n) return undefined;
    if (!organizationMode()) return n.concurrency;
    const value=service.snapshot?.nodes.find(item=>item.id===n.id)?.execution?.maxWorkers;
    return !service.error && Number.isInteger(value) && value>=1 && value<=16?value:undefined;
  }
  const workerCapacity = n => maxWorkersOf(n)===undefined?'并发上限未同步':`并发上限 ${maxWorkersOf(n)}`;
  const workerCapacityDetail = n => maxWorkersOf(n)===undefined?'实际并发上限未同步':`按任务自动分配 · 最多同时执行 ${maxWorkersOf(n)} 个任务`;
  const configurationNode = value => { const {execution,executionError,...saved}=value; return saved; };
  const organizationFields = ['name','brainName','description','capabilities','model','parent'];
  const sameField = (key, left, right) => key==='model'
    ? ['provider','model','reasoningEffort'].every(part=>left?.[part]===right?.[part]) : left===right;
  const organizationChanges = (value, original) => Object.fromEntries(organizationFields
    .map(key=>[key,typeof value[key]==='string'?value[key].trim():value[key]])
    .filter(([key,next])=>!sameField(key,next,original[key])));
  const pill = n => `<span class="status-pill ${connected()?'neutral':'pending'}" data-runtime-label="${escape(n.id)}"><i></i>${connected()?escape(runtimeLabel(n.id)):n.kind === 'root' ? '状态未同步' : '待连接'}</span>`;
  const button = (label, action, id = '', style = 'secondary', glyph = '') => `<button type="button" class="btn ${style}" data-action="${action}"${id ? ` data-id="${escape(id)}"` : ''}>${glyph ? icon(glyph) : ''}<span>${label}</span></button>`;
  function announce(message) {
    const toast = byId('composition-toast'); clearTimeout(toastTimer); toast.textContent = message; toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
  }
  function persist() {
    try { const value=JSON.stringify(state); sessionStorage.setItem(STORAGE,value); savedWindowDraft=value; return true; }
    catch { announce('草稿保存失败，请重试。更改仍保留在编辑区。'); return false; }
  }
  function serviceNotice() {
    if (!connected()) return `<div class="system-service-note" role="status"><span>运行服务不可用 · 当前为此窗口的配置草稿</span>${apiClient()?button('重新连接','system-retry','','quiet'):''}</div>`;
    const status = serviceMessage(), issue=service.error || service.readinessError;
    return `<div class="system-service-note${issue?' error':''}" role="status"><span data-system-service-message>${escape(status)}</span><div>${savedWindowDraft?button('查看此窗口草稿','draft-review','','quiet'):''}${issue?button('重新连接','system-retry','','quiet'):''}</div></div>`;
  }
  function serviceMessage() {
    return service.readinessError || (service.error ? '运行服务连接中断 · 已保留最近一次配置'
      : !service.clientReady ? '组织配置已读取 · 工作区正在连接，暂不能修改。' : settingsPending() ? '组织配置已读取 · 正在读取执行设置…'
      : service.snapshot.configured ? savedConfigurationText() : '尚未注册实例 · 保存配置后可启动');
  }
  function installSnapshot(snapshot, updateConfiguration = true) {
    if (!snapshot?.available || !Array.isArray(snapshot.nodes) || !Number.isInteger(snapshot.revision) || !snapshot.nodes.some(item => item.id === snapshot.rootId)) throw new Error('系统配置响应无效，请重试。');
    if (snapshot.view==='configuration' && service.snapshot) {
      const catalogs={};
      snapshot={...snapshot,nodes:snapshot.nodes.map(value=>{
        const previous=service.snapshot.nodes.find(item=>item.id===value.id);
        // A scoped save/readback does not refresh original execution settings. Retain only unchanged organizations' read-only projections.
        if (!previous || ['workspace','roleModels','concurrency','engine','workerTools','workerSkills'].some(key=>JSON.stringify(previous[key])!==JSON.stringify(value[key]))) return value;
        if (service.snapshot.catalogs?.[value.id]) catalogs[value.id]=service.snapshot.catalogs[value.id];
        return {...value,...Object.fromEntries(['execution','executionError'].filter(key=>Object.hasOwn(previous,key)).map(key=>[key,previous[key]]))};
      }),catalogs};
    }
    service.snapshot = snapshot; service.phase = 'connected'; service.error = '';
    if (updateConfiguration) {
      state = {version:1,nodes:structuredClone(snapshot.nodes)};
      if (!node(currentInstanceId)) currentInstanceId = snapshot.rootId;
    }
    document.dispatchEvent(new Event('jarvis:organization-updated'));
  }
  function schedulePoll() {
    clearTimeout(service.pollTimer);
    if (!visible() || !connected() || service.busy) return;
    service.pollTimer = setTimeout(() => refreshService(), 5000);
  }
  function clientReadiness(client) {
    if (!service.readiness) service.readiness = Promise.resolve(client.ready).then(() => {
      service.clientReady=true; return true;
    }, () => {
      service.readinessError='组织配置仍可查看 · 工作区加载失败，刷新页面后才能修改。';
      return false;
    });
    return service.readiness;
  }
  async function refreshService(initial = false) {
    if (service.request) return service.request;
    const client = apiClient(); if (!client) { service.phase='unavailable'; return; }
    const readiness=clientReadiness(client);
    const epoch=service.epoch;
    service.request = (async () => {
      try {
        if (!organizationMode() && !await readiness) return;
        let snapshot = await client.api(organizationMode() && (initial || !service.clientReady) ? '/api/system?view=topology' : '/api/system');
        if (epoch!==service.epoch) return;
        if (snapshot?.view === 'topology' || !service.clientReady) {
          installSnapshot(snapshot, !editor);
          if (!editor) render(); else updateRuntimeStatus();
          if (!await readiness || epoch!==service.epoch) { updateRuntimeStatus(); return; }
          // Older hosts return the full response for the query; only new topology snapshots need hydration.
          if (snapshot.view === 'topology') snapshot = await client.api('/api/system');
        }
        if (epoch!==service.epoch) return;
        const hydrated = settingsPending();
        const changed = snapshot.revision !== service.snapshot?.revision;
        const focusedField = main.contains(document.activeElement) && document.activeElement.matches('input,textarea,select');
        installSnapshot(snapshot, !editor && !focusedField);
        if ((initial || hydrated) && !editor) render();
        else if (changed && !editor && !focusedField && currentView !== 'draft-review' && visible()) render();
        else updateRuntimeStatus();
        await refreshDetail();
        if (currentView === 'overview') await refreshTopologyTasks();
      } catch (error) {
        if (epoch!==service.epoch) return;
        service.error = error.message || '无法连接运行服务。';
        if (!connected()) service.phase='unavailable';
        if (initial && !editor) render(); else updateRuntimeStatus();
      } finally { service.request=null; schedulePoll(); }
    })();
    return service.request;
  }
  async function refreshDetail() {
    if (!visible() || !connected() || settingsPending() || !service.snapshot.configured || !['runtime','workers'].includes(currentView)) return;
    const id = currentInstanceId;
    const epoch=service.epoch;
    try {
      const detail = await apiClient().api('/api/system/' + encodeURIComponent(id));
      if (epoch!==service.epoch) return;
      if (detail.instanceId === id) service.details.set(id,detail);
      if (currentInstanceId === id) updateRuntimeStatus();
    } catch (error) {
      if (epoch!==service.epoch) return;
      service.details.set(id,{instanceId:id,queryError:error.message});
      if (currentInstanceId === id) updateRuntimeStatus();
    }
  }
  function ensureService() {
    if (service.phase !== 'idle') return false;
    if (!apiClient()) { service.phase='unavailable'; return false; }
    service.phase='loading'; refreshService(true); return true;
  }
  function viewNavigation() {
    const active = currentView === 'editor' ? '' : currentView;
    const entries = [['overview','概览'],['children','下级实例',directInstances().length],['workers','普通 Worker'],['runtime','运行状态']];
    return `<nav class="composition-views" aria-label="当前实例管理">${entries.map(([view,label,count]) => `<button type="button" data-view="${view}"${view === active ? ' aria-current="page"' : ''}>${label}${count === undefined ? '' : `<span class="nav-count">${count}</span>`}</button>`).join('')}<span class="draft-label">${connected()?'系统配置':'配置草稿'}</span></nav>`;
  }
  function breadcrumb() {
    const n = node(currentInstanceId);
    const breadcrumbs = ancestry(n.id).map((item,i,items) => `<button type="button" data-action="enter-instance" data-id="${escape(item.id)}"${i === items.length-1 ? ' aria-current="location"' : ''}>${escape(item.name)}</button>`).join(`<span class="breadcrumb-divider">${icon('chevron')}</span>`);
    return `<nav class="instance-breadcrumb" aria-label="实例层级"><span>SuperJarvis</span><span class="breadcrumb-divider">${icon('chevron')}</span>${breadcrumbs}</nav>`;
  }
  function heading() {
    const n = node(currentInstanceId);
    return `${breadcrumb()}<div class="page-heading" data-current-instance="${escape(n.id)}"><div class="title-block"><h1 id="composition-title" tabindex="-1">${escape(n.name)}</h1><p>${escape(n.description)}</p></div><div class="heading-actions">${pill(n)}${button('实例配置','edit',n.id,'secondary','settings')}</div></div>${viewNavigation()}`;
  }
  function ancestry(id) {
    const result = []; let current = node(id);
    while (current) { result.unshift(current); current = node(current.parent); }
    return result;
  }
  function render() {
    topologyObserver?.disconnect();
    if (currentView!=='editor') unmountEngine();
    ensureService();
    if (service.phase === 'loading') { page.classList.remove('topology-mode'); main.innerHTML=`<div class="empty-state" role="status"><h1 id="composition-title" tabindex="-1">${organizationMode()?'组织架构管理':'系统管理'}</h1><p>正在读取系统配置…</p></div>`; return; }
    if (organizationMode() && !connected()) { page.classList.remove('topology-mode'); main.innerHTML=`<div class="empty-state" role="status"><h1 id="composition-title" tabindex="-1">暂时无法读取组织配置</h1><p>${escape(service.error || '请重新连接后再试。')}</p>${button('重新连接','system-retry','','secondary')}</div>`; return; }
    if (connected() && !editor) { state={version:1,nodes:structuredClone(service.snapshot.nodes)}; if (!node(currentInstanceId)) currentInstanceId=rootId(); }
    if (requestedEditorRoute && settingsPending()) {
      page.classList.remove('topology-mode');
      const issue=service.error || service.readinessError;
      main.innerHTML=`<div class="empty-state" role="status"><h1 id="composition-title" tabindex="-1">组织架构管理</h1><p>${escape(issue || (!service.clientReady?'工作区正在连接，暂不能修改。':'正在读取执行设置…'))}</p>${issue?button('重新连接','system-retry','','secondary'):''}</div>`;
      return;
    }
    if (requestedEditorRoute && connected()) {
      const {id,tab,section}=requestedEditorRoute; requestedEditorRoute=null;
      if (node(id) && node(id).kind!=='worker') {
        if (editor?.value.id===id) selectEditorTab(tab,section);
        else { currentInstanceId=id; openEditor(id,false,tab,section); return; }
      } else { main.innerHTML=`<div class="empty-state"><h1 id="composition-title" tabindex="-1">找不到此组织实例</h1><p>此实例可能已被移除。</p><a href="${organizationBase}">返回组织架构</a></div>`; return; }
    }
    page.classList.toggle('topology-mode', currentView === 'overview');
    if (currentView === 'draft-review') renderDraftReview();
    else if (currentView === 'editor') renderEditor();
    else if (currentView === 'overview') renderOverview();
    else if (currentView === 'children') renderChildren();
    else if (currentView === 'workers') renderWorkers();
    else renderRuntime();
    main.querySelector('.system-service-note')?.remove();
    main.insertAdjacentHTML('afterbegin',serviceNotice());
    updateRuntimeStatus(); schedulePoll();
    if (currentView === 'runtime' || currentView === 'workers') refreshDetail();
  }
  const directInstances = () => children(currentInstanceId).filter(n => n.kind === 'instance');
  const matchesSearch = n => `${n.name} ${n.description} ${n.capabilities}`.toLowerCase().includes(search.toLowerCase());
  function childCards(items) {
    if (!items.length) return `<div class="empty-state">${icon(search ? 'search' : 'layers')}<h2>${search ? '本层没有匹配的实例' : '还没有下级实例'}</h2><p>${search ? '试试其他名称或能力。' : '在这里为当前实例添加下级 SuperJarvis。'}</p></div>`;
    return `<div class="child-list">${items.map(n => `<article class="child-row" data-instance-id="${escape(n.id)}">${tile(n)}<div class="row-main"><h3>${escape(n.name)}</h3><p>${escape(n.description)}</p></div><span class="child-count">${children(n.id).filter(child => child.kind === 'instance').length} 个下级实例</span>${pill(n)}${button('进入实例','enter-instance',n.id,'quiet','arrow')}</article>`).join('')}</div>`;
  }
  function childrenSection() {
    return `<section class="children-section" aria-label="下级实例"><div class="section-title"><div><h2>下级实例 <span class="section-count">${directInstances().length}</span></h2><p>直属于 ${escape(nameOf(currentInstanceId))}</p></div>${button('添加下级实例','add-instance','','secondary','plus')}</div><div id="instance-list">${childCards(directInstances())}</div></section>`;
  }
  function renderOverview() {
    topologyObserver?.disconnect();
    const n = node(currentInstanceId);
    main.innerHTML = `<section class="topology-workspace" aria-label="实例与 Worker 拓扑"><header class="topology-commandbar" data-current-instance="${escape(n.id)}"><div class="topology-context">${breadcrumb()}<h1 id="composition-title" class="sr-only" tabindex="-1">${escape(n.name)}</h1></div>${viewNavigation()}<div class="topology-command-actions">${button('实例配置','edit',n.id,'quiet','settings')}${button('添加 SuperJarvis','add-instance','','secondary','plus')}</div></header><div class="topology-canvas" id="topology-canvas" role="region" aria-label="执行拓扑画布" tabindex="0"><div class="topology-tree" id="topology-tree" style="zoom:${topologyZoom}"><svg class="topology-links" aria-hidden="true"></svg>${topologyBranch(n)}</div></div><div class="topology-legend"><span class="legend-brain">${icon('brain')}大脑</span><span class="legend-agent">${icon('bots')}普通 Worker</span><span class="legend-instance">${icon('portal')}虚拟入口 · SuperJarvis</span></div><div class="topology-controls">${button('全部展开','topology-expand','','quiet')}${button('收起下级','topology-collapse','','quiet')}<button type="button" class="btn quiet" data-action="topology-zoom-out" aria-label="缩小拓扑">−</button><output id="topology-zoom" aria-label="拓扑缩放比例">${Math.round(topologyZoom*100)}%</output><button type="button" class="btn quiet" data-action="topology-zoom-in" aria-label="放大拓扑">+</button>${button('100%','topology-reset','','quiet')}</div></section>`;
    if (organizationMode() && service.snapshot?.configured) {
      for (const brain of main.querySelectorAll('[data-brain-id]')) {
        const id = brain.dataset.brainId;
        const tasks = document.createElement('details');
        tasks.className = 'org-tasks';
        tasks.dataset.taskOrganization = id;
        tasks.open = taskPages.get(id)?.open === true;
        tasks.innerHTML = '<summary><strong>任务动态</strong><span></span></summary><div class="org-task-page"></div>';
        brain.parentElement.append(tasks);
        tasks.addEventListener('toggle', () => {
          if (!tasks.isConnected) return;
          taskPage(id).open = tasks.open;
          if (tasks.open && !taskPage(id).data) void refreshTopologyTasks();
          drawTopologyLinks();
        });
        paintTaskPage(tasks);
      }
      void refreshTopologyTasks();
    }
    drawTopologyLinks();
    if (window.ResizeObserver) {
      topologyObserver = new ResizeObserver(drawTopologyLinks);
      topologyObserver.observe(byId('topology-tree'));
    }
  }
  function taskPage(id) {
    if (!taskPages.has(id)) taskPages.set(id, { cursor: 0, open: false, data: null, error: false });
    return taskPages.get(id);
  }
  function paintTaskPage(element) {
    const id = element.dataset.taskOrganization, page = taskPage(id), rows = page.data?.items;
    const failed = page.error || service.error || page.data?.availability === 'unavailable';
    const first = rows?.[0];
    const compact = element.querySelector('summary > span');
    const historical = page.data?.availability === 'stored' || first?.availability === 'stored';
    const target = first?.execution?.kind === 'delegated' ? first.execution.name || first.execution.instanceId : '';
    compact.textContent = failed ? '状态未同步' : first ? [historical ? '上次记录' : '', first.statusLabel, target ? '→ ' + target : '', first.title].filter(Boolean).join(' · ')
      : rows ? (page.data?.fromLogs ? '本页暂无工单快照' : '暂无任务记录') : page.onDemand ? '展开查看工单记录' : '正在读取…';
    compact.dataset.status = failed || historical ? '' : first?.status || '';
    compact.title = compact.textContent;
    const panel = element.querySelector('.org-task-page');
    const content = [];
    if (failed) content.push('<p>任务状态暂时无法读取。</p>');
    else if (historical) content.push('<p>' + (page.data?.fromLogs ? '以下为运行日志收录的工单记录。' : '以下为该组织上次保存的记录。') + '</p>');
    if (rows?.length) {
      content.push('<ul>');
      for (const row of rows) {
        const executor = row.execution || {};
        const route = executor.kind === 'delegated' ? '委派给 ' + (executor.name || executor.instanceId)
          : executor.kind === 'local' ? '本级执行' : executor.kind === 'unassigned' ? '尚未分派' : '执行方待确认';
        const trace = row.logs?.traceId;
        const time = row.updatedAt && new Date(row.updatedAt);
        content.push('<li><strong>' + escape(row.title) + '</strong><span>' + escape([row.statusLabel,route].join(' · ')) + '</span>'
          + (row.workRef ? '<code>' + escape(row.workRef) + '</code>' : '')
          + (executor.workerId ? '<span>' + (executor.kind==='delegated'?'下级 Worker':'Worker') + ' · ' + escape(executor.workerId) + '</span>' : '')
          + (row.progress?.summary ? '<p>' + (row.progress.state==='blocked'?'受阻原因 · ':'') + escape(row.progress.summary) + '</p>' : '')
          + '<footer>' + (time && Number.isFinite(time.getTime()) ? '<time datetime="' + escape(row.updatedAt) + '">' + escape(time.toLocaleString('zh-CN',{hour12:false})) + '</time>' : '')
          + (trace ? '<a href="#logs?trace=' + escape(encodeURIComponent(trace)) + '">运行日志</a>' : '') + '</footer></li>');
      }
      content.push('</ul>');
    }
    if (page.cursor || Number.isInteger(page.data?.nextCursor)) {
      content.push('<nav aria-label="任务记录分页">');
      if (page.cursor) content.push(button('返回最新','org-tasks-first',id,'quiet'));
      if (Number.isInteger(page.data?.nextCursor)) content.push(button('下一页','org-tasks-next',id,'quiet'));
      content.push('</nav>');
    }
    const html = content.join('');
    if (panel._renderedTasks !== html) { panel.innerHTML = html; panel._renderedTasks = html; }
  }
  // Older running hosts already publish authenticated, immutable log snapshots.
  // Display those as recorded evidence while their original tasks remain active.
  async function recordedOrgTasks(id, before) {
    const client = apiClient(), params = new URLSearchParams({ organization:id, role:'worker', q:'任务状态快照', limit:'12' });
    if (before) params.set('before',String(before));
    const list = await client.api('/api/logs?' + params);
    if (!Array.isArray(list?.items)) throw new Error('无法读取工单快照');
    const entries = [], seen = new Set();
    for (const entry of list.items) {
      if (entry.organizationId !== id || entry.event !== 'core/ticket/snapshot' || !entry.refs?.ticketId || seen.has(entry.refs.ticketId)) continue;
      seen.add(entry.refs.ticketId); entries.push(entry);
    }
    const items = [];
    for (const entry of entries) {
      const detail = await client.api('/api/logs/' + entry.id), ticket = detail.detail?.record;
      if (detail.organizationId !== id || detail.event !== entry.event) continue;
      if (ticket?.id !== entry.refs.ticketId) {
        items.push({title:entry.summary,statusLabel:'状态待核实',updatedAt:entry.at,logs:{traceId:entry.traceId}});
        continue;
      }
      const assignment = ticket.assignments?.at(-1), report = assignment?.report, trace = entry.traceId;
      const statusLabel = ticket.ended ? ({completed:'已完成',stopped:'已停止'}[ticket.ended.outcome] || '已结束')
        : ({blocked:'执行受阻',failed:'执行失败',waiting:'等待后续事件',progress:'执行中',ready:'已回报'}[report?.state]
          || (assignment?.startedAt ? '已接单' : '等待执行'));
      const execution = { kind: 'unknown' };
      if (ticket.mandate?.basis?.via === 'delegation') {
        execution.kind='local';
        if (assignment?.startedAt) execution.workerId='worker-'+ticket.id;
      } else if (trace && assignment?.id && service.snapshot.nodes.some(n=>n.parent===id)) {
        const query = new URLSearchParams({organization:id, role:'runtime', trace, q:'向下级交办状态快照', limit:'5'});
        const delegates = await client.api('/api/logs?' + query).catch(()=>null);
        const row = delegates?.items?.find(r=>r.organizationId===id && r.traceId===trace && r.event==='instance/process-delegation/out/snapshot'
          && r.refs?.ticketId===ticket.id && r.refs?.assignmentId===assignment.id);
        if (row) {
          const out = (await client.api('/api/logs/'+row.id).catch(()=>null))?.detail?.record?.request;
          if (out?.parentTicketId===ticket.id && out.parentAssignmentId===assignment.id && out.targetInstanceId) {
            execution.kind='delegated'; execution.instanceId=out.targetInstanceId; execution.name=node(out.targetInstanceId)?.name;
          }
        }
      }
      const work = /^work:[^:]+:(JW-[\w-]+)$/.exec(trace || '');
      items.push({title:ticket.title,workRef:work?.[1],updatedAt:ticket.updatedAt || entry.at,statusLabel,
        status:report?.state,execution,progress:report,logs:{traceId:trace}});
    }
    return {instanceId:id,items,nextCursor:list.nextCursor,availability:'stored',fromLogs:true};
  }
  async function refreshTopologyTasks() {
    if (!visible() || currentView !== 'overview' || !organizationMode() || !service.clientReady || !service.snapshot?.configured) return;
    const groups = new Map(), revision = service.snapshot.revision;
    const elements = [...main.querySelectorAll('[data-task-organization]')];
    const fromLogs = apiClient().state?.tasksAvailable !== true;
    for (const el of elements) {
      const id = el.dataset.taskOrganization, cursor = taskPage(id).cursor;
      if (fromLogs) {
        const p=taskPage(id); p.onDemand=elements.length>4 && !el.open;
        if (p.onDemand || (p.data && p.expires>Date.now())) { paintTaskPage(el); continue; }
      }
      if (!groups.has(cursor)) groups.set(cursor, []);
      groups.get(cursor).push(id);
    }
    await Promise.all([...groups].map(async ([cursor, ids]) => {
      const query = new URLSearchParams({ limit:'5', cursor:String(cursor) });
      for (const id of ids) query.append('organizationId',id);
      const key = revision + ':' + query;
      if (taskRequests.has(key)) return taskRequests.get(key);
      const request = (async () => {
        let organizations;
        try {
          if (fromLogs) {
            organizations = await Promise.all(ids.map(id=>recordedOrgTasks(id,cursor).catch(()=>({instanceId:id}))));
          } else {
            const result = await apiClient().api('/api/tasks?' + query);
            organizations = Array.isArray(result?.organizations) ? result.organizations : [];
          }
        } catch { organizations = []; }
        if (!visible() || currentView !== 'overview' || service.snapshot?.revision !== revision) return;
        for (const el of main.querySelectorAll('[data-task-organization]')) {
          const id = el.dataset.taskOrganization, page = taskPage(id);
          if (!ids.includes(id) || page.cursor !== cursor) continue;
          const data = organizations.find(org => org.instanceId === id);
          page.error = !Array.isArray(data?.items);
          if (!page.error) { page.data = data; page.expires = Date.now()+30000; }
          paintTaskPage(el);
        }
        drawTopologyLinks();
      })();
      taskRequests.set(key,request);
      try { await request; } finally { taskRequests.delete(key); }
    }));
  }
  // Child instances expose a virtual Worker in their parent. Derive this view from
  // the existing relation instead of duplicating persisted configuration records.
  function topologyWorker(w) {
    const expanded = !collapsedInstances.has(w.id);
    return `<div class="topology-worker proxy-worker" data-proxy-target="${escape(w.id)}" data-worker-type="superjarvis"><button type="button" class="topology-worker-main" data-action="topology-toggle" data-id="${escape(w.id)}" aria-label="${escape(`${expanded?'收起':'展开'} ${w.name}`)}" title="${escape(w.description || w.capabilities || '未填写职责')}" aria-expanded="${expanded}"><span class="topology-role-icon proxy" aria-hidden="true">${icon('portal')}</span><span class="worker-copy"><strong>${escape(w.name)}</strong><small><span class="execution-type superjarvis">SuperJarvis</span> · 虚拟入口</small></span><span class="worker-purpose sr-only">${escape(w.description || w.capabilities || '未填写职责')}</span><span class="proxy-disclosure"><span class="sr-only">${expanded?'收起':'展开'}</span>${icon('chevron')}</span></button><button type="button" class="topology-proxy-config" data-action="topology-config" data-id="${escape(w.id)}" aria-label="配置 SuperJarvis Worker：${escape(w.name)}" title="配置下级 SuperJarvis">${icon('settings')}</button></div>`;
  }
  // Ordinary Workers are allocated by task; old group records remain only for draft compatibility.
  function topologyWorkerPool(n) {
    const expanded = expandedPools.has(n.id), name = escape(n.name), id = escape(n.id);
    return `<div class="topology-worker agent-worker worker-pool${expanded?' is-expanded':''}" data-worker-id="workers:${id}" data-worker-owner="${id}" data-worker-type="agent"><button type="button" class="topology-worker-main" data-action="topology-pool-toggle" data-id="${id}" aria-label="${expanded?'收起':'展开'}普通 Worker：${name}" aria-expanded="${expanded}"${expanded?` aria-controls="pool-${id}"`:''} title="${name} · 按任务自动分配 Worker"><span class="topology-role-icon agent" aria-hidden="true">${icon('bots')}</span><span class="worker-copy"><strong>普通 Worker</strong><small>DSH <span class="execution-type agent">Agent</span> · <span data-worker-capacity="${id}">${escape(workerCapacity(n))}</span></small></span><span class="worker-purpose sr-only">按任务自动分配 Worker，共用本实例的执行配置。</span><span class="pool-disclosure">${icon('chevron')}</span></button><button type="button" class="topology-pool-config" data-action="topology-worker-config" data-id="${id}" aria-label="配置普通 Worker：${name}" title="Worker 设置">${icon('settings')}</button>${expanded?`<div class="worker-pool-detail" id="pool-${id}" role="region" aria-label="${name}的普通 Worker 执行情况"><div class="pool-state">${icon('activity')}<span data-worker-status="${id}">${escape(workerStatus(n.id))}</span></div><small data-worker-capacity-detail="${id}">${escape(workerCapacityDetail(n))}</small></div>`:''}</div>`;
  }
  function topologyBranch(n) {
    const delegated = children(n.id).filter(item => item.kind === 'instance');
    const workerBranches = `<div class="topology-worker-branch">${topologyWorkerPool(n)}</div>` + delegated.map(w => `<div class="topology-worker-branch">${topologyWorker(w)}${!collapsedInstances.has(w.id)?topologyBranch(w):''}</div>`).join('');
    const brainName = brainNameOf(n);
    return `<section class="topology-instance" data-topology-instance="${escape(n.id)}" aria-label="${escape(n.name)} · SuperJarvis"><div class="topology-brain-node"><button type="button" class="topology-brain" data-brain-id="${escape(n.id)}" data-action="topology-config" data-id="${escape(n.id)}" aria-label="配置大脑：${escape(brainName)} · ${escape(n.name)}" title="${escape(n.name)} · ${escape(brainName)}"><span class="brain-orb" aria-hidden="true">${icon('brain')}</span><span class="brain-copy"><small>${escape(n.name)}</small><strong>${escape(brainName)}</strong><span${connected()?` data-brain-runtime="${escape(n.id)}"`:''}>大脑${connected()?' · '+escape(runtimeLabel(n.id)):''}</span></span></button><div class="topology-node-actions">${n.id!==currentInstanceId?`<button type="button" data-action="enter-instance" data-id="${escape(n.id)}" aria-label="进入 ${escape(n.name)} 实例" title="进入实例">${icon('arrow')}</button>`:''}</div></div><div class="topology-worker-grid" aria-label="${escape(n.name)} 的 Worker">${workerBranches}</div></section>`;
  }
  function drawTopologyLinks() {
    const tree = byId('topology-tree');
    if (!tree || currentView !== 'overview') return;
    // Expanded pools extend their whole instance row before any child instance starts.
    for (const grid of tree.querySelectorAll('.topology-worker-grid')) {
      const branches = [...grid.children].filter(el => el.classList.contains('topology-worker-branch'));
      const heights = branches.map(el => el.querySelector(':scope > .topology-worker').getBoundingClientRect().height/topologyZoom);
      const rowHeight = Math.max(0,...heights);
      branches.forEach((el,i) => el.style.setProperty('--worker-row-offset',`${rowHeight-heights[i]}px`));
    }
    const bounds = tree.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const position = element => {
      const r = element.getBoundingClientRect();
      return {x:(r.left-bounds.left)/topologyZoom, y:(r.top-bounds.top)/topologyZoom, w:r.width/topologyZoom, h:r.height/topologyZoom};
    };
    const paths = [], groups = [];
    const brains = new Map([...tree.querySelectorAll('[data-brain-id]')].map(el => [el.dataset.brainId,el]));
    for (const [id,brain] of brains) {
      const b = position(brain.parentElement.querySelector('.org-tasks') ? brain.parentElement : brain), instance = brain.closest('.topology-instance');
      const workers = instance.querySelectorAll(':scope > .topology-worker-grid > .topology-worker-branch > .topology-worker');
      const members = [b,...[...workers].map(position)];
      groups.push(topologyGroupFrame(node(id),members));
      for (const worker of workers) {
        const w = position(worker), bus = (b.y+b.h+w.y)/2;
        const workerId = worker.dataset.workerId || `proxy:${worker.dataset.proxyTarget}`;
        paths.push(`<path class="brain-worker-link" data-edge-from="${escape(id)}" data-edge-to="${escape(workerId)}" d="M${b.x+b.w/2},${b.y+b.h} V${bus} H${w.x+w.w/2} V${w.y}" marker-end="url(#worker-arrow)"/>`);
        const target = brains.get(worker.dataset.proxyTarget);
        if (!target) continue;
        const t = position(target), gutter = (w.y+w.h+t.y)/2;
        paths.push(`<path class="proxy-brain-link" data-edge-from="${escape(workerId)}" data-edge-to="${escape(worker.dataset.proxyTarget)}" d="M${w.x+w.w/2},${w.y+w.h} V${gutter} H${t.x+t.w/2} V${t.y}" marker-end="url(#proxy-arrow)"/>`);
      }
    }
    const svg = tree.querySelector('.topology-links');
    let groupLayer = tree.querySelector('.topology-groups');
    if (!groupLayer) {
      groupLayer = document.createElement('div');
      groupLayer.className = 'topology-groups';
      groupLayer.setAttribute('aria-hidden','true');
      tree.prepend(groupLayer);
    }
    groupLayer.innerHTML = groups.join('');
    svg.setAttribute('viewBox',`0 0 ${bounds.width/topologyZoom} ${bounds.height/topologyZoom}`);
    svg.innerHTML = `<defs><marker id="worker-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M1 1L5 3L1 5" fill="none" stroke="#9aa0aa" stroke-width="1.2"/></marker><marker id="proxy-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M1 1L5 3L1 5" fill="none" stroke="#7c8490" stroke-width="1.2"/></marker></defs>${paths.join('')}`;
  }
  function topologyGroupFrame(instance,members) {
    // Include direct members only: a proxy belongs here, its target brain does not.
    const x = Math.min(...members.map(r=>r.x))-18;
    const y = Math.min(...members.map(r=>r.y))-18;
    const right = Math.max(...members.map(r=>r.x+r.w))+18;
    const bottom = Math.max(...members.map(r=>r.y+r.h))+12;
    // Uneven subtrees can move the brain away from the frame's midpoint.
    const labelWidth = Math.max(28,members[0].x+members[0].w/2-x-36);
    return `<div class="topology-group-frame" data-group-id="${escape(instance.id)}" style="left:${x}px;top:${y}px;width:${right-x}px;height:${bottom-y}px;--group-label-width:${labelWidth}px"><span class="topology-group-label" title="SuperJarvis · ${escape(instance.name)}">${icon('layers')}<strong>${escape(instance.name)}</strong></span></div>`;
  }
  function updateTopology(action, id) {
    if (currentView !== 'overview') return;
    if (action === 'topology-toggle') {
      if (collapsedInstances.has(id)) collapsedInstances.delete(id); else collapsedInstances.add(id);
    } else if (action === 'topology-pool-toggle') {
      if (expandedPools.has(id)) expandedPools.delete(id); else expandedPools.add(id);
    } else if (action === 'topology-expand') collapsedInstances.clear();
    else if (action === 'topology-collapse') directInstances().forEach(n => collapsedInstances.add(n.id));
    else {
      if (!['topology-reset','topology-zoom-in','topology-zoom-out'].includes(action)) return;
      topologyZoom = action === 'topology-reset' ? 1 : Math.max(.6, Math.min(1.4, Math.round((topologyZoom + (action === 'topology-zoom-in' ? .1 : -.1))*10)/10));
      byId('topology-tree').style.zoom = topologyZoom;
      byId('topology-zoom').textContent = `${Math.round(topologyZoom*100)}%`;
      drawTopologyLinks();
      return;
    }
    const canvas = byId('topology-canvas'), position = [canvas.scrollLeft, canvas.scrollTop];
    renderOverview();
    main.insertAdjacentHTML('afterbegin',serviceNotice()); updateRuntimeStatus();
    byId('topology-canvas').scrollTo(...position);
    const control = [...page.querySelectorAll('[data-action]')].find(el => el.dataset.action === action && (id === undefined || el.dataset.id === id));
    control?.focus({preventScroll:true});
  }
  function openTopologyEditor(id, tab = 'basic') {
    const target = node(id); if (!target || target.kind === 'worker') return;
    if (currentInstanceId !== target.id) {
      goTo({view:'overview',instanceId:target.id});
      if (editor?.dirty) return;
    }
    openEditor(id,false,tab);
  }
  function renderChildren() {
    main.innerHTML = `${heading()}<div class="list-toolbar"><label class="search-field">${icon('search')}<input id="node-search" aria-label="搜索本层实例" placeholder="搜索本层名称或能力" value="${escape(search)}"></label></div><div class="page-content">${childrenSection()}</div>`;
    renderRows();
  }
  function renderRows() {
    const list = byId('instance-list');
    if (list) list.innerHTML = childCards(directInstances().filter(matchesSearch));
  }
  function renderWorkers() {
    const n = node(currentInstanceId);
    main.innerHTML = `${heading()}<div class="page-content"><div class="section-title local-heading"><div><h2>普通 Worker</h2><p>${escape(n.name)} 按任务自动分配执行会话，无需手动添加。</p></div></div><section class="worker-list" aria-label="普通 Worker"><article class="worker-row" data-worker-id="workers:${escape(n.id)}" data-worker-owner="${escape(n.id)}"><span class="icon-tile">${icon('bots')}</span><div class="row-main"><h3>DSH Agent</h3><p data-worker-status="${escape(n.id)}">${escape(workerStatus(n.id))}</p></div><span class="worker-limit">实例<span data-worker-capacity="${escape(n.id)}">${escape(workerCapacity(n))}</span></span>${button('Worker 设置','topology-worker-config',n.id,'secondary','settings')}</article></section></div>`;
  }
  function renderRuntime() {
    const n = node(currentInstanceId);
    if (connected()) { renderConnectedRuntime(n); return; }
    main.innerHTML = `${heading()}<div class="page-content runtime-layout" data-runtime-instance="${escape(n.id)}"><section class="runtime-panel"><div class="section-title"><div><h2>${escape(n.name)} · 运行状态</h2><p>运行数据尚未获取</p></div>${button('运行配置','runtime-config',n.id,'secondary','settings')}</div><dl class="runtime-facts"><div><dt>健康状态</dt><dd><span class="status-pill neutral">未获取</span></dd></div><div><dt>运行版本</dt><dd>—</dd></div><div><dt>任务执行中</dt><dd>—</dd></div><div><dt>维护方</dt><dd>${n.mode === 'connect' ? '外部实例维护方' : '当前计算机'}</dd></div></dl><div class="maintenance-actions"><button class="btn secondary" type="button" disabled>暂停接单</button><button class="btn secondary" type="button" disabled>重启实例</button><button class="btn danger" type="button" disabled>停止实例</button><span>运行管理尚未接入，暂不可操作</span></div></section><section class="runtime-records" id="runtime-records"><div class="section-title"><h2>维护记录</h2><span class="muted">${escape(n.name)}</span></div><div class="empty-state compact">${icon('clock')}<p>暂无运行维护记录</p></div></section></div>`;
  }
  function renderConnectedRuntime(n) {
    main.innerHTML = `${heading()}<div class="page-content runtime-layout" data-runtime-instance="${escape(n.id)}"><section class="runtime-panel"><div class="section-title"><div><h2>${escape(n.name)} · 运行状态</h2><p data-runtime-summary></p></div>${button('运行配置','runtime-config',n.id,'secondary','settings')}</div><dl class="runtime-facts"><div><dt>实例状态</dt><dd data-runtime-phase></dd></div><div><dt>实例 PID</dt><dd data-runtime-pid></dd></div><div><dt>进程代次</dt><dd data-runtime-generation></dd></div><div><dt>DSH 宿主 PID</dt><dd data-runtime-host></dd></div><div><dt>执行中的 Worker</dt><dd data-runtime-workers>—</dd></div><div><dt>未结束任务</dt><dd data-runtime-tickets>—</dd></div></dl><p class="runtime-error field-error" data-runtime-error role="alert" hidden></p><p class="runtime-query-note" data-runtime-query hidden></p><section data-runtime-startup role="status" aria-live="polite" hidden></section><div class="maintenance-actions">${button('启动实例','runtime-start',n.id,'primary')}${button('重启实例','runtime-restart',n.id,'secondary','refresh')}${button('停止实例','runtime-stop',n.id,'danger')}<span data-runtime-action-note></span></div><p class="runtime-operation-note">启停统一控制此实例的贾维斯对话、任务路由和 Worker；历史记录与设置仍可查看。下级实例按任务绑定接收停止请求，其独立进程在各自的运行状态中管理。停止后可重新启动；重启不会重放结果不明的任务。</p></section><section class="runtime-records" id="runtime-records"><div class="section-title"><h2>维护记录</h2><span class="muted">${escape(n.name)}</span></div><div data-runtime-lifecycle></div></section></div>`;
  }
  const startupStages = {process:'启动进程',github:'GitHub 连接检查',sources:'其他来源检查',environment:'准备执行环境',sessions:'初始化会话',finalizing:'确认就绪'};
  const startupStates = {starting:'启动中',ready:'已就绪',blocked:'等待设置',failed:'启动失败',cancelling:'正在取消启动',cancelled:'启动已取消',interrupted:'启动已中断'};
  const startupStageStates = {running:'进行中',complete:'已完成',skipped:'无需检查',blocked:'等待设置',failed:'检查失败',cancelling:'正在取消',cancelled:'已取消',interrupted:'已中断'};
  const seconds = ms => Number.isFinite(ms) && ms>=0 ? (ms/1000).toFixed(1)+' 秒' : '—';
  function paintStartup(panel,runtime) {
    const element=panel.querySelector('[data-runtime-startup]'), startup=runtime?.startup;
    if (!element) return;
    const request=runtimeControlPoll;
    if (request && request.id===panel.dataset.runtimeInstance && ['start','restart'].includes(request.action)
      && (!startup || startup.id===request.previousAttempt)) {
      element.hidden=false;
      element.textContent='已请求启动，等待确认 · 已等待 '+seconds(Date.now()-request.requestedAt);
      return;
    }
    element.hidden=!startup;
    if (!startup) { element.textContent=''; return; }
    const previous=['stopped','failed'].includes(runtime.phase) && startup.state==='ready'?'上次启动 · ':'';
    const markup=`<p><strong>${escape(previous+(startupStates[startup.state]||'启动状态未同步'))}</strong> · ${escape(seconds(startup.elapsedMs))}</p><ol class="runtime-event-list">${Object.entries(startupStages).map(([stage,label])=>{
      const row=startup.stages?.find(item=>item.stage===stage);
      return `<li data-startup-stage="${stage}"><span>${escape(label)} · ${escape(row?startupStageStates[row.status]||'状态未同步':'等待')}</span><small>${row?escape(seconds(row.durationMs)):'—'}</small></li>`;
    }).join('')}</ol>`;
    if (element.innerHTML!==markup) element.innerHTML=markup;
  }
  let runtimeControlPoll=null;
  function scheduleRuntimeControlPoll(poll) {
    clearTimeout(poll.timer);
    if (runtimeControlPoll!==poll) return;
    poll.timer=setTimeout(async()=>{
      try {
        if (!visible()) return;
        // Topology is the existing read-only status path: it never opens a
        // management owner or waits behind the initialize POST for settings.
        const snapshot=await apiClient().api('/api/system?view=topology');
        if (runtimeControlPoll!==poll) return;
        if (!snapshot?.available || !Array.isArray(snapshot.runtime?.instances)) throw new Error('运行状态响应无效，请重试。');
        service.snapshot.runtime=snapshot.runtime; poll.error=''; updateRuntimeStatus();
      } catch (error) {
        if (runtimeControlPoll!==poll) return;
        poll.error=error.message||'暂时无法读取启动进度。'; updateRuntimeStatus();
      } finally { scheduleRuntimeControlPoll(poll); }
    },visible()?500:5000);
  }
  function updateRuntimeStatus() {
    if (!connected()) return;
    for (const tasks of main.querySelectorAll('[data-task-organization]')) paintTaskPage(tasks);
    const notice=main.querySelector('.system-service-note'), message=notice?.querySelector('[data-system-service-message]');
    if (message) {
      const issue=service.error || service.readinessError;
      message.textContent=serviceMessage();
      notice.classList.toggle('error',!!issue);
      const retry=notice.querySelector('[data-action="system-retry"]');
      if (issue && !retry) notice.querySelector('div').insertAdjacentHTML('beforeend',button('重新连接','system-retry','','quiet'));
      else if (!issue) retry?.remove();
    }
    for (const label of main.querySelectorAll('[data-brain-runtime]')) label.textContent='大脑 · '+runtimeLabel(label.dataset.brainRuntime);
    for (const label of main.querySelectorAll('[data-worker-status]')) label.textContent=workerStatus(label.dataset.workerStatus);
    for (const label of main.querySelectorAll('[data-worker-capacity]')) label.textContent=workerCapacity(node(label.dataset.workerCapacity));
    for (const label of main.querySelectorAll('[data-worker-capacity-detail]')) label.textContent=workerCapacityDetail(node(label.dataset.workerCapacityDetail));
    for (const label of main.querySelectorAll('[data-runtime-label]')) {
      const text = runtimeLabel(label.dataset.runtimeLabel);
      if (label.textContent !== text) label.textContent=text;
    }
    for (const control of main.querySelectorAll('[data-action="add-instance"], [data-action="edit"], [data-action="topology-config"], [data-action="topology-worker-config"], [data-action="runtime-config"]')) control.disabled=settingsPending();
    const panel = main.querySelector('[data-runtime-instance]');
    if (!panel) return;
    const id = panel.dataset.runtimeInstance, runtime = runtimeOf(id), detail = service.details.get(id);
    paintStartup(panel,runtime);
    const set = (key,value) => { const element=panel.querySelector('[data-runtime-'+key+']'); if (element) element.textContent=value; };
    const unavailable = !!service.error;
    set('summary',!service.snapshot.configured?'尚未注册实例，先保存配置。':unavailable?'暂时无法读取运行服务。':'当前实例包含贾维斯对话、任务路由和 Worker，启停统一生效。');
    set('phase',runtimeLabel(id)); set('pid',unavailable?'—':runtime?.pid??'—');
    set('generation',unavailable?'—':runtime?.generation??'—'); set('host',unavailable?'—':service.snapshot.runtime?.hostPid??'—');
    const liveCounts=!unavailable && ['ready','running'].includes(runtime?.phase) && detail?.stateAvailable;
    set('workers',liveCounts?detail.counts?.workersRunning??'—':'—');
    set('tickets',liveCounts?detail.counts?.openTickets??'—':'—');
    const error = panel.querySelector('[data-runtime-error]');
    error.textContent = service.controlError || (!unavailable && runtime?.error) || ''; error.hidden=!error.textContent;
    const query=panel.querySelector('[data-runtime-query]');
    query.textContent=unavailable?service.error:runtimeControlPoll?.error||detail?.queryError||''; query.hidden=!query.textContent;
    const phase=runtime?.phase, transitional=['starting','stopping'].includes(phase)||runtime?.startup?.state==='starting';
    const running=['ready','running'].includes(phase), blocked=service.busy || transitional || unavailable || settingsPending() || !service.snapshot.configured;
    for (const control of panel.querySelectorAll('[data-action^="runtime-"]')) {
      const action=control.dataset.action; if (action==='runtime-config') continue;
      control.disabled=blocked || (action==='runtime-start'?(running||!!runtime?.cleanupPending):action==='runtime-stop'?!runtime?.pid&&!runtime?.cleanupPending:!runtime?.pid);
    }
    set('action-note',runtime?.startup?.state==='starting'?startupStages[runtime.startup.stage]||'正在启动…':service.busy?'正在处理…':transitional?'进程正在切换状态。':runtime?.cleanupPending?'会话清理未完成，可重试停止实例。':'');
    const lifecycle=panel.querySelector('[data-runtime-lifecycle]');
    const events=detail?.lifecycle||[];
    const eventName = item => item.event==='startup-progress'?`${startupStages[item.stage]||'启动阶段'} · ${startupStageStates[item.status]||'状态已更新'}`:item.event.startsWith('startup-')?startupStates[item.event.slice(8)]||'启动状态已更新':({start:'开始启动',starting:'开始启动',started:'已启动',ready:'已就绪',stop:'停止',stopping:'开始停止',stopped:'已停止',exit:'进程退出',failed:'启动失败','initialization-failed':'初始化失败',restart:'重启'}[item.event]||item.event);
    const markup=events.length?`<ol class="runtime-event-list">${events.slice(-20).reverse().map(item=>`<li><span>${escape(eventName(item))}</span><small>${escape(item.at)} · 第 ${escape(item.generation)} 代${item.pid?` · PID ${escape(item.pid)}`:''}${item.elapsedMs!==undefined?` · 累计 ${escape(seconds(item.elapsedMs))}`:''}${item.code!==undefined?` · 退出码 ${escape(item.code)}`:''}${item.signal?` · ${escape(item.signal)}`:''}</small></li>`).join('')}</ol>`:`<div class="empty-state compact">${icon('clock')}<p>${detail?.queryError?'维护记录暂不可用':'暂无运行维护记录'}</p></div>`;
    if (lifecycle.innerHTML!==markup) lifecycle.innerHTML=markup;
  }
  async function controlRuntime(action,id) {
    if (!connected() || settingsPending() || service.busy || id!==currentInstanceId || !service.snapshot.configured) return;
    service.busy=true; service.epoch++; service.controlError=''; clearTimeout(service.pollTimer); updateRuntimeStatus();
    const poll=runtimeControlPoll={id,action,previousAttempt:runtimeOf(id)?.startup?.id,requestedAt:Date.now(),error:'',timer:null};
    updateRuntimeStatus(); scheduleRuntimeControlPoll(poll);
    try {
      let snapshot=await apiClient().api('/api/system/'+encodeURIComponent(id)+'/'+action,'POST',{revision:service.snapshot.revision,view:'topology'});
      runtimeControlPoll=null; clearTimeout(poll.timer); service.epoch++;
      if (snapshot.view==='topology') {
        snapshot=snapshot.revision===service.snapshot.revision ? {...service.snapshot,runtime:snapshot.runtime} : await apiClient().api('/api/system');
      }
      installSnapshot(snapshot); service.details.delete(id); await refreshDetail();
      const runtime=runtimeOf(id);
      const complete=action==='stop'?runtime?.phase==='stopped'&&!runtime?.cleanupPending:['ready','running'].includes(runtime?.phase)&&!runtime?.cleanupPending&&(!runtime?.startup||runtime.startup.state==='ready');
      announce(complete?{start:'实例已启动',stop:'实例已停止',restart:'实例已重启'}[action]:'实例状态：'+runtimeLabel(id));
    } catch (error) {
      service.controlError=error.message||'操作失败，请重试。';
      if (service.request) await service.request;
      await refreshService();
    } finally { runtimeControlPoll=null; clearTimeout(poll.timer); service.busy=false; updateRuntimeStatus(); schedulePoll(); document.dispatchEvent(new Event('jarvis:instance-updated')); }
  }
  function draftProblems(draft) {
    if (!draft || !Array.isArray(draft.nodes)) return ['此窗口草稿无法读取，原内容已保留。'];
    const allowed=new Set(['id','parent','kind','name','brainName','description','capabilities','concurrency','workerTools','workerSkills','roleModels','workspace','redelegate','model','engine']);
    const problems=[];
    if (draft.version!==1) problems.push('此窗口草稿版本暂不支持，原内容已保留。');
    const unknown=Object.keys(draft).filter(key=>!['version','nodes'].includes(key));
    if (unknown.length) problems.push(`草稿包含尚不支持的字段 ${unknown.join('、')}。`);
    for (const n of draft.nodes) {
      const label=n?.name||n?.id||'未命名节点';
      if (!n || !['root','instance'].includes(n.kind)) { problems.push(`${label}：不支持旧 Worker 组或未知节点类型。`); continue; }
      const unknown=Object.keys(n).filter(key=>!allowed.has(key));
      if (unknown.length) problems.push(`${label}：包含尚不支持的配置 ${unknown.join('、')}。`);
      if (n.kind==='instance' && !draft.nodes.some(parent => parent?.id === n.parent && ['root','instance'].includes(parent.kind))) problems.push(`${label}：上级组织不存在。`);
      if (!Number.isInteger(n.concurrency)||n.concurrency<1||n.concurrency>16) problems.push(`${label}：任务并发须为 1–16。`);
      if (!n.model || typeof n.model!=='object' || !n.model.provider || !n.model.model) problems.push(`${label}：需要明确的模型服务和模型。`);
      if (!Array.isArray(n.workerTools)||n.workerTools.some(tool=>!['read','glob','grep','read_image','write','edit','bash','pwsh','web_search','web_fetch'].includes(tool))) problems.push(`${label}：需要有效的 Worker 工具配置。`);
    }
    if (!draft.nodes.some(n=>n?.id===rootId()&&n.kind==='root'&&n.parent===null)) problems.push('草稿缺少有效的根实例。');
    if (hasParentCycle(draft.nodes)) problems.push('组织的上级关系形成循环。');
    return problems;
  }
  function renderDraftReview() {
    let draft; try { draft=JSON.parse(savedWindowDraft); } catch { /* keep unreadable contents untouched */ }
    const problems=draftProblems(draft);
    main.innerHTML=`${heading()}<div class="page-content"><section class="window-draft-review"><div class="section-title"><div><h2>核对此窗口草稿</h2><p>保存将替换系统的实例配置；原草稿继续保留在此窗口。</p></div>${button('返回系统配置','draft-close','','secondary')}</div>${problems.length?`<div class="field-error" role="alert">${problems.map(message=>`<p>${escape(message)}</p>`).join('')}<p>尚不支持的内容不会被自动删除或应用。</p></div>`:''}<div class="draft-node-list">${(Array.isArray(draft?.nodes)?draft.nodes:[]).map(n=>`<article><strong>${escape(n?.name)} · ${escape(n?.id)}</strong><pre>${escape(JSON.stringify(n,null,2))}</pre></article>`).join('')}</div><p id="draft-import-error" class="field-error" role="alert" hidden></p><button class="btn primary" type="button" data-action="draft-save"${problems.length||settingsPending()?' disabled':''}>保存草稿到系统</button></section></div>`;
  }
  async function saveWindowDraft() {
    if (!connected() || settingsPending() || service.busy) return;
    let draft; try { draft=JSON.parse(savedWindowDraft); } catch { return; }
    if (draftProblems(draft).length) return;
    service.busy=true; service.epoch++;
    try {
      const snapshot=await apiClient().api('/api/system','PUT',{revision:service.draftRevision,nodes:draft.nodes});
      installSnapshot(snapshot); currentView='overview'; render(); announce(savedConfigurationText());
    } catch (error) { const message=byId('draft-import-error'); if (message) { message.textContent=error.message; message.hidden=false; } else announce(error.message); }
    finally { service.busy=false; schedulePoll(); }
  }
  function draftFor(parent) {
    if (connected()) return {id:`unit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,parent,kind:'instance',name:'',brainName:'贾维斯',description:'',capabilities:'',concurrency:2,workspace:'',workerTools:structuredClone(service.snapshot.defaults.workerTools),model:structuredClone(service.snapshot.defaults.model),...(service.snapshot.defaults.engine?{engine:structuredClone(service.snapshot.defaults.engine)}:{})};
    return { id: `unit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`, parent, kind: 'instance', name: '', brainName:'贾维斯', description: '', capabilities: '', mode: 'local', concurrency: 2, model: 'follow', workspace: '', endpoint: '', credential: '', scope: '', recovery: true, autostart: false };
  }
  function openEditor(id, isNew = false, tab = 'basic', section = 'source') {
    if (service.busy || settingsPending()) return;
    if (connected() && !editor) state={version:1,nodes:structuredClone(service.snapshot.nodes)};
    if (!node(id) || node(id).kind === 'worker') return;
    if (editor?.dirty) {
      captureForm(); showLeaveRequest({ view: 'editor', id, isNew, tab }); return;
    }
    editorReturn = currentView === 'editor' ? editorReturn : currentView;
    editor = { isNew, value: structuredClone(isNew ? draftFor(id) : node(id)), dirty: false, revision:service.snapshot?.revision };
    if (!editor.value) return;
    editor.value.brainName = brainNameOf(editor.value);
    if (connected()) {
      // Old server snapshots have implicit roles; snapshot their effective values before editing any role.
      editor.value.roleModels ??= {};
      for (const role of ['router','worker']) editor.value.roleModels[role] ??= structuredClone(editor.value.model ?? {});
      if (!editor.value.engine && service.snapshot.defaults.engine) editor.value.engine=structuredClone(service.snapshot.defaults.engine);
    }
    editor.original=structuredClone(editor.value);
    selectEditorTab(tab,section); navigate('editor');
  }
  const field = (label, name, value, options = {}) => `<div class="field${options.wide?' full-width':''}"><label for="field-${name}">${label}${options.required?' <span class="required-dot">*</span>':''}</label>${options.multiline ? `<textarea id="field-${name}" name="${name}" rows="3" maxlength="${options.max||500}" placeholder="${escape(options.placeholder||'')}">${escape(value)}</textarea>` : `<input id="field-${name}" name="${name}" type="${options.type||'text'}" value="${escape(value)}" ${options.required?'required':''} ${options.readonly?'readonly':''} ${options.disabled?'disabled':''} ${options.list?`list="${escape(options.list)}"`:''} ${options.type==='number'?`min="${options.min??1}" max="${options.max??20}"`:`maxlength="${options.max||160}"`} placeholder="${escape(options.placeholder||'')}" autocomplete="off">`}${options.help?`<small>${options.help}</small>`:''}</div>`;
  const selectField = (label, name, value, values, help = '') => `<div class="field"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}">${values.map(([v,l])=>`<option value="${escape(v)}"${v===String(value)?' selected':''}>${escape(l)}</option>`).join('')}</select>${help?`<small>${help}</small>`:''}</div>`;
  const switchRow = (title, name, value, description) => `<label class="switch-row"><span><strong>${title}</strong><small>${description}</small></span><input type="checkbox" name="${name}" role="switch" aria-label="${title}"${value?' checked':''}></label>`;
  const section = (title, description, content) => `<section class="form-section">${title?`<div class="section-title"><div><h2>${title}</h2>${description?`<p>${description}</p>`:''}</div></div>`:''}${content}</section>`;
  const configFact = (label, value, help = '', key = '') => `<div class="config-fact"${key?` data-config="${key}"`:''}><div><strong>${label}</strong><p>${escape(value)}</p>${help?`<small>${help}</small>`:''}</div></div>`;
  function editorTabs() {
    if (organizationMode()) return [['basic','组织信息'],['brain','贾维斯'],['engine','任务引擎'],['connections','连接与资源'],['runtime','部署与运行']];
    return [['basic','组织与大脑'],['access','Worker 设置'],['runtime','部署与运行']];
  }
  function unmountEngine() {
    for (const picker of modelPickers.values()) picker.destroy();
    modelPickers.clear();
    engineMountEpoch++;
    engineMount?.controller?.unmount(); engineMount=null;
  }
  const engineDirty = () => !!engineMount?.controller?.isDirty();
  const engineBusy = () => !!engineMount?.controller?.isBusy();
  const engineLocation = () => ({group:engineTab,...engineQuery});
  function openEngineSession(sessionId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)) return Promise.reject(new Error('原生会话标识无效。'));
    const standalone=window.parent===window, requestId=standalone?'deep-link':'session-'+crypto.randomUUID();
    let destination=standalone?null:window.parent;
    return new Promise((resolve,reject)=>{
      const finish=error=>{clearTimeout(timer);window.removeEventListener('message',receive);error?reject(new Error(error)):resolve();};
      const receive=event=>{
        const value=event.data;
        if (event.origin!==location.origin || event.source!==destination || value?.type!=='jarvis:session:opened'
          || value.version!==1 || value.requestId!==requestId || value.sessionId!==sessionId || typeof value.ok!=='boolean') return;
        finish(value.ok?null:typeof value.error==='string'?value.error:'打开原生会话失败，请重试。');
      };
      const timer=setTimeout(()=>finish('宿主未确认打开原生会话，请重试。'),15000);
      window.addEventListener('message',receive);
      if(standalone){
        const url=new URL('/',location.origin);url.searchParams.set('jarvis-session',sessionId);
        destination=window.open(url.href,'_blank');
        if(!destination)finish('浏览器未允许打开原生会话窗口，请允许弹出窗口后重试。');
      } else destination.postMessage({type:'jarvis:session:open',version:1,requestId,sessionId},location.origin);
    });
  }
  function mountEngine(n, target) {
    const epoch=++engineMountEpoch, identity=n.id;
    engineMount={id:identity,target,controller:null};
    const load=window.superagentSettings?.mountSuperagentSettings
      ? Promise.resolve(window.superagentSettings) : import(apiClient().url('/organization.js'));
    load.then(module=>{
      if (epoch!==engineMountEpoch || !target.isConnected || editor?.value.id!==identity || editorTab!=='engine') return;
      engineMount.controller=module.mountSuperagentSettings(target,{instanceId:identity,csrf:apiClient().state.csrf,mountModelPicker:jarvisModels.mount,
        location:engineLocation(),openSession:openEngineSession,onNavigate:location=>{
          if (engineBusy() || editor?.value.id!==identity) return;
          const query=new URLSearchParams();
          for (const key of ['source','version']) if (location[key]!==undefined) query.set(key,location[key]);
          window.location.hash=`${organizationBase}/${encodeURIComponent(identity)}/engine/${location.group}${query.size?'?'+query:''}`;
        }});
    }).catch(error=>{
      if (epoch!==engineMountEpoch || !target.isConnected) return;
      target.innerHTML=`<div class="engine-load-failure" role="alert"><p>${escape(error.message || '完整任务引擎设置暂时无法读取。')}</p>${button('重新读取','engine-retry','','secondary')}</div>`;
    });
  }
  function renderEditor() {
    if (!editor) { navigate('overview'); return; }
    const n = editor.value, tabs = editorTabs(n); if (!tabs.some(([id])=>id===editorTab)) editorTab = 'basic';
    const title = editor.isNew ? '添加下级 SuperJarvis' : organizationMode() ? n.name+' · 设置' : '实例配置';
    const embedded=organizationMode() && editorTab==='engine' && !editor.isNew;
    const saveNote=!connected()?'尚未应用到运行环境':editor.isNew?'可在集团运行时添加下级，当前对话和任务继续运行。保存后下级尚未启动，请进入下级的运行状态，启动后即可接单。':organizationMode()?'组织信息可在运行时保存，页面名称立即更新；大脑名称和路由说明在下次启动后生效。修改模型须先停止当前组织，保存后下次启动生效。更换上级须等相关旧工单与会话收尾，新关系保存后立即生效。':'修改运行中的实例前，请先停止该实例';
    if (embedded && engineMount?.id===n.id && engineMount.target.isConnected) {
      engineMount.controller?.update(engineLocation()); return;
    }
    unmountEngine();
    const content=embedded?'<div class="editor-content superagent-engine-host" id="superagent-engine-host"><p role="status">正在读取完整任务引擎设置…</p></div>':`<form class="editor-content" id="unit-form" novalidate><div class="editor-form-body">${editorFields(n)}<p class="field-error" id="form-error" role="alert" hidden></p><div id="system-conflict-review" hidden></div></div><div class="form-footer"><div class="save-scope"><span id="draft-indicator">${editor.dirty?'有未保存的更改':connected()?(organizationMode()?'保存当前实例配置':'保存到系统'):'保存到此窗口'}</span><small>${saveNote}</small></div><div>${button('取消','cancel-edit','','secondary')}<button class="btn primary" type="submit">${icon('check')}<span>${editor.isNew?'保存并添加':'保存配置'}</span></button></div></div></form>`;
    main.innerHTML = `<div class="editor-header" data-current-instance="${escape(currentInstanceId)}"><div class="editor-context">${breadcrumb()}<h1 id="composition-title" tabindex="-1">${escape(title)}</h1></div><button class="back-link" type="button" data-action="cancel-edit">${icon('back')}<span>返回${{overview:'概览',children:'下级实例',workers:'普通 Worker',runtime:'运行状态'}[editorReturn]}</span></button></div><div class="editor-layout"><nav class="editor-nav" aria-label="配置分区">${tabs.map(([id,label])=>`<button type="button" class="${editorTab===id?'active':''}" data-action="editor-tab" data-id="${id}"${editorTab===id?' aria-current="page"':''}>${label}</button>`).join('')}</nav>${content}</div>`;
    if (embedded) mountEngine(n,byId('superagent-engine-host'));
    mountModelPickers();
    if (service.conflict) showConflictReview(service.conflict);
  }
  function editorFields(n) {
    if (editorTab === 'basic') {
      const candidates = state.nodes.filter(item=>item.kind!=='worker' && item.id!==n.id && !ancestry(item.id).some(a=>a.id===n.id));
      return section('','',`<div class="field-grid">${field('组织名称','name',n.name,{required:true,max:40,placeholder:'例如：研发',help:'例如研发中心，用于拓扑分组和组织层级。'})}${organizationMode()?'':field('大脑名称','brainName',n.brainName,{required:true,max:40,placeholder:'贾维斯',help:'组织内负责协调工作的助手，与组织名称独立。'})}${n.kind!=='root'&&(!connected()||!editor.isNew)?selectField('直属上级','parent',n.parent,candidates.map(item=>[item.id,ancestry(item.id).map(a=>a.name).join(' / ')]),'旧工单与会话结束后才能移动。工作区、权限身份、历史工单和成果保持；新派工按新归属校验。'):''}${field('职责','description',n.description,{wide:true,max:180,placeholder:'这个组织负责什么？'})}${field('能力标签','capabilities',n.capabilities,{wide:true,placeholder:'开发、测试、代码审查',help:n.kind==='root'?'描述本实例能力；标签不会自动启用工具或技能。':'供上级 Router 判断是否交给本实例；标签不会自动启用工具或技能。'})}</div><details class="identity-details"><summary>实例标识</summary><div class="field-grid">${field('实例 ID','instance-display',n.id,{readonly:true,help:'系统标识固定，修改名称不影响关联。'})}</div></details>`)+(connected()&&!organizationMode()?brainModelFields(n)+section('Router 模型','负责任务判断与分派，选择本地 Worker 或下级实例。',modelFields(n,'router')):'');
    }
    if (editorTab === 'brain') return section('贾维斯','负责接收上级交办，理解任务要求。',field('助手名称','brainName',n.brainName,{required:true,max:40}))+brainModelFields(n);
    if (editorTab === 'engine') return engineFields(n);
    if (editorTab === 'connections') return section('连接与资源','按任务需要接入外部资源。',configFact('本地任务','普通任务可以在本地处理与交付，无需配置 GitHub。')+configFact('外部连接','GitHub 和飞书连接在本组织的任务引擎来源设置中管理。','实际连接状态、账号检查和配置以来源页面读取的结果为准。')+`<a class="btn secondary" href="${organizationBase}/${encodeURIComponent(n.id)}/engine/source">管理本组织来源与连接</a>`);
    if (editorTab === 'router') return section('Router 模型','判断任务如何执行，根据职责与能力选择本地 Worker 或已配置的直属下级。',modelFields(n,'router'));
    if (editorTab === 'access') return executionFields(n);
    return deploymentFields(n);
  }
  function engineFields() {
    return section('完整任务引擎设置','', '<p>保存组织信息后，可以管理本组织的完整来源、评估、执行、提示词和部署配置。</p>');
  }
  function executionFields(n) {
    if (connected()) return section('Worker 模型','负责调用工具和技能完成任务；本实例的普通 Worker 共用此模型。',modelFields(n,'worker'))+workerCapabilityFields(n)+section('任务并发','',`<div class="field-grid">${field('同时执行的任务数','concurrency',n.concurrency,{type:'number',max:16,help:'达到上限后，其余任务排队等待。'})}</div>`);
    return section('','',`<div class="field-grid">${field('任务并发上限','concurrency',n.concurrency,{type:'number',max:20,help:'本实例普通 Worker 同时执行的任务总数上限；其余任务排队等待。'})}${configFact('模型来源','使用本实例的模型配置','模型参数在该实例的模型配置中管理。','model')}${field('资源范围说明','scope',n.scope,{wide:true,multiline:true,placeholder:'例如：只处理指定仓库，不修改部署环境',help:'记录工作边界；此说明不授予访问权限，实际权限仍由工具与运行环境控制。'})}</div>`);
  }
  function modelFields(n,role='brain') {
    const model=(role==='brain'?n.model:n.roleModels?.[role]??n.model)||{};
    const inputs=[['ModelProvider',model.provider],['ModelId',model.model],['ReasoningEffort',model.reasoningEffort]];
    return `<div class="instance-model-fields" data-model-role="${role}">${inputs.map(([suffix,value])=>`<input type="hidden" name="${role+suffix}" id="field-${role+suffix}" value="${escape(value||'')}">`).join('')}<div class="instance-model-catalog" id="${role}-model-catalog"></div></div>`;
  }
  function mountModelPickers() {
    if (!connected() || !editor) return;
    for (const role of ['brain','router','worker']) {
      const target=byId(role+'-model-catalog');if(!target)continue;
      const picker=jarvisModels.mount(target, {id:role+'-model',label:({brain:'贾维斯',router:'Router',worker:'Worker'})[role]+'模型',
        onSelect(next,descriptor) {
          const provider=byId('field-'+role+'ModelProvider'), model=byId('field-'+role+'ModelId'), effort=byId('field-'+role+'ReasoningEffort');
          provider.value=next.provider;model.value=next.model;
          if (!descriptor.reasoning?.efforts?.some(item=>item.id===effort.value)) effort.value='';
          model.dispatchEvent(new Event('change',{bubbles:true}));
        },
        onEffort(value) {
          const effort=byId('field-'+role+'ReasoningEffort');
          effort.value=value==='default'?'':value;
          effort.dispatchEvent(new Event('change',{bubbles:true}));
        },
        async onRefresh() {
          apiClient().state.models=await apiClient().api('/api/models/refresh','POST',{force:true});
          document.dispatchEvent(new Event('jarvis:catalog-updated'));
        },
      });
      const model=role==='brain'?editor.value.model:editor.value.roleModels?.[role];
      picker.update(apiClient().state.models,model);modelPickers.set(role,picker);
    }
  }
  function brainModelFields(n) {
    if (n.kind!=='root') return section('贾维斯模型','负责接收上级交办，理解任务要求。',modelFields(n));
    const model=apiClient()?.state?.model?.value??{}, groups=apiClient()?.state?.models?.groups??[];
    const provider=jarvisModels.providerName({groups},model.endpoint), descriptor=jarvisModels.find({groups},{provider:model.endpoint,model:model.model});
    const selected=model.model?[provider,descriptor?.name||model.model,model.reasoning&&model.reasoning!=='default'?model.reasoning:null].filter(Boolean).join(' · '):'尚未配置';
    return section('贾维斯模型','负责与你对话、理解目标和反馈进展。',configFact('当前模型',selected)+
      '<a class="btn secondary" href="#settings/model">设置贾维斯模型</a>');
  }
  function workerCapabilityFields(n) {
    const catalog=service.snapshot.catalogs?.[n.id]??service.snapshot.catalogs?.[rootId()];
    const toolRows=(catalog?.tools??[]).filter(tool=>tool.available||n.workerTools?.includes(tool.name));
    for(const name of n.workerTools??[])if(!toolRows.some(t=>t.name===name))toolRows.push({name,label:name,group:'已保存',available:false});
    const groups=[...new Set(toolRows.map(t=>t.group))];
    const options=groups.map(group=>`<fieldset class="worker-tool-options"><legend>${escape(group)}</legend>${toolRows.filter(t=>t.group===group).map(t=>`<label><input type="checkbox" name="workerTool" value="${escape(t.name)}"${n.workerTools?.includes(t.name)?' checked':''}><span>${escape(t.label)} <small>${escape(t.name)}${t.available?'':' · 已选工具当前不可用，可取消选择'}</small></span></label>`).join('')}</fieldset>`).join('');
    const skills=[...(catalog?.skills??[])];
    for(const name of n.workerSkills??[])if(!skills.some(s=>s.name===name))skills.push({name,description:'当前目录不可用；取消选择后可重新保存。'});
    const skillOptions=skills.length?`<div class="worker-skill-options">${skills.map(s=>`<label><input type="checkbox" name="workerSkill" value="${escape(s.name)}"${n.workerSkills?.includes(s.name)?' checked':''}><span><strong>${escape(s.name)}</strong><small>${escape(s.description)}</small></span></label>`).join('')}</div>`:`<p class="worker-setting-note">${catalog?.complete?'此工作目录没有可用技能。':'技能列表暂时无法读取，请重新连接后再试。'}</p>`;
    const emptyTools=!options?`<p class="worker-setting-note">${Array.isArray(catalog?.tools)&&!catalog.error?'当前没有可用工具。':'工具列表暂时无法读取，请重新连接后再试。'}</p>`:'';
    const commandNote=toolRows.some(tool=>tool.available&&['bash','pwsh'].includes(tool.name))?'<p class="worker-setting-note">命令以当前系统账户权限运行，单次最多运行 30 秒。勾选工具不等于授权任意操作。</p>':'';
    return section('可用工具','只启用任务需要的操作；下级执行时还受上级允许范围限制。',options+emptyTools+commandNote+(catalog?.error&&options?'<p role="status">工具列表暂时无法读取，请重新连接后再试。</p>':''))+section('启用技能','所选技能在执行前载入 Worker；技能不会自动开启工具。更改工作目录后，保存时会重新核对可用性。',skillOptions);
  }
  function syncModelChoices() {
    if (!connected() || !editor) return;
    captureForm();
    for(const [role,picker] of modelPickers)
      picker.update(apiClient().state.models,role==='brain'?editor.value.model:editor.value.roleModels?.[role]);
  }
  function deploymentFields(n) {
    if (connected() && organizationMode()) return section('部署与运行','启停操作和运行记录在当前组织的运行状态中管理。',configFact('实例状态',runtimeLabel(n.id))+(editor.isNew?'<p>保存组织后，可以管理任务引擎部署参数及工作空间。</p>':`<div class="runtime-link-row"><a class="btn secondary" href="${organizationBase}/${encodeURIComponent(n.id)}/engine/deployment">任务引擎部署参数</a><a class="btn secondary" href="${editorRoute(n.id,'workspace')}">工作空间与交付</a><button class="btn secondary" type="button" data-view="runtime" data-instance-id="${escape(n.id)}">${icon('activity')}<span>查看运行状态</span></button></div>`));
    if (connected()) return section('运行设置','',`<div class="config-facts">${configFact('实例状态',runtimeLabel(n.id))}</div><div class="field-grid">${field('工作目录（可选）','workspace',n.workspace,{wide:true,max:1024,placeholder:'无需填写，系统自动分配',help:'本组织执行任务时读取资料、生成文件的默认位置。无需手动设置，留空时由系统自动分配。<br>自定义目录须位于系统数据目录内；已有运行记录后不可更换。'})}</div>`)+(editor.isNew?'':`<div class="runtime-link-row"><span>启动、停止和重启在当前实例的运行状态中管理。</span><button class="btn secondary" type="button" data-view="runtime" data-instance-id="${escape(n.id)}">${icon('activity')}<span>查看运行状态</span></button></div>`);
    const modes = n.kind==='root' ? '' : section('部署方式','',`<div class="choice-grid">${[['local','monitor','创建本机实例','由当前计算机承载。'],['connect','link','连接已有实例','接入另一套 SuperJarvis。']].map(([mode,symbol,title,desc])=>`<button type="button" class="choice-card ${n.mode===mode?'selected':''}" data-action="mode" data-id="${mode}" aria-pressed="${n.mode===mode}">${icon(symbol)}<strong>${title}</strong><span>${desc}</span>${n.mode===mode?`<i>${icon('check')}</i>`:''}</button>`).join('')}</div>`);
    const runtimeLink = editor.isNew ? '' : `<div class="runtime-link-row"><span>维护操作与运行记录在运行状态中查看。</span><button class="btn secondary" type="button" data-view="runtime" data-instance-id="${escape(n.id)}">${icon('activity')}<span>查看运行状态</span></button></div>`;
    if (n.mode==='connect') return modes+section('连接信息','',`<div class="field-grid">${field('实例地址','endpoint',n.endpoint,{wide:true,placeholder:'https://superjarvis.example.com'})}${field('凭据引用','credential',n.credential,{wide:true,placeholder:'填写已保存的凭据名称',help:'仅填写凭据名称，不输入 Token 或密钥。'})}</div><div class="config-facts">${configFact('运行维护','由对方维护','版本、启动与恢复策略在目标实例中管理。')}${configFact('连接状态','尚未验证','保存地址不会立即建立连接。')}</div>`)+runtimeLink;
    return modes+section('运行位置','',`<div class="config-facts">${configFact('承载环境',n.kind==='root'?'当前 DSH 宿主':'当前计算机')}${configFact('运行版本','尚未获取')}</div><div class="field-grid">${field('数据目录','workspace',n.workspace,{wide:true,placeholder:'实例的独立数据目录',help:'用于保存此实例的会话、任务与配置；保存路径不会创建或搬迁文件。'})}</div>`)+section('启动与恢复策略','运行环境接入后才能应用。',`${switchRow('随系统启动','autostart',n.autostart,'计算机启动后自动启动此实例。')}${switchRow('异常退出后自动恢复','recovery',n.recovery,'人工停止后不拉起；恢复进程不等于重新执行任务。')}`)+runtimeLink;
  }
  function captureForm() {
    const form = byId('unit-form'); if (!editor || !form) return;
    if (connected()) {
      for (const role of ['brain','router','worker']) {
        // Each role retains its own model, including across editor sections.
        for (const [suffix,key] of [['ModelProvider','provider'],['ModelId','model'],['ReasoningEffort','reasoningEffort']]) {
          const input=form.elements.namedItem(role+suffix);if(!input)continue;
          const model=role==='brain'?(editor.value.model??={}):editor.value.roleModels[role];
          model[key]=input.value.trim();if(key==='reasoningEffort'&&!input.value)delete model[key];
        }
      }
      // The route can change before this form is replaced; capture only controls actually rendered here.
      if (form.querySelector('[name="workerTool"],[name="workerSkill"]')) {
        editor.value.workerTools=[...form.querySelectorAll('[name="workerTool"]:checked')].map(input=>input.value);
        editor.value.workerSkills=[...form.querySelectorAll('[name="workerSkill"]:checked')].map(input=>input.value);
      }
    }
    for (const input of form.elements) {
      if (!Object.hasOwn(editor.value,input.name) || ['id','kind'].includes(input.name)) continue;
      editor.value[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value===''?NaN:Number(input.value)) : input.value;
    }
  }
  function validate(n) {
    if (!n.name.trim()) return ['basic','请填写组织名称。','name'];
    if (n.name.trim().length>40) return ['basic','名称请控制在 40 个字符以内。','name'];
    if (!n.brainName.trim() || n.brainName.trim().length>40 || /[\u0000-\u001f\u007f]/.test(n.brainName)) return ['basic','请输入 1–40 个字符的大脑名称。','brainName'];
    if (n.kind!=='root' && (!node(n.parent) || node(n.parent).kind==='worker' || ancestry(n.parent).some(item=>item.id===n.id))) return ['basic','请选择有效的上级，不能形成循环委派。','parent'];
    if (state.nodes.some(item=>item.kind!=='worker' && item.id!==n.id && item.parent===n.parent && item.name.trim()===n.name.trim())) return ['basic','同一上级下已存在这个名称，请使用不同名称。','name'];
    if (connected()) {
      if (!Number.isInteger(n.concurrency)||n.concurrency<1||n.concurrency>16) return ['access','任务并发上限应为 1–16 的整数。','concurrency'];
      for(const role of ['brain','router','worker']) {
        const model=role==='brain'?n.model:n.roleModels?.[role];if(role!=='brain'&&!model)continue;
        const tab=role==='worker'?'access':organizationMode()?(role==='router'?'router':'brain'):'basic';
        if(!model?.provider?.trim())return [tab,'请选择模型服务。',role+'ModelProvider'];
        if(!model?.model?.trim())return [tab,'请填写模型。',role+'ModelId'];
      }
      if (n.workspace?.trim() && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+[\\/][^\\]+|\/)/.test(n.workspace.trim())) return [organizationMode()?'workspace':'runtime','工作目录须使用绝对路径，也可留空使用系统默认目录。','workspace'];
      return null;
    }
    if (!Number.isInteger(n.concurrency) || n.concurrency<1 || n.concurrency>20) return ['access','任务并发上限应为 1–20 的整数。','concurrency'];
    if (n.mode==='connect' && n.endpoint) {
      try { const url = new URL(n.endpoint); if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw 0; }
      catch { return ['runtime','请填写不含账号、密钥或查询参数的 HTTP(S) 实例地址。','endpoint']; }
    }
    if (/^(sk-|gh[pousr]_|github_pat_|Bearer\s)/i.test((n.credential || '').trim())) return ['runtime','这里填写凭据名称，请勿输入密钥。','credential'];
    return null;
  }
  function focusInvalidField(name) {
    const role=/^(brain|router|worker)(?:ModelProvider|ModelId)$/.exec(name)?.[1];
    const control=role ? modelPickers.get(role)?.trigger : byId('field-'+name);
    control?.setAttribute('aria-invalid','true'); control?.focus();
  }
  function saveEditor(event) {
    event.preventDefault(); if (!editor || service.busy || settingsPending()) return; captureForm(); const value=structuredClone(editor.value);
    // Organization relationships define routing; obsolete draft controls are no longer saved.
    delete value.redelegate; delete value.depth;
    if (connected()) { saveConnectedEditor(value); return; }
    if (value.mode!=='connect') { value.endpoint=''; value.credential=''; }
    value.endpoint=value.endpoint.trim(); value.credential=value.credential.trim();
    const error=validate(value);
    if (error) { selectEditorTab(error[0]); renderEditor(); const el=byId('form-error'); el.hidden=false; el.textContent=error[1]; focusInvalidField(error[2]); return; }
    value.name=value.name.trim(); const existing=state.nodes.findIndex(n=>n.id===value.id);
    value.brainName=value.brainName.trim();
    const previousNodes=state.nodes; state.nodes=[...state.nodes];
    if (existing<0) state.nodes.push(value); else state.nodes[existing]=value;
    if(!persist()) { state.nodes=previousNodes; editor.dirty=true; byId('draft-indicator').textContent='草稿尚未保存，请重试'; return; }
    editor=null; navigate(editorReturn); announce('配置草稿已保存');
  }
  function showEditorError(message) {
    const error=byId('form-error'); if (!error) return;
    error.textContent=message; error.hidden=false;
  }
  function showConflictReview(snapshot) {
    service.conflict=snapshot;
    const area=byId('system-conflict-review'); if (!area || !editor) return;
    const latest=snapshot.nodes.find(n=>n.id===editor.value.id), removed=!latest&&!editor.isNew;
    if (removed) showEditorError('此组织已在其他位置移除。当前草稿已保留，请返回组织架构核对。');
    area.hidden=false;
    area.innerHTML=`<div class="system-conflict-panel"><h2>配置已在其他位置更新</h2><p>当前编辑内容已保留。核对后采用最新系统版本，再保存当前实例；其他实例使用最新配置。</p><div class="configuration-comparison"><section><h3>系统中的当前配置</h3><pre>${escape(latest?JSON.stringify(latest,null,2):removed?'此实例已被移除，请返回系统重新选择。':'尚未添加此实例')}</pre></section><section><h3>当前编辑内容</h3><pre>${escape(JSON.stringify(editor.value,null,2))}</pre></section></div><button type="button" class="btn secondary" data-action="accept-latest"${removed?' disabled':''}>保留更改并采用最新版本</button></div>`;
  }
  async function saveConnectedEditor(value) {
    if (settingsPending()) return;
    const scoped=organizationMode() && !editor.isNew;
    const changes=scoped?organizationChanges(value,editor.original):null;
    if (scoped) {
      // The original settings APIs own executor, eval, prompts and Worker authorization. A metadata edit must not resave their stale mirrors.
      const base=state.nodes.find(item=>item.id===value.id);
      if (base) value={...structuredClone(base),...changes};
      delete value.redelegate; delete value.depth;
    }
    value=configurationNode(value);
    const error=validate(value);
    if (error) { selectEditorTab(error[0]); renderEditor(); showEditorError(error[1]); focusInvalidField(error[2]); return; }
    value.name=value.name.trim(); value.brainName=value.brainName.trim(); value.workspace=value.workspace.trim();
    const nodes=structuredClone(state.nodes).map(configurationNode), index=nodes.findIndex(n=>n.id===value.id);
    if (index<0) nodes.push(value); else nodes[index]=value;
    const form=byId('unit-form'), editing=editor; let committed=false;
    form.inert=true; service.busy=true; service.epoch++; clearTimeout(service.pollTimer);
    byId('draft-indicator').textContent='正在保存…';
    try {
      const input=scoped?{revision:editing.revision,update:{id:value.id,changes}}:{revision:editing.revision,nodes};
      let snapshot=await apiClient().api('/api/system','PUT',input);
      if (scoped) {
        const matches=actual=>actual?.available && Number.isSafeInteger(actual.revision) && actual.revision>=editing.revision+1
          && actual.nodes?.some(item=>item.id===value.id && Object.entries(changes).every(([key,next])=>sameField(key,item[key],next)));
        if (snapshot.revision!==editing.revision+1 || snapshot.saved?.instanceId!==value.id || snapshot.saved?.effect!==(Object.hasOwn(changes,'parent')?'immediate':'next-start')
          || !Array.isArray(snapshot.saved.fields) || JSON.stringify([...snapshot.saved.fields].sort())!==JSON.stringify(Object.keys(changes).sort())
          || !matches(snapshot)) throw new Error('暂时无法确认保存结果，请重新读取后核对。');
        committed=true;
        snapshot=await apiClient().api('/api/system?view=topology');
        if (!matches(snapshot)) throw new Error('保存后的组织配置已有变化，请重新读取后核对。');
        snapshot={...snapshot,view:'configuration'};
      }
      installSnapshot(snapshot); service.conflict=null;
      if (editor===editing) { editor=null; navigate(editorReturn); }
      announce(editing.isNew?'下级 SuperJarvis 已添加，尚未启动；进入下级的运行状态，启动后即可接单。':scoped
        ?Object.hasOwn(changes,'parent')?'组织上级已更新，新派工按新归属处理；原工作区、权限身份和历史保留。':Object.hasOwn(changes,'model')?'组织模型已保存，下次启动后生效。':'组织信息已保存，页面已更新；运行中的大脑与路由信息下次启动后生效。':savedConfigurationText());
    } catch (error) {
      if (editor!==editing) { announce(error.message||'配置保存失败，请重试。'); return; }
      const uncertain=scoped && (!error.status || error.status>=500);
      editor.dirty=true; byId('draft-indicator').textContent=committed?'已保存，回读待确认':uncertain?'保存结果待核对':'更改尚未保存';
      showEditorError(committed?'组织配置已保存，但未能回读确认。更改仍保留，请重新读取后核对。':error.message||'配置保存失败，请重试。');
      if (error.status===409) {
        try {
          const latest=await apiClient().api(scoped?'/api/system?view=topology':'/api/system');
          if (scoped) latest.view='configuration';
          if (latest.revision!==editing.revision) showConflictReview(latest);
          else { installSnapshot(latest,false); service.conflict=null; byId('system-conflict-review').hidden=true; updateRuntimeStatus(); }
        }
        catch { showEditorError('配置版本已变化，更改已保留。暂时无法读取最新配置，请稍后重试。'); }
      }
    } finally { form.inert=false; service.busy=false; schedulePoll(); }
  }
  function navigate(view) {
    if (organizationMode() && view!=='editor' && location.hash.startsWith(organizationBase)) {
      history.replaceState(null,'',organizationBase); lastRequestedRoute=organizationBase;
      document.dispatchEvent(new Event('jarvis:organization-navigation'));
    }
    currentView=view; render();
    byId('composition-title')?.focus();
  }
  function goTo(destination) {
    if (service.busy || engineBusy()) return;
    if (editor) {
      captureForm();
      if (editor.dirty || engineDirty()) { showLeaveRequest(destination); return; }
      editor=null; service.conflict=null;
    }
    if (destination.instanceId) {
      const next=node(destination.instanceId);
      if (!next || next.kind === 'worker') return;
      currentInstanceId=next.id;
    }
    search=''; navigate(destination.view);
  }
  page.addEventListener('click', event => {
    const target=event.target.closest('[data-action], [data-view]'); if(!target) return;
    if (target.disabled || service.busy || engineBusy()) return;
    if(target.dataset.view) { event.preventDefault(); goTo({view:target.dataset.view,instanceId:target.dataset.instanceId}); return; }
    const {action,id}=target.dataset;
    if (action==='org-tasks-next' || action==='org-tasks-first') {
      const p=taskPage(id), cursor=action==='org-tasks-first'?0:p.data?.nextCursor;
      if (!Number.isInteger(cursor)) return;
      p.cursor=cursor; p.data=null; p.error=false;
      paintTaskPage(target.closest('[data-task-organization]'));
      void refreshTopologyTasks(); return;
    }
    if (action==='system-retry') {
      if (connected()) { refreshService(); return; }
      if (editor) { announce('请先保存或取消当前草稿，再重新连接。'); return; }
      service.phase='idle'; render(); return;
    }
    if (action==='draft-review') { service.draftRevision=service.snapshot?.revision; goTo({view:'draft-review'}); return; }
    if (action==='draft-close') { goTo({view:'overview'}); return; }
    if (action==='draft-save') { saveWindowDraft(); return; }
    if (action==='accept-latest') {
      if (!editor || !service.conflict) return;
      captureForm(); const latest=service.conflict, changes=organizationMode()&&!editor.isNew?organizationChanges(editor.value,editor.original):null;
      if (!editor.isNew && !latest.nodes.some(item=>item.id===editor.value.id)) { showConflictReview(latest); return; }
      installSnapshot(latest,false); state={version:1,nodes:structuredClone(latest.nodes)};
      if (changes) {
        const base=structuredClone(state.nodes.find(item=>item.id===editor.value.id)); base.brainName=brainNameOf(base);
        editor.original=structuredClone(base); editor.value={...base,...changes};
      }
      editor.revision=latest.revision; editor.promptPreview=null; service.conflict=null; renderEditor(); announce('已采用最新系统版本，请确认后保存。'); return;
    }
    if (['runtime-start','runtime-stop','runtime-restart'].includes(action)) { controlRuntime(action.slice(8),id); return; }
    if (action==='engine-retry') { unmountEngine(); renderEditor(); return; }
    if (action === 'topology-config' || action === 'topology-worker-config') { requestEditor(id,action === 'topology-worker-config'?'access':organizationMode()?'brain':'basic'); return; }
    if (action.startsWith('topology-')) { updateTopology(action,id); return; }
    if(action==='enter-instance') goTo({view:'overview',instanceId:id});
    if(action==='edit') requestEditor(id);
    if(action==='runtime-config') requestEditor(id,'runtime');
    if(action==='add-instance') { if(state.nodes.filter(n=>n.kind!=='worker').length>=60) { announce(connected()?'系统实例已达容量上限。':'当前配置草稿已达容量上限。'); return; } openEditor(currentInstanceId,true); }
    if(action==='editor-tab') { if(organizationMode()&&!editor.isNew) { location.hash=editorRoute(editor.value.id,id); return; } captureForm(); selectEditorTab(id); renderEditor(); }
    if(action==='mode') { captureForm(); editor.value.mode=id; editor.dirty=true; renderEditor(); }
    if(action==='cancel-edit') goTo({view:editorReturn});
    if(action==='discard') {
      engineMount?.controller?.discard(); unmountEngine();
      const destination=pendingDestination || {view:editorReturn}; editor=null; pendingDestination=null; service.conflict=null;
      if(destination.view==='editor') openEditor(destination.id,destination.isNew,destination.tab); else goTo(destination);
    }
    if(action==='keep-editing') { pendingDestination=null; byId('leave-request')?.remove(); }
  });
  function showLeaveRequest(destination) {
    pendingDestination=typeof destination==='string'?{view:destination}:destination;
    byId('leave-request')?.remove();
    const strip=document.createElement('div'); strip.id='leave-request'; strip.className='review-strip'; strip.setAttribute('role','alert');
    strip.innerHTML=`<span>还有未保存的更改</span><div>${button('继续编辑','keep-editing','','secondary')}${button('放弃更改','discard','','danger')}</div>`; main.prepend(strip); strip.querySelector('button')?.focus();
  }
  page.addEventListener('input', event=> {
    if(event.target.id==='node-search') { search=event.target.value; renderRows(); }
    if(editor && event.target.closest('#unit-form')) {
      editor.dirty=true; byId('draft-indicator').textContent='有未保存的更改';
    }
  });
  page.addEventListener('change', event=> {
    if (!editor || !event.target.closest('#unit-form')) return;
    editor.dirty=true; byId('draft-indicator').textContent='有未保存的更改';
    if (connected() && /^(brain|router|worker)(ModelProvider|ModelId|ReasoningEffort)$/.test(event.target.name)) syncModelChoices();
  });
  page.addEventListener('submit', event=> { if(event.target.id==='unit-form') saveEditor(event); });
  window.addEventListener('beforeunload', event=> { if(editor?.dirty || engineDirty() || engineBusy()) { event.preventDefault(); event.returnValue=''; } });
  const visibilityChanged=() => { clearTimeout(service.pollTimer); if (visible()) { if (connected() && !service.busy) refreshService(); else if (service.phase==='idle') render(); } };
  document.addEventListener('visibilitychange',visibilityChanged);
  document.addEventListener('jarvis:catalog-updated',syncModelChoices);
  window.addEventListener('hashchange',visibilityChanged);
  const visibilityObserver=new MutationObserver(visibilityChanged);
  visibilityObserver.observe(page,{attributes:true,attributeFilter:['hidden']});
  const settingsPage=document.getElementById('settings-page');
  if (settingsPage) visibilityObserver.observe(settingsPage,{attributes:true,attributeFilter:['hidden']});
  if (containingFrame) visibilityObserver.observe(containingFrame,{attributes:true,attributeFilter:['hidden']});
  // The existing settings router owns the page URL and leaving-page guard.
  window.compositionUI = {
    isRoute: hash => hash === '#settings/system' || hash===organizationBase || /^#settings\/organization\/[^/]+\/(organization|jarvis|router|worker|engine|connections|runtime)(?:\/.*)?$/.test(hash),
    async loadContext() { if (!connected()) await refreshService(); return this.context(); },
    context() { return {id:rootId(),name:node(rootId())?.name||'集团中枢',brainName:apiClient()?.state?.basic?.value?.assistantName||'贾维斯'}; },
    canNavigate(hash) {
      if (!editor) return true;
      const prefix=organizationBase+'/'+encodeURIComponent(editor.value.id)+'/';
      if (!hash.startsWith(prefix)) return false;
      return !engineDirty() || /^(?:engine(?:\/|$)|router$|worker$)/.test(hash.slice(prefix.length));
    },
    isBusy: () => service.busy || engineBusy(),
    render(hash) {
      captureForm();
      if (organizationMode() && hash===organizationBase && hash!==lastRequestedRoute) { editor=null; requestedEditorRoute=null; currentInstanceId=rootId(); currentView='overview'; }
      lastRequestedRoute=hash;
      const [path,search='']=(hash||'').split('?'), query=new URLSearchParams(search);
      engineQuery={}; for (const key of ['source','version']) if (query.has(key)) engineQuery[key]=query.get(key);
      const match=organizationMode() && /^#settings\/organization\/([^/]+)\/(organization|jarvis|router|worker|engine|connections|runtime)(?:\/(source|eval|execution|prompts|deployment|sources|routing|worker|workspace))?$/.exec(path);
      if (match) { let id;try{id=decodeURIComponent(match[1]);}catch{id='';} requestedEditorRoute={id,tab:({organization:'basic',jarvis:'brain',router:'router',worker:'access',engine:'engine',connections:'connections',runtime:'runtime'})[match[2]],section:match[3]||'source'}; }
      render();
    },
    isDirty: () => !!editor?.dirty || engineDirty(),
    discard() { engineMount?.controller?.discard(); unmountEngine(); requestedEditorRoute=null; lastRequestedRoute=null; topologyObserver?.disconnect(); clearTimeout(service.pollTimer); editor=null; pendingDestination=null; service.conflict=null; currentInstanceId=rootId(); currentView='overview'; search=''; collapsedInstances.clear(); expandedPools.clear(); taskPages.clear(); topologyZoom=1; main.replaceChildren(); },
  };
})();
