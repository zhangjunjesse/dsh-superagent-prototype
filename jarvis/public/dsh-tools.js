// Loaded by the DSH plugin only; the standalone service retains its isolated design drafts.
(() => {
  const host = document.getElementById('capabilities-page');

  let current = null, request = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const captions = { working_directory: '查看或切换工作目录', read: '读取文件', write: '写入文件', edit: '编辑文件', read_image: '查看图片', glob: '查找文件', grep: '搜索内容', pwsh: '执行 PowerShell 命令', bash: '执行 Shell 命令', skill: '使用技能', web_search: '搜索网页', web_fetch: '读取网页', job_output: '读取后台结果', job_list: '查看后台任务', job_kill: '停止后台任务', todo_write: '更新待办', subagent: '委派子 Agent' };
  const isTools = () => /^#settings\/tools(?:\/.*)?$/.test(location.hash);
  function draw(hash, query = '') {
    let name; try { name = decodeURIComponent(hash.split('/')[2] || ''); } catch { name = ''; }
    const selected = current.tools.find(tool => tool.name === name);
    host.dataset.route = hash;
    const title = selected?.name || '工具';
    document.title = title + ' · ' + assistantIdentity.name;
    host.innerHTML = `<div class="cap-heading"><div><p class="cap-eyebrow">能力管理</p><h1 id="capabilities-title" tabindex="-1">${esc(title)}</h1><p class="cap-subtitle">${selected ? esc(captions[selected.name] || 'Agent 工具') : '管理' + esc(assistantIdentity.name) + '可调用的工具。'}</p></div>${selected ? '<a class="cap-secondary" href="#settings/tools">返回工具</a>' : ''}</div><div class="cap-scroll">${selected ? detail(selected) : `<div class="cap-toolbar"><label class="cap-search"><input id="dsh-tool-search" type="search" aria-label="搜索工具" placeholder="搜索工具" value="${esc(query)}"></label></div><div class="cap-list">${current.tools.filter(tool => `${tool.name} ${captions[tool.name] || ''} ${tool.description}`.toLowerCase().includes(query.toLowerCase())).map(row).join('') || '<p class="cap-empty">没有匹配的工具</p>'}</div>`}</div><footer class="cap-list-footer"><p role="status" id="dsh-tool-feedback">${current.tools.filter(tool => tool.allowed).length} 个已允许 · ${current.tools.length} 个已提供</p></footer>`;
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
    return `<div class="cap-row"><a class="cap-row-main" href="#settings/tools/${encodeURIComponent(tool.name)}">${toolIcon(tool.name)}<div class="cap-row-copy"><strong>${esc(tool.name)}</strong><span>${esc(captions[tool.name] || tool.description.split('\n')[0].slice(0,95))}</span></div></a><span class="cap-status">${tool.allowed ? '已允许' : '已关闭'}</span><button class="cap-switch" role="switch" type="button" aria-label="允许使用 ${esc(tool.name)}" aria-checked="${tool.allowed}" data-dsh-tool="${esc(tool.name)}"><span></span></button></div>`;
  }
  function detail(tool) {
    return `${row(tool)}<div class="cap-section dsh-tool-detail"><h2>工具说明</h2><p style="white-space:pre-wrap;line-height:1.8">${esc(tool.description)}</p></div><div class="cap-section dsh-tool-detail"><h2>调用参数</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(tool.parameters, null, 2))}</pre></div>`;
  }
  capabilitiesUI.render = hash => {
    if (!hash.startsWith('#settings/tools')) { request++; host.dataset.route = hash; host.innerHTML = '<div class="cap-heading"><h1 id="capabilities-title" tabindex="-1">技能</h1></div><div class="cap-empty"><h2>尚未启用技能管理</h2></div>'; return; }
    const revision = ++request;
    host.dataset.route = hash;
    host.innerHTML = '<div class="cap-heading"><h1 id="capabilities-title" tabindex="-1">工具</h1></div><p role="status">正在加载工具…</p>';
    jarvis.api('/api/tools').then(value => { if (revision === request && isTools()) { current = value; draw(hash); } }).catch(error => {
      if (revision === request) host.querySelector('[role=status]').textContent = error.message;
    });
  };
  capabilitiesUI.isDirty = () => false;
  host.addEventListener('input', event => {
    if (event.target.id !== 'dsh-tool-search') return;
    const value = event.target.value; draw(location.hash, value); const search = host.querySelector('#dsh-tool-search'); search.focus();
  });
  host.addEventListener('click', async event => {
    const button = event.target.closest('[data-dsh-tool]');
    if (!button || !current) return;
    const route = location.hash, generation = request;
    host.querySelectorAll('[data-dsh-tool]').forEach(item => item.disabled = true);
    try {
      const updated = await jarvis.api('/api/tools', 'PUT', { name: button.dataset.dshTool, allowed: button.getAttribute('aria-checked') !== 'true', revision: current.revision });
      if (generation !== request || location.hash !== route) return;
      current = updated; draw(route, host.querySelector('#dsh-tool-search')?.value || '');
      [...host.querySelectorAll('[data-dsh-tool]')].find(item => item.dataset.dshTool === button.dataset.dshTool)?.focus();
      host.querySelector('#dsh-tool-feedback').textContent = '工具设置已保存';
    } catch (error) { if (generation === request && isTools()) { host.querySelector('#dsh-tool-feedback').textContent = error.message; host.querySelectorAll('[data-dsh-tool]').forEach(item => item.disabled = false); } }
  });
})();
