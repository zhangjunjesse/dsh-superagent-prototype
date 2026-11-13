
(async () => {
  const byId = id => document.getElementById(id);
  const page = byId('settings-page');
  const conversation = byId('conversation-page');
  const form = byId('settings-form');
  const basicForm = byId('basic-form');
  const nameField = byId('setting-assistantName');
  const capabilitiesPage = byId('capabilities-page');
  form.inert = true; basicForm.inert = true;
  try { await jarvis.ready; } catch { return; }
  form.inert = false; basicForm.inert = false;
  const dsh = jarvis.state.runtime === 'dsh';
  if (dsh) {
    for (const id of ['setting-protocol', 'setting-key', 'setting-sampling', 'setting-topP', 'setting-retries']) byId(id).closest('label').hidden = true;
    const endpoint = byId('setting-endpoint');
    endpoint.closest('label').querySelector('span').textContent = '模型服务';
    const select = document.createElement('select'); select.id = endpoint.id;
    select.add(new Option('选择模型服务', ''));
    for (const group of jarvis.state.models.groups) select.add(new Option(group.name, group.id));
    endpoint.replaceWith(select);
    byId('setting-model').setAttribute('list', 'dsh-model-list');
    const list = document.createElement('datalist'); list.id = 'dsh-model-list'; form.append(list);
    byId('setting-timeout').closest('label').querySelector('span').textContent = '回复时限 · 秒';
    byId('settings-tab-connection').textContent = '模型选择';
    byId('settings-connection').querySelector('h2').textContent = '模型服务';
  }
  let keyRemoved = false;
  const names = dsh ? ['endpoint', 'model', 'temperature', 'maxTokens', 'reasoning', 'timeout', 'stream'] : [ 'protocol', 'endpoint', 'model', 'sampling', 'temperature', 'topP', 'maxTokens', 'reasoning', 'timeout', 'retries', 'stream'];
  const fields = Object.fromEntries(names.map(name => [name, byId(`setting-${name}`)]));
  const key = byId('setting-key');
  const tabs = [...page.querySelectorAll('[role="tab"]')];
  const defaults = { protocol: 'chat-completions', endpoint: '', model: '', sampling: 'default', temperature: '', topP: '', maxTokens: '', reasoning: 'default', timeout: '120', retries: '2', stream: true };
  let saved = { ...jarvis.state.model.value };
  let modelRevision = jarvis.state.model.revision;
  let currentRoute = location.hash, pendingRoute = '';

  function selectTab(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      byId(tab.getAttribute('aria-controls')).hidden = i !== index;
    });
    byId('settings-scroll').scrollTop = 0;
    if (focus) tabs[index].focus();
  }
  function readDraft() {
    return Object.fromEntries(names.map(name => [name, fields[name].type === 'checkbox' ? fields[name].checked : fields[name].value.trim()]));
  }
  function isModelDirty() { return JSON.stringify(readDraft()) !== JSON.stringify(saved) || key.value !== '' || keyRemoved; }
  function isNameDirty() { return nameField.value.trim() !== assistantIdentity.name; }
  function isDirty() { return isModelDirty() || isNameDirty() || capabilitiesUI.isDirty(); }
  const isSettingsRoute = hash => ['#settings', '#settings/model'].includes(hash) || capabilitiesUI.isRoute(hash);
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
    const wasOpen = !page.hidden;
    const requested = location.hash;
    const open = isSettingsRoute(requested);
    const modelPage = requested === '#settings/model';
    const capabilityPage = capabilitiesUI.isRoute(requested);
    if ((!open && !page.hidden && isDirty()) || (!capabilitiesPage.hidden && capabilitiesUI.isDirty() && requested !== capabilitiesPage.dataset.route)) {
      pendingRoute = requested;
      history.replaceState(null, '', capabilitiesPage.hidden ? currentRoute : capabilitiesPage.dataset.route);
      byId('settings-unsaved').hidden = false;
      byId('settings-discard').textContent = open ? '放弃修改并继续' : '放弃修改并返回';
      byId('settings-stay').focus();
      return;
    }
    if (open && page.hidden) { loadSaved(); loadBasic(); selectTab(0); }
    currentRoute = requested;
    byId('settings-unsaved').hidden = true;
    page.hidden = !open;
    conversation.hidden = open;
    basicForm.hidden = modelPage || capabilityPage;
    form.hidden = !modelPage;
    capabilitiesPage.hidden = !capabilityPage;
    if (capabilityPage) capabilitiesUI.render(requested);
    else capabilitiesUI.discard();
    const group = capabilityPage ? requested.split('/')[1] : modelPage ? 'model' : 'basic';
    for (const section of ['basic', 'model', 'tools', 'skills']) byId('settings-nav-' + section).removeAttribute('aria-current');
    byId('settings-nav-' + group).setAttribute('aria-current', 'page');
    const titleId = capabilityPage ? 'capabilities-title' : modelPage ? 'settings-title' : 'basic-title';
    page.setAttribute('aria-labelledby', titleId);
    document.title = (open ? byId(titleId).textContent + ' · ' : '') + assistantIdentity.name;
    if (open) byId(titleId).focus();
    else { key.value = ''; hideKey(); if (wasOpen) byId('settings-open').focus(); }
  }
  function validate(draft) {
    if (!draft.endpoint) return ['endpoint', '请输入服务地址', 0];
    if (!dsh) try {
      const url = new URL(draft.endpoint);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return ['endpoint', '服务地址须为 HTTP(S) 地址，且不包含凭据、查询参数或片段', 0];
    } catch { return ['endpoint', '请输入有效的服务地址', 0]; }
    if (!draft.model) return ['model', '请输入模型标识', 0];
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
    const group = jarvis.state.models.groups.find(item => item.id === provider);
    byId('dsh-model-list').replaceChildren(...(group?.models || []).map(item => new Option(item.name, item.id)));
    const efforts = group?.models.find(item => item.id === model)?.reasoning?.efforts || [];
    fields.reasoning.replaceChildren(new Option('跟随模型默认', 'default'), ...efforts.map(item => new Option(item.name, item.id)));
    if (reasoning !== 'default' && !efforts.some(item => item.id === reasoning)) fields.reasoning.add(new Option(reasoning + ' · 当前配置', reasoning));
    fields.reasoning.value = reasoning;
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
    basicForm.inert = true;
    basicFeedback('正在保存…');
    try {
      jarvis.state.basic = await jarvis.api('/api/basic', 'PUT', { revision: jarvis.state.basic.revision, value: { assistantName: name } });
      applyAssistantName(jarvis.state.basic.value.assistantName);
      loadBasic();
      basicFeedback('设置已保存');
      if (!isDirty()) byId('settings-unsaved').hidden = true;
    } catch (error) { basicFeedback(error.message, true); }
    finally { basicForm.inert = false; }
  });
  byId('settings-open').addEventListener('click', () => { location.hash = 'settings'; });
  byId('settings-back').addEventListener('click', () => {
    if (isDirty()) { pendingRoute = ''; byId('settings-discard').textContent = '放弃修改并返回'; byId('settings-unsaved').hidden = false; byId('settings-stay').focus(); }
    else location.hash = '';
  });
  byId('settings-stay').addEventListener('click', () => { byId('settings-unsaved').hidden = true; byId(page.getAttribute('aria-labelledby')).focus(); });
  byId('settings-discard').addEventListener('click', () => {
    capabilitiesUI.discard();
    if (!isSettingsRoute(pendingRoute)) { loadSaved(); loadBasic(); }
    byId('settings-unsaved').hidden = true;
    location.hash = pendingRoute;
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
    changed();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = readDraft();
    const error = validate(draft);
    if (error) {
      const [name, message, tab] = error;
      selectTab(tab); fields[name].setAttribute('aria-invalid', 'true');
      fields[name].focus(); setFeedback(message, true); return;
    }
    form.inert = true;
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
    finally { form.inert = false; }

  });
  window.addEventListener('hashchange', renderRoute);
  applyAssistantName(jarvis.state.basic.value.assistantName);
  loadSaved();
  loadBasic();
  renderRoute();
})();
