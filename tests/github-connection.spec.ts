import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { discoverGithubCli, GithubConnection, normalizeGithubRepository, type GithubConnectionDependencies,
  type GithubConnectionInput, type GithubConnectionRunner } from '../src/app/github-connection.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { powershellQuote } from '../src/infra/command-line.ts'
import * as portable from '../src/infra/github-portable.ts'

const TOKEN = 'ghp_connection_test_secret_DO_NOT_PERSIST'
const CANDIDATE_ID = '35ef1bfe-2249-4c25-9a96-895f48ebaa9b'
const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'github-connection-'))
  const lifetime = new AbortController()
  const realCli = join(stateDir, 'real gh.exe'), oldCli = join(stateDir, 'old account.ps1')
  const candidate = { id: CANDIDATE_ID, cli: join(stateDir, 'github-connections', CANDIDATE_ID, 'gh.ps1') }
  const state = { revision: 7, value: { enabled: false, config: { repository: 'old/repo', cli: oldCli,
    pollSeconds: 180, failuresBeforeError: 7, observeIssues: true, observePulls: false, observeComments: true, observeCi: false } },
    saveWait: undefined as Promise<void> | undefined }
  const settings = {
    block: vi.fn(() => ({ revision: state.revision, value: structuredClone(state.value) })),
    save: vi.fn(async (_block: 'source:github', value: unknown, revision: number, _origin: 'panel') => {
      if (state.saveWait) await state.saveWait
      if (revision !== state.revision) throw new SettingsConflict('stale')
      state.value = structuredClone(value) as typeof state.value
      state.revision++
      return { restarting: true }
    }),
  }
  const runner = vi.fn<GithubConnectionRunner>(async (_cli, args) => {
    if (args[1] === 'user') return JSON.stringify({ login: 'agent-account', id: 42 })
    if (args[1]?.startsWith('repos/')) return JSON.stringify({ full_name: 'Canonical/Repository', permissions: { push: true } })
    if (args[1] === 'notifications?per_page=1') return '[]'
    throw new Error('Unexpected read')
  })
  const discover = vi.fn<NonNullable<GithubConnectionDependencies['discover']>>(async (preferred, real) => real ? realCli : preferred || realCli)
  const credentials = { supported: true,
    create: vi.fn(async () => candidate), remove: vi.fn(async () => {}),
    executable: vi.fn(async (_stateDir: string, cli: string) => cli === candidate.cli ? realCli : undefined) }
  const dependencies: GithubConnectionDependencies = { stateDir, settings, lifetime: lifetime.signal, runner, discover, credentials }
  const service = new GithubConnection(dependencies)
  const services = [service]
  onTestFinished(async () => {
    lifetime.abort()
    await Promise.all(services.map(item => item.drain()))
    rmSync(stateDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })
  const input = (override: Partial<GithubConnectionInput> = {}): GithubConnectionInput => ({ revision: 7,
    repository: 'https://github.com/requested/repository.git/', method: 'token', token: TOKEN, ...override })
  const finish = async () => { await service.drain(); return service.read() }
  const progress = () => readFileSync(join(stateDir, 'github-connection.json'), 'utf8')
  const restore = (text: string) => writeFileSync(join(stateDir, 'github-connection.json'), text)
  const restart = () => { const next = new GithubConnection(dependencies); services.push(next); return next }
  return { service, dependencies, lifetime, state, settings, credentials, runner, discover, stateDir, realCli, oldCli,
    candidate, input, finish, progress, restore, restart }
}

it.each([
  ['owner/repository', 'owner/repository'],
  [' https://github.com/Owner/repo.git/ ', 'Owner/repo'],
  ['https://GITHUB.com/owner/repo', 'owner/repo'],
  ['owner/repo.git', 'owner/repo'],
])('normalizes a repository location: %s', (input, expected) => expect(normalizeGithubRepository(input)).toBe(expected))

it.each(['', 'repo', 'http://github.com/owner/repo', 'https://git.example/owner/repo',
  'https://user:secret@github.com/owner/repo', 'https://github.com:8080/owner/repo',
  'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo?tab=readme',
  'https://github.com/owner/repo#readme', 'https://github.com/owner/../repo',
  'https://github.com/owner/%2e%2e', 'https://github.com/owner/repo%2fother',
  'https://github.com\\owner\\repo', '../repo', 'owner/..', 'owner/.', 'owner/repo/extra']) (
  'rejects a non-repository or ambiguous location: %s', input => expect(() => normalizeGithubRepository(input)).toThrow())

