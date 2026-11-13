
(() => {
  const sidebar = document.getElementById('context-sidebar');
  const panels = [...sidebar.querySelectorAll('.panel')];
  const groups = [
    { title: '待决策', count: 3 },
    { title: '推进', count: 8 },
    { title: '风险', count: 1 },
    { title: '交付', count: 12 },
  ];
  const heading = document.createElement('h2');
  heading.className = 'side-heading';
  heading.textContent = '经营概览';
  const close = document.createElement('button');
  close.type = 'button'; close.id = 'context-close'; close.className = 'icon-button';
  close.setAttribute('aria-label', '收起经营概览');
  close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  heading.append(close);
  const tabs = document.createElement('div');
  tabs.className = 'context-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '经营信息分类');

  const select = index => {
    panels.forEach((panel, i) => {
      panel.hidden = i !== index;
      const button = tabs.children[i];
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });
  };

  panels.forEach((panel, i) => {
    panel.id = `context-panel-${i}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `context-tab-${i}`);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-tab';
    button.id = `context-tab-${i}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    button.innerHTML = `<span>${groups[i].title}</span> <strong>${groups[i].count}</strong>`;
    button.addEventListener('click', () => select(i));
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (i + 1) % panels.length;
      if (event.key === 'ArrowLeft') next = (i + panels.length - 1) % panels.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = panels.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(next);
      tabs.children[next].focus();
    });
    tabs.append(button);
  });

  // Preserve the existing task panels and their click listeners.
  sidebar.replaceChildren(heading, tabs, ...panels);
  select(0);
  const toggle = document.getElementById('context-toggle');
  function setOverview(open) {
    sidebar.hidden = !open;
    document.getElementById('conversation-page').classList.toggle('overview-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) close.focus();
    else toggle.focus();
  }
  toggle.addEventListener('click', () => setOverview(sidebar.hidden));
  close.addEventListener('click', () => setOverview(false));

  const menu = document.getElementById('conversation-menu');
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
  document.getElementById('reset').addEventListener('click', () => { menu.open = false; });
  window.addEventListener('hashchange', () => {
    menu.open = false;
    if (!sidebar.hidden) setOverview(false);
  });


  // Keep keyboard focus within the existing detail dialog while it is open.
  const modal = document.getElementById('mission-modal');
  let returnFocus;
  new MutationObserver(() => {
    if (!modal.hidden) {
      returnFocus = document.activeElement;
      modal.querySelector('[data-action="close"]').focus();
    } else if (returnFocus?.isConnected) {
      returnFocus.focus();
    }
  }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!modal.hidden) modal.querySelector('[data-action="close"]').click();
      else if (menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
      else if (!sidebar.hidden) setOverview(false);
    }
    if (modal.hidden || event.key !== 'Tab') return;
    const buttons = [...modal.querySelectorAll('button')];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });
})();


(() => {
const missions = {
        east: { eyebrow:'战略任务', title:'华东增长计划', objective:'季度收入提升 20%', state:'有风险', progress:'销售预测与预算评估', deadline:'今天 18:00 前', next:'需要你决定：是否批准新增预算 300 万。建议方案 B。', evidence:'依据：销售预测、区域成本模型、客户转化数据已完成交叉验证。' },
        release: { eyebrow:'经营决策', title:'生产系统升级', objective:'完成核心服务版本升级', state:'等待确认', progress:'升级计划与回滚准备', deadline:'本周六 02:00', next:'需要你决定：是否接受周末 2 小时停机窗口。', evidence:'依据：回滚方案、影响范围和客户通知稿已经准备完成。' },
        pr: { eyebrow:'执行交付', title:'PR #128 · 登录流程修复', objective:'完成 Issue #42 并交付可审查 PR', state:'等待审查', progress:'检查已通过', deadline:'现在', next:'需要你验收：查看变更和验证证据，决定是否合并。', evidence:'依据：相关检查已完成，变更范围保持在当前 Issue 内。' }
      };
const modal = document.getElementById('mission-modal');
let active;
document.querySelectorAll('[data-mission]').forEach(button => button.addEventListener('click', () => {
 active = missions[button.dataset.mission];
 for (const name of ['eyebrow','title','objective','state','progress','deadline','next','evidence']) document.getElementById('mission-' + name).textContent = active[name];
 modal.hidden = false;
}));
modal.addEventListener('click', event => {
 const action = event.target.closest('[data-action]')?.dataset.action;
 if (action === 'close') modal.hidden = true;
 if (action === 'ack') { modal.hidden = true; document.getElementById('context-close').click(); const input = document.getElementById('input'); input.value = '我想讨论：' + active.title; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); }
});
})();
