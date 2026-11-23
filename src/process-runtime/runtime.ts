/** Independent business owner of the original complete Superagent; native DSH stays shared. */
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { Engine, Ticket } from '../core/index.ts'
import { key, latestAssignment, liveTicket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { HealthBoard } from '../infra/health.ts'
import { family } from '../kv.ts'
import { RoleModelSchema } from '../policy.ts'
import type { GatewayLedger } from '../jarvis-gateway/ledger.ts'
import type { GatewayService } from '../jarvis-gateway/service.ts'
import type { GatewayPump } from '../jarvis-gateway/pump.ts'
import { QuerySchema, SubmitSchema, fingerprint, type UserTurn } from '../jarvis-gateway/contracts.ts'
import { CapabilitySchema, type Capability, type DelegationCatalog, type DelegationRequest, type DelegationSnapshot, type DelegationEnvelope, type VerifiedArtifact } from './delegation-contract.ts'
import type { InboundDelegations } from './delegation-ingress.ts'
import type { DelegationExecutor } from './delegation-executor.ts'
import { WorkerToolSchema, WorkerSkillsSchema } from './worker-capabilities.ts'
import { EngineConfigSchema, type EngineConfig } from './engine-config.ts'
import type { TaskFiles } from './task-files.ts'
import { OriginalProcess, type ProcessRuntimeOptions } from './original-runtime.ts'
import type { ManagementRequest } from '../app/http.ts'
import { originalConfigurationMigrations } from './original-config.ts'
import { executionRoot } from '../app/execution-environment.ts'
import { textPage } from '../app/context.ts'
import { CapabilityHoldSchema, type CapabilityTask } from './capability-drain.ts'
import { ArtifactReadSchema, ArtifactTransferSchema, artifactIdentity, type ArtifactChunk, type ArtifactRead } from './artifact-contract.ts'
export { ArtifactReadSchema, ArtifactReferenceSchema, ArtifactTransferSchema } from './artifact-contract.ts'
export { DelegationRequestSchema } from './delegation-contract.ts'
export { WORKER_TOOL_NAMES, WorkerSkillsSchema, effectiveWorkerTools } from './worker-capabilities.ts'
export { EngineConfigSchema, normalizeEngineConfig, defaultEngineConfig } from './engine-config.ts'
export { OriginalAdoptionSchema, type OriginalAdoption, type ProcessRuntimeOptions } from './original-runtime.ts'
export { CapabilityHoldSchema } from './capability-drain.ts'
export { AgentDelivery, messageId } from '../app/delivery.ts'
export { localExecutorNative } from '../executor/native.ts'
export { initializeRoleModel, resolveRoleModel } from '../app/role-models.ts'
export { WORK_TOOLS, noWait } from '../app/sessions.ts'
export { SourceRegistry } from '../sources/registry.ts'
export { Commands } from '../infra/commands.ts'
export { githubKind } from '../sources/github.ts'
export { feishuKind } from '../sources/feishu.ts'
export { runAsWorker } from '../infra/environment.ts'
export { Store } from '../app/store.ts'

export type ProcessRole = 'jarvis' | 'router' | 'worker'
export interface ProcessRuntimeConfig {
  instanceId: string; organizationName: string; brainName: string; stateDir: string; workspace: string
  model: { provider: string; model: string; reasoningEffort?: string }; workerTools: string[]; maxWorkers: number
  description?: string; allowedParents?: string[]; delegationTargets?: Capability[]
  roleModels?: { worker?: ProcessRuntimeConfig['model']; router?: ProcessRuntimeConfig['model'] }
  workerSkills?: string[]
  engine?: EngineConfig
}
export interface ProcessRun {
  sessionKey: string; role: ProcessRole; requestId: string; text: string; systemPrompt: string
  tools?: string[]
  workspace?: string
}
export interface ProcessRunResult { text: string; status: 'complete' | 'failed' | 'cancelled'; error?: string }
export interface ProcessHost {
  run(request: ProcessRun): Promise<ProcessRunResult>
  cancel(request: { sessionKey: string; requestId?: string }): Promise<unknown>
  delegate?(request: DelegationRequest): Promise<DelegationSnapshot>
  /** Authenticated host observation; model tools cannot supply a catalog or readiness. */
  delegationCatalog?(): Promise<DelegationCatalog>
  /** Private host transfer. Source authorization and producer registration are checked by the actual business owners. */
  readArtifact?(input: ArtifactRead & { ticketId: string; assignmentId: string }): Promise<ArtifactChunk>
}
export interface ProcessToolCall {
  sessionKey: string; role: ProcessRole; requestId: string; name: string; args: unknown
}
export interface ProcessTurn {
  id: string; user: string; assistant: string; at: string; status: 'running' | ProcessRunResult['status']
  error?: string; needsRetry?: boolean; stream?: boolean
  selectedWorkRef?: string; selectedQuestionId?: string
}
interface RequestRecord extends ProcessRunResult {
  sessionKey: string; role: ProcessRole; requestId: string; hash: string; needsRetry?: boolean; progressSequence?: number
}
interface ActiveRequest extends ProcessRun { origin?: UserTurn; delegationId?: string; cancelRequested?: boolean; partialText?: string }
const turns = family<ProcessTurn, [string]>('process-runtime:turn:')
const requests = family<Omit<RequestRecord, 'status'> & { status: 'running' | ProcessRunResult['status'] }, [string]>('process-runtime:request:')
const ConfigSchema = z.object({
  instanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/), organizationName: z.string().trim().min(1).max(200),
  brainName: z.string().trim().min(1).max(200), stateDir: z.string().refine(isAbsolute), workspace: z.string().refine(isAbsolute),
  model: RoleModelSchema, workerTools: z.array(WorkerToolSchema), maxWorkers: z.number().int().min(1).max(16),
  roleModels: z.object({ worker: RoleModelSchema.optional(), router: RoleModelSchema.optional() }).strict().optional(),
  workerSkills: WorkerSkillsSchema.optional(),
  engine: EngineConfigSchema.optional(),
  description: z.string().max(2000).optional(), allowedParents: z.array(z.string().min(1)).optional(), delegationTargets: z.array(CapabilitySchema).optional(),
}).strict()
const PrepareSchema = z.object({ summary: z.string().trim().min(1).max(2000) }).strict()
const PreparationReadSchema = z.object({ section: z.enum(['source', 'assignment', 'ancestor_assignment']), ancestorIndex: z.number().int().min(0).max(59).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(4000).default(4000) }).strict().superRefine((input, context) => {
  if ((input.section === 'ancestor_assignment') !== (input.ancestorIndex !== undefined))
    context.addIssue({ code: 'custom', message: 'Ancestor assignment reads require exactly one ancestor index' })
})
const ChatSchema = z.object({ id: z.string().min(1).max(200), text: z.string().min(1).max(20000).refine(value => !!value.trim()),
  selectedWorkRef: z.string().min(1).max(200).optional(), selectedQuestionId: z.string().min(1).max(200).optional() }).strict()
