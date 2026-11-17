// @vitest-environment jsdom
// The organization entry renders the original settings editors against one immutable API scope.
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { builtInBase, builtInParts, defaultPrompts } from '../src/app/prompts.ts'
import { ApiError, caller, type ApiResponse } from '../src/client/api.ts'
import { mountSuperagentSettings, type OrganizationSettingsController, type OrganizationSettingsLocation } from '../src/client/organization.tsx'
import { zh } from '../src/client/locales.ts'
import { withOverrides } from '../src/client/prompt-config.ts'
import { effectiveWorkerTools } from '../src/process-runtime/worker-capabilities.ts'
import { all, click, field, find, settle, tab, text, type } from './fixtures/panel.tsx'
import { promptVersion, server, usePanelServer } from './fixtures/panel-server.ts'

let controller: OrganizationSettingsController | undefined, host: HTMLElement | undefined
usePanelServer(() => { act(() => { controller?.unmount() }); controller = undefined; host?.remove() })
async function mount(group: OrganizationSettingsLocation['group'] = 'source', instanceId = 'root', openSession?: (id: string) => Promise<void>) {
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { controller = mountSuperagentSettings(host!, { instanceId, csrf: 'organization-csrf', location: { group },
    onNavigate: location => controller!.update(location), openSession }) })
  await settle()
}
const group = async (name: OrganizationSettingsLocation['group']) => click(find(zh[`settingsGroup.${name}`], '.dt-settings-link'))
const capability = (name: string) => [...document.querySelectorAll<HTMLInputElement>('.dt-worker-capabilities input')]
  .find(input => input.closest('label')?.querySelector('strong')?.textContent === name)!
const saveWithin = async (selector: string) => click([...document.querySelector(selector)!.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => button.textContent === zh.save)!)

it('uses one stable organization scope for all original settings, history and model reads, without writing on navigation', async () => {
  await mount()
  expect(text()).toContain('GitHub')
  expect(text()).toContain('飞书')
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual(['来源', '评估', '执行', '提示词', '部署'])
  await group('eval'); expect(field<HTMLInputElement>(zh.evalTimeout).value).toBe('120')
  await group('execution')
  for (const label of [zh.maxWorkers, zh.executionDirectory, zh.prepareCommand, zh.blockedCommands]) expect(field(label)).toBeTruthy()
  expect(document.querySelectorAll('[data-settings-group="execution"] .dt-model')).toHaveLength(1)
  expect(capability('读取文件').checked).toBe(true)
  await group('prompts'); expect(all('.dt-prompt-nav .dt-nav-item')).toHaveLength(3 + Object.keys(builtInParts()).length)
  await group('deployment'); expect(text()).toContain('/srv/dsh-superagent')
  const requests = vi.mocked(fetch).mock.calls
  expect(requests.every(([url]) => String(url).startsWith('/jarvis/api/system/instances/root/superagent/'))).toBe(true)
  expect(server.requests.some(request => request.method !== 'GET')).toBe(false)
  expect(controller!.isDirty()).toBe(false)
})

it('keeps Worker tools, installed skills and executor drafts across sources, full prompt preview and return navigation', async () => {
  await mount('execution')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal denied-command')
  await click(capability('读取文件'))
  await click(capability('review-code'))
  expect(controller!.isDirty()).toBe(true)
  await group('source'); await group('prompts'); await click(tab(zh.promptViewFull))
  expect(controller!.isDirty()).toBe(true)
  await group('execution')
  expect(field<HTMLInputElement>(zh.blockedCommands).value).toBe('gh-personal denied-command')
  expect(capability('读取文件').checked).toBe(false)
  expect(capability('查找文件').checked).toBe(true)
  expect(capability('搜索内容').checked).toBe(true)
  expect(capability('review-code').checked).toBe(false)
  expect(server.workerCapabilities.tools).toEqual(['read', 'glob', 'grep'])
  expect(server.workerCapabilities.skills).toEqual(['review-code'])
  await saveWithin('.dt-worker-capabilities')
  expect(server.workerCapabilities.tools).toEqual(['glob', 'grep'])
  expect(server.workerCapabilities.skills).toEqual([])
  expect(server.settings.executor.blockedCommands).toEqual(['gh-personal'])
  expect(controller!.isDirty()).toBe(true)
  await act(async () => { controller!.discard() }); await settle()
  expect(controller!.isDirty()).toBe(false)
  const write = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PUT')!
  expect(new Headers(write[1]!.headers).get('x-jarvis-csrf')).toBe('organization-csrf')
  expect(new Headers(write[1]!.headers).get('x-orchestrator-request')).toBe('1')
})

