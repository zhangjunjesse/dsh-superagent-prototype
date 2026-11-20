/* The Desktop entry owns navigation only; the existing 4318 service owns all
   conversations, settings and execution. Authentication URLs never enter a
   persisted browser-tab store or a webview src attribute. */
window.__ModuleLoader__.load({ id: 'dsh-superjarvis-desktop-entry', factory: require => {
  const { createElement: h, useCallback, useLayoutEffect, useRef } = require('react');
  const PANEL = 'superjarvis';
  const CHANNEL = '/api';
  const ENDPOINT = 'superjarvis-desktop-entry/';
  const ROOT = 'http://127.0.0.1:4318/';
  const JARVIS = ROOT + 'jarvis/';
  const WORKSPACE = 'superjarvis-desktop:4318';
  const failure = code => Object.assign(new Error(code), { code });
  const cancelled = () => failure('cancelled');

  function messageFor(error) {
    if (error?.code === 'unsupported-host') return '当前桌面版本不支持内嵌页面，请更新桌面，或在浏览器打开。';
    if (error?.code === 'authentication-failed') return 'SuperJarvis 登录未完成，请重试连接。';
    if (error?.code === 'guest-failed') return 'SuperJarvis 页面已中断，请重新连接，或在浏览器打开。';
    return '暂时无法连接 SuperJarvis，请确认服务已启动，然后重试。';
  }

  function validateEntry(value) {
    if (!value || value.jarvisUrl !== JARVIS || !Number.isFinite(value.expiresAt)
      || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 120000) throw failure('authentication-failed');
    let url;
    try { url = new URL(value.launchUrl); } catch { throw failure('authentication-failed'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || url.search || url.hash || !/^\/launch\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) throw failure('authentication-failed');
    return url.href;
  }

  /** Guest storage is process-local; older Electron bridges may omit this optional API. */
  function clearGuestHistory(view) {
    try { if (typeof view.clearHistory === 'function') view.clearHistory(); } catch { /* The dedicated, nonpersistent guest still owns this in-memory history. */ }
  }

  /** Cancel and time-bound native operations without retaining their URL in UI state. */
  function observeOperation(operation, signal, milliseconds = 20000) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(cancelled()); return; }
      let settled = false;
      const finish = (complete, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', stop);
        complete(value);
      };
      const stop = () => finish(reject, cancelled());
      const timeout = setTimeout(() => finish(reject, failure('guest-failed')), milliseconds);
      signal.addEventListener('abort', stop, { once: true });
      Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  /** One guest for this plugin lifetime, including while another main panel is selected. */
  class DesktopEntry {
    constructor(ctx) {
      this.ctx = ctx;
      this.status = 'idle';
      this.message = '正在连接 SuperJarvis…';
      this.disposed = false;
      this.releases = new Set();
    }

    async call(method, signal) {
      if (typeof this.ctx.connection?.rpc?.call !== 'function') throw failure('unsupported-host');
      // /api owns the authenticated Fetch carrier. Plugin channels outside its
      // injection domain cannot register the host-side generic RPC service.
      const response = await this.ctx.connection.rpc.call(CHANNEL, ENDPOINT + method, {}, signal);
      if (response?.ok !== true) throw failure(response?.error?.code || 'service-unavailable');
      return response.value;
    }

    mount(host) {
      this.host = host;
      if (!host || this.disposed) return;
      const node = (tag, text, style) => {
        const element = document.createElement(tag);
        if (text) element.textContent = text;
        Object.assign(element.style, style);
        return element;
      };
      const header = node('header', '', { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 16px', borderBottom: '1px solid #e5e7eb', flex: '0 0 auto' });
      header.append(node('strong', 'SuperJarvis', { fontSize: '15px' }));
      this.notice = node('span', '', { flex: '1', fontSize: '13px', color: '#626a75' });
      this.notice.setAttribute('role', 'status');
      this.notice.setAttribute('aria-live', 'polite');
      this.browserButton = node('button', '在浏览器打开', { padding: '6px 12px', cursor: 'pointer' });
      this.browserButton.type = 'button';
      this.browserButton.setAttribute('aria-label', '在系统浏览器打开 DSH，可从贾维斯打开或下载文件');
      this.browserButton.title = '在系统浏览器打开 DSH，可从贾维斯打开或下载文件';
      this.browserButton.addEventListener('click', () => this.openBrowser());
      header.append(this.notice, this.browserButton);
      this.content = node('div', '', { position: 'relative', flex: '1 1 0', minHeight: '0', minWidth: '0', display: 'flex' });
      this.cover = node('div', '', { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px', padding: '24px', textAlign: 'center', background: '#ffffff', zIndex: '1' });
      this.description = node('p', '', { margin: '0', maxWidth: '480px', lineHeight: '1.7' });
      this.retryButton = node('button', '重试连接', { padding: '8px 18px', cursor: 'pointer' });
      this.retryButton.type = 'button';
      this.retryButton.addEventListener('click', () => this.start());
      this.cover.append(this.description, this.retryButton);
      this.content.append(this.cover);
      host.append(header, this.content);
      this.paint();
      this.place();
      if (this.anchor) this.start();
    }

    select(anchor) {
      this.anchor = anchor;
      const place = () => this.place();
      const observer = new ResizeObserver(place);
      observer.observe(anchor);
      window.addEventListener('resize', place);
      this.place();
      if (this.status === 'idle') this.start();
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', place);
        if (this.anchor === anchor) this.anchor = undefined;
        this.place();
      };
    }

    place() {
      if (!this.host) return;
      const rect = this.anchor?.getBoundingClientRect();
      this.host.hidden = !rect;
      this.host.style.display = rect ? 'flex' : 'none';
      if (rect) Object.assign(this.host.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }

    paint() {
      if (!this.host || this.disposed) return;
      this.description.textContent = this.message;
      this.description.setAttribute('role', this.status === 'error' ? 'alert' : 'status');
      this.cover.style.display = this.status === 'ready' ? 'none' : 'flex';
      this.retryButton.hidden = this.status !== 'error';
      this.notice.textContent = this.status === 'ready' ? '已连接' : this.status === 'connecting' ? '连接中…' : '';
      this.browserButton.disabled = typeof this.ctx.connection?.rpc?.call !== 'function' || !!this.openingBrowser;
    }

    setState(status, message = '') {
      this.status = status;
      this.message = message;
      this.paint();
    }

    start() {
      if (this.disposed || !this.host || !this.anchor || this.pending) return;
      const attempt = { abort: new AbortController() };
      this.attempt = attempt;
      this.setState('connecting', '正在连接 SuperJarvis…');
      this.pending = this.connect(attempt).catch(async error => {
        await this.dropGuest();
        if (!this.disposed && !attempt.abort.signal.aborted) this.setState('error', messageFor(error));
      }).finally(() => {
        if (this.attempt === attempt) this.attempt = undefined;
        this.pending = undefined;
      });
    }

    current(attempt) {
      if (this.disposed || attempt.abort.signal.aborted || this.attempt !== attempt) throw cancelled();
      if (attempt.failure) throw attempt.failure;
    }

    async connect(attempt) {
      const carrier = globalThis.dshDesktop;
      const bridge = carrier?.protocolVersion === 1 ? carrier.browser : undefined;
      if (typeof bridge?.acquire !== 'function' || typeof bridge?.release !== 'function') throw failure('unsupported-host');
      const state = await this.call('state', attempt.abort.signal);
      this.current(attempt);
      if (state?.ready !== true || state.jarvisUrl !== JARVIS) throw failure('service-unavailable');
      await this.dropGuest();
      this.current(attempt);
      const reservation = await bridge.acquire(WORKSPACE);
      if (this.disposed || attempt.abort.signal.aborted) {
        await this.release(bridge, reservation?.lease);
        throw cancelled();
      }
      if (typeof reservation?.lease !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(reservation.lease)
        || typeof reservation.partition !== 'string' || !reservation.partition || reservation.partition.startsWith('persist:')) {
        await this.release(bridge, reservation?.lease);
        throw failure('unsupported-host');
      }
      this.reservation = { bridge, lease: reservation.lease };
      const view = this.createGuest(reservation, attempt);
      await observeOperation(this.guestReady, attempt.abort.signal, 15000);
      this.current(attempt);
      const entry = await this.call('entry', attempt.abort.signal);
      this.current(attempt);
      const launchUrl = validateEntry(entry);
      await this.navigate(view, launchUrl, attempt);
      const authenticated = new URL(view.getURL());
      if (authenticated.href !== ROOT) throw failure('authentication-failed');
      clearGuestHistory(view);
      await this.navigate(view, JARVIS, attempt);
      const finalUrl = new URL(view.getURL());
      if (finalUrl.origin !== new URL(ROOT).origin || !finalUrl.pathname.startsWith('/jarvis/') || finalUrl.searchParams.has('token')) throw failure('authentication-failed');
      clearGuestHistory(view);
      this.setState('ready');
    }

    createGuest(reservation, attempt) {
      const view = document.createElement('webview');
      this.view = view;
      this.guestAbort = new AbortController();
      const signal = this.guestAbort.signal;
      view.dataset.sidebarBrowserFrame = 'webview';
      view.setAttribute('name', reservation.lease);
      view.setAttribute('partition', reservation.partition);
      view.setAttribute('src', 'about:blank#' + reservation.lease);
      view.setAttribute('aria-label', 'SuperJarvis 工作区');
      Object.assign(view.style, { display: 'flex', flex: '1 1 0', minWidth: '0', minHeight: '0', width: '100%', height: '100%', border: '0' });
      this.guestReady = new Promise(resolve => view.addEventListener('dom-ready', resolve, { once: true, signal }));
      const interrupted = (code = 'guest-failed') => {
        if (this.view !== view || this.disposed) return;
        attempt.failure = failure(code);
        this.setState('error', messageFor(attempt.failure));
      };
      view.addEventListener('did-fail-load', event => {
        if (event.isMainFrame && event.errorCode !== -3) interrupted();
      }, { signal });
      view.addEventListener('did-navigate', event => {
        if (event.httpResponseCode >= 400) interrupted(event.httpResponseCode === 401 ? 'authentication-failed' : 'guest-failed');
      }, { signal });
      for (const name of ['render-process-gone', 'destroyed']) view.addEventListener(name, () => interrupted(), { signal });
      view.addEventListener('new-window', event => event.preventDefault(), { signal });
      // The main process denies new windows and downloads. Do not forward its
      // open-request event into browser tabs, which would persist launch URLs.
      if (typeof this.reservation.bridge.onOpenRequested === 'function') {
        this.unsubscribeOpen = this.reservation.bridge.onOpenRequested(reservation.lease, () => {
          if (!this.disposed && this.view === view && this.notice) this.notice.textContent = '新窗口已阻止，可在浏览器中继续。';
        });
      }
      this.content.append(view);
      return view;
    }

    async navigate(view, url, attempt) {
      this.current(attempt);
      await observeOperation(view.loadURL(url), attempt.abort.signal);
      this.current(attempt);
    }

    async openBrowser() {
      if (this.disposed || this.openingBrowser) return;
      this.openingBrowser = true;
      this.paint();
      try {
        const result = await this.call('openBrowser');
        if (!this.disposed && this.notice) this.notice.textContent = result?.opened === true ? '已在浏览器打开' : '浏览器未能打开，请重试。';
      } catch {
        if (!this.disposed && this.notice) this.notice.textContent = '浏览器未能打开，请确认服务已启动，然后重试。';
      } finally {
        this.openingBrowser = false;
        if (!this.disposed && this.browserButton) this.browserButton.disabled = typeof this.ctx.connection?.rpc?.call !== 'function';
      }
    }

    release(bridge, lease) {
      if (typeof lease !== 'string') return Promise.resolve();
      const released = Promise.resolve().then(() => bridge.release(lease)).catch(() => {
        this.ctx.logger?.warn('SuperJarvis 页面租约释放失败');
      }).finally(() => this.releases.delete(released));
      this.releases.add(released);
      return released;
    }

    dropGuest() {
      this.guestAbort?.abort();
      this.guestAbort = undefined;
      this.guestReady = undefined;
      this.unsubscribeOpen?.();
      this.unsubscribeOpen = undefined;
      this.view?.remove();
      this.view = undefined;
      const reservation = this.reservation;
      this.reservation = undefined;
      return reservation ? this.release(reservation.bridge, reservation.lease) : Promise.resolve();
    }

    async dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.attempt?.abort.abort();
      await this.dropGuest();
      await Promise.all(this.releases);
      this.host?.replaceChildren();
      this.host = undefined;
    }
  }

  function apply(ctx) {
    const entry = new DesktopEntry(ctx);
    ctx.effect(() => () => entry.dispose());
    function MainPanel() {
      const anchor = useRef(null);
      useLayoutEffect(() => entry.select(anchor.current), []);
      return h('div', { ref: anchor, style: { flex: '1 1 0', minHeight: 0, minWidth: 0, width: '100%', height: '100%' } });
    }
    function PersistentPage() {
      const attach = useCallback(host => entry.mount(host), []);
      return h('section', { ref: attach, hidden: true, 'aria-label': 'SuperJarvis', style: {
        position: 'fixed', display: 'none', flexDirection: 'column', minWidth: 0, minHeight: 0,
        border: 0, background: '#ffffff', color: '#20262f', pointerEvents: 'auto', colorScheme: 'light',
      } });
    }
    function Icon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z' }), h('path', { d: 'M14.5 8v6a2.5 2.5 0 0 1-5 0' }));
    }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, inject: () => ({}) }, MainPanel));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: PANEL, order: 0 }, PersistentPage));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 9, label: () => '贾维斯' }, Icon));
  }
  return { inject: ['slots', 'connection'], apply };
} });
