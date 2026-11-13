/** Read-only GitHub connection checks followed by the existing optimistic settings save. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { executable } from '../deployment.ts'
import { commandLine } from '../infra/command-line.ts'
import { withoutDirectory, workerBin } from '../infra/environment.ts'
import { createGithubConnection, GithubCredentialError, managedGithubDirectory, managedGithubExecutable, removeGithubConnection }
  from '../infra/github-credentials.ts'
import { GithubProcessError, runGithubProcess } from '../infra/github-process.ts'
import { SettingsConflict } from './settings.ts'

export interface GithubConnectionInput {
  revision: number
  repository: string
  method: 'token' | 'existing'
  token?: string
  cli?: string
}
export type GithubConnectionErrorCode = 'invalid-repository' | 'invalid-input' | 'invalid-token' | 'source-unavailable'
  | 'unsupported-platform' | 'cli-missing' | 'account' | 'repository' | 'push-required' | 'notifications'
  | 'settings-conflict' | 'save-failed' | 'secure-storage' | 'timeout' | 'interrupted' | 'state-storage'
export type GithubConnectionStatus = 'checking' | 'saving' | 'connected' | 'failed' | 'cancelled' | 'interrupted'
export interface GithubConnectionJob {
  id: string
  status: GithubConnectionStatus
  message: string
  errorCode?: GithubConnectionErrorCode
  restarting?: boolean
}
export interface GithubConnectionView {
  available: boolean
  tokenSupported: boolean
  browserSupported: false
  cli: string | null
  connection: { repository: string; login: string | null; managed: boolean; configured: boolean }
  job: GithubConnectionJob | null
}
interface SourceBlock { revision: number; value: { enabled: boolean; config: Record<string, unknown> } }
interface ConnectionSettings {
  block(block: string): { revision: number; value: unknown }
  save(block: 'source:github', value: unknown, revision: number, origin: 'panel'): Promise<{ restarting: boolean }>
}
export type GithubConnectionRunner = (cli: string, args: string[], signal: AbortSignal) => Promise<string>
export interface GithubConnectionDependencies {
  stateDir: string
  settings: ConnectionSettings
  lifetime: AbortSignal
  runner?: GithubConnectionRunner
  discover?: (preferred: string, real: boolean) => Promise<string | undefined>
  credentials?: {
    supported: boolean
    create: typeof createGithubConnection
    remove: typeof removeGithubConnection
    executable: typeof managedGithubExecutable
  }
}

const ERRORS: Record<GithubConnectionErrorCode, string> = {
  'invalid-repository': 'Enter owner/repository or an HTTPS GitHub repository URL.',
  'invalid-input': 'The connection request is invalid. Reload the settings and try again.',
  'invalid-token': 'Enter a valid GitHub token without spaces or line breaks.',
  'source-unavailable': 'The GitHub source is not installed.',
  'unsupported-platform': 'Secure token storage is unavailable on this platform. Use an existing configured CLI.',
  'cli-missing': 'GitHub CLI was not found. Install it or choose its command name or absolute path.',
  account: 'The GitHub CLI could not verify the account. Check the token or existing CLI login and network connection.',
  repository: 'The account could not read this GitHub repository. Check the repository and account access.',
  'push-required': 'This account needs push access to the selected repository.',
  notifications: 'This connection cannot read GitHub notifications. Use a classic token with repo or notifications scope.',
  'settings-conflict': 'GitHub settings changed during the checks. Reload them and reconnect.',
  'save-failed': 'The connection could not be saved. The previous settings are still selected.',
  'secure-storage': 'The GitHub token could not be saved in secure storage.',
  timeout: 'The GitHub connection checks timed out. Check the network and try again.',
  interrupted: 'The connection was interrupted by a service restart. Reconnect to continue.',
  'state-storage': 'Connection progress could not be saved. Check the state directory and try again.',
}
class ConnectionFailure extends Error {
  constructor(readonly code: GithubConnectionErrorCode) { super(ERRORS[code]) }
}
const RecordSchema = z.object({
  version: z.literal(1), id: z.uuid(), status: z.enum(['checking', 'saving', 'connected', 'failed', 'cancelled', 'interrupted']),
  revision: z.number().int().nonnegative(), repository: z.string().max(200), cli: z.string().max(4096).optional(),
  login: z.string().regex(/^[A-Za-z0-9-]+$/).max(100).optional(),
  selected: z.object({ repository: z.string().max(200), cli: z.string().max(4096),
    login: z.string().regex(/^[A-Za-z0-9-]+$/).max(100) }).optional(),
  candidate: z.object({ id: z.uuid(), cli: z.string().max(4096) }).optional(),
  errorCode: z.enum(Object.keys(ERRORS) as [GithubConnectionErrorCode, ...GithubConnectionErrorCode[]]).optional(),
  restarting: z.boolean().optional(),
}).strict()
type ConnectionRecord = z.infer<typeof RecordSchema>
const active = (record: ConnectionRecord | undefined): boolean => record?.status === 'checking' || record?.status === 'saving'
const sameCli = (left: string, right: string): boolean => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)

/** Reject ambiguous URLs before URL parsing can collapse traversal segments. */
export function normalizeGithubRepository(input: string): string {
  const text = input.trim()
  const pair = /^https:\/\//i.test(text)
    ? /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(text)?.slice(1)
    : /^([^/]+)\/([^/]+)$/.exec(text)?.slice(1)
  const [owner = '', suffix = ''] = pair ?? []
  const repository = suffix.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository === '.' || repository === '..')
    throw new ConnectionFailure('invalid-repository')
  return `${owner}/${repository}`
}

