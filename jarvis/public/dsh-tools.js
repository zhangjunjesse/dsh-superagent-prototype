// Loaded by the DSH plugin only; the standalone service retains its isolated design drafts.
(() => {
  const host = document.getElementById('capabilities-page');

  let current = null, request = 0, saving = false;
  const rootTools = '#settings/organization/root/jarvis/tools';
  const toolRoute = name => rootTools+(name?'/'+encodeURIComponent(name):'');
  const legacyRoute = hash => hash.replace('#settings/organization/root/jarvis/','#settings/');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const captions = { read: '读取文件', read_image: '查看图片', glob: '查找文件', grep: '搜索内容', current_time: '查看当前时间', calculate: '计算与单位、日期换算', web_search: '搜索网页', web_fetch: '读取网页', jarvis_organization_directory: '查询组织架构与职责', jarvis_work_query: '查询已交办任务', jarvis_work_submit: '交办任务与传递用户决定' };
  const taskControls = new Set(['jarvis_work_query', 'jarvis_work_submit']);
  const eligible = tool => Object.hasOwn(captions, tool.name);
  const isTools = () => /^#settings\/tools(?:\/.*)?$/.test(legacyRoute(location.hash));
  function draw(hash, query = '') {
    let name; try { name = decodeURIComponent(legacyRoute(hash).split('/')[2] || ''); } catch { name = ''; }
    const selected = current.tools.find(tool => tool.name === name);
    host.dataset.route = hash;
    const title = selected?.name || '工具';
    document.title = '组织架构管理 · ' + assistantIdentity.name;
    host.innerHTML = `<div class="cap-heading"><div><p class="cap-eyebrow">贾维斯</p><h1 id="capabilities-title" tabindex="-1">${esc(title)}</h1><p class="cap-subtitle">${selected ? esc(captions[selected.name]) : esc(assistantIdentity.name) + ' 可直接读取、查询和计算，执行工作通过任务交办发送给后台。Worker 工具在本实例独立配置。开关修改后立即保存。'}</p></div>${selected ? '<a class="cap-secondary" href="'+toolRoute()+'">返回工具</a>' : ''}</div><div class="cap-scroll">${selected ? detail(selected) : `<div class="cap-toolbar"><label class="cap-search"><input id="dsh-tool-search" type="search" aria-label="搜索工具" placeholder="搜索工具" value="${esc(query)}"></label></div>${listing(query)}`}</div><footer class="cap-list-footer"><p role="status" id="dsh-tool-feedback">${current.tools.filter(tool => tool.allowed).length} 个已允许 · ${current.tools.length} 个已提供</p></footer>`;
  }
  function listing(query) {
    const tools = current.tools.filter(tool => `${tool.name} ${captions[tool.name]} ${tool.description}`.toLowerCase().includes(query.toLowerCase()));
    return [[false, '读取、查询与计算'], [true, '任务控制']].map(([control, label]) => {
      const group = tools.filter(tool => taskControls.has(tool.name) === control);
      return group.length ? `<section class="cap-section" aria-label="${label}"><h2>${label}</h2><div class="cap-list">${group.map(row).join('')}</div></section>` : '';
    }).join('') || '<p class="cap-empty">没有匹配的工具</p>';
  }
  function toolIcon(name) {
    const paths = /read/.test(name) ? '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>'
      : /write|edit/.test(name) ? '<path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14l-1 7 7-1"/>'
      : /grep|glob/.test(name) ? '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>'
      : /pwsh|bash/.test(name) ? '<path d="m5 6 6 6-6 6m8 0h7"/>'
      : '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 12h8m-4-4v8"/>';
    return '<span class="cap-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg></span>';
  }
  function row(tool) {
    return `<div class="cap-row"><a class="cap-row-main" href="${toolRoute(tool.name)}">${toolIcon(tool.name)}<div class="cap-row-copy"><strong>${esc(tool.name)}</strong><span>${esc(captions[tool.name] || tool.description.split('\n')[0].slice(0,95))}</span></div></a><span class="cap-status">${tool.allowed ? '已允许' : '已关闭'}</span><button class="cap-switch" role="switch" type="button" aria-label="允许使用 ${esc(tool.name)}" aria-checked="${tool.allowed}" data-dsh-tool="${esc(tool.name)}"><span></span></button></div>`;
  }
  function detail(tool) {
    return `${row(tool)}<div class="cap-section dsh-tool-detail"><h2>工具说明</h2><p style="white-space:pre-wrap;line-height:1.8">${esc(tool.description)}</p></div><div class="cap-section dsh-tool-detail"><h2>调用参数</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(tool.parameters, null, 2))}</pre></div>`;
  }
  capabilitiesUI.render = hash => {
    if (!legacyRoute(hash).startsWith('#settings/tools')) { request++; host.dataset.route = hash; host.innerHTML = '<div class="cap-heading"><div><h1 id="capabilities-title" tabindex="-1">技能</h1><p class="cap-subtitle">当前组织的贾维斯在对话中使用的技能。</p></div></div><div class="cap-empty"><h2>贾维斯技能配置尚未接入</h2><p>Worker 的执行技能已在本实例的 Worker 设置中单独管理。</p></div>'; return; }
    const revision = ++request;
    host.dataset.route = hash;
    host.innerHTML = '<div class="cap-heading"><h1 id="capabilities-title" tabindex="-1">工具</h1></div><p role="status">正在加载工具…</p>';
    jarvis.api('/api/tools').then(value => { if (revision === request && isTools()) { current = { ...value, tools: value.tools.filter(eligible) }; draw(hash); } }).catch(error => {
      if (revision === request) host.querySelector('[role=status]').textContent = error.message;
    });
  };
  capabilitiesUI.isDirty = () => false;
  capabilitiesUI.isBusy = () => saving;
  host.addEventListener('input', event => {
    if (event.target.id !== 'dsh-tool-search') return;
    const value = event.target.value; draw(location.hash, value); const search = host.querySelector('#dsh-tool-search'); search.focus();
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('[data-dsh-tool]');
    if (!button || !current) return;
    const route = location.hash, generation = request;
    saving = true;
    host.querySelectorAll('[data-dsh-tool]').forEach(item => item.disabled = true);
    try {
      const updated = await jarvis.api('/api/tools', 'PUT', { name: button.dataset.dshTool, allowed: button.getAttribute('aria-checked') !== 'true', revision: current.revision });
      if (generation !== request || location.hash !== route) return;
      current = { ...updated, tools: updated.tools.filter(eligible) }; draw(route, host.querySelector('#dsh-tool-search')?.value || '');
      [...host.querySelectorAll('[data-dsh-tool]')].find(item => item.dataset.dshTool === button.dataset.dshTool)?.focus();
      host.querySelector('#dsh-tool-feedback').textContent = '工具设置已保存';
    } catch (error) { if (generation === request && isTools()) { host.querySelector('#dsh-tool-feedback').textContent = error.message; host.querySelectorAll('[data-dsh-tool]').forEach(item => item.disabled = false); } }
    finally { saving=false; }
  });
})();