it('retains all original prompt parts, override bases, custom skills, composed previews and revision history', async () => {
  await mount('prompts')
  const names = all('.dt-prompt-nav .dt-nav-item > span').map(item => item.firstChild?.textContent)
  expect(names.slice(0, 3)).toEqual(['沟通方式', '工单范围', '交付要求'])
  expect(names.slice(3)).toEqual(Object.keys(builtInParts()).map(key => zh[`promptPart.${key}` as keyof typeof zh]))
  await click(all('.dt-nav-item').find(item => item.textContent === zh['promptPart.runtime/shared'])!)
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Organization shared rules')
  await type(field<HTMLInputElement>(zh.promptAddSkill), 'org-review')
  await click(zh.promptAddSkillAction)
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'Review requirements for this organization')
  await click(tab(zh.promptViewFull))
  expect(text()).toContain('Organization shared rules')
  const preview = server.requests.filter(request => request.path === 'prompts/preview').at(-1)!
  expect(preview.body).toMatchObject({ skills: { 'org-review': 'Review requirements for this organization' },
    overrides: { 'runtime/shared': { text: 'Organization shared rules', base: builtInBase(builtInParts()['runtime/shared'].text) } } })
  await click(zh.save)
  expect(server.prompts.current.config.skills['org-review']).toBe('Review requirements for this organization')
  await click(tab(zh.promptViewHistory))
  expect(text()).toContain('版本 1')
  await click(zh.promptDefaults)
  expect(text()).toContain(zh.promptDraftFromDefaults)
  expect(controller!.isDirty()).toBe(true)
  expect(server.prompts.current.config.overrides).toHaveProperty('runtime/shared')
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['prompts'])
})

it('keeps the history list inside the settings content without clipping its rows', async () => {
  await mount('prompts')
  await click(tab(zh.promptViewHistory))
  const list = document.querySelector<HTMLElement>('.dt-settings .dt-list')!
  // An unpadded settings form must not inherit the list's -8px page gutter bleed.
  // Vitest stubs CSS imports; apply the shipped stylesheet for these computed-style checks.
  const stylesheet = document.createElement('style')
  stylesheet.textContent = readFileSync('src/client/client.css', 'utf8')
  document.head.append(stylesheet)
  try {
    const style = getComputedStyle(list)
    expect(Number.parseFloat(style.marginLeft)).toBe(0)
    expect(Number.parseFloat(style.marginRight)).toBe(0)
    expect(getComputedStyle(list.querySelector('.dt-row')!).paddingRight).toBe('8px')
    expect(list.querySelector('button')?.textContent).toBe(zh.promptRestore)
    expect(getComputedStyle(document.querySelector('.dt-settings-body')!).overflowX).not.toBe('hidden')
  } finally { stylesheet.remove() }
})

it('restores the existing original-panel prompt draft and preserves a newer remote section on CAS retry', async () => {
  const defaults = withOverrides(defaultPrompts())
  sessionStorage.setItem('dsh-superagent/prompts/master', JSON.stringify({ base: defaults, value: { ...defaults, communication: 'Original tab draft' }, revision: 0 }))
  await mount('prompts')
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('Original tab draft')
  server.prompts.revision = 1; server.prompts.current = promptVersion(1, { ...defaults, scope: 'Other page scope' })
  await click(zh.save)
  expect(controller!.isDirty()).toBe(true)
  expect(text()).toContain('提示词已被修改到版本 1')
  await click(zh.save)
  expect(server.prompts.current.config).toMatchObject({ communication: 'Original tab draft', scope: 'Other page scope' })
  expect(sessionStorage.getItem('dsh-superagent/prompts/master')).toBeNull()
})

