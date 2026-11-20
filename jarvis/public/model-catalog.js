/* Model identities and reasoning metadata come from the DSH catalog. */
(() => {
  'use strict';

  // The native DSH panel and Jarvis serve this same scoped component stylesheet.
  const styles = `
.model-catalog-control,.model-catalog-control *,.model-catalog-panel,.model-catalog-panel * { box-sizing:border-box; }
.model-catalog-panel[hidden],.model-catalog-panel [hidden] { display:none!important; }
.model-catalog-panel button,.model-catalog-toggle { cursor:pointer; -webkit-tap-highlight-color:transparent; }
.model-catalog-control { display:inline-flex; min-width:0; max-width:100%; color:var(--dsw-alias-label-primary,#303033); font-size:13px; }
.model-catalog-toggle { display:flex; align-items:center; gap:4px; width:auto; min-width:0; max-width:min(360px,100%); height:28px; padding:0 4px 0 8px; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary,#606066); text-align:left; font:inherit; font-size:13px; font-weight:400; line-height:20px; }
.model-catalog-toggle:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,#f0f0f2); }
.model-catalog-current { display:flex; align-items:center; min-width:0; }
.model-catalog-current-name,.model-catalog-option-name { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:100%; font-weight:400; white-space:nowrap; }
.model-catalog-current-effort { min-width:0; flex-shrink:1000; overflow:hidden; color:var(--dsw-alias-label-caption,#909096); text-overflow:ellipsis; white-space:nowrap; }
.model-catalog-name-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.model-catalog-chevron { display:grid; place-items:center; flex:none; color:var(--dsw-alias-label-caption,#909096); transition:transform .12s; }
.model-catalog-chevron svg { width:16px; height:16px; }
.model-catalog-toggle[aria-expanded='true'] .model-catalog-chevron { transform:rotate(180deg); }
.model-catalog-panel { position:fixed; z-index:1100; display:flex; flex-direction:column; width:max-content; min-width:min(240px,calc(100vw - 32px)); max-width:min(420px,calc(100vw - 32px)); max-height:min(360px,calc(100vh - 96px)); padding:4px; border:0; border-radius:8px; background:var(--dsw-alias-bg-layer-2,#fff); color:var(--dsw-alias-label-primary,#303033); box-shadow:var(--dsw-elevation-prominent,0 0 0 1px #0000000d,0 8px 32px #00000024,0 2px 8px #0000000d); font:400 13px/20px Inter,'Segoe UI','Microsoft YaHei UI',system-ui,sans-serif; overflow:hidden; }
.model-catalog-menu { min-height:0; overflow:auto; }
.model-catalog-cell { display:flex; align-items:center; gap:6px; width:100%; height:34px; padding:0 8px; border:0; border-radius:6px; background:transparent; color:inherit; text-align:left; font:inherit; }
.model-catalog-cell-label { flex:none; white-space:nowrap; }
.model-catalog-cell-value { display:flex; justify-content:flex-end; flex:1; min-width:0; overflow:hidden; color:var(--dsw-alias-label-tertiary,#8c8c92); text-align:right; text-overflow:ellipsis; white-space:nowrap; }
.model-catalog-cell-chevron { display:grid; place-items:center; flex:none; color:var(--dsw-alias-label-tertiary,#8c8c92); }
.model-catalog-cell-chevron svg { width:12px; height:12px; }
.model-catalog-page { display:flex; flex-direction:column; flex:1; min-height:0; overflow:auto; }
.model-catalog-filters { display:flex; align-items:center; flex:none; gap:6px; margin:2px 0 3px; padding:5px 7px; border-radius:6px; color:var(--dsw-alias-label-caption,#909096); }
.model-catalog-filters > svg { flex:none; width:14px; height:14px; }
.model-catalog-filters input { flex:1; width:100%; min-width:0; height:20px; padding:0; border:0; border-radius:0; outline:none; background:transparent; color:var(--dsw-alias-label-primary,#303033); font:inherit; font-size:12px; line-height:18px; box-shadow:none; }
.model-catalog-filters input::placeholder { color:var(--dsw-alias-label-caption,#909096); }
.model-catalog-filters input::-webkit-search-cancel-button { display:none; }
.model-catalog-search-clear { flex:none; width:24px; height:24px; margin:-3px -3px -3px 0; padding:0; border:0; border-radius:50%; background:transparent; color:var(--dsw-alias-label-secondary,#606066); font:inherit; font-size:18px; line-height:24px; }
.model-catalog-results,.model-catalog-efforts { min-height:0; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; }
.model-catalog-group + .model-catalog-group { margin-top:4px; }
.model-catalog-group-title { position:sticky; top:0; z-index:1; margin:0; padding:5px 7px; background:var(--dsw-alias-bg-layer-2,#fff); color:var(--dsw-alias-label-tertiary,#8c8c92); font-size:12px; font-weight:400; line-height:18px; overflow-wrap:anywhere; }
.model-catalog-option { display:flex; align-items:center; gap:6px; width:100%; min-height:34px; margin:0; padding:5px 7px; border:0; border-radius:6px; background:transparent; color:inherit; text-align:left; font:inherit; font-size:13px; font-weight:400; line-height:18px; }
.model-catalog-option[aria-selected='true'] { border:0; background:transparent; }
.model-catalog-cell:hover:not(:disabled),.model-catalog-cell:focus-visible,.model-catalog-option:hover:not(:disabled),.model-catalog-option.is-active:not(:disabled),.model-catalog-option:focus-visible,.model-catalog-search-clear:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,#f0f0f2); }
.model-catalog-option-body { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.model-catalog-check { display:grid; place-items:center; flex:0 0 14px; color:inherit; }
.model-catalog-check svg { width:14px; height:14px; }
.model-catalog-badge { display:inline-block; flex:none; padding:1px 4px; border-radius:4px; background:#edf0f4; color:#526070; font-size:11px; font-weight:500; line-height:16px; }
.model-catalog-badge[data-tone='info'] { background:#e9f1ff; color:#3162ab; }
.model-catalog-badge[data-tone='success'] { background:#e7f6ef; color:#247250; }
.model-catalog-badge[data-tone='warning'] { background:#fff3d9; color:var(--dsw-alias-state-warn-label,#8b641f); }
.model-catalog-count,.model-catalog-feedback,.model-catalog-status { flex:none; max-height:90px; margin:0; padding:8px; overflow:auto; color:var(--dsw-alias-label-tertiary,#8c8c92); font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.model-catalog-warning { flex:none; max-height:110px; margin:0 0 3px; padding:6px 7px; border-radius:6px; background:var(--dsw-alias-bg-module-platform,#f8f8f9); color:var(--dsw-alias-state-warn-label,#8b641f); font-size:11px; line-height:16px; overflow:auto; overflow-wrap:anywhere; }
.model-catalog-tools { flex:0 0 auto; min-height:0; max-height:min(140px,40vh); overflow:auto; }
.model-catalog-failures { margin:0; padding:6px 7px; border-radius:6px; background:var(--dsw-alias-bg-module-platform,#f8f8f9); color:var(--dsw-alias-state-warn-label,#8b641f); font-size:11px; line-height:16px; }
.model-catalog-failures summary { cursor:pointer; }
.model-catalog-failures ul { margin:7px 0 0; padding-left:18px; }
.model-catalog-failures li { margin:6px 0; overflow-wrap:anywhere; }
.model-catalog-failures li :is(strong,span) { display:block; }
.model-catalog-feedback.error,.model-catalog-status.error { color:var(--dsw-alias-state-error-primary,#b94b4b); }
.model-catalog-refresh { padding:5px 7px; margin:0; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary,#606066); font:inherit; font-size:12px; }
.model-catalog-refresh:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,#f0f0f2); }
.model-catalog-panel :focus-visible { outline:none; box-shadow:none; }
.model-catalog-toggle:focus-visible { outline:none; box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#9fbbea); }
.model-catalog-panel :disabled,.model-catalog-toggle:disabled { opacity:1; color:var(--dsw-alias-label-dimmed,#b0b0b5); cursor:default; }
.model-catalog-panel button:active:not(:disabled),.model-catalog-toggle:active:not(:disabled) { transform:none; }
`;
  if (!document.getElementById('jarvis-model-catalog-style')) {
    const style = document.createElement('style'); style.id = 'jarvis-model-catalog-style'; style.textContent = styles;
    (document.head || document.documentElement).append(style);
  }
  const mounts = new WeakMap();
  let opened, sequence = 0;
  const providerId = group => group.desktopProvider || String(group.id).replace(/^desktop:/, '');
  const providerRank = group => providerId(group) === 'deepseek-account' ? 0 : providerId(group) === 'deepseek-official' ? 1 : 2;
  const groups = catalog => Array.isArray(catalog?.groups) ? [...catalog.groups].sort((left, right) => providerRank(left) - providerRank(right)) : [];
  const language = locale => (locale || document.documentElement.lang || 'en').toLowerCase().replace(/_/g, '-').split('-')[0];
  const accountNames = { zh: 'DeepSeek 账号', en: 'DeepSeek Account', ja: 'DeepSeek アカウント', es: 'Cuenta DeepSeek', fr: 'Compte DeepSeek', de: 'DeepSeek-Konto', ru: 'DeepSeek Аккаунт', pt: 'DeepSeek Conta' };
  const groupName = (group, locale) => providerId(group) === 'deepseek-account' ? accountNames[language(locale)] || accountNames.en : group.name;
  const find = (catalog, value) => groups(catalog).find(group => group.id === value?.provider)?.models.find(model => model.id === value?.model);
  const providerName = (catalog, id, locale) => { const group = groups(catalog).find(group => group.id === id); return group ? groupName(group, locale) : String(id || '').replace(/^desktop:/, '') || (locale === 'en' ? 'No provider selected' : '尚未选择来源'); };
  const effortName = (item, locale) => item.name || ((locale === 'en' ? { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' } : { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' })[item.id] || item.id);
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  function icon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
    path.setAttribute('d', { down: 'm4 6 4 4 4-4', right: 'm6 4 4 4-4 4', check: 'm3 8 3 3 7-7', search: 'M11 11l3 3M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0' }[kind]);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    svg.append(path); return svg;
  }
  function badgeText(value, locale) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    return typeof value[language(locale)] === 'string' ? value[language(locale)] : typeof value.en === 'string' ? value.en : '';
  }
  function appendBadge(parent, model, first = false, locale) {
    const text = badgeText(model?.badge?.text, locale); if (!text) return;
    const badge = node('span', 'model-catalog-badge', text);
    if (['neutral', 'info', 'success', 'warning'].includes(model.badge.tone)) badge.dataset.tone = model.badge.tone;
    if (first) parent.prepend(badge, document.createTextNode(' '));
    else parent.append(document.createTextNode(' '), badge);
  }
  function modelLabel(model, fallback, placement = 'option', locale) {
    const label = node('span', 'model-catalog-' + placement + '-name');
    label.append(node('span', 'model-catalog-name-text', model?.name || fallback || '选择模型'));
    appendBadge(label, model, placement === 'current', locale); return label;
  }
  function modelDescription(group, model, locale) {
    const efforts = model.reasoning?.efforts || [];
    return [groupName(group, locale) + ' · ' + model.id, model.description, efforts.length ? (locale === 'en' ? 'Reasoning: ' : '思考：') + efforts.map(item => `${effortName(item, locale)} (${item.id})`).join(' / ') : ''].filter(Boolean).join('\n');
  }
  // Match the ordered letters used by DSH search; provider identity remains searchable too.
  function matchScore(value, query) {
    const text = String(value || '').toLocaleLowerCase();
    const direct = text.indexOf(query); if (direct >= 0) return direct === 0 ? 0 : 100 + direct;
    let cursor = 0, start = -1, previous = -1, gaps = 0;
    for (const letter of query) {
      const next = text.indexOf(letter, cursor); if (next < 0) return Infinity;
      if (start < 0) start = next; else gaps += next - previous - 1;
      previous = next; cursor = next + letter.length;
    }
    return 1000 + start + gaps * 2;
  }
  function filteredModels(group, query, locale) {
    if (!query) return group.models;
    const source = [groupName(group, locale), group.name, group.id, group.desktopProvider].map(value => matchScore(value, query));
    return group.models.map((model, order) => ({ model, order, score: Math.min(...source, ...[model.name, model.id, model.description, badgeText(model.badge?.text, locale)].map(value => matchScore(value, query))) }))
      .filter(item => Number.isFinite(item.score)).sort((left, right) => left.score - right.score || left.order - right.order).map(item => item.model);
  }
  function mount(host, { id = 'model-catalog-' + ++sequence, label = '模型', locale, expanded = false, trigger: externalTrigger, onSelect, onEffort, onRefresh, onOpenChange } = {}) {
    mounts.get(host)?.destroy();
    const copy = (zh, en) => locale === 'en' ? en : zh;
    const root = node('div', 'model-catalog-control'), trigger = externalTrigger || node('button', 'model-catalog-toggle');
    const triggerAttributes = Object.fromEntries(['aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-label', 'title'].map(name => [name, trigger.getAttribute(name)]));
    const initialDisabled = trigger.disabled, current = node('span', 'model-catalog-current');
    if (!externalTrigger) {
      trigger.type = 'button'; trigger.id = id + '-toggle';
      const chevron = node('span', 'model-catalog-chevron'); chevron.append(icon('down'));
      trigger.append(current, chevron); root.append(trigger);
    }
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', id + '-panel');
    const panel = node('div', 'model-catalog-panel'); panel.id = id + '-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', copy(label + '与推理等级', label + ' and reasoning effort'));
    const menu = node('div', 'model-catalog-menu');
    function cell(kind, name) {
      const button = node('button', 'model-catalog-cell'); button.type = 'button'; button.id = id + '-' + kind + '-entry'; button.setAttribute('role', 'menuitem');
      const value = node('span', 'model-catalog-cell-value'), chevron = node('span', 'model-catalog-cell-chevron'); chevron.append(icon('right'));
      button.append(node('span', 'model-catalog-cell-label', name), value, chevron); menu.append(button); return { button, value };
    }
    const modelCell = cell('model', copy('模型', 'Model')), effortCell = cell('effort', copy('推理等级', 'Effort'));
    const modelPage = node('div', 'model-catalog-page'); modelPage.id = id + '-models-page';
    const filters = node('div', 'model-catalog-filters'); filters.append(icon('search'));
    const search = node('input'); search.type = 'search'; search.id = id + '-search'; search.placeholder = copy('搜索模型或来源', 'Search models or providers'); search.autocomplete = 'off';
    search.setAttribute('aria-label', copy('搜索' + label + '或来源', 'Search ' + label + ' or provider')); search.setAttribute('aria-controls', id + '-results');
    const clear = node('button', 'model-catalog-search-clear', '×'); clear.type = 'button'; clear.setAttribute('aria-label', copy('清除搜索', 'Clear search')); clear.hidden = true;
    filters.append(search, clear);
    const warning = node('p', 'model-catalog-warning'); warning.setAttribute('role', 'status'); warning.hidden = true;
    const results = node('div', 'model-catalog-results'); results.id = id + '-results'; results.setAttribute('role', 'listbox'); results.setAttribute('aria-label', copy('可选' + label, 'Available ' + label));
    const count = node('p', 'model-catalog-count'); count.setAttribute('role', 'status');
    const tools = node('div', 'model-catalog-tools'), failures = node('details', 'model-catalog-failures'); failures.hidden = true;
    const refresh = node('button', 'model-catalog-refresh', copy('重新读取可选模型', 'Reload available models')); refresh.type = 'button'; refresh.hidden = !onRefresh;
    const feedback = node('p', 'model-catalog-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
    tools.append(failures, refresh, feedback); modelPage.append(filters, warning, results, count, tools);
    const effortPage = node('div', 'model-catalog-page'), efforts = node('div', 'model-catalog-efforts'); effortPage.id = id + '-efforts-page';
    efforts.id = id + '-efforts'; efforts.setAttribute('role', 'listbox'); efforts.setAttribute('aria-label', copy('推理等级', 'Reasoning effort')); effortPage.append(efforts);
    const status = node('p', 'model-catalog-status'); status.id = id + '-status'; status.hidden = true; status.setAttribute('role', 'status');
    panel.append(menu, modelPage, effortPage, status); host.replaceChildren(root); document.body.append(panel);
    let catalog = {}, selection = {}, disabled = false, triggerDisabled = initialDisabled, refreshing = false, destroyed = false, view = 'menu', highlighted = 0, animationFrame = 0, lastAnchor = '', openVersion = 0;
    const listeners = [], unavailable = () => catalog.available === false || catalog.stale === true;
    const descriptor = () => find(catalog, selection);
    const selectedEffort = () => (selection.reasoningEffort ?? selection.reasoning) || 'default';
    function listen(target, type, handler, options) { target.addEventListener(type, handler, options); listeners.push(() => target.removeEventListener(type, handler, options)); }
    function controls() {
      trigger.disabled = triggerDisabled; panel.setAttribute('aria-busy', String(disabled || refreshing));
      modelCell.button.disabled = disabled || refreshing;
      effortCell.button.disabled = disabled || refreshing || unavailable() || !descriptor() || !onEffort;
      search.disabled = disabled || refreshing; clear.disabled = disabled || refreshing; refresh.disabled = disabled || refreshing;
      results.querySelectorAll('button').forEach(button => { button.disabled = disabled || refreshing || unavailable(); });
      efforts.querySelectorAll('button').forEach(button => { button.disabled = disabled || refreshing || unavailable() || !descriptor() || !onEffort || button.dataset.retained === 'true'; });
    }
    function effortLabel() {
      const model = descriptor(), value = selectedEffort(), levels = model?.reasoning?.efforts || [];
      const chosen = levels.find(item => item.id === (value === 'default' ? model?.reasoning?.defaultEffort : value));
      return value === 'default' ? copy('默认', 'Default') + (chosen ? ' · ' + effortName(chosen, locale) : '') : effortName(chosen || { id: value }, locale);
    }
    function renderCurrent() {
      const model = descriptor(), origin = providerName(catalog, selection.provider, locale), effort = effortLabel(), fallback = selection.model || copy('选择模型', 'Select model');
      current.replaceChildren(modelLabel(model, fallback, 'current', locale), node('span', 'model-catalog-current-effort', ' · ' + effort));
      modelCell.value.replaceChildren(modelLabel(model, fallback, 'option', locale)); effortCell.value.textContent = effort;
      trigger.title = [origin, selection.model, effort].filter(Boolean).join(' · ');
      trigger.setAttribute('aria-label', copy(label + '：' + (model?.name || fallback) + '，' + origin + '，推理等级：' + effort, label + ': ' + (model?.name || fallback) + ', ' + origin + ', reasoning effort: ' + effort));
      const missing = selection.model && !model;
      warning.hidden = !missing && !unavailable();
      const reason = typeof catalog.status === 'string' && catalog.status ? catalog.status.replace(/[。.!！]$/, '') + '。' : '';
      warning.textContent = unavailable() ? reason + copy('模型来源暂未连接，已保留当前配置。重新连接模型来源后刷新，或选择其他可用来源。', 'Model providers are disconnected. Your current setting is retained. Reconnect and reload, or choose another available provider.') : missing ? reason + copy('当前模型已不在可用目录中，已保留原配置。重新连接原来源后刷新，或选择其他模型。', 'The current model is no longer in the available catalog. Your setting is retained. Reconnect and reload, or select another model.') : '';
      refresh.textContent = warning.hidden ? copy('重新读取可选模型', 'Reload available models') : copy('重新连接并刷新', 'Reconnect and reload');
    }
    function highlight(index) {
      const rows = [...results.querySelectorAll('button')]; highlighted = rows.length ? (index + rows.length) % rows.length : -1;
      rows.forEach((row, item) => { row.classList.toggle('is-active', item === highlighted); });
      if (!filters.hidden && rows[highlighted]) search.setAttribute('aria-activedescendant', rows[highlighted].id); else search.removeAttribute('aria-activedescendant');
      rows[highlighted]?.scrollIntoView?.({ block: 'nearest' });
    }
    function choose(callback, ...args) {
      if (disabled || refreshing || unavailable()) return;
      callback?.(...args);
      // The owner may hold the panel open while an asynchronous save is pending.
      if (!disabled && !refreshing) close();
    }
    function renderResults() {
      results.replaceChildren();
      filters.hidden = groups(catalog).reduce((total, group) => total + group.models.length, 0) <= 4;
      if (filters.hidden) search.value = '';
      const query = search.value.trim().toLocaleLowerCase(); let matches = 0, selected = 0;
      clear.hidden = !search.value;
      for (const group of groups(catalog)) {
        const models = filteredModels(group, query, locale); if (!models.length) continue;
        const area = node('div', 'model-catalog-group'); area.setAttribute('role', 'group'); area.setAttribute('aria-label', groupName(group, locale));
        area.append(node('p', 'model-catalog-group-title', groupName(group, locale)));
        for (const model of models) {
          const button = node('button', 'model-catalog-option'); button.type = 'button'; button.id = id + '-model-option-' + matches; button.setAttribute('role', 'option');
          button.dataset.provider = group.id; button.dataset.model = model.id;
          const isSelected = selection.provider === group.id && selection.model === model.id; if (isSelected) selected = matches;
          button.setAttribute('aria-selected', String(isSelected)); button.title = modelDescription(group, model, locale); button.setAttribute('aria-description', button.title);
          const content = node('span', 'model-catalog-option-body'), check = node('span', 'model-catalog-check'); check.setAttribute('aria-hidden', 'true');
          content.append(modelLabel(model, model.id, 'option', locale)); if (isSelected) check.append(icon('check')); button.append(content, check);
          button.tabIndex = filters.hidden ? 0 : -1;
          button.addEventListener('click', () => choose(onSelect, { provider: group.id, model: model.id }, model));
          button.addEventListener('pointermove', () => { if (!disabled && !refreshing) highlight([...results.querySelectorAll('button')].indexOf(button)); });
          button.addEventListener('focus', () => highlight([...results.querySelectorAll('button')].indexOf(button)));
          area.append(button); matches++;
        }
        results.append(area);
      }
      count.textContent = matches ? copy(`${matches} 个模型${unavailable() ? ' · 当前目录离线，仅供查看' : ''}`, `${matches} models${unavailable() ? ' · Offline catalog, read only' : ''}`) : query ? copy('没有匹配的模型，请更换关键词或来源。', 'No matching models. Try another name or provider.') : copy('没有可用模型。连接模型来源后，重新读取。', 'No available models. Connect a model provider and reload.');
      count.hidden = Boolean(matches && !unavailable()); highlight(query ? 0 : selected); controls();
    }
    function renderEfforts() {
      efforts.replaceChildren();
      const model = descriptor(), levels = [{ id: 'default', name: copy('默认', 'Default') }, ...(model?.reasoning?.efforts || []).filter(item => item.id !== 'default')], value = selectedEffort();
      if (!levels.some(item => item.id === value)) levels.push({ id: value, name: effortName({ id: value }, locale) + copy(' · 当前配置', ' · Current setting'), retained: true });
      for (const level of levels) {
        const button = node('button', 'model-catalog-option'); button.type = 'button'; button.setAttribute('role', 'option'); button.dataset.effort = level.id;
        button.setAttribute('aria-selected', String(value === level.id)); if (level.retained) button.dataset.retained = 'true';
        const check = node('span', 'model-catalog-check'); check.setAttribute('aria-hidden', 'true'); if (value === level.id) check.append(icon('check'));
        button.append(node('span', 'model-catalog-option-body', level.id === 'default' ? effortLabelForDefault(model) : effortName(level, locale)), check);
        button.addEventListener('click', () => { if (!level.retained && model) choose(onEffort, level.id, model); }); efforts.append(button);
      }
      controls();
    }
    function effortLabelForDefault(model) {
      const level = model?.reasoning?.efforts?.find(item => item.id === model.reasoning.defaultEffort);
      return copy('默认', 'Default') + (level ? ' · ' + effortName(level, locale) : '');
    }
    function renderFailures() {
      failures.replaceChildren(); const failed = Array.isArray(catalog.failures) ? catalog.failures : []; failures.hidden = !failed.length;
      if (!failed.length) return;
      failures.append(node('summary', '', copy(`部分来源暂时无法读取（${failed.length}）`, `Some providers could not be loaded (${failed.length})`))); const list = node('ul');
      for (const item of failed) { const row = node('li'); row.append(node('strong', '', groupName(item, locale)), node('span', '', item.message)); list.append(row); }
      failures.append(list);
    }
    function update(nextCatalog, nextSelection) {
      if (destroyed) return;
      const focusedModel = document.activeElement?.dataset?.model, focusedProvider = document.activeElement?.dataset?.provider, focusedEffort = document.activeElement?.dataset?.effort;
      catalog = nextCatalog || {}; selection = { ...nextSelection };
      renderCurrent(); renderResults(); renderEfforts(); renderFailures(); position();
      if (!panel.hidden && (focusedModel || focusedEffort)) {
        const row = focusedModel ? [...results.querySelectorAll('button')].find(item => item.dataset.model === focusedModel && item.dataset.provider === focusedProvider) : [...efforts.querySelectorAll('button')].find(item => item.dataset.effort === focusedEffort);
        (row && !row.disabled ? row : view === 'models' && !filters.hidden ? search : trigger).focus();
      }
    }
    function position() {
      if (panel.hidden || destroyed) return;
      const viewport = window.visualViewport, width = viewport?.width || document.documentElement.clientWidth || window.innerWidth, height = viewport?.height || document.documentElement.clientHeight || window.innerHeight, margin = 12, gap = 8;
      const anchor = trigger.getBoundingClientRect(), offsetLeft = viewport?.offsetLeft || 0, offsetTop = viewport?.offsetTop || 0;
      const clearance = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance'));
      const topMargin = Number.isNaN(clearance) ? margin : Math.max(margin, Math.min((document.documentElement.hasAttribute('data-fullscreen') ? 0 : clearance) + 20, anchor.top >= 0 ? anchor.bottom + gap : Infinity));
      const minimum = Math.min(240, Math.max(0, window.innerWidth - 32), Math.max(0, width - margin * 2)), maximum = Math.min(420, Math.max(0, window.innerWidth - 32), Math.max(0, width - margin * 2));
      panel.style.width = 'max-content'; panel.style.minWidth = minimum + 'px'; panel.style.maxWidth = maximum + 'px';
      const maxHeight = Math.max(0, Math.min(360, window.innerHeight - 96, height - topMargin - margin));
      panel.style.maxHeight = maxHeight + 'px';
      const bounds = panel.getBoundingClientRect(), menuWidth = Math.max(minimum, Math.min(bounds.width || panel.offsetWidth || minimum, maximum));
      const menuHeight = Math.min(maxHeight, bounds.height || panel.scrollHeight || (view === 'menu' ? 76 : view === 'efforts' ? efforts.children.length * 34 + 8 : 360));
      const webkit = window.CSS?.supports?.('-webkit-backdrop-filter', 'none');
      // DSH's top/end anchor clamps within the viewport rather than switching sides.
      panel.dataset.side = 'top';
      panel.style.left = Math.max(offsetLeft + margin, Math.min((webkit ? offsetLeft : 0) + anchor.right - menuWidth, offsetLeft + width - margin - menuWidth)) + 'px';
      panel.style.top = Math.max(offsetTop + topMargin, Math.min((webkit ? offsetTop : 0) + anchor.top - gap - menuHeight, offsetTop + height - margin - menuHeight)) + 'px';
      lastAnchor = anchorKey(anchor);
    }
    const anchorKey = bounds => [bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height].join(',');
    function followAnchor() {
      if (panel.hidden || destroyed) return;
      if (anchorKey(trigger.getBoundingClientRect()) !== lastAnchor) position();
      animationFrame = window.requestAnimationFrame(followAnchor);
    }
    function setView(next, focus = true) {
      view = ['models', 'efforts'].includes(next) ? next : 'menu'; panel.dataset.view = view;
      menu.hidden = view !== 'menu'; modelPage.hidden = view !== 'models'; effortPage.hidden = view !== 'efforts'; panel.setAttribute('role', view === 'menu' ? 'menu' : 'group'); position();
      if (!focus) return;
      const list = view === 'models' ? results : efforts;
      const target = view === 'menu' ? modelCell.button : view === 'models' && !filters.hidden ? search : list.querySelector('[aria-selected="true"]:not(:disabled)') || list.querySelector('button:not(:disabled)') || (view === 'models' && !refresh.hidden && !refresh.disabled ? refresh : null);
      (target && !target.disabled ? target : trigger).focus();
    }
    function open(next = 'menu') {
      if (destroyed || triggerDisabled) return false;
      const wasOpen = !panel.hidden; if (opened && opened !== api) opened.close(false);
      opened = api; panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      if (!wasOpen) { openVersion++; search.value = ''; renderResults(); onOpenChange?.(true); animationFrame = window.requestAnimationFrame(followAnchor); }
      setView(next); return true;
    }
    function close(focus = true) {
      if (destroyed) return;
      const wasOpen = !panel.hidden; panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (opened === api) opened = undefined;
      window.cancelAnimationFrame(animationFrame); animationFrame = 0;
      if (wasOpen) onOpenChange?.(false); if (focus && wasOpen) trigger.focus();
    }
    function back() { const from = view; setView('menu', false); (from === 'efforts' ? effortCell.button : modelCell.button).focus(); }
    function keydown(event) {
      if (event.isComposing) return;
      if (panel.hidden) { if (event.target === trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } return; }
      if (event.key === 'Escape' || event.key === 'Tab' && event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); if (view !== 'menu') back(); else close(); return;
      }
      const rows = [...(view === 'menu' ? menu : view === 'models' ? results : efforts).querySelectorAll('button:not(:disabled)')];
      if (tools.contains(event.target) || view === 'models' && !rows.length && event.key === 'Tab') return;
      if (view === 'models' && !filters.hidden && (event.target === search || rows.includes(event.target))) {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); highlight(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : highlighted + (event.key === 'ArrowDown' ? 1 : -1)); search.focus(); return;
        }
        if (event.target === search && (event.key === 'Enter' || event.key === 'Tab' && rows.length)) { event.preventDefault(); rows[highlighted]?.click(); return; }
      }
      if (event.key === 'Tab') { event.preventDefault(); if (rows.includes(event.target)) event.target.click(); else rows[0]?.focus(); return; }
      const index = rows.indexOf(event.target), next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
      if (next !== null && rows.length) { event.preventDefault(); rows[(next + rows.length) % rows.length]?.focus(); }
      if (event.key === 'ArrowRight' && view === 'menu' && rows.includes(event.target)) { event.preventDefault(); event.target.click(); }
      if (event.key === 'ArrowLeft' && view !== 'menu') { event.preventDefault(); back(); }
    }
    function outside(event) { if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target) && !root.contains(event.target)) close(false); }
    listen(trigger, 'click', () => { if (!triggerDisabled) { if (panel.hidden) open(); else close(false); } });
    listen(trigger, 'keydown', keydown); listen(panel, 'keydown', keydown);
    listen(modelCell.button, 'click', () => setView('models')); listen(effortCell.button, 'click', () => setView('efforts'));
    listen(search, 'input', event => { event.stopPropagation(); renderResults(); position(); });
    listen(clear, 'click', () => { search.value = ''; renderResults(); position(); search.focus(); });
    listen(panel, 'input', event => event.stopPropagation()); listen(panel, 'change', event => event.stopPropagation());
    listen(document, 'pointerdown', outside); listen(document, 'mousedown', outside); listen(document, 'focusin', outside);
    listen(window, 'resize', position); listen(window, 'hashchange', () => close(false));
    listen(document, 'scroll', event => { if (!panel.contains(event.target)) position(); }, true);
    if (window.visualViewport) { listen(window.visualViewport, 'resize', position); listen(window.visualViewport, 'scroll', position); }
    listen(refresh, 'click', async () => {
      if (disabled || refreshing || !onRefresh) return;
      const refreshFocus = panel.contains(document.activeElement) ? document.activeElement : null, refreshView = view, refreshVersion = openVersion;
      // Chrome drops focus to BODY when the active button becomes disabled.
      // Keep keyboard dismissal reachable without taking focus back after the user leaves.
      if (refreshFocus) trigger.focus({ preventScroll: true });
      refreshing = true; feedback.hidden = false; feedback.classList.remove('error'); feedback.textContent = copy('正在读取可选模型…', 'Reloading available models…'); controls(); position();
      try { await onRefresh(); feedback.textContent = unavailable() ? catalog.status || copy('模型来源尚未连接，已保留当前配置。', 'Model providers are disconnected. Your current setting is retained.') : copy('可选模型已更新', 'Available models updated'); feedback.classList.toggle('error', unavailable()); }
      catch (error) { feedback.textContent = error?.message || copy('暂时无法读取模型，请重试。', 'Could not reload models. Please retry.'); feedback.classList.add('error'); }
      finally {
        refreshing = false;
        if (!destroyed) {
          controls(); position();
          if (!panel.hidden && view === refreshView && openVersion === refreshVersion && document.activeElement === trigger && refreshFocus?.isConnected && !refreshFocus.disabled && !refreshFocus.closest('[hidden], [inert]')) refreshFocus.focus({ preventScroll: true });
        }
      }
    });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null; observer?.observe(panel); observer?.observe(trigger);
    const api = {
      root, panel, trigger, update, open, close, focus: () => trigger.focus(), get isOpen() { return !panel.hidden; },
      setDisabled(value, { trigger: disableTrigger = true } = {}) { disabled = Boolean(value); triggerDisabled = disabled && disableTrigger; controls(); },
      setStatus(text, error = false) { status.textContent = text || ''; status.hidden = !text; status.classList.toggle('error', error); position(); },
      destroy() {
        if (destroyed) return; close(false); destroyed = true; listeners.forEach(remove => remove()); observer?.disconnect(); panel.remove(); root.remove(); mounts.delete(host);
        if (externalTrigger) { for (const [name, value] of Object.entries(triggerAttributes)) { if (value === null) trigger.removeAttribute(name); else trigger.setAttribute(name, value); } trigger.disabled = initialDisabled; }
      },
    };
    mounts.set(host, api); update({}, {}); setView('menu', false); if (expanded) open(); return api;
  }
  window.jarvisModels = { find, providerName, effortName, appendBadge, mount };
})();
