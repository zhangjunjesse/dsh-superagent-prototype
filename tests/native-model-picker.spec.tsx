// @vitest-environment jsdom
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'
import { click, find, settle, translator } from './fixtures/panel.tsx'
import { server, usePanelServer } from './fixtures/panel-server.ts'

let root: Root | undefined, host: HTMLElement | undefined
const unmount = () => { act(() => { root?.unmount() }); root = undefined; host?.remove(); host = undefined }
usePanelServer(unmount)

async function mount(group: 'eval' | 'execution', dictionary = zh) {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'settings', query: { group } }, stack: [] }))
  const t = translator(dictionary), original = fetch
  const directory = { default: { provider: 'worker-provider', model: 'worker-model' }, routableProviders: [], failures: [], groups: [
    { id: 'worker-provider', name: 'Worker provider', models: [{ id: 'worker-model', name: 'Worker model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      { id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] },
    { id: 'other-provider', name: 'Other provider', models: [{ id: 'worker-model', name: 'Worker model' }, { id: 'gamma', name: 'Gamma' }] },
    { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'official', name: 'Unchanged official model', badge: { text: { en: 'Official', zh: '官方' } } }] },
  ] }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url, 'http://native.invalid').pathname.endsWith('/models')) {
      server.requests.push({ path: 'models', method: init?.method ?? 'GET' }); return Response.json(directory)
    }
    return original(url, init)
  }))
  let Main: ComponentType<{ t: T }> | undefined
  const ctx = {
    effect: (effect: () => unknown) => effect(),
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: { name: string }, component: ComponentType<{ t: T }>) => {
      if (options.name === 'main') Main = component
      return () => {}
    } },
    locale: { register: () => () => {}, bind: () => t },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) }, refresh: async () => {} },
    uiWorkspace: { openSession: () => {} }, get: () => undefined,
  }
  apply(ctx as never)
  if (!Main) throw new Error('Native main panel was not registered')
  const NativeMain = Main
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<NativeMain t={t} />) }); await settle()
}
const id = (value: string) => document.getElementById(value)!
async function pick(prefix: string, provider: string, model: string) {
  await click(id(prefix + '-toggle')); await click(id(prefix + '-model-entry'))
  await click(id(prefix + '-results').querySelector<HTMLElement>(`[data-provider="${provider}"][data-model="${model}"]`)!)
}

it('the registered native main panel shares the DSH picker for independent Eval and Execution settings, saves exact routes and restores inheritance', async () => {
  await mount('eval')
  expect(id('dt-eval-model-toggle')).toBeTruthy()
  expect(document.querySelectorAll('#jarvis-model-catalog-style')).toHaveLength(1)
  expect(document.querySelector('.dt-model details')?.hasAttribute('open')).toBe(false)
  await pick('dt-eval-model', 'other-provider', 'worker-model')
  expect(server.settings.eval.model).toBeNull()
  await click(zh.save)
  expect(server.settings.eval.model).toEqual({ provider: 'other-provider', model: 'worker-model' })
  await click(find(zh['settingsGroup.execution'], '.dt-settings-link'))
  expect(document.querySelector('#dt-eval-model-panel')).toBeNull()
  await pick('dt-worker-model', 'worker-provider', 'worker-model')
  await click(id('dt-worker-model-toggle')); await click(id('dt-worker-model-effort-entry'))
  await click(id('dt-worker-model-efforts').querySelector<HTMLElement>('[data-effort="high"]')!)
  await click(zh.save)
  expect(server.settings.executor.model).toEqual({ provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'high' })
  expect(server.settings.eval.model).toEqual({ provider: 'other-provider', model: 'worker-model' })
  await click(find(zh.modelInherit, '.dt-model button')); await click(zh.save)
  expect(server.settings.executor.model).toBeNull()
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/eval', 'settings/executor', 'settings/executor'])
  unmount(); expect(document.querySelectorAll('.model-catalog-panel')).toHaveLength(0)
  expect(document.querySelectorAll('#jarvis-model-catalog-style')).toHaveLength(1)
});

it('the native English panel keeps English picker actions and official labels without importing Jarvis global styles or changing the document language', async () => {
  const before = document.documentElement.lang; document.documentElement.lang = 'zh-CN'
  onTestFinished(() => { document.documentElement.lang = before })
  await mount('execution', en)
  await click(id('dt-worker-model-toggle'))
  expect([...id('dt-worker-model-panel').querySelectorAll('.model-catalog-cell-label')].map(item => item.textContent)).toEqual(['Model', 'Effort'])
  await click(id('dt-worker-model-model-entry'))
  expect(id('dt-worker-model-search').getAttribute('placeholder')).toBe('Search models or providers')
  expect([...id('dt-worker-model-results').querySelectorAll('.model-catalog-group-title')].map(item => item.textContent)).toContain('DeepSeek Account')
  expect(id('dt-worker-model-results').querySelector('[data-model="official"]')?.textContent).toBe('Unchanged official model Official')
  const refresh = id('dt-worker-model-models-page').querySelector<HTMLElement>('.model-catalog-refresh')!
  expect(refresh.textContent).toBe('Reload available models'); await click(refresh)
  expect(id('dt-worker-model-models-page').querySelector('.model-catalog-feedback')?.textContent).toBe('Available models updated')
  expect(document.documentElement.lang).toBe('zh-CN')
  const styles = document.getElementById('jarvis-model-catalog-style')!.textContent!
  expect(styles).not.toMatch(/(?:^|\n)\s*(?::root|html|body)\b|\.composer|\.shell/)
  expect(server.requests.some(request => request.method !== 'GET')).toBe(false)
});