it('persists the three actual machine overrides separately, unsets blank values, and merges a concurrent machine revision', async () => {
  server.deployment.values = { promptMaxChars: 150000 }
  server.deployment.effective.promptMaxChars = 150000
  await mount('deployment')
  expect(field<HTMLInputElement>(zh.deploymentContextPages)).toMatchObject({ value: '', placeholder: '10' })
  expect(document.querySelector('input[value="/srv/dsh-superagent"]')).toBeNull()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  server.deployment = { ...server.deployment, revision: 1, values: { promptMaxChars: 200000 }, effective: { ...server.deployment.effective, promptMaxChars: 200000 } }
  await click(zh.save)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  expect(field<HTMLInputElement>(zh.deploymentContextPages).value).toBe('20')
  await click(zh.save)
  expect(server.deployment.values).toEqual({ promptMaxChars: 200000, admissionContextMaxPages: 20 })
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '')
  await click(zh.save)
  expect(server.deployment.values).toEqual({ admissionContextMaxPages: 20 })
  expect(server.deployment.effective.promptMaxChars).toBe(100000)
  expect(text()).toContain('无需重启')
  expect(server.requests.filter(request => request.method === 'PUT').every(request => request.path === 'deployment')).toBe(true)
})

it('preserves unavailable saved Worker choices, omits unavailable unselected tools and keeps a refused save editable', async () => {
  server.workerCapabilities.tools.push('retired-tool')
  server.workerCapabilities.skills.push('retired-skill')
  server.workerCapabilities.catalog.tools.push({ name: 'unavailable-new', label: 'Should not appear', group: '文件', available: false })
  server.workerCapabilities.catalog.complete = false
  await mount('execution')
  expect(capability('retired-tool').checked).toBe(true)
  expect(text()).not.toContain('Should not appear')
  expect(text()).toContain(zh.capabilityCatalogIncomplete)
  await click(capability('retired-tool')); await click(capability('retired-skill'))
  server.capabilitiesSaveError = 'Worker capability is unavailable'
  await saveWithin('.dt-worker-capabilities')
  expect(document.querySelector('.dt-worker-capabilities .dt-savebar [role="alert"]')?.textContent).toContain('Worker capability is unavailable')
  expect(capability('retired-tool')).toBeUndefined()
  expect(server.workerCapabilities.tools).toContain('retired-tool')
  expect(controller!.isDirty()).toBe(true)
  server.capabilitiesSaveError = undefined
  await saveWithin('.dt-worker-capabilities')
  expect(server.workerCapabilities.tools).toEqual(['read', 'glob', 'grep'])
  expect(server.workerCapabilities.skills).toEqual(['review-code'])
})

it('copies a scoped caller, encodes values, preserves structured errors and rejects nonlocal API bases', async () => {
  const scope = { base: '/jarvis/api/system/instances/child/superagent/', csrf: 'child-csrf' }
  const messages = () => ({ offline: 'offline', notRunning: 'stopped', serverError: String, requestFailed: String, setup: () => 'setup', user: () => 'user' })
  const call = caller(messages, scope)
  scope.base = '/jarvis/api/system/instances/root/superagent'; scope.csrf = 'changed'
  await call('GET settings')
  expect(String(vi.mocked(fetch).mock.calls.at(-1)![0])).toBe('/jarvis/api/system/instances/child/superagent/settings')
  await expect(call('PUT deployment', { body: { revision: 55, values: {} } })).rejects.toBeInstanceOf(ApiError)
  const init = vi.mocked(fetch).mock.calls.at(-1)![1]!
  expect(new Headers(init.headers).get('x-jarvis-csrf')).toBe('child-csrf')
  for (const base of ['https://foreign.invalid/api', '//foreign.invalid', '/api/../other', '/api?q=x', '/api#other', '/\\foreign.invalid/api', '/api/%2e%2e/other']) expect(() => caller(messages, { base })).toThrow()
})

