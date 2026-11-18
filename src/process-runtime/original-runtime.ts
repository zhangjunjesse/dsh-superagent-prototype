/** Composition of the original complete application in an independent organization owner. */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { Runtime } from '../app/runtime.ts'
import type { RuntimeNativePorts } from '../app/runtime-ports.ts'
import type { Machine } from '../deployment.ts'
import { KV } from '../kv.ts'
import { LIMITS } from '../limits.ts'
import { SettingsSchema } from '../policy.ts'
import { GatewayLedger } from '../jarvis-gateway/ledger.ts'
import { GatewayService } from '../jarvis-gateway/service.ts'
import { GatewayPump } from '../jarvis-gateway/pump.ts'
import { jarvisKind, SourceBackend } from '../jarvis-gateway/source.ts'
import * as github from '../sources/github.ts'
import * as feishu from '../sources/feishu.ts'
import { InboundDelegations } from './delegation-ingress.ts'
import { DelegationExecutor } from './delegation-executor.ts'
import { EngineConfigSchema, normalizeEngineConfig } from './engine-config.ts'
import { initializeOriginalConfiguration } from './original-config.ts'
import { TaskFiles, artifactLinks } from './task-files.ts'
import { effectiveWorkerTools } from './worker-capabilities.ts'
import { CapabilityDrain, type CapabilityHold } from './capability-drain.ts'
import type { ProcessHost, ProcessRunResult, ProcessRuntimeConfig } from './runtime.ts'

