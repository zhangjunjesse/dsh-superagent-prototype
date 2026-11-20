
(async () => {
  const byId = id => document.getElementById(id);
  const page = byId('settings-page');
  const conversation = byId('conversation-page');
  const form = byId('settings-form');
  const basicForm = byId('basic-form');
  const nameField = byId('setting-assistantName');
  const capabilitiesPage = byId('capabilities-page');
  const compositionPage = byId('composition-page');
  const compositionUI = window.compositionUI;
  const logsPage = byId('operation-logs-page');
  const logsUI = window.operationLogsUI;
  const promptsPage = byId('prompts-page');
  const promptsUI = window.jarvisPromptsUI;
  form.inert = true; basicForm.inert = true;
  // The authenticated DSH page can read its organization graph independently
  // of the workspace's slower model and conversation initialization.
  const organizationStartup = compositionUI && location.pathname.startsWith('/jarvis/');
  function renderStartupRoute() {
    if (!organizationStartup) return;
    let requested=location.hash;
    if (['#settings','#settings/system'].includes(requested)) requested='#settings/organization';
    else if (/^#settings\/(model|tools|skills)(?:\/.*)?$/.test(requested)) requested='#settings/organization/root/jarvis/'+requested.slice('#settings/'.length);
    const open=compositionUI.isRoute(requested);
    if (requested!==location.hash) history.replaceState(null,'',requested);
    page.hidden=!open; conversation.hidden=open;
    basicForm.hidden=true; form.hidden=true; capabilitiesPage.hidden=true;
    compositionPage.hidden=!open;
    if (logsPage) logsPage.hidden=true;
    if (promptsPage) promptsPage.hidden=true;
    if (open) {
      page.classList.add('organization-settings'); page.querySelector('.settings-rail').hidden=true;
      page.setAttribute('aria-labelledby','composition-title');
      compositionUI.render(requested);
      document.title='组织架构管理 · '+assistantIdentity.name;
    }
  }
  const startupOpen = () => { if (organizationStartup) location.hash='#settings/organization'; };
  const startupBack = () => { if (organizationStartup) location.hash=''; };
  window.addEventListener('hashchange',renderStartupRoute);
  byId('settings-open').addEventListener('click',startupOpen);
  byId('settings-back').addEventListener('click',startupBack);
  renderStartupRoute();
  try { await jarvis.ready; } catch { return; }
  window.removeEventListener('hashchange',renderStartupRoute);
  byId('settings-open').removeEventListener('click',startupOpen);
  byId('settings-back').removeEventListener('click',startupBack);
  form.inert = false; basicForm.inert = false;
  const dsh = jarvis.state.runtime === 'dsh';
  let catalogPicker;
  if (dsh) {
    for (const id of ['setting-protocol', 'setting-key', 'setting-sampling', 'setting-topP', 'setting-retries']) byId(id).closest('label').hidden = true;
    const endpoint = byId('setting-endpoint');
    endpoint.type = 'hidden';
    endpoint.closest('.model-section').hidden = true;
    const reasoning = byId('setting-reasoning');
    reasoning.closest('label').hidden = true;
    const storedEffort = document.createElement('input'); storedEffort.id = reasoning.id; storedEffort.type = 'hidden';
    reasoning.replaceWith(storedEffort);
    const model = byId('setting-model'); model.closest('label').hidden = true;
    const catalog = document.createElement('div'); catalog.id = 'settings-model-catalog'; catalog.className = 'model-field wide';
    model.closest('.model-fields').prepend(catalog);
    byId('setting-timeout').closest('label').querySelector('span').textContent = '回复时限 · 秒';
    byId('settings-tab-connection').textContent = '模型选择';
    byId('settings-connection').querySelector('h2').textContent = '模型服务';
  }
  const organization = dsh && !!compositionUI;
  const organizationBase = '#settings/organization';
  const rootRoleBase = organizationBase+'/root/jarvis/';
  const rootRole = hash => organization && (promptsUI?.isRoute(hash) ? 'prompts' : /^#settings\/organization\/root\/jarvis\/(basic|model|tools|skills)(?:\/[^/]+)?$/.exec(hash)?.[1]);
  const canonicalRoute = hash => !organization ? hash : hash==='#settings'||hash==='#settings/system' ? organizationBase :
    hash===organizationBase+'/root/jarvis' ? rootRoleBase+'model' :
    /^#settings\/(model|tools|skills)(?:\/.*)?$/.test(hash) ? rootRoleBase+hash.slice('#settings/'.length) : hash;
  const roleHeader = document.createElement('section'); roleHeader.id='organization-role-header'; roleHeader.hidden=true;
  if (organization) {
    page.classList.add('organization-settings');
    page.querySelector('.settings-rail').hidden=true;
    page.querySelector('.settings-frame').prepend(roleHeader);
    const home=document.createElement('a'); home.href=organizationBase; home.textContent='组织架构管理'; home.id='organization-home';
    home.addEventListener('click',event=>{
      if(location.hash!==organizationBase)return;
      event.preventDefault(); if(compositionUI.isBusy())return;
      if(compositionUI.isDirty()) {
        pendingRoute=organizationBase; byId('settings-unsaved').hidden=false;
        byId('settings-discard').textContent='放弃修改并继续'; byId('settings-stay').focus();
      } else { compositionUI.discard(); compositionUI.render(organizationBase); }
    });
    page.querySelector('.settings-breadcrumb > span:last-child').replaceWith(home);
    byId('basic-title').textContent='身份'; byId('settings-title').textContent='模型';
    basicForm.querySelector('.settings-eyebrow').textContent='贾维斯';
    form.querySelector('.settings-eyebrow').textContent='贾维斯';
    byId('settings-save').textContent='保存贾维斯模型'; byId('basic-save').textContent='保存贾维斯身份';
    form.querySelector('.model-tabs').hidden=true;
  }
  const htmlText = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function renderRoleHeader() {
    if (!organization || roleHeader.hidden) return;
    const context=compositionUI.context(), category=rootRole(location.hash);
    const sections=[['organization','组织信息'],['jarvis/model','贾维斯'],['engine/sources','任务引擎'],['connections','连接与资源'],['runtime','部署与运行']];
    const tabs=[['basic','身份'],['model','模型'],['tools','工具'],['skills','技能']];
    if(jarvis.state.promptManagement===true&&promptsUI)tabs.push(['prompts','提示词']);
    roleHeader.innerHTML='<div class="organization-context"><a href="'+organizationBase+'">'+htmlText(context.name)+'</a><span> / </span><strong>'+htmlText(context.brainName)+'</strong></div><p class="organization-purpose">与你对话、理解目标和反馈进展；这里的设置只属于当前组织的贾维斯。</p><nav class="organization-sections" aria-label="实例配置分区">'+sections.map(([path,label])=>'<a href="'+organizationBase+'/root/'+path+'"'+(path.startsWith('jarvis')?' aria-current="page"':'')+'>'+label+'</a>').join('')+'</nav><nav class="organization-role-tabs" aria-label="贾维斯设置">'+tabs.map(([id,label])=>'<a href="'+rootRoleBase+id+'"'+(id===category?' aria-current="page"':'')+'>'+label+'</a>').join('')+'</nav>';
  }
  document.addEventListener('jarvis:organization-updated',renderRoleHeader);
  document.addEventListener('jarvis:organization-navigation',()=>{ currentRoute=location.hash; });
  let saving = false;
  let keyRemoved = false;
  const names = dsh ? ['endpoint', 'model', 'temperature', 'maxTokens', 'reasoning', 'timeout', 'stream'] : [ 'protocol', 'endpoint', 'model', 'sampling', 'temperature', 'topP', 'maxTokens', 'reasoning', 'timeout', 'retries', 'stream'];
  const fields = Object.fromEntries(names.map(name => [name, byId(`setting-${name}`)]));
  if (dsh) catalogPicker = jarvisModels.mount(byId('settings-model-catalog'), {
    id: 'setting-model', label: '贾维斯模型',
    onSelect(next, descriptor) {
      const reasoning = descriptor.reasoning?.efforts?.some(item => item.id === fields.reasoning.value) ? fields.reasoning.value : 'default';
      updateDshChoices(next.provider, next.model, reasoning); changed();
    },
    onEffort(reasoning) {
      updateDshChoices(fields.endpoint.value, fields.model.value, reasoning); changed();
    },
    async onRefresh() {
      jarvis.state.models = await jarvis.api('/api/models/refresh', 'POST', { force: true });
      document.dispatchEvent(new Event('jarvis:catalog-updated'));
    },
  });
  const key = byId('setting-key');
  const tabs = [...form.querySelectorAll('[role="tab"]')];
  const defaults = { protocol: 'chat-completions', endpoint: '', model: '', sampling: 'default', temperature: '', topP: '', maxTokens: '', reasoning: 'default', timeout: '120', retries: '2', stream: true };
  let saved = { ...jarvis.state.model.value };
  let modelRevision = jarvis.state.model.revision;
  let currentRoute = location.hash, pendingRoute = '';
  let organizationReturnRoute = organizationBase;

  function selectTab(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      byId(tab.getAttribute('aria-controls')).hidden = organization ? false : i !== index;
    });
    byId('settings-scroll').scrollTop = 0;
    if (focus) tabs[index].focus();
  }
  function readDraft() {
    return Object.fromEntries(names.map(name => [name, fields[name].type === 'checkbox' ? fields[name].checked : fields[name].value.trim()]));
  }
  function isModelDirty() { const draft=readDraft(); return names.some(name=>draft[name]!==saved[name]) || key.value !== '' || keyRemoved; }
  function isNameDirty() { return nameField.value.trim() !== assistantIdentity.name; }
  function isDirty() { return isModelDirty() || isNameDirty() || capabilitiesUI.isDirty() || compositionUI?.isDirty() || promptsUI?.isDirty(); }
  const isSettingsRoute = hash => ['#settings', '#settings/model'].includes(hash) || capabilitiesUI.isRoute(hash) || compositionUI?.isRoute(hash) || promptsUI?.isRoute(hash);
  function setFeedback(message, error = false) {
    const feedback = byId('settings-feedback');
    feedback.textContent = message;
    feedback.classList.toggle('error', error);
  }
  function syncInputs() {
    fields.temperature.disabled = !dsh && fields.sampling.value !== 'temperature';
    if (!dsh) fields.topP.disabled = fields.sampling.value !== 'topP';
    byId('settings-save').disabled = !isModelDirty();
  }
  function hideKey() {
    key.type = 'password';
    byId('settings-key-toggle').textContent = '显示';
    byId('settings-key-toggle').setAttribute('aria-pressed', 'false');
    byId('settings-key-toggle').setAttribute('aria-label', '显示 API Key');
  }
  function loadSaved() {
    saved = { ...jarvis.state.model.value };
    modelRevision = jarvis.state.model.revision;
    if (dsh) updateDshChoices(saved.endpoint, saved.model, saved.reasoning);
    names.forEach(name => {
      if (fields[name].type === 'checkbox') fields[name].checked = saved[name];
      else fields[name].value = saved[name];
      fields[name].removeAttribute('aria-invalid');
    });
    key.value = '';
    keyRemoved = false;
    key.placeholder = jarvis.state.model.hasKey ? '已保存，留空不修改' : '输入 API Key';
    byId('connection-status').textContent = saved.endpoint && saved.model ? '已配置 · 待连接' : '未配置';
    hideKey();
    byId('settings-unsaved').hidden = true;
    setFeedback('无未保存的修改');
    syncInputs();
  }
  function renderRoute() {
    const wasOpen = !page.hidden, wasCompositionOpen = !!compositionPage && !compositionPage.hidden;
    const requested = canonicalRoute(location.hash);
    if (requested!==location.hash) history.replaceState(null,'',requested);
    const role=rootRole(requested), open=isSettingsRoute(requested);
    const logsOpen=!!logsUI?.isRoute(requested);
    const modelPage=role==='model'||requested==='#settings/model';
    const capabilityPage=['tools','skills'].includes(role)||capabilitiesUI.isRoute(requested);
    const promptPage=!!promptsUI?.isRoute(requested);
    const systemPage=compositionUI?.isRoute(requested)&&!role&&!promptPage;
    if (wasOpen && requested!==currentRoute && (saving || compositionUI?.isBusy() || capabilitiesUI.isBusy?.() || promptsUI?.isBusy())) {
      history.replaceState(null,'',currentRoute); return;
    }
    const leavingRootRole=organization&&rootRole(currentRoute)&&requested!==currentRoute&&(isModelDirty()||isNameDirty());
    const leavingInstance=wasCompositionOpen&&compositionUI?.isDirty()&&(!systemPage||(organization&&!compositionUI.canNavigate(requested)));
    const leavingPrompts=promptsPage&&!promptsPage.hidden&&promptsUI?.isDirty()&&requested!==currentRoute;
    if ((!open&&wasOpen&&isDirty()) || (!capabilitiesPage.hidden&&capabilitiesUI.isDirty()&&requested!==capabilitiesPage.dataset.route) || leavingInstance || leavingRootRole || leavingPrompts) {
      pendingRoute=requested;
      history.replaceState(null,'',currentRoute);
      byId('settings-unsaved').hidden=false;
      byId('settings-discard').textContent=open?'放弃修改并继续':'放弃修改并返回';
      byId('settings-stay').focus(); return;
    }
    if (open && !wasOpen) { loadSaved(); loadBasic(); selectTab(0); }
    if (!modelPage && catalogPicker?.isOpen) catalogPicker.close(false);
    if (open && organization) organizationReturnRoute=requested;
    currentRoute=requested; byId('settings-unsaved').hidden=true;
    page.hidden=!open; conversation.hidden=open||logsOpen;
    if(logsPage)logsPage.hidden=!logsOpen;
    basicForm.hidden=organization ? role!=='basic' : modelPage||capabilityPage||systemPage||promptPage;
    form.hidden=!modelPage; capabilitiesPage.hidden=!capabilityPage;
    if(compositionPage)compositionPage.hidden=!systemPage;
    if(promptsPage)promptsPage.hidden=!promptPage;
    roleHeader.hidden=!role;
    if(role){renderRoleHeader();compositionUI.loadContext().then(renderRoleHeader).catch(()=>{});}
    if(capabilityPage)capabilitiesUI.render(requested);else if(!logsOpen)capabilitiesUI.discard();
    if(systemPage)compositionUI.render(requested);else if(wasCompositionOpen&&!logsOpen)compositionUI?.discard();
    if(logsOpen)logsUI.enter(organizationReturnRoute);else logsUI?.leave();
    if(promptPage)promptsUI.render();else promptsUI?.leave();
    const group=capabilityPage?requested.split('/')[1]:systemPage?'system':modelPage?'model':'basic';
    for(const section of ['basic','model','tools','skills','system'])byId('settings-nav-'+section)?.removeAttribute('aria-current');
    byId('settings-nav-'+group)?.setAttribute('aria-current','page');
    const titleId=promptPage?'prompts-title':capabilityPage?'capabilities-title':systemPage?'composition-title':modelPage?'settings-title':'basic-title';
    page.setAttribute('aria-labelledby',titleId);
    document.title=(logsOpen?'运行日志 · ':open?(organization?'组织架构管理':systemPage?'系统管理':byId(titleId).textContent)+' · ':'')+assistantIdentity.name;
    if(open)byId(titleId)?.focus();else {key.value='';hideKey();if(logsOpen)byId('operation-logs-title')?.focus();else if(wasOpen)byId('settings-open').focus();}
  }
  function validate(draft) {
    if (!draft.endpoint) return ['endpoint', dsh ? '请选择模型来源和模型' : '请输入服务地址', 0];
    if (!dsh) try {
      const url = new URL(draft.endpoint);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return ['endpoint', '服务地址须为 HTTP(S) 地址，且不包含凭据、查询参数或片段', 0];
    } catch { return ['endpoint', '请输入有效的服务地址', 0]; }
    if (!draft.model) return ['model', dsh ? '请选择模型' : '请输入模型标识', 0];
    const rules = [
      ['temperature', 0, 2, false, 1, dsh ? draft.temperature !== '' : draft.sampling === 'temperature'],
      ['topP', Number.MIN_VALUE, 1, false, 1, !dsh && draft.sampling === 'topP'],
      ['maxTokens', 1, Number.MAX_SAFE_INTEGER, true, 1, draft.maxTokens !== '' || fields.maxTokens.validity?.badInput],
      ['timeout', 1, 3600, true, 2, true],
      ['retries', 0, 5, true, 2, !dsh],
    ];
    for (const [name, min, max, integer, tab, enabled] of rules) {
      if (!enabled) continue;
      const value = Number(draft[name]);
      if (draft[name] === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
        const range = name === 'maxTokens' ? '正整数' : `${min}–${max}${integer ? ' 之间的整数' : ''}`;
        return [name, `请输入${range}`, tab];
      }
    }
    return null;
  }
  function changed() {
    names.forEach(name => fields[name].removeAttribute('aria-invalid'));
    syncInputs();
    setFeedback(isModelDirty() ? '有未保存的修改' : '无未保存的修改');
  }
  function updateDshChoices(provider, model, reasoning) {
    fields.endpoint.value = provider;
    fields.model.value = model;
    fields.reasoning.value = reasoning;
    catalogPicker.update(jarvis.state.models, { provider, model, reasoningEffort: reasoning });
  }
  if (dsh) {
    fields.endpoint.addEventListener('change', () => { fields.model.value = ''; updateDshChoices(fields.endpoint.value, '', 'default'); changed(); });
    fields.model.addEventListener('input', () => { updateDshChoices(fields.endpoint.value, fields.model.value, 'default'); changed(); });
  }
  document.addEventListener('jarvis:model-updated', () => {
    if (modelRevision === jarvis.state.model.revision) return;
    if (!isModelDirty()) { saved = { ...jarvis.state.model.value }; loadSaved(); }
    else setFeedback('模型配置已在其他位置更新；当前草稿已保留，返回对话后重新打开设置可加载最新配置', true);
  });
  document.addEventListener('jarvis:catalog-updated', () => {
    if (dsh) updateDshChoices(fields.endpoint.value, fields.model.value, fields.reasoning.value);
  });
  function basicFeedback(message, error = false) {
    byId('basic-feedback').textContent = message;
    byId('basic-feedback').classList.toggle('error', error);
  }
  function loadBasic() {
    nameField.value = assistantIdentity.name;
    nameField.removeAttribute('aria-invalid');
    byId('basic-save').disabled = true;
    basicFeedback('无未保存的修改');
  }
  basicForm.addEventListener('input', () => {
    nameField.removeAttribute('aria-invalid');
    byId('basic-save').disabled = !isNameDirty();
    basicFeedback(isNameDirty() ? '有未保存的修改' : '无未保存的修改');
  });
  basicForm.addEventListener('submit', async event => {
    event.preventDefault();
    const name = nameField.value.trim();
    if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
      nameField.setAttribute('aria-invalid', 'true');
      nameField.focus(); basicFeedback('请输入 1–40 个字符的助手名称', true); return;
    }
    basicForm.inert = true; saving=true;
    basicFeedback('正在保存…');
    try {
      jarvis.state.basic = await jarvis.api('/api/basic', 'PUT', { revision: jarvis.state.basic.revision, value: { assistantName: name } });
      applyAssistantName(jarvis.state.basic.value.assistantName);
      loadBasic(); renderRoleHeader();
      basicFeedback('设置已保存');
      if (!isDirty()) byId('settings-unsaved').hidden = true;
    } catch (error) { basicFeedback(error.message, true); }
    finally { basicForm.inert = false; saving=false; }
  });
  byId('settings-open').addEventListener('click', () => { location.hash = organization?organizationBase:'settings'; });
  byId('settings-back').addEventListener('click', () => {
    if(promptsUI?.isBusy())return;
    if (isDirty()) { pendingRoute = ''; byId('settings-discard').textContent = '放弃修改并返回'; byId('settings-unsaved').hidden = false; byId('settings-stay').focus(); }
    else location.hash = '';
  });
  byId('settings-stay').addEventListener('click', () => { byId('settings-unsaved').hidden = true; byId(page.getAttribute('aria-labelledby')).focus(); });
  byId('settings-discard').addEventListener('click', () => {
    if(promptsUI?.isBusy())return;
    capabilitiesUI.discard();
    compositionUI?.discard();
    promptsUI?.discard();
    if (organization || !isSettingsRoute(pendingRoute)) { loadSaved(); loadBasic(); }
    byId('settings-unsaved').hidden = true;
    if(location.hash===pendingRoute)renderRoute();else location.hash = pendingRoute;
  });
  byId('settings-key-remove').addEventListener('click', () => { key.value = ''; keyRemoved = true; key.placeholder = '保存后移除密钥'; changed(); });
  byId('settings-key-toggle').addEventListener('click', () => {
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    byId('settings-key-toggle').textContent = show ? '隐藏' : '显示';
    byId('settings-key-toggle').setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key');
    byId('settings-key-toggle').setAttribute('aria-pressed', String(show));
  });
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(i));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); selectTab(next, true); }
    });
  });
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  byId('settings-reset').addEventListener('click', () => {
    for (const name of names.filter(name => !['protocol', 'endpoint', 'model'].includes(name))) {
      if (fields[name].type === 'checkbox') fields[name].checked = defaults[name];
      else fields[name].value = defaults[name];
    }
    if (dsh) updateDshChoices(fields.endpoint.value, fields.model.value, fields.reasoning.value);
    changed();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = readDraft();
    const error = validate(draft);
    if (error) {
      const [name, message, tab] = error;
      selectTab(tab); fields[name].setAttribute('aria-invalid', 'true');
      if (dsh && ['endpoint', 'model'].includes(name)) catalogPicker.focus(); else fields[name].focus();
      setFeedback(message, true); return;
    }
    form.inert = true; saving=true;
    setFeedback('正在保存…');
    try {
      const input = { revision: modelRevision, value: draft };
      if (key.value.trim() || keyRemoved) input.apiKey = key.value.trim();
      jarvis.state.model = await jarvis.api('/api/model', 'PUT', input);
      saved = { ...jarvis.state.model.value };
      loadSaved();
      document.dispatchEvent(new Event('jarvis:model-updated'));
      setFeedback('配置已保存');
    } catch (error) { setFeedback(error.message, true); }
    finally { form.inert = false; saving=false; }

  });
  window.addEventListener('hashchange', renderRoute);
  window.addEventListener('beforeunload', event => { if (organization && (isDirty() || saving || capabilitiesUI.isBusy?.() || promptsUI?.isBusy())) { event.preventDefault(); event.returnValue=''; } });
  applyAssistantName(jarvis.state.basic.value.assistantName);
  loadSaved();
  loadBasic();
  if (organizationStartup) selectTab(0);
  renderRoute();
})();