it('constructs before source registration and reads local configuration without making GitHub requests', async () => {
  const f = fixture()
  expect(f.settings.block).not.toHaveBeenCalled()
  f.settings.block.mockImplementationOnce(() => { throw new Error('Not registered yet') })
  expect((await f.service.read()).available).toBe(false)
  const view = await f.service.read()
  expect(view).toMatchObject({ available: true, tokenSupported: true, browserSupported: false, cli: f.realCli,
    connection: { repository: 'old/repo', login: null, managed: false, configured: true }, job: null })
  expect(f.runner).not.toHaveBeenCalled()
  expect(f.credentials.create).not.toHaveBeenCalled()
})

it('checks account, push access and notifications, then saves only a new immutable connection and preserves all source fields', async () => {
  const f = fixture(), old = structuredClone(f.state.value)
  const checking = await f.service.start(f.input())
  expect(checking.job?.status).toBe('checking')
  expect(JSON.parse(f.progress()).status).toBe('checking')
  const view = await f.finish()
  expect(view).toMatchObject({ connection: { repository: 'Canonical/Repository', login: 'agent-account', managed: true, configured: true },
    job: { status: 'connected', restarting: true } })
  expect(f.state.value).toEqual({ ...old, config: { ...old.config, repository: 'Canonical/Repository', cli: f.candidate.cli } })
  expect(f.settings.save).toHaveBeenCalledWith('source:github', f.state.value, 7, 'panel')
  expect(f.runner.mock.calls.map(([_cli, args]) => args)).toEqual([
    ['api', 'user', '--hostname', 'github.com'], ['api', 'repos/requested/repository', '--hostname', 'github.com'],
    ['api', 'notifications?per_page=1', '--hostname', 'github.com'],
  ])
  expect(f.runner.mock.calls.every(([cli]) => cli === f.candidate.cli)).toBe(true)
  expect(f.credentials.create).toHaveBeenCalledWith({ stateDir: f.stateDir, token: TOKEN, executable: f.realCli }, expect.any(AbortSignal))
  expect(f.credentials.remove).not.toHaveBeenCalled()
  for (const text of [f.progress(), JSON.stringify(view), JSON.stringify(f.settings.save.mock.calls), JSON.stringify(f.runner.mock.calls)])
    expect(text).not.toContain(TOKEN)
})

it('keeps the selected managed account when existing CLI connection is requested', async () => {
  const f = fixture()
  f.state.value.config.cli = f.candidate.cli
  await f.service.start(f.input({ method: 'existing', token: undefined }))
  expect((await f.finish()).job?.status).toBe('connected')
  expect(f.discover).toHaveBeenCalledWith(f.candidate.cli, false, true, expect.any(AbortSignal))
  expect(f.runner.mock.calls.every(([cli]) => cli === f.candidate.cli)).toBe(true)
  expect(f.credentials.create).not.toHaveBeenCalled()
  expect(f.state.value.config.cli).toBe(f.candidate.cli)
})

it('keeps the saved account visible when a later connection attempt fails', async () => {
  const f = fixture()
  await f.service.start(f.input())
  expect((await f.finish()).connection.login).toBe('agent-account')
  f.runner.mockRejectedValueOnce(new Error(TOKEN))
  await f.service.start(f.input({ method: 'existing', token: undefined, revision: f.state.revision }))
  const view = await f.finish()
  expect(view.job?.status).toBe('failed')
  expect(view.connection).toMatchObject({ login: 'agent-account', repository: 'Canonical/Repository', configured: true })
  expect(f.credentials.remove).not.toHaveBeenCalled()
})

it.each(['account', 'repository', 'push-required', 'notifications'] as const)(
  'leaves the previous configuration in place and removes only its candidate after %s failure', async stage => {
    const f = fixture(), old = structuredClone(f.state.value)
    f.runner.mockImplementation(async (_cli, args) => {
      if (args[1] === 'user') {
        if (stage === 'account') throw new Error(TOKEN)
        return JSON.stringify({ login: 'agent-account', id: 42 })
      }
      if (args[1]?.startsWith('repos/')) {
        if (stage === 'repository') throw new Error(TOKEN)
        return JSON.stringify({ full_name: 'Canonical/Repository', permissions: { push: stage !== 'push-required' } })
      }
      throw new Error(TOKEN)
    })
    await f.service.start(f.input())
    const view = await f.finish()
    expect(view.job).toMatchObject({ status: 'failed', errorCode: stage })
    expect(f.state.value).toEqual(old)
    expect(f.settings.save).not.toHaveBeenCalled()
    expect(f.credentials.remove).toHaveBeenCalledWith(f.stateDir, CANDIDATE_ID)
    expect(f.progress() + JSON.stringify(view)).not.toContain(TOKEN)
  },
)

