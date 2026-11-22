/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { delimiter } from 'node:path'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, credentialHelper, verifyEnvironment, withoutDirectory, workerBin, workerGitConfig, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem, type StartupObserver } from '../setup.ts'
import type { DeploymentNativePort } from './runtime-ports.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  readonly native?: Pick<DeploymentNativePort, 'probe'>
  readonly allowLocal?: boolean
  readonly startup?: StartupObserver
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  /** Applied to the owning Session's subprocesses; it must never change the shared host environment. */
  get workerEnvironment(): Record<string, string | undefined> {
    return { ...this.variables, PATH: [workerBin(this.host.machine.stateDir), this.path].join(delimiter) }
  }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    this.problem = undefined
    this.feishuProblem = undefined
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      await this.host.startup?.({ stage: error.place === 'github' ? 'github' : 'environment', status: 'blocked' })
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe(), this.path, this.host.allowLocal)
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    if (this.host.native) return (argv: string[], env?: Record<string, string>) =>
      this.host.native!.probe(argv, machine.stateDir, { ...this.commandEnvironment, ...env },
        AbortSignal.any([lifetime, AbortSignal.timeout(60_000)]))
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    await this.host.startup?.({ stage: 'github', status: 'running' })
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe, this.path, this.host.allowLocal)
    await this.host.startup?.({ stage: 'github', status: deployment.github ? 'complete' : 'skipped' })
    await this.host.startup?.({ stage: 'sources', status: 'running' })
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    await this.host.startup?.({ stage: 'sources', status: this.feishuProblem ? 'failed' : feishu ? 'complete' : 'skipped' })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await this.host.startup?.({ stage: 'environment', status: 'running' })
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    if (!this.host.native) this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    const verified = this.host.native ? this.verifyNative(resolved) : verifyEnvironment(resolved, context.subprocess, lifetime)
    await verified.catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    await this.host.startup?.({ stage: 'environment', status: 'complete' })
    return resolved
  }
  private async verifyNative(deployment: Deployment): Promise<void> {
    if (!deployment.github) return
    const output = await this.host.native!.probe(['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'],
      deployment.stateDir, this.workerEnvironment, AbortSignal.any([this.host.lifetime, AbortSignal.timeout(60_000)])).catch(() => '')
    const expected = [`file:${workerGitConfig(deployment.stateDir)}`, credentialHelper(deployment.github.cli), ''].join('\0')
    if (output !== expected) throw new SetupError('gitTooOld')
  }
}
