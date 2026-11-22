// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { GithubConnectionView } from '../src/app/github-connection.ts'
import { en, zh } from '../src/client/locales.ts'
import { all, at, click, field, find, mount, remount, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { problemOf, server } from './fixtures/panel-server.ts'

usePanel()
const source = () => server.settings.sources.github!
const card = () => document.getElementById('dt-source-github')!
const form = () => card().querySelector<HTMLFormElement>('.dt-github-connect-form')!
const receive = () => card().querySelector<HTMLFormElement>('.dt-github-receiving')!
const connection = (patch: Partial<GithubConnectionView> = {}): GithubConnectionView => ({
  available: true, tokenSupported: true, browserSupported: false, cli: '/usr/bin/gh',
  connection: { repository: String(source().config.repository ?? ''), login: server.setup.accounts?.agent ?? null,
    configured: Boolean(source().config.repository && source().config.cli), managed: false }, job: null, ...patch,
})
async function open() { at({ page: 'settings', query: { group: 'source' } }); await mount() }
async function submit(element = form()) {
  await act(async () => { element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
}
const stored = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!)).join('')

it('starts an unconfigured repository with a neutral Token form and preserves receiving defaults', async () => {
  server.settings.sources.github = { ...source(), enabled: false, config: { repository: '', cli: '' } }
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await open()
  expect(card().textContent).toContain(zh.githubConnectionIntro)
  expect(card().querySelector('.dt-github-status')?.getAttribute('data-state')).toBe('idle')
  expect(card().querySelector('.dt-error')).toBeNull()
  expect(find(zh.githubConnectionToken, '[role="tab"]').getAttribute('aria-selected')).toBe('true')
  expect(field<HTMLInputElement>(zh.githubConnectionRepository).value).toBe('')
  expect(field<HTMLInputElement>(zh.githubConnectionTokenLabel).type).toBe('password')
  expect(card().querySelector('a')?.getAttribute('href')).toBe('https://github.com/settings/tokens/new?scopes=repo&description=Superagent')
  expect(card().querySelector('a')?.textContent).toBe(zh.githubConnectionCreateToken)
  expect(find(zh.githubReceivingEnable).getAttribute('aria-checked')).toBe('false')
  expect([...receive().querySelectorAll('[role="switch"]')].map(item => item.getAttribute('aria-checked')))
    .toEqual(['false', 'false', 'false', 'false', 'false'])
  expect(card().textContent).not.toMatch(/OAuth|浏览器登录|Demo|演示/)
})

it('shows the discovered CLI in Token mode after a previous missing-CLI failure', async () => {
  server.settings.sources.github = { ...source(), config: { repository: '', cli: '' } }
  server.githubConnection = connection({ job: { id: 'previous', status: 'failed', errorCode: 'cli-missing', message: '' } })
  await open()
  expect(card().textContent).toContain('/usr/bin/gh')
  expect(card().textContent).toContain('重新验证')
  expect(card().textContent).not.toContain(zh['githubConnectionError.cli-missing'])
  expect(card().textContent).not.toContain(zh['githubConnectionStatus.connected'])
})

it('submits a repository URL and Token only through the connection API, clearing it before the request completes', async () => {
  await open()
  await click(find(zh.githubConnectionToken, '[role="tab"]'))
  const secret = 'ghp_ui_secret_that_must_not_persist'
  await type(field(zh.githubConnectionRepository), 'https://github.com/acme/new-work.git')
  await type(field(zh.githubConnectionTokenLabel), secret)
  await click('接收仓库里的新 Issue')
  let finish!: (view: GithubConnectionView) => void
  server.githubConnect = () => new Promise(resolve => { finish = resolve })
  await act(async () => { form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(field<HTMLInputElement>(zh.githubConnectionTokenLabel).value).toBe('')
  expect(field<HTMLInputElement>(zh.githubConnectionTokenLabel).autocomplete).toBe('off')
  expect(stored(sessionStorage) + stored(localStorage)).not.toContain(secret)
  const request = server.requests.find(item => item.path === 'github/connection' && item.method === 'POST')!
  expect(request.body).toEqual({ revision: 0, repository: 'https://github.com/acme/new-work.git', method: 'token', token: secret })
  expect(server.requests.some(item => item.method === 'PUT')).toBe(false)
  server.githubConnection = connection({ job: { id: 'token-attempt', status: 'checking', message: 'Checking' } })
  await act(async () => { finish(server.githubConnection!) }); await settle()
  await click(find(zh.cancel, '.dt-github-connect-actions button'))
  expect(server.requests.find(item => item.path === 'github/connection/cancel')?.body).toEqual({ id: 'token-attempt' })
  expect(card().textContent).toContain(zh['githubConnectionStatus.cancelled'])
  await submit(receive())
  const saved = server.requests.find(item => item.path === 'settings/source:github')!
  expect(JSON.stringify(saved.body)).not.toContain(secret)
  expect(source().config).toMatchObject({ observeIssues: true, repository: 'acme/widgets' })
})

it('uses an existing signed-in account without requiring a CLI path, and supports an explicit path in advanced settings', async () => {
  await open()
  expect(find(zh.githubConnectionExisting, '[role="tab"]').getAttribute('aria-selected')).toBe('true')
  expect(card().querySelector('input[placeholder="ghp_…"]')).toBeNull()
  expect([...card().querySelectorAll('label')].map(label => label.textContent)).not.toContain(zh.githubConnectionCliLabel)
  await click(find(zh.githubConnectionAdvanced, '[data-disclosure-row]'))
  await type(field(zh.githubConnectionCliLabel), '/opt/agent/gh')
  expect(card().textContent).toContain('@agent-bot')
  await submit()
  expect(server.requests.find(item => item.method === 'POST' && item.path === 'github/connection')?.body)
    .toEqual({ revision: 0, repository: 'acme/widgets', method: 'existing', cli: '/opt/agent/gh' })
  expect(source().config.cli).not.toBe('/opt/agent/gh')
})

it('allows a custom discovered executable for Token connections and hides unsupported methods', async () => {
  server.githubConnection = connection({ cli: null })
  await open()
  await click(find(zh.githubConnectionToken, '[role="tab"]'))
  expect(card().textContent).toContain(zh.githubConnectionCliMissing)
  await click(find(zh.githubConnectionAdvanced, '[data-disclosure-row]'))
  await type(field(zh.githubConnectionCliLabel), 'C:\\Tools\\gh.exe')
  await type(field(zh.githubConnectionTokenLabel), 'ghp_custom_cli')
  await submit()
  expect(server.requests.find(item => item.method === 'POST' && item.path === 'github/connection')?.body)
    .toMatchObject({ method: 'token', cli: 'C:\\Tools\\gh.exe' })
  server.settings.sources.github = { ...source(), config: { ...source().config, repository: '', cli: '' } }
  server.setup = { ...server.setup, accounts: null }
  server.githubConnection = connection({ tokenSupported: false, cli: null })
  await remount()
  expect(card().querySelector('input[type="password"]')).toBeNull()
  expect(card().querySelector('a[href*="tokens/new"]')).toBeNull()
  expect(card().textContent).toContain(zh.githubConnectionCliMissing)
})

it('restores an active connection attempt after refresh, polls to completion, and distinguishes deployment readiness', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true }); onTestFinished(() => { vi.useRealTimers() })
  server.githubConnection = connection({ job: { id: 'restored-attempt', status: 'checking', message: 'Checking' } })
  await open()
  expect(card().textContent).toContain(zh['githubConnectionStatus.checking'])
  expect(find(zh.cancel, '.dt-github-connect-actions button').matches(':disabled')).toBe(false)
  server.setup = { ...server.setup, problem: problemOf('environmentFailed'), accounts: null }
  server.githubConnection = connection({ connection: { repository: 'acme/widgets', login: 'agent-bot', configured: true, managed: true },
    job: { id: 'restored-attempt', status: 'connected', message: 'Connected' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(card().textContent).toContain(zh['githubConnectionStatus.connected'])
  expect(card().textContent).toContain(zh.githubConnectionDeploymentPending)
  expect(card().textContent).not.toContain(zh.githubConnectionDeploymentReady)
  expect(card().textContent).toContain(zh.githubConnectionProtected)
  expect(server.requests.filter(item => item.path === 'settings').length).toBeGreaterThan(1)
})

it('disables cancellation during the save and explains failed or interrupted attempts without changing the saved connection', async () => {
  server.githubConnection = connection({ job: { id: 'saving-attempt', status: 'saving', message: 'Saving' } })
  await open()
  expect(find(zh.cancel, '.dt-github-connect-actions button').matches(':disabled')).toBe(true)
  expect(card().textContent).toContain(zh.githubConnectionSavingHint)
  server.githubConnection = connection({ job: { id: 'failed-attempt', status: 'failed', message: 'Access failed', errorCode: 'push-required' } })
  await remount()
  expect(card().querySelector('[role="alert"]')?.textContent).toBe(zh['githubConnectionError.push-required'])
  expect(card().textContent).toContain('@agent-bot')
  expect(source().config.repository).toBe('acme/widgets')
  server.githubConnection = connection({ job: { id: 'interrupted-attempt', status: 'interrupted', message: 'Interrupted', errorCode: 'interrupted' } })
  await remount(en)
  expect(card().textContent).toContain(en['githubConnectionStatus.interrupted'])
  expect(card().textContent).toContain(en['githubConnectionError.interrupted'])
  expect(find(en.githubConnectionUpdate, '.dt-github-connect-actions button').matches(':disabled')).toBe(false)
})

it('keeps receiving edits when a different saved connection arrives and saves them against that connection', async () => {
  await open()
  await click('接收仓库里的新 Issue')
  server.settings.sources.github = { ...source(), config: { ...source().config, repository: 'acme/replacement', cli: '/new/gh' } }
  server.revisions['source:github'] = 1
  await submit(receive())
  expect(receive().querySelector('.dt-savebar')?.textContent).toContain(zh.saveMerged)
  expect(find('接收仓库里的新 Issue').getAttribute('aria-checked')).toBe('true')
  await submit(receive())
  const requests = server.requests.filter(item => item.path === 'settings/source:github')
  expect(requests.at(-1)?.body).toMatchObject({ revision: 1, value: { config: { repository: 'acme/replacement', cli: '/new/gh', observeIssues: true } } })
  expect(source().config).toMatchObject({ repository: 'acme/replacement', cli: '/new/gh', observeIssues: true })
})

it('clears an unsubmitted Token when leaving the page while preserving the non-secret receiving draft', async () => {
  await open()
  await click(find(zh.githubConnectionToken, '[role="tab"]'))
  const input = field<HTMLInputElement>(zh.githubConnectionTokenLabel)
  await type(input, 'ghp_unsubmitted_secret')
  await click('接收仓库里的评论')
  expect(stored(sessionStorage) + stored(localStorage)).not.toContain('ghp_unsubmitted_secret')
  await click(find(zh['settingsGroup.execution'], '.dt-settings-link'))
  expect(input.value).toBe('')
  expect(input.getAttribute('value')).toBeNull()
  await click(find(zh['settingsGroup.source'], '.dt-settings-link'))
  await click(find(zh.githubConnectionToken, '[role="tab"]'))
  expect(field<HTMLInputElement>(zh.githubConnectionTokenLabel).value).toBe('')
  expect(find('接收仓库里的评论').getAttribute('aria-checked')).toBe('true')
})

it('erases the detached password field when switching to the existing account method', async () => {
  await open()
  await click(find(zh.githubConnectionToken, '[role="tab"]'))
  const input = field<HTMLInputElement>(zh.githubConnectionTokenLabel)
  await type(input, 'ghp_switching_method_secret')
  await click(find(zh.githubConnectionExisting, '[role="tab"]'))
  expect(input.value).toBe('')
  expect(input.getAttribute('value')).toBeNull()
  await click(find(zh.githubConnectionToken, '[role="tab"]'))
  expect(field<HTMLInputElement>(zh.githubConnectionTokenLabel).value).toBe('')
})

it('does not treat a stale successful attempt as verification of a changed saved connection', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true }); onTestFinished(() => { vi.useRealTimers() })
  server.githubConnection = connection({ connection: { repository: 'acme/changed', login: null, configured: true, managed: false },
    job: { id: 'old-success', status: 'connected', message: 'Connected', restarting: true } })
  await open()
  expect(card().textContent).toContain(zh['githubConnectionStatus.saved'])
  expect(card().textContent).toContain(zh.githubConnectionAccountUnchecked)
  expect(card().textContent).not.toContain(zh['githubConnectionStatus.connected'])
  const reads = server.requests.filter(item => item.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(server.requests.filter(item => item.path === 'state')).toHaveLength(reads)
})

it('keeps a failed submission visible when the next status read succeeds', async () => {
  await open()
  server.githubConnect = async () => { throw new Error('Connection dropped') }
  await submit()
  expect(card().querySelector('[role="alert"]')?.textContent).toBe(zh.offline)
  expect(server.requests.filter(item => item.path === 'github/connection' && item.method === 'GET').length).toBeGreaterThan(1)
  expect(find(zh.githubConnectionRetry).matches(':disabled')).toBe(false)
})

it('reports a connection API failure with a retry, while leaving receiving preferences available', async () => {
  const previous = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => String(args[0]).endsWith('/github/connection')
    ? new Response(JSON.stringify({ error: 'GitHub connection is temporarily unavailable' }), { status: 503 })
    : previous(...args)))
  await open()
  expect(card().querySelector('[role="alert"]')?.textContent).toBe('GitHub connection is temporarily unavailable')
  expect(find(zh.githubConnectionRetry).matches(':disabled')).toBe(false)
  expect(find(zh.githubConnectionConnect, '.dt-github-connect-actions button').matches(':disabled')).toBe(true)
  expect(find(zh.githubReceivingEnable).matches(':disabled')).toBe(false)
  expect(all('.dt-github-receiving [role="switch"]')).toHaveLength(5)
})