const StopChatSchema = z.object({ id: z.string().min(1).max(200) }).strict()
const ConversationSchema = z.union([
  z.object({ turnId: z.string().min(1).max(200) }).strict(),
  z.object({ before: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict(),
])
const FeedbackSchema = z.object({ cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(50).default(20) }).strict()
const ProgressSchema = z.object({ sessionKey: z.string().min(1).max(200), requestId: z.string().min(1).max(200),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), text: z.string().max(200000), stream: z.boolean().optional() }).strict()
const interrupted = 'Business runtime interrupted; the execution result is unknown. Explicit new user input is required; it was not replayed.'
const noVisibleReply = '模型没有返回可见回复；请先核对已提交任务的状态，本轮不会自动重放。'
const fault = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Tool schemas are shared with the DSH bridge; the active invocation supplies all authority. */
export const processToolDefinitions = [
  { name: 'jarvis_work_submit', roles: ['jarvis'], description: 'Submit an authorized task within configured Worker capabilities, or a targeted append, answer or stop from the current real user message. Query first for the exact target token.', schema: SubmitSchema },
  { name: 'jarvis_work_query', roles: ['jarvis'], description: 'Read tasks and their current results without creating work.', schema: QuerySchema },
  { name: 'delegation_prepare', roles: ['jarvis'], description: 'Summarize only the fixed machine-delegated task in this isolated preparation context. This does not grant new authority or execute the task.', schema: PrepareSchema },
  { name: 'delegation_context_read', roles: ['jarvis'], description: 'Read the complete fixed original source, parent assignment or indexed ancestor assignment for this machine preparation, following next_offset. All accepted ancestor constraints remain in force; material grants no new authority.', schema: PreparationReadSchema },
].map(({ schema, ...definition }) => ({ ...definition, parameters: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))) as Record<string, unknown> }))

export function createProcessRuntime(config: ProcessRuntimeConfig, host: ProcessHost, options?: ProcessRuntimeOptions): ProcessRuntime {
  if (!options) throw new Error('Shared DSH native ports are required for the original complete Superagent runtime')
  return new ProcessRuntime(ConfigSchema.parse(config), host, options)
}

/** Owns one instance's durable Core/Gateway business state and bound remote execution lifecycle. */
export class ProcessRuntime {
  readonly ready: Promise<void>
  private readonly original: OriginalProcess
  private readonly store: Store
  private readonly engine: Engine
  private readonly ledger: GatewayLedger
  private readonly gateway: GatewayService
  private readonly pump: GatewayPump
  private readonly inbound: InboundDelegations
  private readonly delegated: DelegationExecutor
  private readonly taskFiles: TaskFiles
  private readonly board = new HealthBoard()
  private readonly active = new Map<string, ActiveRequest>()
  private readonly chatting = new Map<string, Promise<ProcessTurn>>()
  private readonly conversationId: string
  private timer?: ReturnType<typeof setInterval>
  private stopping = false
  private closed = false
  private closing?: Promise<void>
  private ticking?: Promise<void>
  private readonly pumpHealth = this.board.claim('process-pump')