const absolute = z.string().refine(isAbsolute)
const machineDefaults = z.object({
  promptMaxChars: z.number().int().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max),
  admissionContextMaxPages: z.number().int().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max),
  admissionContextTimeoutMs: z.number().int().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max),
}).strict()
export const OriginalAdoptionSchema = z.object({
  version: z.literal(1), instanceId: z.string().min(1),
  identity: z.object({ deploymentId: z.string().min(1), principalId: z.string().min(1) }).strict(),
  masterId: z.string().min(1), sessions: z.array(z.object({ sessionId: z.string().min(1), role: z.enum(['orchestrator', 'worker']),
    ticketId: z.string().min(1).optional(), cwd: absolute }).strict()),
  sourcePaths: z.object({ core: absolute, gateway: absolute, stateDir: absolute }).strict(),
  sourceHashes: z.object({ core: z.string().regex(/^[a-f0-9]{64}$/), gateway: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  completedAt: z.string().min(1), journalPath: absolute,
  machineDefaults,
  legacyDefaults: z.object({ engine: EngineConfigSchema, source: z.object({ reference: z.string().min(1), revision: z.number().int().nonnegative().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict() }).strict().optional(),
}).strict()
export type OriginalAdoption = z.infer<typeof OriginalAdoptionSchema>
export interface ProcessRuntimeOptions {
  native: RuntimeNativePorts; managementOnly?: boolean; adoption?: OriginalAdoption;
  /** Restarts only this business owner after the original settings service schedules it. */
  restart?(): void;
  /** Installed from durable host coordination before original Sources or effects can admit work. */
  capabilityHold?: CapabilityHold;
}
type Preparation = { prepare(id: string, text: string): Promise<ProcessRunResult>; cancel(sessionKey: string): Promise<unknown> }

/** Validate adopted identities against the actual locked Store rather than trusting transport observations. */
function verifyAdoption(runtime: Runtime, config: ProcessRuntimeConfig, adoption: OriginalAdoption): void {
  if (adoption.instanceId !== config.instanceId || runtime.masterId !== adoption.masterId) throw new Error('Adopted Core master identity does not match the organization')
  const { store } = runtime, master = adoption.sessions.filter(item => item.role === 'orchestrator')
  if (master.length !== 1 || master[0]!.sessionId !== runtime.masterId || master[0]!.ticketId || relative(resolve(master[0]!.cwd), resolve(adoption.sourcePaths.stateDir)) !== '') throw new Error('Adopted master Session binding is invalid')
  if (new Set(adoption.sessions.map(item => item.sessionId)).size !== adoption.sessions.length) throw new Error('Duplicate adopted Session binding')
  for (const binding of adoption.sessions.filter(item => item.role === 'worker')) {
    const ticket = binding.ticketId && store.tickets.get(binding.ticketId)
    if (!ticket || binding.sessionId !== `worker-${ticket.id}` || !ticket.execution?.directory || relative(resolve(binding.cwd), resolve(ticket.execution.directory)) !== '') throw new Error('Adopted Worker does not match its actual Core ticket directory')
  }
  const source = store.settings().sources.jarvis?.config
  // The original plugin only registers jarvisKind. Absent/partial stored config
  // is resolved by that kind's identity defaults; it is not a missing identity.
  // GatewayLedger below independently verifies the paired database metadata.
  if (source && (source.deploymentId !== undefined && source.deploymentId !== adoption.identity.deploymentId
    || source.principalId !== undefined && source.principalId !== adoption.identity.principalId)) throw new Error('Adopted source identity does not match the original Gateway')
}

/** Owns no replacement task loop: all local business rules are the original Runtime's. */
export class OriginalProcess {
  readonly runtime: Runtime
  readonly ledger: GatewayLedger
  readonly gateway: GatewayService
  readonly pump: GatewayPump
  readonly inbound: InboundDelegations
  readonly delegated: DelegationExecutor
  readonly taskFiles: TaskFiles
  readonly capabilityDrain: CapabilityDrain
  readonly ready: Promise<void>
  private readonly context = new Context()
  private unregister?: () => void
  private sourceScopes: { dispose(): Promise<void> }[] = []
  private closing?: Promise<void>
  private draining = false
  private quiescing?: Promise<void>

  constructor(readonly config: ProcessRuntimeConfig, host: ProcessHost, readonly options: ProcessRuntimeOptions, preparation: Preparation) {
    if (!options?.native) throw new Error('The original complete task runtime requires its shared DSH native ports')
    const directory = realpathSync.native(config.stateDir), workspace = realpathSync.native(config.workspace)
    const marker = join(directory, 'process-instance.json'), ownership = { instanceId: config.instanceId, workspace }
    if (existsSync(marker)) {
      const previous = JSON.parse(readFileSync(marker, 'utf8'))
      if (previous.instanceId !== ownership.instanceId || relative(resolve(previous.workspace), workspace) !== '') throw new Error('State directory belongs to another instance or workspace')
    } else {
      if (existsSync(join(directory, 'orchestrator.sqlite')) && !options.adoption) throw new Error('Existing Core state has no organization ownership or trusted adoption record')
      writeFileSync(marker, JSON.stringify(ownership), { flag: 'wx', mode: 0o600 })
    }
    const adoption = options.adoption && OriginalAdoptionSchema.parse(options.adoption)
    if (existsSync(join(directory, 'original-adoption.json')) && !adoption) throw new Error('Adopted state requires its host-verified handover record')
    const identity = adoption?.identity ?? { deploymentId: config.instanceId, principalId: 'local-user' }
    const reference = (value: number) => ({ get: () => value as never })
    const defaults = adoption?.machineDefaults ?? { promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }
    const machine: Machine = { stateDir: directory, promptMaxChars: reference(defaults.promptMaxChars), admissionContextMaxPages: reference(defaults.admissionContextMaxPages), admissionContextTimeoutMs: reference(defaults.admissionContextTimeoutMs) }
    let ledger: GatewayLedger | undefined, runtime: Runtime | undefined
    try {
      // Verify the actual paired Gateway identity before the original application
      // can initialize Sessions, Sources or effects, including schema-default Sources.
      this.ledger = ledger = new GatewayLedger(join(directory, 'jarvis-gateway.sqlite'), identity)
      this.runtime = runtime = new Runtime(this.context, machine, () => { options.restart?.() }, {
        native: options.native, managementOnly: options.managementOnly, registerHttp: false, machineSettings: true, localTasks: true,
        setup: { native: options.native.deployment, allowLocal: true },
        masterDirectory: adoption?.sessions.find(item => item.role === 'orchestrator')?.cwd,
        expectedMasterId: adoption?.masterId,
        workerTools: ticket => effectiveWorkerTools(this.inbound?.toolsFor(ticket) ?? config.workerTools).names,
        workerSkills: () => config.workerSkills ?? [],
        localTicket: ticket => !this.delegated.remote(ticket),
        executionHeld: () => this.draining || (this.capabilityDrain?.frozen ?? false),
        authorizeCapabilityStop: operationId => this.capabilityDrain.authorizeStop(operationId),
        engine: { resumeCompletedCommands: true,
          admission: { evaluate: trigger => !this.draining && this.capabilityDrain.evaluate(trigger), resume: ticket => !this.draining && this.capabilityDrain.resume(ticket),
            frozen: () => this.draining || this.capabilityDrain.frozen },
          delegation: { authorize: trigger => this.inbound?.authorize(trigger), revalidate: mandate => this.inbound?.revalidate(mandate) ?? false } },
        scope: { scope: input => input.source === 'delegation'
          ? this.inbound?.listens(input.meta) ? { listened: true, observed: false } : { listened: false, reason: 'delegation_not_allowed' }
          : this.runtime.sources.scope(input) },
        routing: { targets: trigger => trigger.source === 'delegation' ? [] : config.delegationTargets ?? [], select: (id, target) => this.delegated.select(id, target) },
        executor: local => ({
          start: (ticket, assignment) => this.delegated.remote(ticket) ? this.delegated.start(ticket, assignment) : local.start(ticket, assignment),
          deliver: (ticket, assignment) => { if (!this.delegated.remote(ticket)) local.deliver(ticket, assignment) },
          stop: (ticket, assignment, reason) => {
            if (this.delegated.remote(ticket)) this.delegated.stop(ticket, assignment)
            // A locked management owner has no loaded native execution. Its
            // guarded domain stop is durable; only the live business owner can cancel Sessions.
            else if (!options.managementOnly) local.stop(ticket, assignment, reason)
          },
        }),
        reportArtifacts: (ticketId, artifacts) => artifactLinks(config.instanceId, ticketId, this.taskFiles.register(ticketId, artifacts)),
        initialize: original => {
          if (adoption) verifyAdoption(original, config, adoption)
          const before = original.store.settings().sources.jarvis?.config
          if (before && (before.deploymentId !== undefined && before.deploymentId !== identity.deploymentId
            || before.principalId !== undefined && before.principalId !== identity.principalId)) throw new Error('Persisted Jarvis identity belongs to another principal or deployment')
          initializeOriginalConfiguration({ store: original.store, prompts: original.prompts, instanceId: config.instanceId,
            legacyEngine: normalizeEngineConfig(config.engine), source: { reference: `organization:${config.instanceId}:legacy-engine` },
            legacyDefaults: adoption?.legacyDefaults,
            initialSettings: SettingsSchema.parse({ sources: { jarvis: { enabled: true, config: identity } },
              policy: { sources: { jarvis: { allowed: [{ id: identity.principalId }] } } },
              eval: { model: config.roleModels?.router ?? config.model }, executor: { model: config.roleModels?.worker ?? config.model,
                maxWorkers: config.maxWorkers, directory: workspace } }) })
        },
      })
      this.taskFiles = new TaskFiles(directory, workspace, { executionDirectory: id => runtime!.store.tickets.get(id)?.execution?.directory })
      const kind = jarvisKind(ledger, identity)
      this.unregister = runtime.sources.register(kind)
      this.inbound = new InboundDelegations(config, runtime.store, runtime.engine,
        { ...preparation, admitted: id => this.capabilityDrain.prepare(id) })
      this.delegated = new DelegationExecutor(config, runtime.store, runtime.engine, host.delegate?.bind(host), () => this.capabilityDrain?.frozen ?? false)
      this.capabilityDrain = new CapabilityDrain(runtime, this.inbound,
        () => options.native.sessions.current(runtime!.masterId)?.status === 'running', !options.managementOnly, options.capabilityHold)
      const backend = new SourceBackend(runtime.context(kind), identity)
      this.gateway = new GatewayService(ledger, backend, identity, Date.now, { resumeCompletedCommands: true, canResumeCompleted: ticket => !this.delegated.remote(ticket) })
      this.pump = new GatewayPump(ledger, backend)
      if (options.managementOnly) {
        const unregisterGithub = runtime.sources.register(github.githubKind), unregisterFeishu = runtime.sources.register(feishu.feishuKind)
        this.sourceScopes = [{ dispose: async () => { unregisterGithub() } }, { dispose: async () => { unregisterFeishu() } }]
      } else this.sourceScopes = [this.context.plugin(github), this.context.plugin(feishu)]
      this.ready = runtime.ready
    } catch (error) {
      this.unregister?.(); ledger?.close(); void runtime?.stop(); throw error
    }
  }
  close(): Promise<void> { return this.closing ??= this.shutdown() }
  /** Fence original admission and drain the original pass/source owners without closing their Store. */
  beginShutdown(): Promise<void> {
    this.draining = true
    return this.quiescing ??= (async () => {
      await Promise.allSettled(this.sourceScopes.reverse().map(scope => scope.dispose()))
      await this.runtime.passes.stop()
    })()
  }
  private async shutdown(): Promise<void> {
    try {
      // Source loops release before their Core owner, retaining the original poll cursors and cancellation behavior.
      await this.beginShutdown()
      await this.runtime.stop()
    } finally { this.unregister?.(); this.ledger.close() }
  }
}
