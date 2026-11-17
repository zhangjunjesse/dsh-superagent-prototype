/** Maintenance admission records attached to the original Store; task state stays in the original Engine. */
import { z } from 'zod'
import { latestAssignment, liveTicket, type Ticket, type Trigger } from '../core/index.ts'
import type { Runtime } from '../app/runtime.ts'
import { record } from '../kv.ts'
import { fingerprint } from '../jarvis-gateway/contracts.ts'
import type { InboundDelegations } from './delegation-ingress.ts'

export const CapabilityHoldSchema = z.object({ operationId: z.string().min(1).max(200), frozen: z.boolean().optional() }).strict()
export type CapabilityHold = z.infer<typeof CapabilityHoldSchema>
export interface CapabilityTask {
  id: string; kind: 'ticket' | 'assessment' | 'conversation' | 'delegation'; title: string; status: string; reasons: string[];
  ticketId?: string; assignmentId?: string; sessionId?: string; evalId?: string; triggerId?: string; delegationId?: string;
}
interface HoldRecord extends CapabilityHold {
  version: 1; ticketIds: string[]; triggerIds: string[]; delegationIds: string[];
  /** Observed frozen manifests authorize only their exact work identities, even after a restart. */
  manifests: Record<string, CapabilityTask[]>;
}
const held = record<HoldRecord>('process-runtime:capability-hold')
const TaskSchema = z.object({ id: z.string().min(1), kind: z.enum(['ticket', 'assessment', 'conversation', 'delegation']),
  title: z.string(), status: z.string(), reasons: z.array(z.string()), ticketId: z.string().optional(), assignmentId: z.string().optional(),
  sessionId: z.string().optional(), evalId: z.string().optional(), triggerId: z.string().optional(), delegationId: z.string().optional() }).strict()
const StoredHoldSchema = CapabilityHoldSchema.extend({ version: z.literal(1), ticketIds: z.array(z.string().min(1)),
  triggerIds: z.array(z.string().min(1)), delegationIds: z.array(z.string().min(1)), manifests: z.record(z.string(), z.array(TaskSchema)) }).strict()

