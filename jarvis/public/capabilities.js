// Design drafts only: no tools are registered, invoked or granted access by this module.
const capabilitiesUI = (() => {
  const host = document.getElementById('capabilities-page');
  const storageKey = 'jarvis.capability-design-drafts.v1';
  const seed = {
    tools: [
      { id: 'github', name: 'GitHub', description: '读取仓库、Issue 与 Pull Request。', icon: 'code', kind: 'remote', scope: 'work', access: 'read', resource: '', endpoint: '', allowed: false },
      { id: 'files', name: '工作文件', description: '访问你指定的文件与目录。', icon: 'folder', kind: 'files', scope: 'work', access: 'read', resource: '', endpoint: '', allowed: false },
      { id: 'web', name: '网页读取', description: '读取公开网页，获取原始资料。', icon: 'globe', kind: 'remote', scope: 'chat', access: 'read', resource: '', endpoint: '', allowed: false },
    ],
    skills: [
      { id: 'issue-fix', name: '问题修复', description: '从复现问题到提交可审查的修改。', icon: 'code', scope: 'work', allowed: false, dependencies: ['github', 'files'], content: '# 适用场景\n处理明确的缺陷或 GitHub Issue。\n\n# 工作步骤\n1. 确认问题、范围和验收条件。\n2. 复现问题，保留失败证据。\n3. 完成必要修改，验证相关行为。\n4. 交付修改说明和验证结果。\n\n# 完成条件\n问题得到修复，相关检查通过，结果可以审查。' },
      { id: 'delivery-review', name: '交付审查', description: '按目标和证据检查交付质量。', icon: 'check', scope: 'work', allowed: false, dependencies: ['github', 'files'], content: '# 适用场景\n检查一项工作是否达到约定的完成条件。\n\n# 检查内容\n- 对照原始目标，确认没有遗漏或扩大范围。\n- 阅读实际变更与验证证据。\n- 区分已通过、未通过和未验证的检查。\n\n# 输出要求\n给出审查结论、依据和仍需处理的问题。' },
      { id: 'research', name: '资料整理', description: '提炼资料要点，保留来源与分歧。', icon: 'book', scope: 'chat', allowed: false, dependencies: ['web'], content: '# 适用场景\n围绕一个明确问题查阅与整理资料。\n\n# 工作步骤\n1. 明确需要回答的问题。\n2. 查阅相关原始资料。\n3. 区分事实、推断与尚未确认的信息。\n\n# 输出要求\n简洁回答问题，并保留可核对的来源。' },
    ],
  };
  let data = JSON.parse(JSON.stringify(seed));
  let category = 'tools', item = null, baseline = '', filter = 'all', query = '';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paths = {
    code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    check: '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M8 11l4 4L22 3"/>',
    book: '<path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    arrow: '<path d="m9 5 7 7-7 7"/>',
    back: '<path d="m14 5-7 7 7 7"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.code}</svg>`;
  const scopeName = scope => scope === 'work' ? '执行任务' : '助手对话';
  const route = () => '#settings/' + category;
  const title = () => category === 'tools' ? '工具' : '技能';
  const isRoute = hash => /^#settings\/(tools|skills)(\/[^/]+)?$/.test(hash);
  function validItem(value, group) {
    return value && typeof value.id === 'string' && /^[\w-]{1,80}$/.test(value.id) &&
      ['name', 'description', 'scope', 'icon'].every(key => typeof value[key] === 'string') &&
      typeof value.allowed === 'boolean' && ['chat', 'work'].includes(value.scope) &&
      (group === 'tools' ? ['kind', 'access', 'resource', 'endpoint'].every(key => typeof value[key] === 'string') :
        typeof value.content === 'string' && Array.isArray(value.dependencies) && value.dependencies.every(id => typeof id === 'string'));
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey));
    if (stored && ['tools', 'skills'].every(group => Array.isArray(stored[group]) && stored[group].length <= 100 && stored[group].every(entry => validItem(entry, group)))) data = stored;
  } catch { /* Unavailable browser storage leaves the editable defaults intact. */ }
  function feedback(text, error = false) {
    const target = host.querySelector('[data-feedback]');
    if (target) { target.textContent = text; target.classList.toggle('error', error); }
  }
  function persist(next) {
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); data = next; return true; }
    catch { feedback('无法保存草稿，请检查浏览器存储是否可用。', true); return false; }
  }
  function status(entry) {
    if (category === 'tools') return { text: '未连接', tone: 'muted' };
    return { text: entry.allowed ? '待就绪' : '草稿', tone: entry.allowed ? 'amber' : 'muted' };
  }
  function switchControl(entry, list = false) {
    return `<button class="cap-switch" type="button" role="switch" aria-label="允许使用${escape(entry.name || title())}" aria-checked="${entry.allowed}" ${list ? `data-toggle="${escape(entry.id)}"` : 'id="cap-allowed"'}><span></span></button>`;
  }
  function renderRows() {
    const rows = data[category].filter(entry => `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' || (filter === 'allowed' ? entry.allowed : !entry.allowed)));
    const target = host.querySelector('#cap-list');
    target.innerHTML = rows.length ? rows.map(entry => {
      const state = status(entry);
      return `<article class="cap-row">
        <a class="cap-row-main" href="${route()}/${escape(entry.id)}" aria-label="${escape(entry.name)}，${category === 'tools' ? '配置工具' : '编辑技能'}">
          <span class="cap-icon ${category === 'skills' ? 'skill' : ''}">${icon(entry.icon)}</span>
          <span class="cap-row-copy"><strong>${escape(entry.name)}</strong><span>${escape(entry.description)}</span><small>${scopeName(entry.scope)}${category === 'skills' ? ` · ${entry.dependencies.length} 个依赖工具` : ''}</small></span>
        </a>
        <span class="cap-status ${state.tone}"><i></i>${state.text}</span>
        <span class="cap-row-switch">${switchControl(entry, true)}</span>
        <a class="cap-row-open" href="${route()}/${escape(entry.id)}" aria-label="打开${escape(entry.name)}">${icon('arrow')}</a>
      </article>`;
    }).join('') : `<div class="cap-empty">${icon('search')}<h2>没有匹配的${title()}</h2><p>换个关键词，或查看全部。</p><button class="reset" type="button" data-clear-search>清除筛选</button></div>`;
    host.querySelector('#cap-count').textContent = `${data[category].length} 个${title()}`;
  }
  function renderList() {
    item = null; baseline = ''; filter = 'all'; query = '';
    host.innerHTML = `<header class="cap-heading">
      <div><p class="cap-eyebrow">能力管理</p><h1 id="capabilities-title" tabindex="-1">${title()}</h1><p class="cap-subtitle">${category === 'tools' ? '连接服务，控制访问范围。' : '定义工作方法与交付标准。'}</p></div>
      <a class="cap-primary" href="${route()}/new">${icon('plus')}${category === 'tools' ? '添加工具' : '新建技能'}</a>
    </header>
    <div class="cap-toolbar"><label class="cap-search">${icon('search')}<input id="cap-search" type="search" placeholder="搜索${title()}" aria-label="搜索${title()}" autocomplete="off"></label>
      <div class="cap-filters" role="group" aria-label="使用筛选"><button type="button" data-filter="all" aria-pressed="true">全部</button><button type="button" data-filter="allowed" aria-pressed="false">允许使用</button><button type="button" data-filter="off" aria-pressed="false">已关闭</button></div></div>
    <div class="cap-list-heading"><span id="cap-count"></span><span>状态<span class="cap-switch-heading">允许使用</span></span></div>
    <div class="cap-scroll"><div class="cap-list" id="cap-list"></div></div>
    <div class="cap-list-footer"><span>${category === 'tools' ? '尚未连接任何工具' : '尚无可用技能'}</span><span data-feedback role="status"></span></div>`;
    renderRows();
  }
  function scopeField() {
    return `<fieldset class="cap-scope"><legend>使用范围</legend>${[['chat', '助手对话', '在与你对话时使用'], ['work', '执行任务', '在推进具体任务时使用']].map(([value, label, note]) => `<label><input type="radio" name="scope" value="${value}" ${item.scope === value ? 'checked' : ''}><span><strong>${label}</strong><small>${note}</small></span></label>`).join('')}</fieldset>`;
  }
  const field = (name, label, value, options = '') => `<label class="cap-field"><span>${label}</span><input id="cap-${name}" name="${name}" value="${escape(value)}" ${options}></label>`;
  function toolFields() {
    return `<section class="cap-section"><h2>服务信息</h2>
      ${field('name', '工具名称', item.name, 'maxlength="60" required placeholder="例如：知识库"')}
      ${field('description', '用途', item.description, 'maxlength="160" placeholder="用一句话说明能做什么"')}
      <label class="cap-field"><span>连接方式</span><select id="cap-kind" name="kind"><option value="remote" ${item.kind === 'remote' ? 'selected' : ''}>网络服务</option><option value="files" ${item.kind === 'files' ? 'selected' : ''}>文件目录</option></select></label>
      <div id="cap-endpoint-wrap" ${item.kind === 'files' ? 'hidden' : ''}>${field('endpoint', '服务地址', item.endpoint, 'type="url" placeholder="https://service.example.com" autocomplete="off" spellcheck="false"')}</div>
    </section><section class="cap-section"><h2>访问范围</h2>
      ${field('resource', item.kind === 'files' ? '允许访问的目录' : '允许访问的资源', item.resource, 'maxlength="500" placeholder="指定目录、仓库或资源范围"')}
      <label class="cap-field"><span>访问权限</span><select name="access" id="cap-access"><option value="read" ${item.access === 'read' ? 'selected' : ''}>仅查看</option><option value="write" ${item.access === 'write' ? 'selected' : ''}>查看与修改</option></select></label>
    </section>`;
  }
  function skillFields() {
    return `<section class="cap-section"><h2>技能信息</h2>
      ${field('name', '技能名称', item.name, 'maxlength="60" required placeholder="例如：项目周报"')}
      ${field('description', '用途', item.description, 'maxlength="160" placeholder="什么时候使用，解决什么问题"')}
    </section><section class="cap-section cap-instructions"><div class="cap-section-heading"><h2>技能内容</h2><span>Markdown</span></div>
      <label class="sr-only" for="cap-content">技能内容</label><textarea id="cap-content" name="content" maxlength="16000" spellcheck="false" placeholder="# 适用场景&#10;&#10;# 工作步骤&#10;&#10;# 完成条件">${escape(item.content)}</textarea>
    </section>`;
  }
  function sideFields() {
    const dependencies = category === 'skills' ? `<section class="cap-aside-section"><h2>依赖工具</h2><div class="cap-dependencies">${data.tools.map(tool => `<label class="cap-dependency"><input type="checkbox" name="dependency" value="${escape(tool.id)}" ${item.dependencies.includes(tool.id) ? 'checked' : ''}><span>${escape(tool.name)}<small>未连接 · ${scopeName(tool.scope)}</small></span></label>`).join('')}</div><p class="cap-note" id="cap-dependency-note"></p><a class="cap-text-link" href="#settings/tools">管理工具 ${icon('arrow')}</a></section>` :
      `<section class="cap-aside-section"><h2>关联技能</h2>${data.skills.filter(skill => skill.dependencies.includes(item.id)).map(skill => `<a class="cap-related" href="#settings/skills/${escape(skill.id)}">${escape(skill.name)}${icon('arrow')}</a>`).join('') || '<p class="cap-note">暂无技能依赖此工具</p>'}</section>`;
    return `<aside class="cap-detail-aside"><div class="cap-state-box"><span class="cap-icon ${category === 'skills' ? 'skill' : ''}">${icon(item.icon)}</span><div><strong>${category === 'tools' ? '未连接' : '尚未就绪'}</strong><p>${category === 'tools' ? '完成连接后可使用' : '完成接入并连接依赖工具'}</p></div></div>
      <section class="cap-aside-section">${scopeField()}<div class="cap-allow"><span>允许使用</span>${switchControl(item)}</div><p class="cap-note">${category === 'tools' ? '连接成功后，按所选范围使用。' : '就绪后，按所选范围使用。'}</p></section>${dependencies}</aside>`;
  }
  function renderEditor(id) {
    const found = data[category].find(entry => entry.id === id);
    if (!found && id !== 'new') {
      item = null; baseline = '';
      host.innerHTML = `<div class="cap-empty"><h1 id="capabilities-title" tabindex="-1">找不到此${title()}</h1><a class="cap-primary" href="${route()}">返回${title()}列表</a></div>`;
      return;
    }
    item = found ? JSON.parse(JSON.stringify(found)) : category === 'tools' ?
      { id: crypto.randomUUID(), name: '', description: '', icon: 'code', kind: 'remote', scope: 'chat', access: 'read', resource: '', endpoint: '', allowed: false } :
      { id: crypto.randomUUID(), name: '', description: '', icon: 'book', scope: 'chat', allowed: false, dependencies: [], content: '' };
    host.innerHTML = `<form id="cap-editor" class="cap-editor" novalidate autocomplete="off">
      <header class="cap-editor-heading"><a class="cap-back" href="${route()}">${icon('back')}全部${title()}</a><div class="cap-editor-title"><h1 id="capabilities-title" tabindex="-1">${escape(found ? item.name : '新建' + title())}</h1><span class="cap-status muted"><i></i>草稿</span></div></header>
      <div class="cap-scroll"><div class="cap-detail-grid"><div class="cap-detail-main">${category === 'tools' ? toolFields() : skillFields()}</div>${sideFields()}</div></div>
      <footer class="cap-editor-footer"><p role="status" data-feedback>无未保存的修改</p><a class="cap-secondary" href="${route()}">返回</a><button class="cap-primary" id="cap-save" type="submit" disabled>保存草稿</button></footer>
    </form>`;
    baseline = JSON.stringify(readEditor());
    dependencyNote();
  }
  function readEditor() {
    if (!item || !host.querySelector('#cap-editor')) return null;
    const value = name => host.querySelector(`[name="${name}"]`).value.trim();
    const common = { ...item, name: value('name'), description: value('description'), scope: host.querySelector('[name="scope"]:checked').value,
      allowed: host.querySelector('#cap-allowed').getAttribute('aria-checked') === 'true' };
    return category === 'tools' ? { ...common, kind: value('kind'), endpoint: value('kind') === 'files' ? '' : value('endpoint'), access: value('access'), resource: value('resource') } :
      { ...common, content: value('content'), dependencies: [...host.querySelectorAll('[name="dependency"]:checked')].map(el => el.value) };
  }
  const isDirty = () => Boolean(item && JSON.stringify(readEditor()) !== baseline);
  function dependencyNote() {
    const note = host.querySelector('#cap-dependency-note');
    if (!note) return;
    const draft = readEditor();
    const mismatch = draft.dependencies.some(id => data.tools.find(tool => tool.id === id)?.scope !== draft.scope);
    note.textContent = mismatch ? '部分工具的使用范围与此技能不同，需要调整。' : draft.dependencies.length ? `${draft.dependencies.length} 个工具尚未连接。` : '没有指定依赖工具。';
    note.classList.toggle('attention', mismatch);
  }
  function changed() {
    if (!item) return;
    const kind = host.querySelector('#cap-kind');
    if (kind) {
      host.querySelector('#cap-endpoint-wrap').hidden = kind.value === 'files';
      host.querySelector('#cap-resource').previousElementSibling.textContent = kind.value === 'files' ? '允许访问的目录' : '允许访问的资源';
    }
    host.querySelector('#cap-save').disabled = !isDirty();
    feedback(isDirty() ? '有未保存的修改' : '无未保存的修改');
    dependencyNote();
  }
  function save(event) {
    event.preventDefault();
    const draft = readEditor();
    if (!draft) return;
    let error;
    if (!draft.name) error = ['name', '请输入名称'];
    else if (category === 'skills' && !draft.content) error = ['content', '请填写技能内容'];
    else if (category === 'tools' && draft.endpoint) {
      try {
        const url = new URL(draft.endpoint);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw 0;
      } catch { error = ['endpoint', '请填写不包含凭据或查询参数的 HTTP(S) 地址']; }
    }
    if (error) { host.querySelector('#cap-' + error[0]).focus(); feedback(error[1], true); return; }
    const exists = data[category].some(entry => entry.id === draft.id);
    const next = { ...data, [category]: exists ? data[category].map(entry => entry.id === draft.id ? draft : entry) : [...data[category], draft] };
    if (!persist(next)) return;
    item = draft; baseline = JSON.stringify(draft);
    history.replaceState(null, '', route() + '/' + draft.id);
    host.dataset.route = location.hash;
    host.querySelector('#capabilities-title').textContent = draft.name;
    document.title = draft.name + ' · ' + assistantIdentity.name;
    host.querySelector('#cap-save').disabled = true;
    feedback('草稿已保存');
  }
  host.addEventListener('submit', save);
  host.addEventListener('input', event => {
    if (event.target.id === 'cap-search') { query = event.target.value; renderRows(); } else changed();
  });
  host.addEventListener('change', changed);
  host.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-filter')) {
      filter = button.dataset.filter;
      host.querySelectorAll('[data-filter]').forEach(el => el.setAttribute('aria-pressed', String(el === button)));
      renderRows();
    }
    if (button.hasAttribute('data-clear-search')) renderList();
    if (button.id === 'cap-allowed') { button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true')); changed(); }
    if (button.hasAttribute('data-toggle')) {
      const id = button.dataset.toggle;
      const next = { ...data, [category]: data[category].map(entry => entry.id === id ? { ...entry, allowed: !entry.allowed } : entry) };
      if (persist(next)) { renderRows(); feedback('使用偏好已保存为草稿'); host.querySelector(`[data-toggle="${id}"]`)?.focus(); }
    }
  });
  return {
    isRoute, isDirty,
    discard() { item = null; baseline = ''; },
    render(hash) {
      host.dataset.route = hash;
      category = hash.split('/')[1];
      const id = hash.split('/')[2];
      if (id) renderEditor(id); else renderList();
    },
  };
})();
