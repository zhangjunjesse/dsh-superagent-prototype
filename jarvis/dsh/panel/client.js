/* DSH's browser module format; kept as plain JavaScript so the Jarvis entry
   ships with the plugin without requiring a build of the superagent panel. */
window.__ModuleLoader__.load({ id: 'dsh-superagent-jarvis-panel', factory: require => {
  const { createElement: h, useCallback, useLayoutEffect, useRef } = require('react');
  const PANEL = 'dsh-superagent-jarvis';

  function apply(ctx) {
    let anchor = null, frame = null;
    const seen = new Set();
    ctx.effect(() => {
      let disposed=false;
      const listed=async (sessionId,refresh=false)=>{
        let catalog=ctx.sessions.list.getSnapshot();
        if (refresh || catalog.phase!=='ready' || !catalog.byId[sessionId]) { await ctx.sessions.refresh(); catalog=ctx.sessions.list.getSnapshot(); }
        if (catalog.phase!=='ready') throw new Error('原生会话列表尚未就绪，请重试。');
        if (!catalog.byId[sessionId]) throw new Error('原生会话列表中没有此会话，请刷新后重试。');
      };
      const receive=async event=>{
        const message=event.data;
        if (disposed || event.origin!==location.origin || !frame?.contentWindow || event.source!==frame.contentWindow
          || !message || message.type!=='jarvis:session:open' || message.version!==1
          || typeof message.requestId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(message.requestId)
          || typeof message.sessionId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(message.sessionId)
          || seen.has(message.requestId)) return;
        const source=event.source, requestId=message.requestId, sessionId=message.sessionId;
        seen.add(requestId);
        if(seen.size>256)seen.delete(seen.values().next().value);
        const current=()=>!disposed && frame?.contentWindow===source;
        try {
          await listed(sessionId);
          if (!current()) return;
          await ctx.uiWorkspace.openSession(sessionId);
          if (current()) source.postMessage({type:'jarvis:session:opened',version:1,requestId,sessionId,ok:true},location.origin);
        } catch (error) {
          if (current()) source.postMessage({type:'jarvis:session:opened',version:1,requestId,sessionId,ok:false,
            error:error instanceof Error?error.message:'打开原生会话失败，请重试。'},location.origin);
        }
      };
      window.addEventListener('message',receive);
      const address=new URL(location.href), deepSession=address.searchParams.get('jarvis-session');
      let failure;
      if (deepSession!==null) void (async()=>{
        try {
          if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(deepSession))throw new Error('原生会话标识无效。');
          await listed(deepSession,true);
          if(disposed)return;
          await ctx.uiWorkspace.openSession(deepSession);
          if(disposed)return;
          const current=new URL(location.href);
          if(current.searchParams.get('jarvis-session')===deepSession){current.searchParams.delete('jarvis-session');history.replaceState(null,'',current);}
          window.opener?.postMessage({type:'jarvis:session:opened',version:1,requestId:'deep-link',sessionId:deepSession,ok:true},location.origin);
        } catch(error) {
          if(disposed)return;
          const message=error instanceof Error?error.message:'打开原生会话失败，请重试。';
          failure=document.createElement('div');failure.className='jarvis-session-open-error';failure.setAttribute('role','alert');
          failure.style.cssText='position:fixed;left:16px;right:16px;bottom:16px;z-index:10000;padding:16px;background:#fff3f3;color:#842020;border:1px solid #e6bcbc;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere';
          failure.textContent=message+'\n会话标识：'+deepSession;document.body.append(failure);
          window.opener?.postMessage({type:'jarvis:session:opened',version:1,requestId:'deep-link',sessionId:deepSession,ok:false,error:message},location.origin);
        }
      })();
      return ()=>{disposed=true;window.removeEventListener('message',receive);seen.clear();failure?.remove();};
    });
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
  return { inject: ['slots','sessions','uiWorkspace'], apply };
} });
