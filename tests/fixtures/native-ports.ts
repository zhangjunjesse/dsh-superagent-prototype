/** Controlled native boundary; application rules always execute in the real original Runtime. */
import { realpathSync, statSync } from 'node:fs'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { messageId } from '../../src/app/delivery.ts'
import type { NativeSession, NativeSessionCallbacks, NativeSessionEvent, NativeSessionPolicy, RuntimeNativePorts } from '../../src/app/runtime-ports.ts'
import type { ProcessRun } from '../../src/process-runtime/runtime.ts'

export interface NativeTurn {
  sessionId: string; text: string; requestId: string; policy: NativeSessionPolicy;
  tool(name: string, args: unknown): Promise<unknown>;
  authorize(name: string): Promise<void>;
}
type DeliveryInput = { sessionId: string; requestId: string; text: string }
export function processRunOf(input: DeliveryInput, policy: NativeSessionPolicy): ProcessRun {
  return { sessionKey: policy.role === 'worker' ? `worker:${policy.ticketId}` : 'router',
    role: policy.role === 'worker' ? 'worker' : 'router', requestId: input.requestId, text: input.text,
    systemPrompt: policy.prompt, tools: policy.allowedTools, workspace: policy.cwd }
}
export async function routeOriginal(turn: NativeTurn, title = 'Read bounded files', targetInstanceId?: string) {
  const card = JSON.parse(turn.text)
  if (card.kind !== 'candidate') return
  const dispatch = card.dispatch
  return turn.tool('orchestrator_route', { decisions: [dispatch && dispatch.operation !== 'new'
    ? { kind: dispatch.operation === 'stop' ? 'stop' : 'attach', trigger_id: card.trigger_id, ticket_id: dispatch.target_ticket_id }
    : { kind: 'accept', trigger_id: card.trigger_id, title, worktree_name: 'bounded-task', acknowledgement: 'Accepted bounded request.',
      ...(targetInstanceId ? { target_instance_id: targetInstanceId } : {}) }] })
}
export function controlledNative(run: (turn: NativeTurn) => Promise<void> = async () => {}, options: {
  beforeDelivery?(input: DeliveryInput, policy: NativeSessionPolicy): Promise<void>;
  cancel?(sessionId: string): void;
} = {}) {
  let callbacks: NativeSessionCallbacks | undefined
  const sessions = new Map<string, NativeSession>(), events = new Map<string, SessionEvent[]>(), listeners = new Set<(event: NativeSessionEvent) => void>()
  const seen = new Set<string>(), errors: unknown[] = [], deliveries: NativeTurn[] = [], policies: NativeSessionPolicy[] = []
  const active = new Map<string, Promise<void>>(), prepare: { command: string; cwd: string }[] = []
  const emit = (event: NativeSessionEvent) => { callbacks?.event(event); for (const listener of listeners) listener(event) }
  const api = () => { if (!callbacks) throw new Error('Original Sessions callbacks are not installed'); return callbacks }
  const modelCatalog: RuntimeNativePorts['deployment']['modelCatalog'] = async () => ({ providers: [] } as never)
  const native: RuntimeNativePorts = {
    sessions: {
      install(value) { callbacks = value; return () => { callbacks = undefined } },
      async ensure(input) {
        const policy = await api().policy(input.sessionId, false)
        if (realpathSync.native(input.cwd) !== realpathSync.native(policy.cwd)) throw new Error('Native Session directory does not match its owner')
        const existing = sessions.get(input.sessionId)
        const session = existing ?? { id: input.sessionId, status: 'idle' as const }
        sessions.set(session.id, session); events.set(session.id, events.get(session.id) ?? [])
        if (!existing) emit({ kind: 'restored', sessionId: session.id, status: session.status, events: events.get(session.id)! })
        return session
      },
      current: id => sessions.get(id),
      holds: async (id, request) => seen.has(`${id}:${request}`),
      async deliver(input, admission) {
        if (typeof input.mode !== 'object') await options.beforeDelivery?.(input, await api().policy(input.sessionId, false))
        await api().authorize(input.sessionId, 'delivery'); admission?.authorize?.()
        const identity = `${input.sessionId}:${input.requestId}`
        admission?.accepted?.()
        if (seen.has(identity)) return
        seen.add(identity)
        const event: SessionEvent<'user/message'> = { seq: SessionSeq(events.get(input.sessionId)!.length), time: Date.now(), type: 'user/message', surfaceOp: 'append',
          data: { id: messageId(input.requestId), role: 'user', content: [{ type: 'text', text: input.text }],
            source: typeof input.mode === 'object' ? { kind: 'dsh-superagent', form: 'notice', summary: input.mode.inject } : { kind: 'dsh-superagent', form: 'relay' } } }
        events.get(input.sessionId)!.push(event); emit({ kind: 'event', sessionId: input.sessionId, event })
        if (typeof input.mode === 'object') return
        const turn: NativeTurn = { sessionId: input.sessionId, requestId: input.requestId, text: input.text,
          policy: await api().policy(input.sessionId, true),
          tool: async (name, args) => { await api().authorize(input.sessionId, 'tool', name); return api().tool(input.sessionId, name, args, new AbortController().signal) },
          authorize: async name => { await api().authorize(input.sessionId, 'tool', name) } }
        deliveries.push(turn); policies.push(turn.policy)
        const pending = Promise.resolve().then(async () => {
          const session = sessions.get(input.sessionId)!; session.status = 'running'
          emit({ kind: 'status', sessionId: session.id, status: 'running', cancelled: false })
          try { await run(turn) } catch (error) { errors.push(error); emit({ kind: 'error', sessionId: session.id, error }) }
          finally {
            session.status = 'idle'; emit({ kind: 'status', sessionId: session.id, status: 'idle', cancelled: false })
            if (active.get(session.id) === pending) active.delete(session.id)
          }
        })
        active.set(input.sessionId, pending)
      },
      inspect: async id => events.get(id) ?? [], readSourceImage: async () => { throw new Error('No images in controlled native fixture') },
      flush: async () => {}, modelCatalog, resolveModel: async value => value,
    },
    executor: {
      current: id => sessions.get(id), listen(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      async cancel(id) { options.cancel?.(id); const session = sessions.get(id); if (session) { session.status = 'idle'; emit({ kind: 'status', sessionId: id, status: 'idle', cancelled: true }) } },
      whenIdle: async id => { await active.get(id) }, removePending: async () => {}, events: async id => events.get(id) ?? [],
      runPrepare: async (command, cwd) => { prepare.push({ command, cwd }) },
      verifyDirectory: async directory => { if (!statSync(directory).isDirectory()) throw new Error('Not a directory') },
      stopBackground: async () => {}, stopSubagents: async () => {}, runningJobs: async () => [], collectJob: async () => undefined,
      untilQuiet: async () => true, killJobs: async () => {},
    },
    deployment: { modelCatalog, resolveModel: async value => value, probe: async () => '' },
  }
  return { native, sessions, errors, deliveries, policies, prepare, api, emit,
    idle: async () => { for (;;) { const running = [...active.values()]; if (!running.length) return; await Promise.allSettled(running) } } }
}