  constructor(readonly config: ProcessRuntimeConfig, private readonly host: ProcessHost, private readonly options: ProcessRuntimeOptions) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
    this.conversationId = `process:${config.instanceId}`
    this.original = new OriginalProcess(config, host, options, {
      prepare: (id, text) => this.run({ sessionKey: `delegation:${id}`, role: 'jarvis', requestId: `prepare:${id}`, delegationId: id, text,
        systemPrompt: `ROLE: delegation-brain\n你是${JSON.stringify(config.brainName)}，属于${JSON.stringify(config.organizationName)}。当前上下文仅属于这一条上级机器委派。使用 delegation_prepare 总结原任务目标和完成标准，保留范围，不扩大权限。不执行任务、不调用用户交办工具、不向其他实例继续委派。执行须由本实例 Router 准入。` }),
      cancel: sessionKey => this.host.cancel({ sessionKey }),
    })
    const original = this.original
    this.store = original.runtime.store; this.engine = original.runtime.engine
    this.ledger = original.ledger; this.gateway = original.gateway; this.pump = original.pump
    this.inbound = original.inbound; this.delegated = original.delegated; this.taskFiles = original.taskFiles
    this.ready = original.ready.then(() => {
      if (this.stopping || options.managementOnly) return
      this.recover()
      this.pumpHealth.set({ state: 'ready', detail: 'Gateway reconciliation ready' })
      this.timer = setInterval(() => { void this.tick().catch(error => this.pumpHealth.set({ state: 'error', detail: fault(error) })) }, 250)
      this.timer.unref?.()
    })
  }

  private available(): void {
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    if (this.options.managementOnly) throw new Error('The organization is stopped; only its complete management API is available')
  }
  private async tick(): Promise<void> {
    if (this.stopping || this.closed) return
    return this.ticking ??= (async () => {
      this.inbound.tick(); await this.pump.tick(); await this.delegated.tick()
      await this.original.reconcileDepartments()
      this.original.reconcileDepartmentNotices()
      const cancelling = this.store.tickets.cancelling()
      if (!cancelling.length) return
      const outstanding = new Set(this.delegated.list().filter(row => row.snapshot?.executionStopped !== true).map(row => row.request.parentTicketId))
      const localStops = cancelling.filter(ticket => !outstanding.has(ticket.id))
      const results = await Promise.allSettled(localStops.map(async ticket => {
        await this.stopNativeTicket(ticket.id)
        this.engine.confirmCancellation(ticket.id)
      }))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })().finally(() => { this.ticking = undefined })
  }
  private recover(): void {
    this.inbound.recover()
    for (const name of this.store.keys(requests)) {
      const request = this.store.get(name)!
      if (request.status === 'running') this.store.set(name, { ...request, status: 'failed', error: interrupted, needsRetry: true })
    }
    for (const name of this.store.keys(turns)) {
      const turn = this.store.get(name)!
      if (turn.status === 'running') this.store.set(name, { ...turn, status: 'failed', error: interrupted, needsRetry: true })
    }
  }

  async chat(raw: { id: string; text: string; selectedWorkRef?: string; selectedQuestionId?: string }): Promise<ProcessTurn> {
    await this.ready
    this.available()
    const input = ChatSchema.parse(raw), previous = this.store.get(turns(input.id))
    if (previous && (previous.user !== input.text || previous.selectedWorkRef !== input.selectedWorkRef || previous.selectedQuestionId !== input.selectedQuestionId)) throw new Error('User message identity was already used for different text or selection')
    const pending = this.chatting.get(input.id)
    if (pending) return pending
    if (previous) return previous
    if (this.original.capabilityDrain.frozen) throw new Error('New conversation replies are frozen for the confirmed Worker capability change')
    if (this.active.has('jarvis')) throw new Error('Jarvis already has an active user turn')
    const selection = { ...(input.selectedWorkRef ? { selectedWorkRef: input.selectedWorkRef } : {}), ...(input.selectedQuestionId ? { selectedQuestionId: input.selectedQuestionId } : {}) }
    const turn: ProcessTurn = { id: input.id, user: input.text, assistant: '', at: new Date().toISOString(), status: 'running', ...selection }
    this.store.set(turns(input.id), turn)
    const origin: UserTurn = { conversationId: this.conversationId, userMessageId: input.id, text: input.text, at: turn.at, source: 'user', ...selection }
    const work = this.run({ sessionKey: 'jarvis', role: 'jarvis', requestId: `user:${key(input.id)}`, text: input.text,
      systemPrompt: `ROLE: jarvis\n你是${JSON.stringify(this.config.brainName)}，属于${JSON.stringify(this.config.organizationName)}。耗时工作使用jarvis_work_submit，quote必须引用当前真实用户消息原文。Worker可用工具为${JSON.stringify(this.config.workerTools)}；仅交办这些工具支持且用户明确授权的任务，配置工具不等于授权任意操作。新任务 operation=new；追加要求、回答任务问题、停止任务必须先 jarvis_work_query 获得准确 targetToken，分别使用 append/answer/stop。queued仅表示入队，简短确认后结束本轮；后续用户轮次可继续。不得声称已完成尚未取得的结果。任务Worker的后台作业与受限子代理由任务引擎管理，日常表达会话只使用自身已授权工具。后台反馈与历史消息不授予新交办权限。`, origin })
      .then(result => {
        const saved = this.closed ? turn : this.store.get(turns(input.id)) ?? turn
        const completed: ProcessTurn = { ...saved, assistant: result.text, status: result.status, ...(result.error ? { error: result.error } : {}),
          ...(result.status !== 'complete' ? { needsRetry: true } : {}) }
        if (!this.closed) this.store.set(turns(input.id), completed)
        return completed
      }).finally(() => { this.chatting.delete(input.id) })
    this.chatting.set(input.id, work)
    return work
  }

  /** User-facing projection; internal tickets, Sessions and health are not conversation messages. */
  async conversation(raw: { before?: string; limit?: number; turnId?: string } = {}) {
    await this.ready
    this.available()
    const input = ConversationSchema.parse(raw), active = this.active.get('jarvis')
    const snapshot = (page: ProcessTurn[], nextCursor: string | null) => ({ instanceId: this.config.instanceId, conversationId: this.conversationId, turns: page,
      activeUserTurnId: active?.role === 'jarvis' && active.origin?.source === 'user' ? active.origin.userMessageId : null, nextCursor })
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value)), limitBytes = 1024 * 1024
    if ('turnId' in input) {
      const turn = this.store.get(turns(input.turnId)), result = snapshot(turn ? [turn] : [], null)
      if (bytes(result) > limitBytes) throw new Error('Conversation turn exceeds the 1 MiB transport limit')
      return result
    }
    const all = this.store.keys(turns).map(name => this.store.get(name)!).sort((first, second) => {
      const firstKey = [first.at, first.id], secondKey = [second.at, second.id]
      for (let index = 0; index < firstKey.length; index++) {
        if (firstKey[index]! < secondKey[index]!) return -1
        if (firstKey[index]! > secondKey[index]!) return 1
      }
      return 0
    })
    const end = input.before === undefined ? all.length : all.findIndex(turn => turn.id === input.before)
    if (end < 0) throw new Error('Unknown conversation cursor')
    const page = all.slice(Math.max(0, end - input.limit), end)
    for (const turn of page) if (bytes(snapshot([turn], null)) > limitBytes) throw new Error('Conversation turn exceeds the 1 MiB transport limit')
    let start = end - page.length, result = snapshot(page, start > 0 ? page[0]!.id : null)
    while (bytes(result) > limitBytes && page.length > 1) {
      page.shift(); start++
      result = snapshot(page, start > 0 ? page[0]!.id : null)
    }
    if (bytes(result) > limitBytes) throw new Error('Conversation page exceeds the 1 MiB transport limit')
    return result
  }

  async feedback(raw: { cursor?: number; limit?: number } = {}) {
    await this.ready
    this.available()
    const input = FeedbackSchema.parse(raw)
    await this.pump.tick()
    this.original.reconcileDepartmentNotices()
    const questionStates: { workRef: string; questionId: string | null }[] = []
    for (let offset = 0;; offset += 20) {
      const works = this.ledger.works('', offset, 20)
      for (const work of works) {
        if (work.conversationId !== this.conversationId) continue
        const ticket = work.ticketId ? this.store.tickets.get(work.ticketId) : undefined
        questionStates.push({ workRef: work.workRef,
          questionId: ticket && !ticket.ended && !ticket.attention?.answeredBy ? ticket.attention?.id ?? null : null })
      }
      if (works.length < 20) break
    }
    return { ...this.ledger.eventPage(this.conversationId, input.cursor, input.limit), questionStates }
  }

  async stopChat(raw: { id: string }): Promise<{ stopped: boolean }> {
    await this.ready
    this.available()
    const { id } = StopChatSchema.parse(raw), request = this.active.get('jarvis')
    if (request?.role !== 'jarvis' || request.origin?.source !== 'user' || request.origin.userMessageId !== id || request.cancelRequested) return { stopped: false }
    request.cancelRequested = true
    try {
      const result = await this.host.cancel({ sessionKey: request.sessionKey, requestId: request.requestId })
      if (!result || typeof result !== 'object' || !('cancelled' in result) || result.cancelled !== true) {
        if (this.active.get('jarvis') === request) request.cancelRequested = false
        return { stopped: false }
      }
    }
    catch (error) { if (this.active.get('jarvis') === request) request.cancelRequested = false; throw error }
    return { stopped: true }
  }

  /** Cumulative text replaces the previous partial; only this exact active user invocation can advance it. */
  async progress(raw: { sessionKey: string; requestId: string; sequence: number; text: string; stream?: boolean }): Promise<{ accepted: boolean }> {
    await this.ready
    this.available()
    const input = ProgressSchema.parse(raw), request = this.active.get(input.sessionKey)
    if (input.sessionKey !== 'jarvis' || request?.role !== 'jarvis' || request.origin?.source !== 'user' ||
      request.requestId !== input.requestId || request.cancelRequested) return { accepted: false }
    const name = requests(key(request.sessionKey, request.requestId)), record = this.store.get(name), turn = this.store.get(turns(request.origin.userMessageId))
    if (record?.status !== 'running' || turn?.status !== 'running' || input.sequence <= (record.progressSequence ?? -1)) return { accepted: false }
    const stream = input.stream ?? true
    if (turn.stream !== undefined && turn.stream !== stream) return { accepted: false }
    this.store.atomic(() => {
      this.store.set(name, { ...record, text: input.text, progressSequence: input.sequence })
      this.store.set(turns(turn.id), { ...turn, assistant: input.text, stream })
    })
    request.partialText = input.text
    return { accepted: true }
  }

  private async run(request: ActiveRequest): Promise<ProcessRunResult> {
    this.available()
    const name = requests(key(request.sessionKey, request.requestId)), hash = fingerprint([request.role, request.text, request.systemPrompt, ...(request.tools ? [request.tools] : []), ...(request.workspace ? [request.workspace] : [])])
    const old = this.store.get(name)
    if (old) {
      if (old.hash !== hash) throw new Error('Session request identity conflicts with its persisted payload')
      return { text: old.text, status: old.status === 'running' ? 'failed' : old.status, error: old.error ?? (old.status === 'running' ? interrupted : undefined) }
    }
    if (this.active.has(request.sessionKey)) throw new Error('A session already has an active invocation')
    this.store.set(name, { sessionKey: request.sessionKey, role: request.role, requestId: request.requestId, hash, text: '', status: 'running' })
    this.active.set(request.sessionKey, request)
    let result: ProcessRunResult
    try { result = await this.host.run({ sessionKey: request.sessionKey, role: request.role, requestId: request.requestId, text: request.text, systemPrompt: request.systemPrompt,
      ...(request.tools ? { tools: request.tools } : {}), ...(request.workspace ? { workspace: request.workspace } : {}) }) }
    catch (error) { result = { status: 'failed', text: '', error: fault(error) } }
    if (this.stopping) result = { ...result, status: 'failed', error: interrupted }
    if (request.sessionKey === 'jarvis' && request.role === 'jarvis' && request.origin?.source === 'user' &&
      result.status === 'complete' && !result.text.trim()) result = { ...result, status: 'failed', text: '', error: noVisibleReply }
    const partial = this.closed ? undefined : this.store.get(name), partialText = partial?.text ?? request.partialText
    if (result.status !== 'complete' && !result.text && partialText) result = { ...result, text: partialText }
    if (!this.closed) this.store.set(name, { ...partial, sessionKey: request.sessionKey, role: request.role, requestId: request.requestId, hash, ...result,
      ...(result.status !== 'complete' ? { needsRetry: true } : {}) })
    if (this.active.get(request.sessionKey) === request) this.active.delete(request.sessionKey)
    return result
  }

  async tool(call: ProcessToolCall): Promise<unknown> {
    this.available()
    const request = this.active.get(call.sessionKey)
    if (!request || request.cancelRequested || request.role !== call.role || request.requestId !== call.requestId) throw new Error('Tool call is not bound to an active session invocation')
    if (request.delegationId && call.role === 'jarvis' && call.name === 'delegation_prepare') {
      const input = PrepareSchema.parse(call.args); this.inbound.prepare(request.delegationId, input.summary); return { prepared: true }
    }
    if (request.delegationId && call.role === 'jarvis' && call.name === 'delegation_context_read') {
      const input = PreparationReadSchema.parse(call.args), context = this.inbound.preparationContext(request.delegationId)
      const ancestor = input.ancestorIndex === undefined ? undefined : context.ancestors[input.ancestorIndex]
      if (input.section === 'ancestor_assignment' && !ancestor) throw new Error('Unknown delegation ancestor constraint')
      return textPage(`delegation:${request.delegationId}:${input.section}${input.ancestorIndex === undefined ? '' : `:${input.ancestorIndex}`}`,
        input.section === 'source' ? context.source.text : ancestor?.assignment ?? context.assignment, input.offset, input.limit)
    }
    if (call.role === 'jarvis' && call.sessionKey === 'jarvis') {
      if (call.name === 'jarvis_work_query') { await this.pump.tick(); return this.gateway.query(call.args) }
      if (call.name === 'jarvis_work_submit') {
        if (this.original.capabilityDrain.frozen) throw new Error('Task submission is frozen for the confirmed Worker capability change')
        const input = SubmitSchema.parse(call.args)
        if (request.origin?.source !== 'user') throw new Error('Background expression cannot grant user authorization')
        const result = this.gateway.submit(input, request.origin)
        void this.tick().catch(() => {})
        return result
      }
    }
    throw new Error(`Tool ${call.name} is not registered in this conversation; task tools belong to the original Sessions mechanism`)
  }

  async management(request: ManagementRequest) {
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    await this.ready
    if (request.method === 'GET' && request.path === 'configuration-migrations') return { status: 200, body: { items: originalConfigurationMigrations(this.store, this.config.instanceId) } }
    return this.original.runtime.management(request)
  }

  /** Private host IPC entry. Model arguments never choose a principal, engine or trusted turn identity. */
  async gatewayRequest(raw: unknown) {
    await this.ready
    this.available()
    const origin = z.object({ conversationId: z.string().min(1).max(200), userMessageId: z.string().min(1).max(200),
      text: z.string().min(1).max(32000), at: z.string().min(1).max(100), source: z.literal('user'),
      selectedWorkRef: z.string().min(1).max(200).optional(), selectedQuestionId: z.string().min(1).max(200).optional() }).strict()
    const request = z.discriminatedUnion('operation', [
      z.object({ operation: z.literal('submit'), input: SubmitSchema, origin }).strict(),
      z.object({ operation: z.literal('query'), input: QuerySchema }).strict(),
      z.object({ operation: z.literal('events'), conversationId: z.string().min(1).max(200),
        cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    ]).parse(raw)
    if (request.operation === 'submit') {
      if (this.original.capabilityDrain.frozen) throw new Error('Task submission is frozen while organization configuration changes')
      const result = this.gateway.submit(request.input, request.origin)
      return result
    }
    await this.tick()
    if (request.operation === 'query') {
      const projection = this.gateway.query(request.input)
      if (request.input.operation !== 'get') return projection
      const ticketId = this.ledger.work(request.input.workRef)?.ticketId
      return { ...projection, artifacts: this.artifactsForTicket(ticketId),
        departmentWaits: ticketId ? this.original.departmentWaitsForTicket(ticketId) : [] }
    }
    const page = this.ledger.eventPage(request.conversationId, request.cursor, request.limit)
    const refs = new Set(page.items.map(event => event.workRef))
    const works = [...refs].flatMap(workRef => {
      const work = this.ledger.work(workRef)
      if (!work || work.conversationId !== request.conversationId) return []
      return [{ ...work, receivedAt: this.ledger.command(work.commandId)?.command.receivedAt ?? '',
        artifacts: this.artifactsForTicket(work.ticketId) }]
    })
    const questionStates = works.map(work => ({ workRef: work.workRef,
      questionId: (this.gateway.query({ operation: 'get', workRef: work.workRef }) as { question?: { id: string } }).question?.id ?? null }))
    return { ...page, works, questionStates }
  }
  async state() {
    await this.ready
    this.available(); await this.pump.tick()
    const settings = this.store.settings()
    return { instanceId: this.config.instanceId, organizationName: this.config.organizationName, brainName: this.config.brainName, pid: process.pid,
      turns: this.store.keys(turns).map(name => this.store.get(name)!).sort((a, b) => a.at.localeCompare(b.at)), tickets: this.store.tickets.list(),
      works: this.gateway.query({ operation: 'search', query: '', cursor: 0, limit: 20 }), events: this.ledger.eventPage(this.conversationId, 0, 50),
      delegations: { incoming: this.inbound.list(), outgoing: this.delegated.list() },
      departmentWaits: this.store.tickets.open().flatMap(ticket => this.original.departmentWaitsForTicket(ticket.id)),
      execution: { evalModel: settings.eval.model, workerModel: settings.executor.model, maxWorkers: settings.executor.maxWorkers,
        directory: executionRoot(settings, this.original.runtime.machine.stateDir) },
      health: { ...this.original.runtime.health, ...this.board.all }, active: [...this.active.values()].map(({ sessionKey, role, requestId }) => ({ sessionKey, role, requestId })) }
  }
  private artifactsForTicket(ticketId?: string): VerifiedArtifact[] {
    if (!ticketId) return []
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return []
    const artifacts = [...this.taskFiles.links(this.config.instanceId, ticketId).map(item => ({ ...item, instanceId: this.config.instanceId, ticketId })),
      ...this.delegated.artifacts(ticketId)]
    return [...new Map(artifacts.map(item => [item.url, item])).values()]
  }
  /** The host checks this again for every transfer chunk; a model cannot supply an additional handoff grant. */
  authorizeArtifact(raw: unknown): { authorized: true } {
    const input = ArtifactTransferSchema.parse(raw)
    const ticket = this.store.tickets.get(input.ticketId), assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== input.assignmentId || assignment.state === 'ended'
      || !this.original.handoffArtifacts(ticket).some(item => artifactIdentity(item) === artifactIdentity(input.artifact))) throw new Error('Artifact has no authorized handoff in the current task assignment')
    return { authorized: true }
  }
  /** Only fixed registered producer/task/assignment/version references are served; paths are derived under the producer root. */
  readArtifact(raw: unknown): ArtifactChunk {
    const input = ArtifactReadSchema.parse(raw)
    if (input.artifact.instanceId !== this.config.instanceId) throw new Error('Artifact producer identity does not match this owner')
    return this.taskFiles.read(input)
  }
  async delegation(envelope: DelegationEnvelope): Promise<DelegationSnapshot> {
    await this.ready
    this.available()
    const snapshot = await this.inbound.receive(envelope)
    return this.delegationResult(snapshot)
  }
  /** Admission readiness uses the original Core and maintenance owner, not process liveness alone. */
  async delegationReadiness(raw: unknown = {}): Promise<{ ready: boolean }> {
    z.object({}).strict().parse(raw)
    if (this.stopping || this.closed || this.options.managementOnly) return { ready: false }
    await this.ready
    return { ready: !this.stopping && !this.closed && this.original.delegationReady() }
  }
  private delegationResult(snapshot: DelegationSnapshot): DelegationSnapshot {
    const downstream = snapshot.ticketId && this.delegated.result(snapshot.ticketId)
    const paths = snapshot.ticketId ? this.delegated.artifactLineages(snapshot.ticketId).map(path =>
      [this.inbound.resultLink(snapshot.delegationId, path[0]!.parentAssignmentId), ...path]) : []
    return { ...snapshot, artifacts: this.artifactsForTicket(snapshot.ticketId),
      ...(snapshot.ticketId ? { departmentWaits: this.original.departmentWaitsForTicket(snapshot.ticketId) } : {}),
      ...(snapshot.lineage ? { lineage: [...snapshot.lineage, ...(downstream && downstream.lineage || [])] } : {}),
      ...(paths.length ? { artifactLineages: paths } : {}) }
  }
  /** Private lifecycle-only control; it cannot submit, append, answer or resume work. */
  async lifecycleDelegation(envelope: DelegationEnvelope): Promise<DelegationSnapshot> {
    await this.ready
    if (!['query', 'stop'].includes(envelope.request.operation) || this.closed) throw new Error('Lifecycle delegation permits bound query and stop only')
    const snapshot = await this.inbound.receiveLifecycle(envelope)
    if (envelope.request.operation !== 'stop') return this.delegationResult(snapshot)
    const ticket = snapshot.ticketId && this.store.tickets.get(snapshot.ticketId)
    if (!['stopped', 'completed', 'missing'].includes(snapshot.status) && !(ticket && ticket.cancellation)) return this.delegationResult(snapshot)
    await this.inbound.idle(envelope.request.delegationId)
    if (snapshot.ticketId) {
      await this.delegated.shutdown(snapshot.ticketId)
      await this.stopNativeTicket(snapshot.ticketId)
      this.engine.confirmCancellation(snapshot.ticketId)
    }
    await this.options.native.sessions.flush()
    const verified = await this.inbound.receiveLifecycle({ ...envelope, request: { ...envelope.request, operation: 'query' } })
    return { ...this.delegationResult(verified), executionStopped: true }
  }
  private async stopNativeTicket(ticketId: string): Promise<void> {
    const sessionId = `worker-${ticketId}`
    if (this.options.managementOnly) {
      await this.options.native.executor.stopBackground(sessionId, 'Owning parent organization stopped', false)
    }
    if (!this.options.managementOnly) {
      const loaded = this.options.native.executor.current(sessionId)
      if (loaded) await this.options.native.executor.cancel(sessionId, false)
      // Persisted Session ownership outlives an in-memory Agent. Its background
      // jobs must still be stopped and verified by the native owner port.
      await this.options.native.executor.stopBackground(sessionId, 'Owning parent organization stopped', false)
      if (loaded) {
        await this.options.native.executor.whenIdle(sessionId)
        const quiet = await this.options.native.executor.untilQuiet(sessionId, AbortSignal.timeout(1000))
        const remaining = await this.options.native.executor.runningJobs(sessionId)
        if (!quiet || remaining.length || this.options.native.executor.current(sessionId)?.status !== 'idle') throw new Error('Bound child native execution cleanup has not completed')
      }
    }
    await this.options.native.sessions.flush()
  }
  /** A stopped management owner can finish persisted controls without starting Sources, Router or Workers. */
  async drainDelegations(raw: unknown = {}): Promise<void> {
    const { preserveDepartmentWaits } = z.object({ preserveDepartmentWaits: z.boolean().optional() }).strict().parse(raw)
    await this.ready
    await this.original.beginShutdown()
    await this.delegated.shutdown(undefined, preserveDepartmentWaits ? ticket => this.original.departmentWaitsForTicket(ticket.id).length > 0 : undefined)
    for (const ticket of this.store.tickets.cancelling()) {
      await this.stopNativeTicket(ticket.id)
      this.engine.confirmCancellation(ticket.id)
    }
  }
  /** Installs or releases the durable owner admission fence before reporting activity. */
  async capabilitiesHold(raw: unknown) {
    await this.ready
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    const input = CapabilityHoldSchema.extend({ held: z.boolean() }).parse(raw)
    this.original.capabilityDrain.set(input)
    return this.capabilitiesActivity()
  }
  /** Observes the real Engine, original executor and active foreground/preparation requests. */
  async capabilitiesActivity(raw: unknown = {}) {
    await this.ready
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    const input = z.object({ operationId: z.string().min(1).max(200).optional() }).strict().parse(raw)
    if (input.operationId && this.original.capabilityDrain.operationId !== input.operationId) throw new Error('Worker capability operation does not own the admission hold')
    return this.capabilitySnapshot()
  }
  private capabilitySnapshot() {
    const extra: CapabilityTask[] = [...this.active.values()].map(request => ({
      id: `conversation:${request.sessionKey}:${request.requestId}`, kind: request.delegationId ? 'delegation' : 'conversation',
      title: request.origin?.text ?? request.text.slice(0, 200), status: request.cancelRequested ? 'stopping' : 'running',
      sessionId: request.sessionKey, ...(request.delegationId ? { delegationId: request.delegationId } : {}), reasons: ['active_request'] }))
    for (const row of this.delegated.list()) {
      if (!row.stopped || row.finished) continue
      const ticket = this.store.tickets.get(row.request.parentTicketId)
      extra.push({ id: `ticket:${row.request.parentTicketId}:${row.request.parentAssignmentId}`, kind: 'ticket',
        title: ticket?.title ?? row.request.text ?? 'Delegated task', ticketId: row.request.parentTicketId,
        assignmentId: row.request.parentAssignmentId, status: 'stopping', reasons: ['delegation_stop_pending'] })
    }
    return this.original.capabilityDrain.snapshot(this.config.instanceId, extra)
  }
  /** Unlike Worker maintenance, a graph move must also wait for parked business tickets. */
  private topologySnapshot() {
    const activity = this.capabilitySnapshot(), tasks = [...activity.tasks, ...activity.waitingTasks]
    for (const row of this.delegated.list()) {
      if (!row.stopped || row.snapshot?.executionStopped === true) continue
      const id = `ticket:${row.request.parentTicketId}:${row.request.parentAssignmentId}`
      if (!tasks.some(task => task.id === id)) tasks.push({ id, kind: 'ticket', title: 'Delegated task cleanup is not confirmed',
        ticketId: row.request.parentTicketId, assignmentId: row.request.parentAssignmentId,
        status: 'stopping', reasons: ['delegation_stop_pending'] })
    }
    for (const row of this.inbound.activity()) {
      if (row.phase === 'stopped' || ['completed', 'stopped'].includes(row.status) || row.ticketId) continue
      if (!tasks.some(task => task.delegationId === row.id)) tasks.push({ id: `delegation:${row.id}`, kind: 'delegation',
        title: row.title, delegationId: row.id, status: row.phase, reasons: ['unfinished_delegation'] })
    }
    for (const thread of this.store.threads.active()) for (const id of thread.pending) {
      if (tasks.some(task => task.triggerId === id)) continue
      const trigger = this.store.triggers.get(id)
      tasks.push({ id: `pending:${id}`, kind: 'assessment', title: trigger?.text.slice(0, 200) ?? 'Pending task',
        triggerId: id, status: 'queued', reasons: ['pending_admission'] })
    }
    return { instanceId: this.config.instanceId, busy: tasks.length > 0, tasks }
  }
  /** Private host IPC: observe unfinished work without disturbing an active owner. */
  async topologyActivity() {
    await this.ready
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    return this.topologySnapshot()
  }
  async topologyPrepare(raw: unknown) {
    await this.ready
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).strict().parse(raw)
    const before = this.topologySnapshot()
    if (before.busy) return { ...before, prepared: false }
    try {
      await this.original.freezeTopology(operationId)
      return { ...this.topologySnapshot(), prepared: true }
    } catch (error) {
      try { this.original.capabilityDrain.releaseTopology(operationId) } catch { /* Keep another maintenance owner's fence intact. */ }
      throw error
    }
  }
  /** Private host IPC: update only the graph while all original work is fenced and drained. */
  async topologyConfigure(raw: unknown) {
    await this.ready
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    const ids = z.array(z.string().min(1).max(200)).refine(value => new Set(value).size === value.length)
    const input = z.object({ operationId: z.string().min(1).max(200), allowedParents: ids,
      delegationTargets: z.array(CapabilitySchema).refine(value => new Set(value.map(target => target.instanceId)).size === value.length),
      delegationLimits: z.array(z.object({ sourceInstanceId: z.string().min(1).max(200), tools: z.array(WorkerToolSchema) }).strict()) }).strict().parse(raw)
    this.original.capabilityDrain.authorizeTopology(input.operationId)
    if (this.topologySnapshot().busy) throw new Error('Organization topology must wait for unfinished work')
    this.original.configureTopology(input)
    return { configured: true, instanceId: this.config.instanceId }
  }
  async topologyRelease(raw: unknown) {
    await this.ready
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).strict().parse(raw)
    this.original.capabilityDrain.releaseTopology(operationId)
    return { released: true, instanceId: this.config.instanceId }
  }
  async capabilitiesFreeze(raw: unknown) {
    await this.ready
    this.available()
    const { operationId } = z.object({ operationId: z.string().min(1).max(200) }).strict().parse(raw)
    this.original.capabilityDrain.freeze(operationId)
    return this.capabilitySnapshot()
  }
  /** Private host IPC only: update Worker policy in place while preserving original task and Session owners. */
  async capabilitiesConfigure(raw: unknown) {
    await this.ready
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    const input = z.object({ operationId: z.string().min(1).max(200), workerTools: z.array(WorkerToolSchema),
      workerSkills: WorkerSkillsSchema, delegationTargets: z.array(CapabilitySchema),
      delegationLimits: z.array(z.object({ sourceInstanceId: z.string().min(1).max(200), tools: z.array(WorkerToolSchema) }).strict()) }).strict().parse(raw)
    this.original.capabilityDrain.authorizeConfiguration(input.operationId)
    await this.original.prepareCapabilityConfiguration(input.delegationTargets)
    if (this.stopping || this.closed) throw new Error('Business runtime is stopping')
    this.original.capabilityDrain.authorizeConfiguration(input.operationId)
    // A management-only owner has no Sessions, Sources or effects running. The
    // host verified its stopped native owner before opening this Store; durable
    // pending tickets/effects can be preserved and tightened without executing.
    if (this.capabilitySnapshot().busy && !this.options.managementOnly) throw new Error('Worker capability configuration requires all active execution to drain')
    // Keep validation, grant tightening and policy replacement in one turn;
    // frozen execution cannot enter between the observation and the change.
    this.original.configureCapabilities(input)
    return { configured: true, instanceId: this.config.instanceId }
  }
  /** Stops only identities present in the confirmed frozen manifest, through original domain operations. */
  async capabilitiesStop(raw: unknown) {
    await this.ready
    this.available()
    const { operationId, fingerprint } = z.object({ operationId: z.string().min(1).max(200), fingerprint: z.string().min(1) }).strict().parse(raw)
    const current = this.capabilitySnapshot(), confirmed = this.original.capabilityDrain.confirmed(operationId, fingerprint, current.tasks)
    const active = new Set(current.tasks.map(task => task.id))
    const tasks = confirmed.filter(task => active.has(task.id))
    // No await between validation and domain stops: a new admission cannot enter the confirmed set.
    for (const task of tasks) {
      if (task.kind === 'assessment' && task.triggerId)
        this.engine.cancelAssessment(task.triggerId, 'Stopped to apply the confirmed Worker capability change.', task.evalId)
      if (task.ticketId) {
        const ticket = this.store.tickets.get(task.ticketId)
        if (ticket && liveTicket(ticket) && latestAssignment(ticket)?.id === task.assignmentId)
          this.engine.stopTicket(ticket.id, 'Stopped to apply the confirmed Worker capability change.')
      }
    }
    const cancellations: Promise<unknown>[] = []
    const sessions = new Set(tasks.filter(task => task.kind === 'assessment').flatMap(task => task.sessionId ? [task.sessionId] : []))
    for (const sessionId of sessions) cancellations.push(this.options.native.executor.cancel(sessionId, false))
    for (const task of tasks) {
      if (task.kind !== 'conversation' && task.kind !== 'delegation' || !task.sessionId) continue
      const request = this.active.get(task.sessionId)
      if (request && task.id === `conversation:${request.sessionKey}:${request.requestId}`) {
        request.cancelRequested = true
        cancellations.push(this.host.cancel({ sessionKey: request.sessionKey, requestId: request.requestId }))
      }
    }
    const incomingIds = [...new Set(tasks.flatMap(task => task.delegationId ? [task.delegationId] : []))]
    cancellations.push(this.inbound.stop(incomingIds, operationId))
    const results = await Promise.allSettled(cancellations)
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    await this.tick()
    return this.capabilitySnapshot()
  }
  close(raw: unknown = {}): Promise<void> {
    const { preserveDepartmentWaits } = z.object({ preserveDepartmentWaits: z.boolean().optional() }).strict().parse(raw)
    return this.closing ??= this.shutdown(preserveDepartmentWaits).catch(error => { this.closing = undefined; throw error })
  }
  private async shutdown(preserveDepartmentWaits = false): Promise<void> {
    this.stopping = true; clearInterval(this.timer)
    await Promise.allSettled([...this.active.values()].map(request => this.host.cancel({ sessionKey: request.sessionKey })))
    await this.inbound.close()
    await this.ticking
    if (!this.options.managementOnly) await this.drainDelegations({ preserveDepartmentWaits })
    await this.original.close(); this.closed = true
  }

}
export { verifiedDelegationArtifacts } from './delegation-contract.ts'