/** Captures admitted work once and restores that same set before original business effects start. */
export class CapabilityDrain {
  private hold?: HoldRecord
  constructor(private readonly runtime: Runtime, private readonly incoming: InboundDelegations,
    private readonly masterRunning: () => boolean, private readonly processing: boolean, initial?: CapabilityHold) {
    const persisted = runtime.store.get(held)
    this.hold = persisted && StoredHoldSchema.parse(persisted)
    if (initial) this.set({ ...CapabilityHoldSchema.parse(initial), held: true })
  }
  get operationId(): string | undefined { return this.hold?.operationId }
  get frozen(): boolean { return this.hold?.frozen === true }
  private matching(operationId: string): HoldRecord {
    if (!this.hold || this.hold.operationId !== operationId) throw new Error('Worker capability operation does not own the admission hold')
    return this.hold
  }
  set(input: CapabilityHold & { held: boolean }): void {
    if (this.hold && this.hold.operationId !== input.operationId) throw new Error('Another Worker capability operation owns the admission hold')
    if (!input.held) {
      if (this.hold) { this.runtime.store.delete(held); this.hold = undefined }
      if (this.processing) this.runtime.passes.request()
      return
    }
    if (!this.hold) {
      this.hold = { version: 1, operationId: input.operationId, frozen: input.frozen ?? false,
        ticketIds: this.runtime.store.tickets.open().map(ticket => ticket.id),
        triggerIds: this.runtime.store.threads.active().flatMap(thread => thread.evaluating?.triggerIds ?? []),
        delegationIds: this.incoming.activity().filter(row => row.phase === 'preparing'
          || row.phase === 'routed' && !row.ticketId && row.status === 'pending').map(row => row.id), manifests: {} }
    } else if (input.frozen !== undefined) {
      if (this.hold.frozen !== input.frozen) this.hold.manifests = {}
      this.hold.frozen = input.frozen
    }
    this.runtime.store.set(held, this.hold)
    if (input.frozen === false && this.processing) this.runtime.passes.request()
  }
  evaluate(trigger: Trigger): boolean {
    if (!this.hold) return true
    if (this.frozen) return false
    if (this.admittedOrigin(trigger)) return true
    const target = trigger.dispatch?.targetTicketId && this.runtime.store.tickets.get(trigger.dispatch.targetTicketId)
    return !!target && this.resume(target)
  }
  private admittedOrigin(trigger: Trigger): boolean {
    return !!this.hold && (this.hold.triggerIds.includes(trigger.id) || trigger.source === 'delegation'
      && typeof trigger.meta.delegationId === 'string' && this.hold.delegationIds.includes(trigger.meta.delegationId))
  }
  resume(ticket: Ticket): boolean {
    if (!this.hold) return true
    if (this.frozen || !liveTicket(ticket)) return false
    return this.hold.ticketIds.includes(ticket.id) || ticket.origin.triggerIds.some(id => {
      const trigger = this.runtime.store.triggers.get(id)
      return !!trigger && this.admittedOrigin(trigger)
    })
  }
  prepare(id: string): boolean { return !this.frozen && (!this.hold || this.hold.delegationIds.includes(id)) }
  freeze(operationId: string): void {
    this.matching(operationId); this.set({ operationId, held: true, frozen: true })
    if (this.processing) this.runtime.engine.evaluateDue()
  }
  /** Native receipt settlement shares this exact frozen maintenance ownership; it grants no execution permission. */
  authorizeStop(operationId: string): void {
    if (!this.matching(operationId).frozen) throw new Error('Native delivery cancellation requires the frozen Worker capability owner')
  }
  /** A synchronous observation: installing the hold/freeze always precedes this read. */
  snapshot(instanceId: string, extra: CapabilityTask[] = []) {
    const { runtime } = this, work = new Map(extra.map(task => [task.id, task]))
    const activity = new Map(runtime.executor.activity().map(task => [task.ticketId, task]))
    for (const ticket of runtime.store.tickets.list()) {
      const observed = activity.get(ticket.id)
      if (!liveTicket(ticket) && !observed) continue
      const assignment = latestAssignment(ticket)
      const task: CapabilityTask = { id: `ticket:${ticket.id}:${assignment?.id ?? ''}`, kind: 'ticket', title: ticket.title,
        ticketId: ticket.id, assignmentId: assignment?.id, sessionId: `worker-${ticket.id}`,
        status: ticket.ended ? 'stopping' : ticket.attention ? 'awaiting_input' : assignment?.report?.state ?? assignment?.state ?? 'open',
        reasons: [...work.get(`ticket:${ticket.id}:${assignment?.id ?? ''}`)?.reasons ?? [], ...liveTicket(ticket) ? ['open_ticket'] : [],
          ...observed?.reasons ?? [], ...ticket.undelivered.length ? ['pending_inputs'] : []] }
      work.set(task.id, task)
    }
    for (const thread of runtime.store.threads.active()) {
      for (const id of thread.pending) {
        const trigger = runtime.store.triggers.get(id)
        if (!trigger || !this.admittedOrigin(trigger)) continue
        const task: CapabilityTask = { id: `assessment-input:${id}`, kind: 'assessment', triggerId: id,
          title: trigger.text.slice(0, 200), status: 'queued_admission', reasons: ['admitted_input_waiting'],
          ...(trigger.source === 'delegation' && typeof trigger.meta.delegationId === 'string' ? { delegationId: trigger.meta.delegationId } : {}) }
        work.set(task.id, task)
      }
      const evaluation = thread.evaluating
      if (!evaluation) continue
      const trigger = runtime.store.triggers.get(evaluation.primary ?? evaluation.triggerIds[0]!)
      const task: CapabilityTask = { id: `assessment:${evaluation.id}`, kind: 'assessment', evalId: evaluation.id,
        triggerId: evaluation.triggerIds[0], title: trigger?.text.slice(0, 200) ?? 'Original task assessment',
        sessionId: runtime.masterId, status: evaluation.delivered ? 'assessing' : 'queued_delivery', reasons: ['active_assessment'] }
      work.set(task.id, task)
    }
    const masterRunning = this.masterRunning()
    if (masterRunning || [...work.values()].some(task => task.kind === 'assessment' && task.sessionId === runtime.masterId)) {
      const task: CapabilityTask = { id: `assessment-session:${runtime.masterId}`, kind: 'assessment', title: 'Original task coordinator',
        sessionId: runtime.masterId, status: masterRunning ? 'running' : 'queued_delivery', reasons: ['coordinator_turn'] }
      work.set(task.id, task)
    }
    const incoming = this.incoming.activity()
    for (const row of incoming) {
      if (row.phase !== 'preparing' || row.ticketId) continue
      const task: CapabilityTask = { id: `delegation:${row.id}`, kind: 'delegation', delegationId: row.id,
        title: row.title, status: 'preparing', reasons: ['delegation_preparation'] }
      work.set(task.id, task)
    }
    const tasks = [...work.values()].sort((a, b) => a.id.localeCompare(b.id)), hash = fingerprint(tasks.map(task => task.id))
    if (this.hold?.frozen) {
      this.hold.manifests[hash] = tasks
      runtime.store.set(held, this.hold)
    }
    return { instanceId, operationId: this.hold?.operationId ?? null, held: !!this.hold, frozen: this.frozen,
      busy: tasks.length > 0, fingerprint: hash, tasks,
      queued: { triggers: runtime.store.threads.active().reduce((sum, thread) => sum + thread.pending.length, 0),
        delegations: incoming.filter(row => row.phase === 'queued').length }, blockingReasons: tasks.length ? ['affected_work_active'] : [] }
  }
  confirmed(operationId: string, expected: string, current: readonly CapabilityTask[]): CapabilityTask[] {
    const hold = this.matching(operationId), manifest = hold.manifests[expected]
    if (!hold.frozen || !manifest) throw new Error('Worker capability stop requires a confirmed frozen work snapshot')
    const allowed = new Set(manifest.map(task => task.id))
    if (current.some(task => !allowed.has(task.id))) throw new Error('Affected work changed after confirmation; inspect and confirm the current work')
    return manifest
  }
}
