/** Submission validation and bounded projections, with explicit dependencies and no execution loop. */
import { latestAssignment, ticketStage, type Ticket } from '../core/index.ts'
import { boundedText, commandId, fingerprint, referenceUrls, referenceIdentity, QuerySchema, SubmitSchema, type Command, type Delivery, type Identity, type SubmitResult,
  type SuperagentBackend, type Target, type UserTurn, type WorkLink } from './contracts.ts'
import type { GatewayLedger } from './ledger.ts'

/** Connects one trusted local principal to their Gateway work; model input never supplies identity. */
export class GatewayService {
  constructor(readonly ledger: GatewayLedger, readonly backend: SuperagentBackend, readonly identity: Identity,
    private readonly clock: () => number = Date.now,
    private readonly options: { resumeCompletedCommands?: boolean; canResumeCompleted?: (ticket: Ticket) => boolean } = {}) {}
  private canResume(ticket: Ticket): boolean {
    return this.options.resumeCompletedCommands === true && ticket.ended?.outcome === 'completed' && ticket.ended.by !== 'human'
      && (this.options.canResumeCompleted?.(ticket) ?? true)
  }
  submit(raw: unknown, origin: UserTurn): SubmitResult {
    if (origin.source !== 'user') return { status: 'denied', reason: '后台反馈没有用户交办权限。' }
    const parsed = SubmitSchema.safeParse(raw)
    if (!parsed.success) return { status: 'needs_clarification', reason: '交办参数不完整或超出支持范围。' }
    const input = parsed.data
    if (origin.selectedQuestionId && input.operation !== 'answer') {
      return { status: 'needs_clarification', reason: '当前消息正在回答一个具体问题；如要另行交办或停止任务，请先取消问题关联并明确说明。' }
    }
    if (origin.selectedWorkRef && input.operation === 'new') {
      return { status: 'needs_clarification', reason: '当前消息已关联一个任务；如要新建任务，请先取消任务关联。' }
    }
    if (!origin.userMessageId || !origin.conversationId || !origin.text.includes(input.request.quote)) {
      return { status: 'denied', reason: '要求必须引用当前真实用户消息中的原文。' }
    }
    const id = commandId(this.identity, origin)
    const target = 'targetToken' in input ? this.ledger.getTarget(input.targetToken) : undefined
    if ('targetToken' in input && !target) return { status: 'conflict', reason: '任务引用已失效，请重新查询。' }
    if (target && origin.selectedWorkRef && origin.selectedWorkRef !== target.workRef) {
      return { status: 'needs_clarification', reason: `当前消息已关联任务 ${origin.selectedWorkRef}，请使用该任务的最新引用。` }
    }
    if (target && !origin.selectedWorkRef && !origin.text.includes(target.workRef)) {
      return { status: 'needs_clarification', reason: `请确认任务 ${target.workRef}；搜索结果本身不代表用户选择。` }
    }
    const questionId = input.operation === 'answer' ? input.questionToken : undefined
    if (questionId && origin.selectedQuestionId && origin.selectedQuestionId !== questionId) {
      return { status: 'conflict', reason: '你回复的问题已经改变，不能把旧答案应用到新问题。' }
    }
    if (questionId && !origin.selectedQuestionId && !origin.text.includes(questionId)) {
      return { status: 'needs_clarification', reason: '请从对应问题选择回答，确认答案所对应的问题。' }
    }
    if (questionId && questionId !== target?.attentionId) return { status: 'conflict', reason: '问题已改变，请查看当前问题。' }
    const references = input.operation === 'new' ? input.references : []
    const userReferences = new Set(referenceUrls(origin.text).map(value => referenceIdentity(value)))
    if (references.some(url => !userReferences.has(referenceIdentity(url)))) return { status: 'denied', reason: '资料引用必须来自当前用户消息中的完整链接。' }
    const workRef = target?.workRef ?? `JW-${id.slice(3,15)}`
    // A changed model summary is not a different authorization or a second action slot.
    const hash = fingerprint([this.identity, origin.userMessageId, origin.text, input.operation, input.request.quote,
      target ? [target.workRef,target.ticketId,target.revision,target.decisionId] : null, questionId ?? null, references])
    const old = this.ledger.command(id)
    if (old) return old.command.hash === hash
      ? { status: 'replayed', commandId: id, workRef: old.command.workRef, receivedAt: old.command.receivedAt }
      : { status: 'conflict', reason: '这条用户消息已登记另一项操作，不能在重试中改目标或操作。' }
    if (!this.backend.available()) return { status: 'unavailable', reason: '任务执行入口尚未就绪，未提交。' }
    if (target) {
      const ticket = this.backend.ticket(target.ticketId)
      const resumesCompleted = input.operation === 'append' && !!ticket && this.canResume(ticket)
      if (ticket && ticket.decisionId === target.decisionId && input.operation === 'append' && this.options.resumeCompletedCommands
        && ticket.ended?.outcome === 'completed' && ticket.ended.by !== 'human' && !resumesCompleted) {
        return { status: 'unsupported', reason: '这个已完成的下级任务暂不支持原任务续改；未提交新任务，请先明确新的交办要求。' }
      }
      if (!ticket || ticket.decisionId !== target.decisionId || ((ticket.ended || ticket.cancellation) && input.operation !== 'stop' && !resumesCompleted)) {
        return { status: 'conflict', reason: '任务已结束或授权关联改变，请重新查询。' }
      }
      if (questionId && (ticket.attention?.id !== questionId || ticket.attention?.answeredBy)) return { status: 'conflict', reason: '原问题已不再等待回答。' }
    } else if (references.length && this.backend.related(references).length) {
      return { status: 'unsupported', reason: '该资料已关联到底座现有任务；首期不自动接管或另建重复任务。' }
    }
    const command: Command = { id, hash, triggerId: `jarvis:${id}`, threadId: id, workRef, identity: this.identity,
      origin: structuredClone(origin), operation: input.operation, quote: input.request.quote, summary: input.request.summary,
      references, ...(target ? { target } : {}), ...(questionId ? { questionId } : {}), receivedAt: new Date(this.clock()).toISOString() }
    const result = this.ledger.enqueue(command)
    return result === 'conflict' ? { status: 'conflict', reason: '任务关联在提交时已改变。' }
      : { status: result, commandId: id, workRef, receivedAt: command.receivedAt }
  }
  query(raw: unknown) {
    const input = QuerySchema.parse(raw)
    if (input.operation === 'get') {
      const work = this.ledger.work(input.workRef)
      return work ? this.project(work, true) : { status: 'not_found' }
    }
    const items = this.ledger.works(input.query, input.cursor, input.limit + 1)
    return { items: items.slice(0,input.limit).map(work => this.project(work, false)),
      nextCursor: items.length > input.limit ? input.cursor + input.limit : null }
  }
  /** Call only after DSH inspection proves this reserved attempt has not been admitted. */
  reviewDelivery(delivery: Delivery): boolean {
    if (!this.backend.available()) return false
    // Missing authority is not evidence that a question is current; retain the batch for recovery.
    if (delivery.events.some(event => event.kind === 'question' && !this.backend.ticket(this.ledger.work(event.workRef)?.ticketId ?? ''))) return false
    const obsolete = delivery.events.filter(event => {
      if (event.kind !== 'question') return false
      const work = this.ledger.work(event.workRef)
      const ticket = work?.ticketId ? this.backend.ticket(work.ticketId) : undefined
      return !!ticket && (ticket.ended || !ticket.attention || ticket.attention.id !== event.attentionId || ticket.attention.answeredBy)
    }).map(event => event.id)
    if (obsolete.length) { this.ledger.supersede(delivery.batchId,obsolete); return false }
    return true
  }
  private project(work: WorkLink, detail: boolean) {
    const record = this.ledger.command(work.commandId)
    const ticket = work.ticketId && this.backend.available() ? this.backend.ticket(work.ticketId) : undefined
    const head = { workRef: work.workRef, title: work.title, ...(record ? { receivedAt: record.command.receivedAt } : {}) }
    if (!ticket) {
      const reason = record?.consumption?.reason ?? record?.error
      return { ...head, status: work.ticketId ? 'unavailable' : record?.consumption?.outcome ?? (record?.transport === 'rejected' ? 'rejected' : 'queued'),
        ...(reason === undefined ? {} : { reason }), canSubmit: false }
    }
    const target: Target = { token: `jt_${fingerprint([this.identity,work.workRef,work.revision,ticket.id,ticket.decisionId,ticket.attention?.id,!!ticket.ended])}`,
      workRef: work.workRef, ticketId: ticket.id, revision: work.revision, decisionId: ticket.decisionId,
      ended: !!ticket.ended, ...(ticket.attention ? { attentionId: ticket.attention.id } : {}) }
    this.ledger.target(target)
    const assignment = latestAssignment(ticket)
    // DSH validates the returned value before JSON rendering; absent fields must not contain undefined.
    return { ...head, status: ticket.ended?.outcome ?? (ticket.cancellation ? 'cancelling' : ticketStage(ticket)), updatedAt: ticket.updatedAt, canSubmit: !ticket.ended && !ticket.cancellation,
      ...(this.canResume(ticket) ? { canSubmit:true } : {}),
      targetToken: target.token, ...(!ticket.ended && ticket.attention && !ticket.attention.answeredBy
        ? { question: { id: ticket.attention.id, text: boundedText(ticket.attention.question) } } : {}),
      ...(assignment?.report ? { result: { state: assignment.report.state, summary: boundedText(assignment.report.summary, detail ? 4000 : 240),
        ref: `ticket/${ticket.id}/report/${assignment.id}` } } : {}),
      ...(detail ? { originalRequest: boundedText(record?.command.quote ?? '',4000), references: record?.command.references ?? [] } : {}) }
  }
}