it('keeps intentional empty Worker tool and skill selections through preview navigation, then saves both empty lists', async () => {
  await mount('execution')
  for (const input of [...document.querySelectorAll<HTMLInputElement>('.dt-worker-capabilities input:checked')]) await click(input)
  await group('prompts'); await click(tab(zh.promptViewFull)); await group('source'); await group('execution')
  expect(document.querySelectorAll('.dt-worker-capabilities input:checked')).toHaveLength(0)
  expect(controller!.isDirty()).toBe(true)
  await saveWithin('.dt-worker-capabilities')
  expect(server.workerCapabilities.tools).toEqual([])
  expect(server.workerCapabilities.skills).toEqual([])
  expect(controller!.isDirty()).toBe(false)
})

it('preserves unreadable and obsolete original drafts for explicit review before replacing their browser storage', async () => {
  const key = 'dsh-superagent/prompts/master', raw = '{"value":{"router":"old short prompt"},"revision":0}'
  sessionStorage.setItem(key, raw)
  await mount('prompts')
  expect(text()).toContain(zh.draftUnmerged)
  expect(document.querySelector('.dt-draft-recovery pre')?.textContent).toBe(raw)
  expect(sessionStorage.getItem(key)).toBe(raw)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(defaultPrompts().communication)
  await type(field<HTMLTextAreaElement>(zh.promptBody), 'New complete prompt draft')
  expect(sessionStorage.getItem(`${key}/unmerged/0`)).toBe(raw)
  expect(JSON.parse(sessionStorage.getItem(key)!).value.communication).toBe('New complete prompt draft')
  await click(zh.draftPreserveAndContinue)
  expect(text()).not.toContain(zh.draftUnmerged)
  expect(sessionStorage.getItem(`${key}/unmerged/0`)).toBe(raw)
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe('New complete prompt draft')
  await click(zh.save)
  expect(sessionStorage.getItem(key)).toBeNull()
  expect(sessionStorage.getItem(`${key}/unmerged/0`)).toBe(raw)
})

it('shows automatic native tool names and their actual boundaries without new authorization switches', async () => {
  server.workerCapabilities.tools.push('pwsh')
  server.workerCapabilities.effective = effectiveWorkerTools(server.workerCapabilities.tools)
  await mount('execution')
  const automatic = all('[data-automatic-tool]')
  expect(automatic.map(row => row.dataset.automaticTool)).toEqual(['job_output', 'job_list', 'job_kill', 'skill', 'todo_write',
    'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent'])
  expect(automatic.every(row => !row.querySelector('input,button,select'))).toBe(true)
  expect(automatic.find(row => row.dataset.automaticTool === 'job_kill')?.textContent).toContain('当前 Worker 会话已获准启动的后台任务')
  expect(automatic.find(row => row.dataset.automaticTool === 'job_kill')?.textContent).toContain('依赖已允许工具：pwsh')
  expect(automatic.find(row => row.dataset.automaticTool === 'skill')?.textContent).toContain('技能不授予新的文件、命令或网络权限')
  expect(automatic.find(row => row.dataset.automaticTool === 'todo_write')?.textContent).toContain('内部待办状态')
  expect(automatic.find(row => row.dataset.automaticTool === 'subagent')?.textContent).toContain('同一任务内的子 Agent')
  expect(controller!.isDirty()).toBe(false)
  expect(server.requests.some(request => request.method !== 'GET')).toBe(false)
})

it('opens the actual native Session adapter and shows its real failure in an unclipped viewport portal', async () => {
  const openSession = vi.fn(async () => { throw new Error('Workspace refused this Session') })
  await mount('prompts', 'root', openSession)
  await click(zh.openMaster)
  expect(openSession).toHaveBeenCalledWith('master')
  const toast = document.querySelector('.dt-toast')!
  expect(toast.textContent).toBe('Workspace refused this Session')
  expect(toast.closest('.dt-organization-portals')?.parentElement).toBe(document.body)
  expect(host!.contains(toast)).toBe(false)
  expect(controller!.isDirty()).toBe(false)
})

