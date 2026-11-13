/* DSH's browser module format; kept as plain JavaScript so the Jarvis entry
   ships with the plugin without requiring a build of the superagent panel. */
window.__ModuleLoader__.load({ id: 'dsh-superagent-jarvis-panel', factory: require => {
  const { createElement: h, useCallback, useLayoutEffect, useRef } = require('react');
  const PANEL = 'dsh-superagent-jarvis';

  function apply(ctx) {
    let anchor = null, frame = null;
    function place() {
      if (!frame) return;
      frame.hidden = !anchor;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      Object.assign(frame.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      if (!frame.hasAttribute('src')) frame.src = '/jarvis/';
    }

    // Main slots unmount on navigation. The shell's persistent overlay seat
    // keeps the same iframe document (and its drafts/stream) alive while hidden.
    function MainPanel() {
      const target = useRef(null);
      useLayoutEffect(() => {
        const element = target.current;
        anchor = element;
        const observer = new ResizeObserver(place);
        observer.observe(element);
        window.addEventListener('resize', place);
        place();
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', place);
          if (anchor === element) anchor = null;
          place();
        };
      }, []);
      return h('div', { ref: target, style: { flex: '1 1 0', minHeight: 0, minWidth: 0, width: '100%', height: '100%' } });
    }
    function PersistentPage() {
      const attach = useCallback(node => { frame = node; place(); }, []);
      return h('iframe', {
        ref: attach, title: '贾维斯工作区', hidden: true,
        style: { position: 'fixed', border: 0, background: '#ffffff', pointerEvents: 'auto', colorScheme: 'light' },
      });
    }
    function Icon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z' }),
        h('path', { d: 'M14.5 8v6a2.5 2.5 0 0 1-5 0' }));
    }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, inject: () => ({}) }, MainPanel));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: PANEL, order: 0 }, PersistentPage));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 9, label: () => '贾维斯' }, Icon));
  }
  return { inject: ['slots'], apply };
} });
