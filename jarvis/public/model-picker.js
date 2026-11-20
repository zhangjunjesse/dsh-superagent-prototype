(async () => {
  const byId = id => document.getElementById(id);
  const button = byId('composer-model'), label = byId('composer-model-label');
  let working = false;
  const catalogPicker = jarvisModels.mount(byId('quick-model-catalog'), {
    id: 'quick-model', label: '对话模型', trigger: button,
    onSelect: selection => switchModel(selection),
    onEffort: reasoning => save({ reasoning }),
    onRefresh: refreshCatalog,
    onOpenChange: open => { if (open) openPicker(); },
  });
  const tools = catalogPicker.panel.querySelector('.model-catalog-tools');
  const actions = document.createElement('div'); actions.className = 'model-picker-actions';
  const settings = document.createElement('button'); settings.type = 'button'; settings.id = 'model-picker-settings';
  settings.className = 'model-picker-settings'; settings.textContent = '完整模型设置'; actions.append(tools.querySelector('.model-catalog-refresh'), settings); tools.append(actions);
  const effortName = jarvisModels.effortName;
  const selectedModel = value => jarvisModels.find(jarvis.state.models, { provider: value.endpoint, model: value.model });
  const isBusy = () => byId('conversation-page').dataset.busy === 'true' || Boolean(jarvis.state?.active);
  function message(text, error = false) { catalogPicker.setStatus(text, error); }
  function readyMessage() {
    const unavailable = jarvis.state.models?.available === false || jarvis.state.models?.stale === true;
    message(isBusy() ? '回复结束后可切换 · 当前回复使用原模型' : unavailable ? jarvis.state.models.status || '模型来源尚未连接，请重新连接后刷新' : '', unavailable);
  }
  function currentLabel() {
    const value = jarvis.state.model.value, model = selectedModel(value), info = model?.reasoning;
    const selected = info?.efforts.find(item => item.id === value.reasoning);
    const defaultLevel = info?.efforts.find(item => item.id === info.defaultEffort);
    const effort = value.reasoning === 'default' ? '默认' + (defaultLevel ? ` · ${effortName(defaultLevel)}` : '') : effortName(selected || { id: value.reasoning });
    const name = model?.name || value.model, provider = jarvisModels.providerName(jarvis.state.models, value.endpoint);
    label.textContent = value.model ? name : '选择模型';
    if (value.model) {
      jarvisModels.appendBadge(label, model, true);
      const level = document.createElement('span'); level.className = 'model-indicator-effort'; level.textContent = effort; label.append(' ', level);
    }
    button.title = value.model ? `${value.model} · ${provider} · ${effort} · 用于下一条消息` : '配置模型';
    button.setAttribute('aria-label', value.model ? `对话模型：${name}，来源：${provider}，推理等级：${effort}，用于下一条消息` : '配置模型');
  }
  function controls() { catalogPicker.setDisabled(working || isBusy(), { trigger: false }); }
  function render() {
    if (!jarvis.state) return;
    const value = jarvis.state.model.value;
    catalogPicker.update(jarvis.state.models, { provider: value.endpoint, model: value.model, reasoningEffort: value.reasoning });
    const refresh = tools.querySelector('.model-catalog-refresh'); refresh.hidden = !jarvis.state.models?.refreshable;
    controls(); currentLabel();
  }
  async function load() {
    const state = await jarvis.api('/api/state');
    jarvis.state.models = state.models; jarvis.state.model = state.model; jarvis.state.csrf = state.csrf; jarvis.state.active = state.active;
    document.dispatchEvent(new Event('jarvis:model-updated'));
    document.dispatchEvent(new Event('jarvis:catalog-updated'));
  }
  async function save(patch) {
    if (working || isBusy()) return;
    const current = jarvis.state.model, next = { ...current.value, ...patch };
    if (JSON.stringify(next) === JSON.stringify(current.value)) return;
    const restoreFocus = catalogPicker.isOpen && catalogPicker.panel.contains(document.activeElement);
    const ownsFocus = () => catalogPicker.isOpen && document.activeElement === button;
    let failed = false;
    // Keep keyboard events on this picker before the browser blurs a disabled option.
    if (restoreFocus) button.focus({ preventScroll: true });
    working = true; controls(); message('正在切换…');
    try {
      jarvis.state.model = await jarvis.api('/api/model', 'PUT', { revision: current.revision, value: next });
      document.dispatchEvent(new Event('jarvis:model-updated'));
      render(); message('已切换 · 下一条消息生效');
      if (catalogPicker.isOpen) catalogPicker.close(restoreFocus && ownsFocus());
    } catch (error) {
      failed = true;
      try { await load(); } catch { /* keep the last confirmed selection */ }
      render(); message(error.message, true);
    } finally {
      working = false; controls();
      if (failed && restoreFocus && ownsFocus()) {
        const view = catalogPicker.panel.dataset.view;
        const options = view === 'models' ? byId('quick-model-results') : view === 'efforts' ? byId('quick-model-efforts') : null;
        (options?.querySelector('[aria-selected="true"]:not(:disabled)') || button).focus({ preventScroll: true });
      }
    }
  }
  function switchModel(selection) {
    const next = { endpoint: selection.provider, model: selection.model };
    const reasoning = jarvis.state.model.value.reasoning;
    const supported = selectedModel(next)?.reasoning?.efforts.some(item => item.id === reasoning);
    return save({ ...next, reasoning: supported ? reasoning : 'default' });
  }
  async function openPicker() {
    if (!jarvis.state) { catalogPicker.close(false); return; }
    if (jarvis.state.runtime !== 'dsh') { catalogPicker.close(false); location.hash = 'settings/model'; return; }
    if (working) return;
    working = true; render(); message('正在获取模型…');
    try {
      await load();
      if (jarvis.state.models?.refreshable && !isBusy()) {
        jarvis.state.models = await jarvis.api('/api/models/refresh', 'POST', {});
        document.dispatchEvent(new Event('jarvis:catalog-updated'));
      }
      render(); readyMessage();
    } catch (error) { render(); message(error.message, true); }
    finally { working = false; controls(); }
  }
  async function refreshCatalog() {
    if (working || isBusy()) return;
    working = true; controls(); message('正在读取模型能力…');
    try {
      jarvis.state.models = await jarvis.api('/api/models/refresh', 'POST', { force: true });
      document.dispatchEvent(new Event('jarvis:catalog-updated'));
      render(); readyMessage();
    } catch (error) { message(error.message, true); throw error; }
    finally { working = false; controls(); }
  }
  settings.addEventListener('click', () => {
    catalogPicker.close(false);
    location.hash = jarvis.state.runtime === 'dsh' ? 'settings/organization/root/jarvis/model' : 'settings/model';
  });
  document.addEventListener('jarvis:model-updated', render);
  document.addEventListener('jarvis:catalog-updated', render);
  document.addEventListener('jarvis:activity', () => {
    if (!jarvis.state) return;
    jarvis.state.active = null; controls();
    if (catalogPicker.isOpen && !working) readyMessage();
  });
  try { await jarvis.ready; render(); } catch { /* workspace handles loading failure */ }
})();
