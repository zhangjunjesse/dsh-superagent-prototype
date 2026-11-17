/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, latestAssignment, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import { Later, type Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'
import type { NativeSession, NativeSessionEvent, NativeSessionPolicy, NativeSourceContext, SessionNativePort } from './runtime-ports.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  /** Omit for the original same-process DSH path. */
  readonly native?: SessionNativePort
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly masterDirectory?: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Pick<Agent, 'id'>, ticket?: Ticket): Tool[]
  /** Organization and delegated-mandate ceiling, intersected with the original role tools. */
  workerTools?(ticket: Ticket): readonly string[]
  workerSkills?(ticket: Ticket): readonly string[]
  sourceContext?(sessionId: string, triggerId: string): NativeSourceContext
  nativeEnvironment?(): Record<string, string | undefined>
  skillDirectory?(): string
  localTicket?(ticket: Ticket): boolean
  /** Freeze new model requests and input deliveries while an exact stop set is confirmed. */
  executionHeld?(): boolean
  /** Independent of execution admission: permits only exact frozen-owner receipt cancellation. */
  authorizeCapabilityStop?(operationId: string): void
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
export const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/** PowerShell's direct sleep command and built-in alias at command positions; this is a responsiveness guard, not a shell sandbox. */
const POWERSHELL_SLEEP = /(?:^|[;&|({\n])\s*(?:&\s*)?(?:Microsoft\.PowerShell\.Utility\\)?(?:Start-Sleep|sleep)\b/i
/**
 * The main Session's guard: it refuses a shell command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
export function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash' || name === 'pwsh') {
    const sleeps = typeof args.command === 'string' && (name === 'pwsh' ? POWERSHELL_SLEEP : SLEEP).test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery?: AgentDelivery
  private nativeDispose?: () => void
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    if (!host.native) this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    if (this.host.native) {
      if (this.nativeDispose) return
      this.nativeDispose = this.host.native.install({
        policy: (id, bind) => this.nativePolicy(id, bind),
        authorize: (id, operation, tool) => this.authorizeNative(id, operation, tool),
        authorizeCapabilityStop: operationId => {
          if (this.host.closing() || this.host.lifetime.aborted) throw new Error('Superagent is stopping')
          if (!this.host.authorizeCapabilityStop) throw new Error('Native delivery cancellation has no capability maintenance owner')
          return this.host.authorizeCapabilityStop(operationId)
        },
        capabilityFrozen: () => Boolean(this.host.executionHeld?.()),
        tool: async (id, name, args, signal) => {
          this.authorizeNative(id, 'tool', name)
          const ticket = this.ticketForId(id)
          const definition = this.host.tools({ id: id as SessionId }, ticket).find(tool => tool.name === name)
          if (!definition) throw new Error('Tool is not registered for this Session')
          signal.throwIfAborted()
          return definition.execute(definition.schema.parse(args), signal)
        },
        event: event => this.nativeEvent(event),
        sourceContext: this.host.sourceContext?.bind(this.host),
      })
      return
    }
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent | NativeSession> {
    if (role === 'worker' && this.host.executionHeld?.()) throw new Later('Worker creation is frozen for a pending capability change')
    if (this.host.native) {
      const settings = this.host.store.settings()
      // Attachment snapshots and following events share the native journal's
      // order. A separate inspect/restore here can race a newer retry event.
      return this.host.native.ensure({ sessionId: id, cwd, title, role,
        model: role === 'orchestrator' ? settings.eval.model : settings.executor.model })
    }
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    if (this.host.native) return this.host.native.holds(sessionId, key(requestId))
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery!.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    if (this.host.native) return this.host.native.deliver({ sessionId, requestId: key(requestId), text, mode }, { authorize, accepted })
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery!.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    if (this.host.native) {
      if (!this.host.native.current(this.host.masterId)) return
      const text = JSON.stringify(value)
      return this.host.native.deliver({ sessionId: this.host.masterId, requestId: `notice:${name}:${key(text)}`, text, mode: { inject: summary } })
    }
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery!.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      const loaded = this.host.native ? this.host.native.current(sessionId) : this.ctx.agents.get(sessionId as SessionId)
      return loaded && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      // Zod adds hidden runtime metadata; DSH's public schema directory requires plain JSON data.
      const parameters = JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as Record<string, unknown>
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters,
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    return this.ticketForId(agent.id)
  }
  private ticketForId(sessionId: string): Ticket | undefined {
    const ticketId = ticketOfSession(sessionId)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private authorizeNative(sessionId: string, operation: 'request' | 'tool' | 'delivery', toolName?: string): void {
    if (operation !== 'tool' && this.host.executionHeld?.()) throw new Later('Task execution is frozen for a pending Worker capability change')
    if (this.host.closing() || this.host.lifetime.aborted) throw new Error('Superagent is stopping')
    if (sessionId === this.host.masterId) return
    const ticket = this.ticketForId(sessionId)
    if (!ticket) throw new Error('Session does not belong to this application')
    if (this.host.localTicket?.(ticket) === false) throw new Error('Ticket execution belongs to a child instance')
    if (!liveTicket(ticket)) throw new Error('Ticket ended; new work needs a new authorized ticket')
    if (operation === 'tool' && toolName && WORK_TOOLS.includes(toolName)) {
      const ceiling = this.host.workerTools?.(ticket)
      if (ceiling && !ceiling.includes(toolName)) throw new Error('Tool is outside the organization or delegated capability')
    }
  }
  /** Uses the same original composition, skill text and version binding as the local DSH path. */
  nativePolicy(sessionId: string, bind: boolean): NativeSessionPolicy {
    const ticket = this.ticketForId(sessionId), master = sessionId === this.host.masterId
    if (!master && !ticket) throw new Error('Session does not belong to this application')
    // Preview/recovery reads never admit work. Binding a real request still requires the current live owner.
    if (bind) this.authorizeNative(sessionId, 'request')
    const version = this.versionFor(sessionId, bind), settings = this.host.store.settings()
    const prompt = this.host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', ticket ? this.host.environment(ticket) : undefined)
    const ceiling = ticket && this.host.workerTools?.(ticket)
    return { sessionId, role: master ? 'orchestrator' : 'worker', ...(ticket ? { ticketId: ticket.id, assignmentId: latestAssignment(ticket)?.id } : {}),
      cwd: ticket?.execution?.directory ?? this.host.masterDirectory ?? '', promptRevision: version.revision,
      prompt: `[dsh-superagent prompt revision ${version.revision}]\n${prompt}\n${ticket ? mandateInstructions(ticket.mandate) : ''}`,
      complete: master, skillDirectory: this.host.skillDirectory?.() ?? this.host.masterDirectory ?? '',
      skills: this.skillsFor(version), environment: this.host.nativeEnvironment?.() ?? {},
      ...(ticket && this.host.workerSkills ? { selectedSkills: [...this.host.workerSkills(ticket)] } : {}),
      tools: this.host.tools({ id: sessionId as SessionId }, ticket).map(tool => ({ name: tool.name, description: tool.description,
        parameters: JSON.parse(JSON.stringify(z.toJSONSchema(tool.schema))) as Record<string, unknown> })),
      allowedTools: master ? ['skill', 'bash', 'pwsh', 'read', 'read_image', 'job_output', 'job_list', 'job_kill']
        : WORK_TOOLS.filter(name => !ceiling || ceiling.includes(name)),
      initialModel: master ? settings.eval.model : settings.executor.model }
  }
  private nativeEvent(event: NativeSessionEvent): void {
    // The original local listener observes only this application's main and
    // ticket Workers. A guarded native subagent is not an additional managed
    // Worker and must not contribute to the application's model health.
    if (event.sessionId !== this.host.masterId && !this.ticketForId(event.sessionId)) return
    if (event.kind === 'restored') {
      this.retryHealth.restore(event.sessionId, event.events)
      if (event.status === 'idle') this.retryHealth.clear(event.sessionId)
    }
    if (event.kind === 'event') this.retryHealth.observe(event.sessionId, event.event)
    if (event.kind === 'disposed' || event.kind === 'status' && event.status === 'idle' && !this.host.closing()) this.retryHealth.clear(event.sessionId)
    this.updateModelHealth()
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      // Windows presets inherit pwsh instead of bash; DSH rejects restrictions naming absent tools.
      const parent = scopeParentOf(agent)
      const allow = ['skill', 'bash', 'pwsh', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'].filter(name => agent.ctx.tools.get(name, parent))
      binding.disposers.push(agent.ctx.tools.restrict({ allow }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const ticket = store.tickets.get(ticketId), ceiling = ticket && this.host.workerTools?.(ticket)
    const allow = WORK_TOOLS.filter(name => (!ceiling || ceiling.includes(name)) && agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      if (current && this.host.localTicket?.(current) === false) return 'Ticket execution belongs to a child instance'
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const skill of this.skillsFor(version)) {
      disposers.push(scope.skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'runtime',
        ...(skill.resourceDirectory ? { resourceBase: { kind: 'directory' as const, path: skill.resourceDirectory } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.versionFor(agent.id, bind)
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    return version
  }
  private versionFor(sessionId: string, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(sessionId)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(sessionId), bound)
    return version
  }
  private skillsFor(version: PromptVersion) {
    return this.host.prompts.skills(version.config).map(([name, content]) => {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      return { name: `${SKILL_PREFIX}${name}`, description: bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.'),
        content, ...(bundled ? { resourceDirectory: dirname(bundled.path) } : {}) }
    })
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void {
    this.nativeDispose?.(); this.nativeDispose = undefined
    for (const agent of [...this.bindings.keys()]) this.release(agent)
  }
}