it('checks notification capability even when the source is disabled and every receive switch is off', async () => {
  const f = fixture()
  Object.assign(f.state.value.config, { observeIssues: false, observePulls: false, observeComments: false, observeCi: false })
  await f.service.start(f.input())
  expect((await f.finish()).job?.status).toBe('connected')
  expect(f.runner.mock.calls.some(([_cli, args]) => args[1] === 'notifications?per_page=1')).toBe(true)
  expect(f.state.value.enabled).toBe(false)
})

it('rejects stale revisions before creating credentials and detects source changes during checks', async () => {
  const f = fixture()
  expect((await f.service.start(f.input({ revision: 6 }))).job).toMatchObject({ status: 'failed', errorCode: 'settings-conflict' })
  expect(f.credentials.create).not.toHaveBeenCalled()
  const original = f.runner.getMockImplementation()!
  f.runner.mockImplementation(async (...args) => {
    const text = await original(...args)
    if (args[1][1] === 'notifications?per_page=1') { f.state.revision++; f.state.value.config.observePulls = true }
    return text
  })
  await f.service.start(f.input())
  expect((await f.finish()).job).toMatchObject({ status: 'failed', errorCode: 'settings-conflict' })
  expect(f.settings.save).not.toHaveBeenCalled()
  expect(f.state.value.config).toMatchObject({ repository: 'old/repo', cli: f.oldCli, observePulls: true })
  expect(f.credentials.remove).toHaveBeenCalledOnce()
})

it.each([new SettingsConflict('stale'), new Error(TOKEN)])('keeps the old selection when Settings.save rejects', async failure => {
  const f = fixture(), old = structuredClone(f.state.value)
  f.settings.save.mockRejectedValueOnce(failure)
  await f.service.start(f.input())
  const view = await f.finish()
  expect(view.job).toMatchObject({ status: 'failed', errorCode: failure instanceof SettingsConflict ? 'settings-conflict' : 'save-failed' })
  expect(f.state.value).toEqual(old)
  expect(f.credentials.remove).toHaveBeenCalledWith(f.stateDir, CANDIDATE_ID)
  expect(f.progress() + JSON.stringify(view)).not.toContain(TOKEN)
})

it('cancels checking, keeps one in-flight job, and never saves a cancelled candidate', async () => {
  const f = fixture()
  f.runner.mockImplementation((_cli, _args, signal) => new Promise((_done, reject) => {
    signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true })
  }))
  const first = await f.service.start(f.input())
  const second = await f.service.start(f.input({ repository: 'other/repo' }))
  expect(second.job?.id).toBe(first.job?.id)
  expect(f.credentials.create).toHaveBeenCalledOnce()
  expect((await f.service.cancel(first.job!.id)).job?.status).toBe('cancelled')
  expect(JSON.parse(f.progress()).status).toBe('cancelled')
  expect(f.settings.save).not.toHaveBeenCalled()
  expect(f.credentials.remove).toHaveBeenCalledOnce()
})

it('ignores a stale cancel ID after a newer connection attempt has started', async () => {
  const f = fixture()
  f.runner.mockImplementation((_cli, _args, signal) => new Promise((_done, reject) => {
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
  }))
  const first = await f.service.start(f.input())
  await vi.waitFor(() => expect(f.runner).toHaveBeenCalledOnce())
  await f.service.cancel(first.job!.id)
  const next = await f.service.start(f.input())
  await vi.waitFor(() => expect(f.runner).toHaveBeenCalledTimes(2))
  expect(next.job?.id).not.toBe(first.job?.id)
  expect((await f.service.cancel(first.job!.id)).job).toMatchObject({ id: next.job!.id, status: 'checking' })
  expect(f.runner.mock.calls.at(-1)?.[2].aborted).toBe(false)
  expect(f.settings.save).not.toHaveBeenCalled()
  await f.service.cancel(next.job!.id)
})

