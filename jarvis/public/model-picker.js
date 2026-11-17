(async () => {
  const byId = id => document.getElementById(id);
  const button = byId('composer-model'), label = byId('composer-model-label');
  const popup = byId('model-picker'), modelSelect = byId('quick-model');
  const levels = byId('quick-efforts'), status = byId('model-picker-status');
  let working = false, choices = [];
  const effortName = item => ({ off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }[item.id] || item.name || item.id);
  const selectedModel = value => jarvis.state.models?.groups.find(group => group.id === value.endpoint)?.models.find(model => model.id === value.model);
  const isBusy = () => byId('conversation-page').dataset.busy === 'true' || Boolean(jarvis.state.active);
  function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  function currentLabel() {
    const value = jarvis.state.model.value;
    const info = selectedModel(value)?.reasoning;
    const selected = info?.efforts.find(item => item.id === value.reasoning);
    const fallback = { id: value.reasoning };
    const defaultLevel = info?.efforts.find(item => item.id === info.defaultEffort);
    const effort = value.reasoning === 'default' ? '默认' + (defaultLevel ? ` · ${effortName(defaultLevel)}` : '') : effortName(selected || fallback);
    label.textContent = value.model ? `${value.model} · ${effort}` : '选择模型';
    button.title = value.model ? '切换模型与思考级别' : '配置模型';
  }
  function controls() {
    const disabled = working || isBusy();
    modelSelect.disabled = disabled;
    levels.querySelectorAll('button').forEach(item => { item.disabled = disabled; });
    byId('model-picker-refresh').disabled = disabled;
  }
  function render() {
    const value = jarvis.state.model.value;
    choices = [];
    modelSelect.replaceChildren();
    for (const group of jarvis.state.models?.groups || []) {
      const optgroup = document.createElement('optgroup'); optgroup.label = group.name;
      for (const model of group.models) {
        const index = choices.push({ endpoint: group.id, model: model.id }) - 1;
        optgroup.append(new Option(model.name === model.id ? model.id : `${model.name} · ${model.id}`, String(index)));
      }
      modelSelect.append(optgroup);
    }
    let index = choices.findIndex(item => item.endpoint === value.endpoint && item.model === value.model);
    if (index < 0) {
      index = choices.push({ endpoint: value.endpoint, model: value.model }) - 1;
      const option = new Option(value.model ? `${value.model} · 未在目录中` : '请选择模型', String(index));
      option.disabled = true; modelSelect.append(option);
    }
    modelSelect.value = String(index);
    const info = selectedModel(value)?.reasoning;
    const available = info?.efforts || [];
    const defaultLevel = available.find(item => item.id === info.defaultEffort);
    levels.replaceChildren();
    for (const item of [{ id: 'default', name: '默认' }, ...available]) {
      const choice = document.createElement('button'); choice.type = 'button';
      choice.dataset.effort = item.id;
      choice.setAttribute('aria-pressed', String(value.reasoning === item.id));
      const name = document.createElement('span'); name.textContent = item.id === 'default' ? '默认' : effortName(item);
      const detail = document.createElement('small'); detail.textContent = item.id === 'default' ? (defaultLevel?.id || '自动') : item.id;
      choice.append(name, detail);
      choice.addEventListener('click', () => save({ reasoning: item.id }));
      levels.append(choice);
    }
    byId('quick-efforts-empty').hidden = available.length > 0;
    byId('model-picker-refresh').hidden = !jarvis.state.models?.refreshable;
    controls(); currentLabel();
  }
  function close(focus = false) {
    popup.hidden = true; button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  }
  async function load() {
    const state = await jarvis.api('/api/state');
    jarvis.state.models = state.models; jarvis.state.model = state.model; jarvis.state.csrf = state.csrf; jarvis.state.active = state.active;
    document.dispatchEvent(new Event('jarvis:model-updated'));
  }
  async function save(patch) {
    if (working || isBusy()) return;
    const current = jarvis.state.model;
    const next = { ...current.value, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current.value)) return;
    working = true; controls(); message('正在切换…');
    try {
      jarvis.state.model = await jarvis.api('/api/model', 'PUT', { revision: current.revision, value: next });
      document.dispatchEvent(new Event('jarvis:model-updated'));
      render(); message('已切换 · 下一条消息生效');
      const active = patch.reasoning ? [...levels.querySelectorAll('button')].find(item => item.dataset.effort === patch.reasoning) : modelSelect;
      // Focus after controls are re-enabled below.
      working = false; controls(); active?.focus();
    } catch (error) {
      try { await load(); } catch { /* keep the last confirmed selection */ }
      render(); message(error.message, true);
    } finally { working = false; controls(); }
  }
  modelSelect.addEventListener('change', () => {
    const next = choices[Number(modelSelect.value)];
    if (!next) return;
    const reasoning = jarvis.state.model.value.reasoning;
    const supported = selectedModel(next)?.reasoning?.efforts.some(item => item.id === reasoning);
    save({ ...next, reasoning: supported ? reasoning : 'default' });
  });
  button.addEventListener('click', async () => {
    if (!jarvis.state) return;
    if (jarvis.state.runtime !== 'dsh') { location.hash = 'settings/model'; return; }
    if (!popup.hidden) { close(); return; }
    popup.hidden = false; button.setAttribute('aria-expanded', 'true');
    popup.style.maxHeight = Math.max(180, button.getBoundingClientRect().top - 20) + 'px';
    working = true; render(); message('正在获取模型…'); byId('model-picker-close').focus();
    try {
      await load();
      if (jarvis.state.models?.refreshable && !isBusy()) {
        jarvis.state.models = await jarvis.api('/api/models/refresh', 'POST', {});
        document.dispatchEvent(new Event('jarvis:catalog-updated'));
      }
      render(); message(isBusy() ? '回复结束后可切换' : '用于下一条消息');
    }
    catch (error) { render(); message(error.message, true); }
    finally { working = false; controls(); }
  });
  byId('model-picker-refresh').addEventListener('click', async () => {
    if (working || isBusy()) return;
    working = true; controls(); message('正在读取模型能力…');
    try {
      jarvis.state.models = await jarvis.api('/api/models/refresh', 'POST', { force: true });
      document.dispatchEvent(new Event('jarvis:catalog-updated'));
      render(); message('模型与可选级别已更新');
    } catch (error) { message(error.message, true); }
    finally { working = false; controls(); }
  });
  byId('model-picker-close').addEventListener('click', () => close(true));
  byId('model-picker-settings').addEventListener('click', () => { close(); location.hash = jarvis.state.runtime==='dsh'?'settings/organization/root/jarvis/model':'settings/model'; });
  document.addEventListener('pointerdown', event => { if (!popup.contains(event.target) && !button.contains(event.target)) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); close(true); } });
  document.addEventListener('focusin', event => { if (!popup.hidden && !popup.contains(event.target) && !button.contains(event.target)) close(); });
  document.addEventListener('jarvis:model-updated', currentLabel);
  document.addEventListener('jarvis:activity', () => { jarvis.state.active = null; controls(); if (!popup.hidden && !working) message(isBusy() ? '回复结束后可切换' : '用于下一条消息'); });
  window.addEventListener('hashchange', () => close());
  try { await jarvis.ready; currentLabel(); } catch { /* workspace handles loading failure */ }
})();
