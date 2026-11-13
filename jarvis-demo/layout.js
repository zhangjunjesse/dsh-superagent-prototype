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
  heading.innerHTML = '经营概览';
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
    button.textContent = `${groups[i].title} ${groups[i].count}`;
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
  toggle.addEventListener('click', () => {
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const open = mobile && !sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', open);
    toggle.setAttribute('aria-expanded', String(open || !mobile));
    if (open || !mobile) tabs.querySelector('[aria-selected="true"]').focus();
  });
  document.getElementById('reset').addEventListener('click', () => {
    select(0);
    sidebar.classList.remove('mobile-open');
    toggle.setAttribute('aria-expanded', 'false');
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
      else {
        sidebar.classList.remove('mobile-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
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