it('keeps the exact server legacy archive available without displaying it in the complete prompt editor', async () => {
  const engine = { prompts: { router: '  old <router>\r\nsecond line\r\n', worker: 'old worker', communication: 'adopted team communication',
    scope: 'already present scope', delivery: 'old conflicting delivery' } }
  const baseline = { prompts: { router: 'default router', worker: 'old worker', communication: 'default communication', scope: 'default scope', delivery: 'default delivery' } }
  const archive: ApiResponse<'GET configuration-migrations'>['items'][number] = { version: 1, id: 'a'.repeat(32), instanceId: 'root',
    recordedAt: '2026-11-16T12:00:00.000Z', source: { reference: 'organization:root:legacy-engine', revision: 5, sha256: 'b'.repeat(64) },
    sha256: 'c'.repeat(64), legacyEngine: engine, legacyDefaults: { engine: baseline, source: { reference: 'verified-release', sha256: 'd'.repeat(64) } },
    original: { promptRevision: 7, settingsRevision: 3 }, appliedPromptRevision: 8,
    fields: [{ key: 'router', status: 'pending', reason: 'role-semantics' }, { key: 'worker', status: 'original-default', reason: 'legacy-default' },
      { key: 'communication', status: 'migrated', reason: 'team-section' }, { key: 'scope', status: 'already-present', reason: 'same-text' },
      { key: 'delivery', status: 'pending', reason: 'team-conflict' }], status: 'pending' }
  server.configurationMigrations = [archive]
  server.prompts.revision = 8; server.prompts.current = promptVersion(8, { ...defaultPrompts(), communication: engine.prompts.communication,
    scope: engine.prompts.scope, delivery: 'original complete delivery customization' })
  await mount('prompts')
  expect(document.querySelector('.dt-configuration-migrations, [data-migration-id]')).toBeNull()
  expect(text()).not.toContain(zh.configurationMigrations)
  expect(server.requests.some(request => request.path === 'configuration-migrations')).toBe(false)
  const response = await fetch('/jarvis/api/system/instances/root/superagent/configuration-migrations')
  expect(JSON.parse(await response.text())).toEqual({ items: [archive] })
  expect(server.configurationMigrations).toEqual([archive])
  expect(field<HTMLTextAreaElement>(zh.promptBody).value).toBe(engine.prompts.communication)
  expect(server.prompts.current.config.overrides).toBeUndefined()
  expect(server.requests.some(request => request.method !== 'GET')).toBe(false)
  expect(controller!.isDirty()).toBe(false)
})

it('does not expose technical migration evidence failures in the product prompt editor', async () => {
  server.migrationError = 'Migration evidence is unavailable'
  await mount('prompts')
  expect(document.querySelector('.dt-configuration-migrations')).toBeNull()
  expect(text()).not.toContain('Migration evidence is unavailable')
  expect(text()).not.toContain(zh.configurationMigrationsNone)
  expect(server.requests.some(request => request.path === 'configuration-migrations')).toBe(false)
  expect(server.requests.some(request => request.method !== 'GET')).toBe(false)
})

it('saves idle Worker authorization once and reports that its actual tools and skills are applied', async () => {
  await mount('execution')
  await click(capability('读取文件')); await click(capability('review-code'))
  await saveWithin('.dt-worker-capabilities')
  expect(server.workerCapabilities.applied).toEqual({ tools: ['glob', 'grep'], skills: [] })
  expect(document.querySelector('[data-capability-application]')?.textContent).toContain('已保存并生效')
  expect(document.querySelector('[data-applied-capabilities]')?.textContent).toContain('glob')
  expect(document.querySelector('[data-applied-capabilities]')?.textContent).not.toContain('review-code')
  expect(server.requests.filter(request => request.method !== 'GET').map(request => request.path)).toEqual(['worker-capabilities'])
  expect(controller!.isDirty()).toBe(false)
})

