/** Composition of the original complete application in an independent organization owner. */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { Runtime } from '../app/runtime.ts'
import { latestAssignment, liveTicket, type Ticket } from '../core/index.ts'
import type { RuntimeNativePorts } from '../app/runtime-ports.ts'
import type { Machine } from '../deployment.ts'
import type { StartupObserver } from '../setup.ts'
import { family, KV } from '../kv.ts'
import { LIMITS } from '../limits.ts'
import { SettingsSchema } from '../policy.ts'
import { GatewayLedger } from '../jarvis-gateway/ledger.ts'
import { GatewayService } from '../jarvis-gateway/service.ts'
import { GatewayPump } from '../jarvis-gateway/pump.ts'
import { jarvisKind, SourceBackend } from '../jarvis-gateway/source.ts'
import * as github from '../sources/github.ts'
import * as feishu from '../sources/feishu.ts'
import { InboundDelegations, type DelegationLimit } from './delegation-ingress.ts'
import { DelegationExecutor } from './delegation-executor.ts'
import { CapabilitySchema, DelegationCatalogSchema, verifiedDepartmentWaits, type Capability } from './delegation-contract.ts'
import { EngineConfigSchema, normalizeEngineConfig } from './engine-config.ts'
import { initializeOriginalConfiguration } from './original-config.ts'
import { TaskFiles } from './task-files.ts'
import { ArtifactReferenceSchema, artifactIdentity, type ArtifactReference } from './artifact-contract.ts'
import { effectiveWorkerTools, WorkerSkillsSchema, WorkerToolSchema } from './worker-capabilities.ts'
import { CapabilityDrain, type CapabilityHold } from './capability-drain.ts'
import type { ProcessHost, ProcessRunResult, ProcessRuntimeConfig } from './runtime.ts'
import { executionRoot } from '../app/execution-environment.ts'
import { DepartmentWaits } from './department-waits.ts'

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
  /** Rebuild current admission from the host's committed graph after any interrupted move. */
  delegationLimits?: DelegationLimit[];
  /** Stage-only observation of the original setup and native Session initialization. */
  startup?: StartupObserver;
}
type Preparation = { prepare(id: string, text: string): Promise<ProcessRunResult>; cancel(sessionKey: string): Promise<unknown> }
const WorkerCapabilityBindingSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), tools: z.array(WorkerToolSchema), skills: WorkerSkillsSchema }).strict()
const workerCapabilities = family<z.infer<typeof WorkerCapabilityBindingSchema>, [string]>('process-runtime:worker-capabilities:')
const localHandoffs = family<{ reviewId: string; evidenceRef: string }, [string]>('process-runtime:local-handoff:')

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
  readonly departments: DepartmentWaits
  readonly ready: Promise<void>
  private readonly context = new Context()
  private unregister?: () => void
  private sourceScopes: { dispose(): Promise<void> }[] = []
  private closing?: Promise<void>
  private draining = false
  private quiescing?: Promise<void>
  private readyTargets = new Set<string>()
  private catalogRefresh?: Promise<void>

  /** Settle a catalog read admitted before the host fenced the graph. */
  async freezeTopology(operationId: string): Promise<void> {
    this.capabilityDrain.freezeTopology(operationId)
    await this.catalogRefresh
  }
  /** A private host operation changes relationships without replacing task or Session owners. */
  configureTopology(input: { operationId: string; allowedParents: string[]; delegationTargets: Capability[]; delegationLimits: DelegationLimit[] }): void {
    this.capabilityDrain.authorizeTopology(input.operationId)
    if (input.delegationTargets.some(target => target.instanceId === this.config.instanceId || target.tools.some(tool => !this.config.workerTools.includes(tool)))
      || input.allowedParents.includes(this.config.instanceId)) throw new Error('Organization topology exceeds the current capability or identity')
    const previous = this.config.allowedParents
    this.config.allowedParents = [...input.allowedParents]
    try { this.inbound.configureTopology(input.delegationLimits) }
    catch (error) { this.config.allowedParents = previous; throw error }
    this.config.delegationTargets = structuredClone(input.delegationTargets)
    this.readyTargets = new Set()
  }

  constructor(readonly config: ProcessRuntimeConfig, private readonly host: ProcessHost, readonly options: ProcessRuntimeOptions, preparation: Preparation) {
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
        startup: options.managementOnly ? undefined : options.startup,
        setup: { native: options.native.deployment, allowLocal: true },
        masterDirectory: adoption?.sessions.find(item => item.role === 'orchestrator')?.cwd,
        expectedMasterId: adoption?.masterId,
        workerTools: ticket => effectiveWorkerTools(this.workerCapabilities(ticket).tools).names,
        workerSkills: ticket => this.workerCapabilities(ticket).skills,
        prepareTicket: ticket => {
          runtime!.store.set(workerCapabilities(ticket.id), WorkerCapabilityBindingSchema.parse({ version: 2, ...this.workerCapabilities(ticket) }))
          return ticket
        },
        localTicket: ticket => !this.delegated.remote(ticket) && !this.departments?.held(ticket),
        prepareHandoff: async (ticket, assignment) => this.taskFiles.materialize(ticket.id, this.handoffArtifacts(ticket), async input => {
          if (!host.readArtifact) throw new Error('The authenticated artifact transfer is unavailable')
          return host.readArtifact({ ...input, ticketId: ticket.id, assignmentId: assignment.id })
        }),
        executionHeld: () => this.draining || (this.capabilityDrain?.frozen ?? false),
        authorizeCapabilityStop: operationId => this.capabilityDrain.authorizeStop(operationId),
        engine: { resumeCompletedCommands: true,
          admission: { evaluate: trigger => !this.draining && this.capabilityDrain.evaluate(trigger), resume: ticket => !this.draining && this.capabilityDrain.resume(ticket),
            frozen: () => this.draining || this.capabilityDrain.frozen },
          delegation: { authorize: trigger => this.inbound?.authorize(trigger), revalidate: mandate => this.inbound?.revalidate(mandate) ?? false },
          resultReview: {
            context: (ticket, assignment) => ({ delegation: this.delegated.reviewContext(ticket, assignment), capabilities: this.workerCapabilities(ticket) }),
            authorize: (ticket, assignment, decision) => {
              this.departments.authorize(ticket, assignment, decision, this.departmentTargets(ticket))
              if (decision.kind === 'continue' && !this.delegated.remote(ticket, assignment)) {
                const review = assignment.resultReviews?.at(-1), proof = runtime!.store.get(localHandoffs(assignment.id))
                if (!review || proof?.reviewId !== review.id || proof.evidenceRef !== review.evidenceRef) throw new Error('The original Worker execution has not been verified stopped for this result')
              }
              this.delegated.authorizeReview(ticket, assignment, decision)
            },
            request: (ticket, assignment, review) => runtime!.sessions.relay(review.id, JSON.stringify({ kind: 'result_review',
              ticket_id: ticket.id, assignment_id: assignment.id, review_id: review.id, evidence_ref: review.evidenceRef,
              scope: ticket.mandate.scope, original_request: ticket.mandate.basis.via === 'delegation'
                ? `delegation/${ticket.origin.triggerId}/source` : `trigger/${ticket.origin.triggerId}`,
              ...(ticket.attention ? { human_action: ticket.attention.question, attention_id: ticket.attention.id } : {}),
              original_assignment: `ticket/${ticket.id}/assignment`, inputs: `ticket/${ticket.id}/inputs`,
              history: `ticket/${ticket.id}/assignments`, read: `ticket/${ticket.id}/review/${review.id}`,
              summary: review.summary.slice(0, 600), chars: review.summary.length,
              producer_state: this.delegated.result(ticket.id)?.status ?? assignment.report?.state,
              execution_targets: (config.delegationTargets ?? []).map(target => ({ ...target,
                tools: target.tools.filter(tool => this.workerCapabilities(ticket).tools.includes(tool)) }))
                .filter(target => target.tools.length && this.readyTargets.has(target.instanceId)),
              instruction: 'Read the original request, complete review, all later inputs and prior results. Judge every original goal and completion condition against actual evidence for the delivered version. A child completion is only a result to review. Use orchestrator_result_review: accept only with sufficient evidence, otherwise continue the remaining work under the same mandate. If the producer cannot execute, choose a direct department with suitable responsibility and tools and retain the reason. Continue from the registered version and remaining work; the business owner queries and confirms the old execution stopped before handoff. Connection loss or an unknown result is not evidence of no changes. If a necessary direct department is missing, use orchestrator_department_wait with the responsibility, all required tools and the remaining instructions. The original review resumes when a suitable department is ready. Ask the user through the original group conversation if the task needs a different goal or more authority. Do not report completion to the user before acceptance.' })),
          } },
        scope: { scope: input => input.source === 'delegation'
          ? this.inbound?.listens(input.meta) ? { listened: true, observed: false } : { listened: false, reason: 'delegation_not_allowed' }
          : this.runtime.sources.scope(input) },
        routing: {
          targets: async trigger => {
            await this.refreshDelegationCatalog()
            const ceiling = this.inbound.toolsForTrigger(trigger)
            return (config.delegationTargets ?? []).map(target => ({ ...target, tools: target.tools.filter(tool => !ceiling || ceiling.includes(tool)) }))
              .filter(target => target.tools.length && this.readyTargets.has(target.instanceId))
          },
          prepare: async (id, target) => { if (target && !this.delegated.selected(id)) await this.refreshDelegationCatalog() },
          select: (id, target) => this.delegated.select(id, target),
          prepareReview: (id, target, assignmentId, reviewId) => this.prepareReview(id, target, assignmentId, reviewId),
        },
        executor: local => ({
          requestCancellation: ticket => this.delegated.requestCancellation(ticket.id)
            || !this.delegated.remote(ticket) && ticket.assignments.some(assignment => assignment.startedAt),
          start: (ticket, assignment) => this.delegated.remote(ticket, assignment) ? this.delegated.start(ticket, assignment) : local.start(ticket, assignment),
          deliver: (ticket, assignment) => { if (!this.delegated.remote(ticket)) local.deliver(ticket, assignment) },
          stop: (ticket, assignment, reason) => {
            if (this.delegated.remote(ticket, assignment)) this.delegated.stop(ticket, assignment)
            // A locked management owner has no loaded native execution. Its
            // guarded domain stop is durable; only the live business owner can cancel Sessions.
            else if (!options.managementOnly) local.stop(ticket, assignment, reason)
          },
        }),
        reportArtifacts: (ticketId, artifacts) => {
          this.taskFiles.register(ticketId, artifacts)
          return this.taskFiles.links(config.instanceId, ticketId).map(item => `- ${item.title.replace(/[\[\]\\\r\n]/g, ' ')}：[打开](${item.url}) · [下载](${item.downloadUrl})${item.version ? ` · SHA-256 ${item.version.sha256}` : ''}`).join('\n')
        },
        waitForDepartment: (ticketId, requirement, summary) => this.departments.stage(ticketId, requirement, summary),
        reportMissingDepartment: (ticketId, requirement, summary) => this.departments.stage(ticketId, requirement, summary),
        holdForDepartment: (ticketId, assignmentId, reviewId, requirement, summary) => this.departments.hold(ticketId, assignmentId, reviewId, requirement, summary),
        resumeDepartment: async (ticketId, assignmentId, reviewId, target, summary) => {
          const committed = runtime!.store.tickets.get(ticketId)?.assignments.find(item => item.id === assignmentId)?.resultReviews?.find(item => item.id === reviewId)?.decision
          if (!committed) await this.prepareReview(ticketId, target, assignmentId, reviewId)
          return this.departments.resume(ticketId, assignmentId, reviewId, target, summary)
        },
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
      this.taskFiles = new TaskFiles(directory, workspace, { executionDirectory: id => runtime!.store.tickets.get(id)?.execution?.directory,
        assignmentId: id => runtime!.store.tickets.get(id)?.assignments.at(-1)?.id,
        assignmentExists: (id, assignmentId) => runtime!.store.tickets.get(id)?.assignments.some(item => item.id === assignmentId) ?? false })
      const kind = jarvisKind(ledger, identity)
      this.unregister = runtime.sources.register(kind)
      this.inbound = new InboundDelegations(config, runtime.store, runtime.engine,
        { ...preparation, admitted: id => this.capabilityDrain.prepare(id), acceptNew: () => this.delegationReady() })
      if (options.delegationLimits) this.inbound.configureTopology(options.delegationLimits)
      this.delegated = new DelegationExecutor(config, runtime.store, runtime.engine, host.delegate?.bind(host),
        () => this.capabilityDrain?.frozen ?? false, id => this.readyTargets.has(id), ticket => this.workerCapabilities(ticket).tools, this.inbound,
        ticket => this.handoffArtifacts(ticket))
      this.departments = new DepartmentWaits(config, runtime.store, runtime.engine, runtime.sessions)
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
  /** Existing task grants can only narrow; changing instance settings never grants an old task new tools or skills. */
  private workerCapabilities(ticket: Ticket) {
    const stored = this.runtime.store.get(workerCapabilities(ticket.id)), saved = stored && WorkerCapabilityBindingSchema.parse(stored)
    return {
      tools: (this.inbound?.toolsFor(ticket) ?? this.config.workerTools)
        .filter(tool => this.config.workerTools.includes(tool) && (!saved || saved.tools.some(name => name === tool))),
      skills: (this.config.workerSkills ?? []).filter(skill => !saved || saved.skills.includes(skill)),
    }
  }
  /** Keep task authority separate from each target's capabilities; old v1 grants remain conservatively narrow. */
  handoffArtifacts(ticket: Ticket): ArtifactReference[] {
    const own = this.taskFiles.links(this.config.instanceId, ticket.id).map(item => ({ ...item, instanceId: this.config.instanceId, ticketId: ticket.id }))
    const input = [...this.inbound.handoff(ticket), ...[...own, ...this.delegated.artifacts(ticket.id)].map(item => {
      if (!item.version || !item.assignmentId) throw new Error('Historical result has no verified version for handoff')
      return { instanceId: item.instanceId, ticketId: item.ticketId, assignmentId: item.assignmentId, version: item.version }
    })]
    const references = input.map(item => ArtifactReferenceSchema.parse(item))
    return [...new Map(references.map(item => [artifactIdentity(item), item])).values()]
  }
  /** Shared by normal reviews and missing-department resumes; no second execution starts before the old one is known quiet. */
  async prepareReview(ticketId: string, target?: string, assignmentId?: string, reviewId?: string): Promise<void> {
    if (target) await this.refreshDelegationCatalog()
    if (target && (!this.config.delegationTargets?.some(item => item.instanceId === target) || !this.readyTargets.has(target))) throw new Error('The selected child is not ready for remaining work')
    const ticket = this.runtime.store.tickets.get(ticketId), assignment = ticket && latestAssignment(ticket)
    const review = assignment?.resultReviews?.at(-1)
    if (!ticket || !liveTicket(ticket) || !assignment || assignmentId && assignment.id !== assignmentId || !review || reviewId && review.id !== reviewId) throw new Error('Result review is no longer current')
    if (this.delegated.remote(ticket, assignment)) return this.delegated.prepareReview(ticketId, assignment.id, review.id)
    const native = this.options.native.executor, sessionId = `worker-${ticketId}`
    if (native.current(sessionId)) await native.cancel(sessionId, false)
    await native.stopBackground(sessionId, 'The owning organization is arranging remaining work', false)
    if (native.current(sessionId)) {
      await native.whenIdle(sessionId)
      if (!await native.untilQuiet(sessionId, AbortSignal.timeout(1000)) || (await native.runningJobs(sessionId)).length || native.current(sessionId)?.status !== 'idle') throw new Error('The original Worker execution cleanup has not completed')
    }
    await this.options.native.sessions.flush()
    this.runtime.store.set(localHandoffs(assignment.id), { reviewId: review.id, evidenceRef: review.evidenceRef })
  }
  /** Catch up a catalog addition already committed by the host before validating the unchanged relationships. */
  async prepareCapabilityConfiguration(targets: readonly Capability[]): Promise<void> {
    const known = new Set((this.config.delegationTargets ?? []).map(target => target.instanceId))
    // A failed host commit may replay configuration after this owner updated its
    // tools. Do not compare that new descriptor with the still-old host tools.
    if (targets.some(target => !known.has(target.instanceId))) await this.refreshDelegationCatalog()
  }
  /** Called synchronously under the frozen owner after both business and native work have drained. */
  configureCapabilities(input: { workerTools: string[]; workerSkills: string[]; delegationTargets: Capability[]; delegationLimits: DelegationLimit[] }): void {
    const previous = new Map((this.config.delegationTargets ?? []).map(target => [target.instanceId, target]))
    if (input.delegationTargets.length !== previous.size || new Set(input.delegationTargets.map(target => target.instanceId)).size !== previous.size
      || input.delegationTargets.some(target => {
        const prior = previous.get(target.instanceId)
        return !prior || target.organizationName !== prior.organizationName || target.description !== prior.description
          || target.tools.some(tool => !input.workerTools.includes(tool))
      })) throw new Error('Worker capability configuration cannot change delegation relationships or organization identities')
    this.inbound.validateCapabilityLimits(input.delegationLimits, input.workerTools)
    const limits = new Map(input.delegationLimits.map(limit => [limit.sourceInstanceId, limit.tools]))
    this.runtime.store.atomic(() => {
      // Include ended tickets: their authorized continuation must not acquire a
      // newly enabled capability, or regain one removed by an earlier change.
      for (const ticket of this.runtime.store.tickets.list()) {
        const current = this.workerCapabilities(ticket)
        const basis = ticket.mandate.basis, parentTools = basis.via === 'delegation' ? limits.get(basis.delegation.parentInstanceId) ?? [] : undefined
        this.runtime.store.set(workerCapabilities(ticket.id), WorkerCapabilityBindingSchema.parse({ version: 2,
          tools: current.tools.filter(tool => input.workerTools.includes(tool) && (!parentTools || parentTools.includes(tool))),
          skills: current.skills.filter(skill => input.workerSkills.includes(skill)) }))
      }
      this.delegated.narrowCapabilities(input.workerTools, input.delegationTargets)
      this.inbound.configureCapabilityLimits(input.delegationLimits, input.workerTools)
    })
    this.config.workerTools = [...input.workerTools]
    this.config.workerSkills = [...input.workerSkills]
    this.config.delegationTargets = structuredClone(input.delegationTargets)
  }
  /** Only additive catalog changes can enter a running owner; bound descriptors remain immutable. */
  private refreshDelegationCatalog(): Promise<void> {
    return this.catalogRefresh ??= this.readDelegationCatalog().catch(error => {
      this.readyTargets = new Set(); throw error
    }).finally(() => { this.catalogRefresh = undefined })
  }
  private async readDelegationCatalog(): Promise<void> {
    if (!this.host.delegate || !this.host.delegationCatalog) { this.readyTargets = new Set(); return }
    const catalog = DelegationCatalogSchema.parse(await this.host.delegationCatalog())
    const byId = new Map(catalog.targets.map(target => [target.instanceId, target]))
    const identity = (target: Capability) => JSON.stringify(CapabilitySchema.parse(target))
    for (const target of this.config.delegationTargets ?? []) {
      const current = byId.get(target.instanceId)
      if (!current || identity(current) !== identity(target)) throw new Error('A running delegation catalog may only add targets')
    }
    for (const target of catalog.targets) {
      if (target.instanceId === this.config.instanceId || target.tools.some(tool => !this.config.workerTools.includes(tool)))
        throw new Error('Delegation catalog exceeds the current organization capability')
    }
    this.config.delegationTargets = catalog.targets
    this.readyTargets = new Set(catalog.readyInstanceIds)
  }
  /** The original admission owner is available without consuming or disturbing current work. */
  delegationReady(): boolean {
    const available = !this.options.managementOnly && !this.draining && !this.closing && !this.runtime.lifetime.aborted
      && this.runtime.configured() && !this.runtime.store.settings().paused && !this.capabilityDrain.operationId && !this.capabilityDrain.frozen
    if (!available) return false
    try { return [this.config.stateDir, this.config.workspace, executionRoot(this.runtime.store.settings(), this.runtime.machine.stateDir)]
      .every(directory => statSync(directory).isDirectory()) }
    catch { return false }
  }
  /** The existing Gateway ledger owns original-conversation delivery and durable semantic deduplication. */
  reconcileDepartmentNotices(): void {
    for (let offset = 0;; offset += 20) {
      const works = this.ledger.works('', offset, 20)
      for (const work of works) if (work.ticketId) for (const wait of this.departmentWaitsForTicket(work.ticketId)) {
        const identity = `${work.workRef}:department:${wait.id}`
        this.ledger.receiveEvent(`department:${wait.id}`, wait, { id: identity, semanticKey: identity, workRef: work.workRef,
          conversationId: work.conversationId, kind: 'message', at: wait.at, actionable: true,
          text: `缺少所需职责：${wait.responsibility}。请在“${wait.ownerOrganizationName}”（${wait.ownerInstanceId}）下创建直属部门，配置职责及必要工具权限（${wait.requiredTools.join('、')}）并启动。原工单保留，核对就绪和授权后将自动继续，无需再发消息。` })
      }
      if (works.length < 20) break
    }
  }
  departmentWaitsForTicket(ticketId: string) {
    const snapshot = this.delegated.result(ticketId)
    return [...this.departments.forTicket(ticketId), ...(snapshot ? verifiedDepartmentWaits(snapshot) : [])]
  }
  private departmentTargets(ticket: Ticket): Capability[] {
    const tools = this.workerCapabilities(ticket).tools
    return (this.config.delegationTargets ?? []).filter(target => this.readyTargets.has(target.instanceId))
      .map(target => ({ ...target, tools: target.tools.filter(tool => tools.includes(tool)) }))
  }
  /** Called by the existing process reconciliation owner; there is no additional background task or service. */
  async reconcileDepartments(): Promise<void> {
    if (!this.departments.active().length || !this.delegationReady()) return
    await this.refreshDelegationCatalog()
    this.departments.reconcile(ticket => this.departmentTargets(ticket))
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