it('does not launch checking after cancellation during the initial progress write', async () => {
  const f = fixture()
  await f.service.read()
  const start = f.service.start(f.input())
  const cancel = f.service.cancel()
  const [started, cancelled] = await Promise.all([start, cancel])
  await f.service.drain()
  expect(started.job?.status).toBe('cancelled')
  expect(cancelled.job?.status).toBe('cancelled')
  expect(JSON.parse(f.progress()).status).toBe('cancelled')
  expect(f.credentials.create).not.toHaveBeenCalled()
  expect(f.runner).not.toHaveBeenCalled()
  expect(f.settings.save).not.toHaveBeenCalled()
})

it.runIf(process.platform === 'win32')('cancels both the PowerShell CLI wrapper and its native child before reporting cancellation', async () => {
  const f = fixture(), cli = join(f.stateDir, 'tracked cli.ps1'), native = join(f.stateDir, 'hanging native.cjs'), pidFile = join(f.stateDir, 'child.json')
  writeFileSync(native, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)`)
  writeFileSync(cli, [
    "if ($args[1] -eq 'user') { [Console]::Out.Write('{\"login\":\"agent-account\",\"id\":42}'); exit 0 }",
    `& ${powershellQuote(process.execPath)} ${powershellQuote(native)}`, 'exit $LASTEXITCODE',
  ].join('\n'))
  const service = new GithubConnection({ ...f.dependencies, runner: undefined, discover: async () => cli })
  onTestFinished(async () => { await service.cancel(); await service.drain() })
  await service.start(f.input({ method: 'existing', token: undefined }))
  await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 })
  const { pid } = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number }
  expect(() => process.kill(pid, 0)).not.toThrow()
  expect((await service.cancel()).job?.status).toBe('cancelled')
  expect(() => process.kill(pid, 0)).toThrow()
  expect(f.settings.save).not.toHaveBeenCalled()
}, 15_000)

it('refuses cancellation once saving begins and drains the commit before shutdown can close settings', async () => {
  const f = fixture(), gate = deferred()
  f.state.saveWait = gate.promise
  await f.service.start(f.input())
  await vi.waitFor(() => expect(f.settings.save).toHaveBeenCalledOnce())
  expect((await f.service.cancel()).job?.status).toBe('saving')
  let drained = false
  const draining = f.service.drain().then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  gate.resolve()
  await draining
  expect((await f.service.read()).job?.status).toBe('connected')
  expect(f.credentials.remove).not.toHaveBeenCalled()
})

it('recovers a persisted checking attempt as interrupted and removes its uncommitted candidate', async () => {
  const f = fixture()
  f.runner.mockImplementation((_cli, _args, signal) => new Promise((_done, reject) => {
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
  }))
  await f.service.start(f.input())
  await vi.waitFor(() => expect(f.runner).toHaveBeenCalledOnce())
  const checkpoint = f.progress()
  f.lifetime.abort()
  await f.service.drain()
  f.credentials.remove.mockClear()
  f.restore(checkpoint)
  const restarted = f.restart()
  expect((await restarted.read()).job).toMatchObject({ status: 'interrupted', errorCode: 'interrupted' })
  expect(f.credentials.remove).toHaveBeenCalledWith(f.stateDir, CANDIDATE_ID)
  expect(f.settings.save).not.toHaveBeenCalled()
})

it.each(['token', 'existing'] as const)('recognizes a committed %s selection after a crash before the final progress write', async method => {
  const f = fixture(), gate = deferred()
  f.state.saveWait = gate.promise
  await f.service.start(f.input({ method, token: method === 'token' ? TOKEN : undefined }))
  await vi.waitFor(() => expect(f.settings.save).toHaveBeenCalledOnce())
  const checkpoint = f.progress()
  gate.resolve()
  expect((await f.finish()).job?.status).toBe('connected')
  f.restore(checkpoint)
  const restarted = f.restart()
  const view = await restarted.read()
  expect(view.job).toMatchObject({ status: 'connected', restarting: true })
  expect(view.connection).toMatchObject({ repository: 'Canonical/Repository', login: 'agent-account' })
  expect(f.credentials.remove).not.toHaveBeenCalled()
})

it('does not remove a committed candidate if saving throws after the settings commit', async () => {
  const f = fixture()
  const save = f.settings.save.getMockImplementation()!
  f.settings.save.mockImplementation(async (...args) => { await save(...args); throw new Error(TOKEN) })
  await f.service.start(f.input())
  const view = await f.finish()
  expect(view.job?.status).toBe('connected')
  expect(f.state.value.config.cli).toBe(f.candidate.cli)
  expect(f.credentials.remove).not.toHaveBeenCalled()
  expect(f.progress() + JSON.stringify(view)).not.toContain(TOKEN)
})

it('reports a missing CLI without creating credentials or touching settings', async () => {
  const f = fixture()
  f.discover.mockResolvedValue(undefined)
  await f.service.start(f.input({ cli: join(f.stateDir, 'missing.exe') }))
  expect((await f.finish()).job).toMatchObject({ status: 'failed', errorCode: 'cli-missing' })
  expect(f.credentials.create).not.toHaveBeenCalled()
  expect(f.settings.save).not.toHaveBeenCalled()
})

it('discovers a real executable outside worker shims and never substitutes another CLI for a missing preferred account', async () => {
  const f = fixture(), bin = join(f.stateDir, 'installed cli'), shims = join(f.stateDir, 'worker-bin')
  mkdirSync(bin); mkdirSync(shims)
  const name = process.platform === 'win32' ? 'gh.exe' : 'gh'
  const actual = join(bin, name)
  writeFileSync(actual, 'test executable', { mode: 0o755 })
  writeFileSync(join(shims, name), 'test worker shim', { mode: 0o755 })
  vi.stubEnv('PATH', [shims, bin].join(delimiter))
  expect(await discoverGithubCli(f.stateDir)).toBe(actual)
  expect(await discoverGithubCli(f.stateDir, actual)).toBe(actual)
  expect(await discoverGithubCli(f.stateDir, join(f.stateDir, 'missing account.exe'))).toBeUndefined()
  expect(await discoverGithubCli(f.stateDir, join(shims, name))).toBeUndefined()
})

it.skipIf(process.platform !== 'win32')('finds a signed CLI in the desktop registry for both connection methods when the service registry is empty', async () => {
  const f = fixture()
  vi.stubEnv('PATH', '')
  vi.stubEnv('ProgramFiles', f.stateDir)
  vi.stubEnv('ProgramFiles(x86)', f.stateDir)
  vi.stubEnv('LOCALAPPDATA', f.stateDir)
  vi.stubEnv('USERPROFILE', f.stateDir)
  vi.stubEnv('DSH_HOME', join(f.stateDir, 'service-home'))
  const roots = ['unregistered', 'unsigned', 'renamed-workspace'].map(name => join(f.stateDir, name))
  for (const root of roots) {
    const bin = join(root, 'tools', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'gh.exe'), 'fixture')
  }
  const registry = join(f.stateDir, '.dsh', 'storages')
  mkdirSync(registry, { recursive: true })
  writeFileSync(join(registry, 'workspace.json'), JSON.stringify({
    global: { workspaceIds: ['missing', 'unsigned', 'portable'] },
    tables: { workspaces: { unused: { path: roots[0] }, unsigned: { path: roots[1] }, portable: { path: roots[2] } } },
  }))
  const installed = join(roots[2]!, 'tools', 'bin', 'gh.exe')
  const verify = vi.spyOn(portable, 'verifiedPortableGithubCli').mockImplementation(async (file, _state, prepare) =>
    file === installed ? prepare ? f.realCli : installed : undefined)
  onTestFinished(() => verify.mockRestore())
  expect(await discoverGithubCli(f.stateDir)).toBe(installed)
  expect(verify.mock.calls.map(([file]) => file)).toEqual([join(roots[1]!, 'tools', 'bin', 'gh.exe'), installed])
  for (const method of ['existing', 'token'] as const) {
    f.state.value.config.cli = ''
    f.credentials.create.mockClear()
    f.runner.mockClear()
    const service = new GithubConnection({ ...f.dependencies, discover: undefined })
    await service.start(f.input({ revision: f.state.revision, method }))
    await service.drain()
    expect((await service.read()).job?.status).toBe('connected')
    expect(verify).toHaveBeenCalledWith(installed, f.stateDir, true)
    if (method === 'token') expect(f.credentials.create).toHaveBeenCalledWith(expect.objectContaining({ executable: f.realCli }), expect.any(AbortSignal))
    else expect(f.runner.mock.calls[0]?.[0]).toBe(f.realCli)
  }
  const controller = new AbortController()
  const started = deferred<void>()
  verify.mockImplementation(async () => { started.resolve(); return new Promise(() => {}) })
  const pending = discoverGithubCli(f.stateDir, '', false, false, controller.signal)
  await started.promise
  controller.abort()
  expect(await pending).toBeUndefined()
})