it('saves busy Worker authorization as pending, keeps old permissions explicit and restores the pending state on return', async () => {
  server.capabilitiesRunning = true
  await mount('execution')
  await click(capability('读取文件')); await saveWithin('.dt-worker-capabilities')
  expect(server.workerCapabilities.tools).toEqual(['glob', 'grep'])
  expect(server.workerCapabilities.applied.tools).toEqual(['read', 'glob', 'grep'])
  const status = document.querySelector('[data-capability-application]')!
  expect(status.textContent).toContain('已保存，等待相关工作结束后自动应用')
  expect(status.textContent).toContain('等待期间仍使用当前生效的工具与技能')
  expect(status.textContent).toContain('产品组织')
  expect(status.textContent).toContain('修复回归')
  expect(status.textContent).toContain('t1')
  expect(capability('读取文件').disabled).toBe(true)
  expect(controller!.isDirty()).toBe(false)
  await group('prompts'); await group('execution')
  expect(document.querySelector('[data-capability-application]')?.textContent).toContain('等待相关工作结束')
  expect(server.requests.filter(request => request.method !== 'GET')).toHaveLength(1)
})

it('cancels pending application explicitly and returns editing to current effective authorization without stopping work', async () => {
  server.capabilitiesRunning = true
  await mount('execution'); await click(capability('读取文件')); await saveWithin('.dt-worker-capabilities')
  await click('取消待应用')
  expect(server.workerCapabilities.application?.state).toBe('cancelled')
  expect(server.workerCapabilities.tools).toEqual(['read', 'glob', 'grep'])
  expect(server.workerCapabilities.applied.tools).toEqual(['read', 'glob', 'grep'])
  expect(capability('读取文件')).toMatchObject({ checked: true, disabled: false })
  expect(text()).toContain('已取消待应用，继续使用当前生效设置')
  expect(server.requests.filter(request => request.method === 'POST').map(request => request.body)).toEqual([
    { revision: 5, applicationId: 'capabilities-5', action: 'cancel' }])
  expect(controller!.isDirty()).toBe(false)
})

it('retries failed application and distinguishes a committed settings change from failed organization recovery', async () => {
  server.workerCapabilities.application = { id: 'failed-apply', state: 'failed', savedAt: '2026-11-17T01:00:00Z',
    affected: [{ instanceId: 'root', name: '产品组织', running: false, busy: false, work: [] }],
    error: 'Could not resume organization', canCancel: false, canRetry: true, canApplyNow: false }
  await mount('execution')
  expect(text()).toContain('Could not resume organization')
  expect(text()).toContain('设置已生效，恢复相关组织运行失败')
  expect(text()).not.toContain('等待期间仍使用当前生效的工具与技能')
  expect(all('button').some(button => button.textContent === '取消待应用')).toBe(false)
  await click('重试应用')
  expect(server.workerCapabilities.application?.state).toBe('applied')
  expect(text()).not.toContain('Could not resume organization')
  expect(server.requests.filter(request => request.method === 'POST').map(request => request.body)).toEqual([
    { revision: 4, applicationId: 'failed-apply', action: 'retry' }])
})