/** File discovery only: never signs in, executes a CLI, or selects an account. */
export async function discoverGithubCli(stateDir: string, preferred = '', real = false): Promise<string | undefined> {
  const original = preferred && real ? await managedGithubExecutable(stateDir, preferred) ?? preferred : preferred
  const common = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
      .filter((directory): directory is string => !!directory).map(directory => join(directory, 'GitHub CLI', 'gh.exe'))
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', join(homedir(), '.local/bin/gh')]
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  for (const name of original ? [original] : ['gh', ...common]) {
    try {
      const file = executable(name, path, workerBin(stateDir))
      const managed = relative(resolve(managedGithubDirectory(stateDir)).toLowerCase(), resolve(file).toLowerCase())
      if (real && managed !== '..' && !managed.startsWith('..\\') && !managed.startsWith('../') && !/^(?:[A-Za-z]:|[/\\])/.test(managed)) continue
      return file
    } catch { /* Continue to PATH and standard installation directories. */ }
  }
  return undefined
}

/** One recoverable connection attempt; only its non-sensitive state is persisted. */
export class GithubConnection {
  private readonly file: string
  private readonly credentials: NonNullable<GithubConnectionDependencies['credentials']>
  private readonly discover: NonNullable<GithubConnectionDependencies['discover']>
  private readonly runner: GithubConnectionRunner
  private record?: ConnectionRecord
  private initialized?: Promise<void>
  private pending?: Promise<void>
  private controller?: AbortController
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly host: GithubConnectionDependencies) {
    this.file = join(host.stateDir, 'github-connection.json')
    this.credentials = host.credentials ?? { supported: process.platform === 'win32', create: createGithubConnection,
      remove: removeGithubConnection, executable: managedGithubExecutable }
    this.discover = host.discover ?? ((preferred, real) => discoverGithubCli(host.stateDir, preferred, real))
    this.runner = host.runner ?? ((cli, args, signal) => this.runCli(cli, args, signal))
  }
  /** Local projection only; source registration may happen after construction. */
  async read(): Promise<GithubConnectionView> {
    await this.initialize()
    const block = this.block(), config = block?.value.config
    const repository = typeof config?.repository === 'string' ? config.repository : ''
    const cli = typeof config?.cli === 'string' ? config.cli : ''
    const managed = !!cli && !!await this.credentials.executable(this.host.stateDir, cli)
    const selected = this.record?.status === 'connected' ? this.record : this.record?.selected
    const login = selected?.cli === cli && selected.repository === repository ? selected.login ?? null : null
    return { available: !!block, tokenSupported: this.credentials.supported, browserSupported: false,
      cli: await this.discover(cli, true) ?? null,
      connection: { repository, login, managed, configured: !!repository && !!cli }, job: this.publicJob() }
  }
  /** Return after recording the attempt, without waiting for network checks or Settings.save. */
  async start(input: GithubConnectionInput): Promise<GithubConnectionView> {
    await this.initialize()
    if (this.pending || active(this.record)) return this.read()
    const record: ConnectionRecord = { version: 1, id: randomUUID(), status: 'checking', revision: 0, repository: '' }
    const previous = this.record?.status === 'connected' ? this.record : this.record?.selected
    if (previous?.cli && previous.login) record.selected = { repository: previous.repository, cli: previous.cli, login: previous.login }
    this.record = record
    const controller = this.controller = new AbortController()
    let request: GithubConnectionInput
    try {
      if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !['token', 'existing'].includes(input.method))
        throw new ConnectionFailure('invalid-input')
      record.revision = input.revision
      record.repository = normalizeGithubRepository(input.repository)
      const block = this.block()
      if (!block) throw new ConnectionFailure('source-unavailable')
      if (block.revision !== input.revision) throw new ConnectionFailure('settings-conflict')
      if (input.method === 'token' && !this.credentials.supported) throw new ConnectionFailure('unsupported-platform')
      if (input.method === 'token' && (!input.token?.trim() || input.token.length > 4096 || !/^[\x21-\x7e]+$/.test(input.token.trim())))
        throw new ConnectionFailure('invalid-token')
      if (input.cli !== undefined && (typeof input.cli !== 'string' || input.cli.length > 4096 || /[\r\n\0]/.test(input.cli)))
        throw new ConnectionFailure('invalid-input')
      this.host.lifetime.throwIfAborted()
      request = { ...input, repository: record.repository }
      await this.persist()
    } catch (error) {
      record.status = 'failed'
      record.errorCode = error instanceof ConnectionFailure ? error.code : 'state-storage'
      await this.persist().catch(() => { record.errorCode = 'state-storage' })
      if (this.controller === controller) this.controller = undefined
      return this.read()
    }
    if (this.record !== record || record.status !== 'checking' || controller.signal.aborted || this.host.lifetime.aborted) {
      delete request.token
      if (this.record === record && record.status === 'checking') {
        record.status = 'interrupted'; record.errorCode = 'interrupted'; await this.persist()
      }
      if (this.controller === controller) this.controller = undefined
      return this.read()
    }
    const task = this.attempt(request, record, AbortSignal.any([controller.signal, this.host.lifetime, AbortSignal.timeout(60_000)]))
    this.pending = task.finally(() => { this.pending = undefined; this.controller = undefined })
    return this.read()
  }
  /** A save is a commit boundary: cancellation only aborts checks and candidate creation. */
  async cancel(id?: string): Promise<GithubConnectionView> {
    await this.initialize()
    if (this.record?.status === 'checking' && (!id || this.record.id === id)) {
      this.record.status = 'cancelled'
      this.controller?.abort()
      await this.persist()
      await this.drain()
    }
    return this.read()
  }
  /** Runtime shutdown must wait for an in-flight settings commit before closing its store. */
  async drain(): Promise<void> { await this.pending; await this.writes }

  private block(): SourceBlock | undefined {
    try {
      const block = this.host.settings.block('source:github')
      const value = z.object({ enabled: z.boolean(), config: z.record(z.string(), z.unknown()) }).parse(block.value)
      return { revision: block.revision, value }
    } catch { return undefined }
  }
  private publicJob(): GithubConnectionJob | null {
    const record = this.record
    if (!record) return null
    const message = record.errorCode ? ERRORS[record.errorCode] : record.status === 'checking' ? 'Checking GitHub account and repository access.'
      : record.status === 'saving' ? 'Saving the verified GitHub connection.' : record.status === 'connected'
      ? record.restarting ? 'Connection saved. The service is restarting to apply it.' : 'Connection saved.'
      : record.status === 'cancelled' ? 'Connection cancelled.' : ERRORS.interrupted
    return { id: record.id, status: record.status, message, ...record.errorCode ? { errorCode: record.errorCode } : {},
      ...record.restarting !== undefined ? { restarting: record.restarting } : {} }
  }
  private initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      try { this.record = RecordSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.record = { version: 1, id: randomUUID(), status: 'failed',
          revision: 0, repository: '', errorCode: 'state-storage' }
        return
      }
      if (!active(this.record)) return
      const block = this.block()
      if (this.committed(this.record, block)) {
        this.record.status = 'connected'
        this.record.restarting = true
      } else {
        this.record.status = 'interrupted'
        this.record.errorCode = 'interrupted'
        await this.discard(this.record)
      }
      await this.persist()
    })()
  }
  private persist(): Promise<void> {
    const text = JSON.stringify(this.record) + '\n'
    const next = this.writes.then(async () => {
      await mkdir(this.host.stateDir, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.file)
    })
    this.writes = next.catch(() => {})
    return next
  }
  private committed(record: ConnectionRecord, block = this.block()): boolean {
    return record.status === 'saving' && !!record.cli && !!record.login && !!block && block.revision > record.revision
      && block.value.config.repository === record.repository && block.value.config.cli === record.cli
  }
  private async discard(record: ConnectionRecord): Promise<void> {
    if (!record.candidate) return
    const block = this.block()
    // A missing source or a reference to this candidate makes ownership of its current use uncertain. Keep it.
    if (!block || typeof block.value.config.cli === 'string' && sameCli(block.value.config.cli, record.candidate.cli)) return
    try { await this.credentials.remove(this.host.stateDir, record.candidate.id); delete record.candidate }
    catch { /* Preserve the encrypted candidate and original safe failure for later inspection. */ }
  }
  private async attempt(input: GithubConnectionInput, record: ConnectionRecord, signal: AbortSignal): Promise<void> {
    let saved = false
    try {
      const before = this.block()
      if (!before || before.revision !== input.revision) throw new ConnectionFailure('settings-conflict')
      const preferred = input.cli?.trim() || String(before.value.config.cli ?? '')
      const cli = await this.discover(preferred, input.method === 'token')
      signal.throwIfAborted()
      if (!cli) throw new ConnectionFailure('cli-missing')
      if (input.method === 'token') {
        record.candidate = await this.credentials.create({ stateDir: this.host.stateDir, token: input.token!, executable: cli }, signal)
        record.cli = record.candidate.cli
        delete input.token
        await this.persist()
      } else record.cli = cli
      const checked = await this.check(record.cli, record.repository, signal)
      signal.throwIfAborted()
      const block = this.block()
      if (!block || block.revision !== input.revision) throw new ConnectionFailure('settings-conflict')
      record.repository = checked.repository
      record.login = checked.login
      record.status = 'saving'
      await this.persist()
      this.host.lifetime.throwIfAborted()
      const result = await this.host.settings.save('source:github', { ...block.value,
        config: { ...block.value.config, repository: checked.repository, cli: record.cli } }, input.revision, 'panel')
      saved = true
      record.status = 'connected'
      record.restarting = result.restarting
    } catch (error) {
      if (saved || this.committed(record)) { record.status = 'connected'; record.restarting = true }
      else {
        record.status = this.host.lifetime.aborted ? 'interrupted' : this.controller?.signal.aborted ? 'cancelled' : 'failed'
        record.errorCode = record.status === 'interrupted' ? 'interrupted' : signal.aborted ? 'timeout'
          : error instanceof ConnectionFailure ? error.code : error instanceof SettingsConflict ? 'settings-conflict'
          : error instanceof GithubCredentialError ? error.code === 'unsupported-platform' || error.code === 'invalid-token' ? error.code
          : error.code === 'invalid-executable' ? 'cli-missing' : 'secure-storage' : 'save-failed'
        if (record.status === 'cancelled') delete record.errorCode
        await this.discard(record)
      }
    } finally {
      delete input.token
      await this.persist().catch(() => {
        if (record.status !== 'connected') { record.status = 'failed'; record.errorCode = 'state-storage' }
      })
    }
  }
  private async check(cli: string, repository: string, signal: AbortSignal): Promise<{ login: string; repository: string }> {
    const request = async (path: string, code: GithubConnectionErrorCode): Promise<unknown> => {
      try {
        signal.throwIfAborted()
        const output = await this.runner(cli, ['api', path, '--hostname', 'github.com'], signal)
        signal.throwIfAborted()
        return JSON.parse(output) as unknown
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof GithubProcessError && error.code === 'timeout') throw new ConnectionFailure('timeout')
        throw new ConnectionFailure(error && typeof error === 'object' && 'killed' in error && error.killed === true ? 'timeout' : code)
      }
    }
    const user = z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/), id: z.number().int().positive() })
      .safeParse(await request('user', 'account'))
    if (!user.success) throw new ConnectionFailure('account')
    const repo = z.object({ full_name: z.string(), permissions: z.object({ push: z.boolean().nullable() }) })
      .safeParse(await request(`repos/${repository}`, 'repository'))
    if (!repo.success) throw new ConnectionFailure('repository')
    if (repo.data.permissions.push !== true) throw new ConnectionFailure('push-required')
    let canonical: string
    try { canonical = normalizeGithubRepository(repo.data.full_name) } catch { throw new ConnectionFailure('repository') }
    if (!Array.isArray(await request('notifications?per_page=1', 'notifications'))) throw new ConnectionFailure('notifications')
    return { login: user.data.login, repository: canonical }
  }
  private async runCli(cli: string, args: string[], signal: AbortSignal): Promise<string> {
    const env = { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
      GH_DEBUG: undefined, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
      PATH: withoutDirectory(process.env.PATH ?? '', workerBin(this.host.stateDir)) }
    const [program = cli, ...argv] = commandLine([cli, ...args], this.host.stateDir, env)
    return runGithubProcess(program, argv, { cwd: this.host.stateDir, env, signal, timeoutMs: 20_000, maxBuffer: 512 * 1024 })
  }
}