it('refreshes exact affected work before confirming immediate application and sends only that confirmation', async () => {
  server.capabilitiesRunning = true
  await mount('execution'); await click(capability('读取文件')); await saveWithin('.dt-worker-capabilities')
  server.workerCapabilities.application!.affected.push({ instanceId: 'child', name: '研发组织', running: true, busy: true,
    work: [{ id: 'child-task-7', title: '完善交付报告', kind: 'ticket', status: 'working' }] })
  server.workerCapabilities.application!.confirmation = 'latest-affected-snapshot'
  await click('停止相关工作并立即应用')
  const dialog = document.querySelector('[role="dialog"]')!
  for (const value of ['产品组织', '修复回归', 't1', '研发组织', '完善交付报告', 'child-task-7']) expect(dialog.textContent).toContain(value)
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  await click(dialog.querySelector<HTMLButtonElement>('[data-confirm-capability-application]')!)
  expect(server.requests.filter(request => request.method === 'POST').map(request => request.body)).toEqual([
    { revision: 5, applicationId: 'capabilities-5', action: 'apply-now', confirmation: 'latest-affected-snapshot' }])
  expect(server.workerCapabilities.applied.tools).toEqual(['glob', 'grep'])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('rejects a stale immediate-application confirmation and requires another review without replaying the action', async () => {
  server.capabilitiesRunning = true
  await mount('execution'); await click(capability('读取文件')); await saveWithin('.dt-worker-capabilities')
  await click('停止相关工作并立即应用')
  server.workerCapabilities.application!.confirmation = 'changed-work'
  server.workerCapabilities.application!.affected[0]!.work.push({ id: 't2', title: '新接收的工作', kind: 'ticket', status: 'working' })
  await click(document.querySelector<HTMLButtonElement>('[data-confirm-capability-application]')!)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(text()).toContain('相关工作或设置已变化，请重新核对后确认')
  expect(server.workerCapabilities.applied.tools).toEqual(['read', 'glob', 'grep'])
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  await click('停止相关工作并立即应用')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('新接收的工作')
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  await click(document.querySelector<HTMLButtonElement>('[data-confirm-capability-application]')!)
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(2)
  expect(server.workerCapabilities.applied.tools).toEqual(['glob', 'grep'])
})

it('preserves a restored local draft while pending application locks saving, and still allows discarding the local draft', async () => {
  server.capabilitiesRunning = true
  await mount('execution'); await click(capability('读取文件')); await saveWithin('.dt-worker-capabilities')
  await act(async () => { controller!.unmount() }); host!.remove()
  const key = 'dsh-superagent/draft/master/worker-capabilities'
  const base = { tools: server.workerCapabilities.tools, skills: server.workerCapabilities.skills }
  sessionStorage.setItem(key, JSON.stringify({ base, value: { ...base, tools: [...base.tools, 'write'] }, revision: 5 }))
  await mount('execution')
  expect(capability('写入文件')).toMatchObject({ checked: true, disabled: true })
  expect(controller!.isDirty()).toBe(true)
  const save = document.querySelector<HTMLButtonElement>('.dt-worker-capabilities .dt-savebar .dt-btn-primary')!
  expect(save.disabled).toBe(true)
  expect((find('取消待应用') as HTMLButtonElement).disabled).toBe(true)
  expect(JSON.parse(sessionStorage.getItem(key)!).value.tools).toContain('write')
  await click(zh.discard)
  expect(controller!.isDirty()).toBe(false)
  expect(sessionStorage.getItem(key)).toBeNull()
  expect((find('取消待应用') as HTMLButtonElement).disabled).toBe(false)
  expect(capability('写入文件').checked).toBe(false)
  expect(server.requests.filter(request => request.method !== 'GET')).toHaveLength(1)
})

it('keeps pending and applied settings distinct after an application action fails and retries only on another explicit click', async () => {
  server.capabilitiesRunning = true
  await mount('execution'); await click(capability('读取文件')); await saveWithin('.dt-worker-capabilities')
  server.capabilitiesActionError = { status: 500, message: 'Cancellation is unavailable' }
  await click('取消待应用')
  expect(text()).toContain('Cancellation is unavailable')
  expect(server.workerCapabilities.application?.state).toBe('waiting')
  expect(server.workerCapabilities.tools).toEqual(['glob', 'grep'])
  expect(server.workerCapabilities.applied.tools).toEqual(['read', 'glob', 'grep'])
  expect(capability('读取文件').disabled).toBe(true)
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  server.capabilitiesActionError = undefined
  await click('取消待应用')
  expect(server.workerCapabilities.application?.state).toBe('cancelled')
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(2)
})

it('refuses to open immediate-application confirmation for a newly replaced saved target until it is reviewed again', async () => {
  server.capabilitiesRunning = true
  await mount('execution'); await click(capability('读取文件')); await saveWithin('.dt-worker-capabilities')
  server.workerCapabilities.revision = 7
  server.workerCapabilities.tools.push('write')
  server.workerCapabilities.application!.id = 'capabilities-7'
  server.workerCapabilities.application!.confirmation = 'replacement-target'
  await click('停止相关工作并立即应用')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(text()).toContain('相关工作或设置已变化，请重新核对后确认')
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(0)
  expect(capability('写入文件').checked).toBe(true)
  await click('停止相关工作并立即应用')
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('本次将应用的工具glob, grep, write')
  await click(dialog.querySelector<HTMLButtonElement>('.dt-modal-close')!)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(0)
})
