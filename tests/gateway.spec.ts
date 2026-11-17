import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, reportReference, type ConsumptionReceipt, type EngineOptions, type Ticket } from '../src/core/index.ts'
import { GatewayLedger } from '../src/jarvis-gateway/ledger.ts'
import { GatewayService } from '../src/jarvis-gateway/service.ts'
import { GatewayPump, snapshotEvents } from '../src/jarvis-gateway/pump.ts'
import { jarvisKind, SourceBackend, triggerFor } from '../src/jarvis-gateway/source.ts'
import { commandId, GatewayFault, type Command, type GatewayEvent, type SuperagentBackend, type UserTurn } from '../src/jarvis-gateway/contracts.ts'

const identity = { deploymentId: 'test-deployment', principalId: 'owner' }
const disposers: (() => void)[] = []
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(),'jarvis-gateway-'))
  disposers.push(() => rmSync(directory,{recursive:true,force:true}))
  const path = join(directory,'gateway.sqlite')
  let ledger = new GatewayLedger(path,identity)
  disposers.push(() => ledger.close())
  const repo = new MemoryRepositories()
  let allowed = true
  const options: EngineOptions = { repo, scope: { scope: () => ({listened:true,observed:false}) }, policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60000,
    gate: () => allowed ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible:false,reason:'revoked' },
    revalidate: () => true, admitsInferred: () => false }),
    assessor: { request: vi.fn(),release: vi.fn() }, executor: { start: vi.fn(),stop: vi.fn(),deliver: vi.fn() },
    outbox: { send: vi.fn(),status: () => undefined,withdraw: vi.fn() } }
  const engine = new Engine(options)
  let now = Date.parse('2026-11-13T00:00:00Z'), online = true, crashAfterReceive = false
  const submit = vi.fn(async (command: Command) => {
    engine.receive(triggerFor(command))
    if (crashAfterReceive) { crashAfterReceive = false; throw new Error('connection lost after durable receive') }
  })
  const backend: SuperagentBackend = { available: () => online, submit, ticket: id => repo.tickets.get(id), related: () => [],
    receipt: id => {
      const receipt = engine.commandReceipt(id)
      return receipt ? { state: receipt.consumption ? 'terminal' : 'pending',consumption: receipt.consumption } : { state: 'missing' }
    } }
  const service = () => new GatewayService(ledger,backend,identity,() => now)
  const pump = () => new GatewayPump(ledger,backend,() => now)
  const origin = (id = 'm1',text = '请修复登录问题'): UserTurn => ({ source:'user',userMessageId:id,conversationId:'conversation-1',text,at:new Date(now).toISOString() })
  const enqueue = (id = 'm1') => service().submit({operation:'new',request:{quote:'请修复登录问题',summary:'登录修复'}},origin(id))
  const accept = (id: string) => engine.decide(id,{kind:'accept',title:'登录修复',scope:'修复登录',reason:'requested'})
  return { get ledger() { return ledger },service,pump,repo,engine,origin,enqueue,accept,submit,backend,outbox:options.outbox,
    advance: () => { now += 60000 }, offline: () => { online = false }, crash: () => { crashAfterReceive = true },
    setAllowed: (value: boolean) => { allowed = value },
    reopen: () => { ledger.close(); ledger = new GatewayLedger(path,identity) } }
}

describe('Gateway commands and durable transport', () => {
  it('refuses a completed task when its executor cannot safely continue the original work', async () => {
    const h = fixture(), receipt = h.enqueue()
    if (!('commandId' in receipt)) throw new Error('receipt missing')
    await h.pump().tick()
    const ticketId = h.accept(h.ledger.command(receipt.commandId)!.command.triggerId).ticketId!
    h.engine.assignmentStarted(ticketId, h.repo.tickets.get(ticketId)!.assignments[0]!.id)
    h.engine.report(ticketId, { state:'ready', summary:'Child deliverable complete' })
    h.advance(); await h.pump().tick()
    const service = new GatewayService(h.ledger, h.backend, identity, Date.now, { resumeCompletedCommands:true, canResumeCompleted:() => false })
    const target = service.query({operation:'get',workRef:receipt.workRef}) as { targetToken:string; canSubmit:boolean }
    expect(target.canSubmit).toBe(false)
    const result = service.submit({operation:'append',targetToken:target.targetToken,request:{quote:'再修改颜色',summary:'修改颜色'}},
      {...h.origin('followup','再修改颜色'),selectedWorkRef:receipt.workRef})
    expect(result).toMatchObject({status:'unsupported',reason:expect.stringContaining('暂不支持原任务续改')})
    expect(h.ledger.works()).toHaveLength(1)
    expect(h.ledger.command(commandId(identity,h.origin('followup','再修改颜色')))).toBeUndefined()
  })
  it('persists a receipt before delivery and replays the same user turn even after restart and summary changes', async () => {
    const h = fixture(), result = h.enqueue()
    expect(result.status).toBe('queued')
    expect(h.submit).not.toHaveBeenCalled()
    h.reopen()
    const replay = h.service().submit({ operation:'new',request:{ quote:'请修复登录问题',summary:'换个说法' } },h.origin())
    expect(replay).toEqual({...result,status:'replayed'})
    expect(h.ledger.works()).toHaveLength(1)
    await h.pump().tick()
    expect(h.submit).toHaveBeenCalledOnce()
  })
  it('reconciles a lost response using the original trigger without re-delivering or creating a second task', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    h.crash(); await h.pump().tick()
    const command = h.ledger.command(result.commandId)!.command
    h.accept(command.triggerId)
    h.reopen(); h.advance(); await h.pump().tick()
    expect(h.submit).toHaveBeenCalledOnce()
    expect(h.ledger.command(result.commandId)?.consumption?.outcome).toBe('applied')
    expect(h.ledger.work(result.workRef)?.ticketId).toBe(h.engine.commandReceipt(command.triggerId)?.consumption?.ticketId)
    expect(h.repo.tickets.list()).toHaveLength(1)
  })
  it('rejects background authorization, invented quotes and a second operation in one genuine turn', () => {
    const h = fixture(), input = {operation:'new',request:{quote:'请修复登录问题',summary:'修复'}}
    expect(h.service().submit(input,{...h.origin(),source:'background'}).status).toBe('denied')
    expect(h.service().submit(input,h.origin('m2','你好')).status).toBe('denied')
    h.enqueue()
    expect(h.service().submit({...input,request:{quote:'登录问题',summary:'其他'}},h.origin()).status).toBe('conflict')
  })
  it.each(['queued','running','question','ended','unavailable'] as const)('returns lossless JSON query data for $0 work through get and search', async state => {
    const h = fixture(), receipt = h.enqueue()
    if (!('commandId' in receipt)) throw new Error('receipt missing')
    if (state !== 'queued') {
      await h.pump().tick()
      const ticketId = h.accept(h.ledger.command(receipt.commandId)!.command.triggerId).ticketId!
      h.engine.assignmentStarted(ticketId,h.repo.tickets.get(ticketId)!.assignments[0]!.id)
      h.advance(); await h.pump().tick()
      if (state === 'question') h.engine.report(ticketId,{state:'blocked',summary:'需要范围决定',question:'请选择修改范围'})
      if (state === 'ended') h.engine.stopTicket(ticketId)
      if (state === 'unavailable') h.offline()
    }
    const detail = h.service().query({operation:'get',workRef:receipt.workRef})
    const page = h.service().query({operation:'search',query:''})
    // Native DSH rejects undefined-valued fields before rendering a tool result.
    for (const output of [detail,page,h.service().query({operation:'get',workRef:'JW-missing'})]) {
      expect(output).toStrictEqual(JSON.parse(JSON.stringify(output)))
    }
    expect(detail).toMatchObject({workRef:receipt.workRef})
    expect(page).toMatchObject({items:[{workRef:receipt.workRef}],nextCursor:null})
    if (state === 'running') {
      expect(detail).toMatchObject({canSubmit:true,targetToken:expect.any(String)})
      expect(detail).not.toHaveProperty('question')
      expect(detail).not.toHaveProperty('result')
    }
    if (state === 'question') expect(detail).toMatchObject({question:{id:expect.any(String),text:'请选择修改范围'},result:{state:'blocked'}})
    if (state === 'queued') expect(detail).toMatchObject({status:'queued',canSubmit:false})
    if (state === 'ended') expect(detail).toMatchObject({status:'stopped',canSubmit:false})
    if (state === 'unavailable') expect(detail).toMatchObject({status:'unavailable',canSubmit:false})
  })
  it('requires a real user target reference, rechecks active state, and keeps query bounded and free of execution', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    await h.pump().tick()
    const command = h.ledger.command(result.commandId)!.command
    const accepted = h.accept(command.triggerId)
    h.advance(); await h.pump().tick()
    const target = h.service().query({operation:'get',workRef:result.workRef}) as {targetToken:string}
    const append = {operation:'append',targetToken:target.targetToken,request:{quote:'再检查退出登录',summary:'检查退出'}}
    expect(h.service().submit(append,h.origin('m2','再检查退出登录')).status).toBe('needs_clarification')
    expect(h.service().submit(append,{...h.origin('m2','再检查退出登录'),selectedWorkRef:result.workRef}).status).toBe('queued')
    const current = h.repo.tickets.get(accepted.ticketId!)!
    h.repo.tickets.save({...current,ended:{at:current.updatedAt,by:'human',outcome:'stopped'}})
    expect(h.service().submit(append,{...h.origin('m3','再检查退出登录'),selectedWorkRef:result.workRef}).status).toBe('conflict')
    const calls = h.submit.mock.calls.length
    for (let i=2;i<=100;i++) h.enqueue(`dataset-${i}`)
    const page = h.service().query({operation:'search',query:'',limit:10}) as {items:unknown[];nextCursor:number}
    expect(page.items).toHaveLength(10); expect(page.nextCursor).toBe(10)
    expect(JSON.stringify(page).length).toBeLessThan(15000)
    expect(h.submit).toHaveBeenCalledTimes(calls)
  })
  it.each([
    {outcome:'ignored',reason:'用户要求暂不执行'},
    {outcome:'denied',reason:'commandNotExplicit'},
    {outcome:'unavailable',reason:'评估服务暂不可用'},
    {outcome:'conflict',reason:'targetEnded'},
  ] as const)('keeps one durable $outcome explanation without a Router reply across ledger restarts', async ({outcome,reason}) => {
    const h = fixture(), initial = h.enqueue('initial')
    if (!('commandId' in initial)) throw new Error('receipt missing')
    await h.pump().tick()
    const ticketId = h.accept(h.ledger.command(initial.commandId)!.command.triggerId).ticketId!
    h.advance(); await h.pump().tick()
    const before = h.service().query({operation:'get',workRef:initial.workRef})
    const inputs = h.repo.tickets.get(ticketId)!.inputs
    expect(h.ledger.reserve('conversation-1',1,'session-1')).toBeUndefined()
    const result = h.service().submit({operation:'append',targetToken:'targetToken' in before ? before.targetToken : '',
      request:{quote:'补充退出登录测试',summary:'补充测试'}}, {...h.origin('append','补充退出登录测试'),selectedWorkRef:initial.workRef})
    if (!('commandId' in result)) throw new Error('append receipt missing')
    await h.pump().tick()
    expect(h.ledger.command(result.commandId)?.transport).toBe('recorded')
    const command = h.ledger.command(result.commandId)!.command
    if (outcome === 'denied') {
      h.setAllowed(false)
      expect(() => h.engine.attach(ticketId,command.triggerId)).toThrow()
    } else if (outcome === 'conflict') {
      h.engine.stopTicket(ticketId,'用户已经停止此任务')
      expect(() => h.engine.attach(ticketId,command.triggerId)).toThrow()
    } else {
      h.engine.evaluateDue()
      const candidate = h.engine.candidate(command.triggerId)
      expect(candidate).toBeDefined()
      expect(h.engine.decide(command.triggerId,{kind:outcome === 'ignored' ? 'ignore' : 'unavailable',reason,evalId:candidate!.evalId}))
        .toMatchObject({kind:outcome === 'ignored' ? 'ignore' : 'unavailable'})
    }
    const terminal = h.engine.commandReceipt(command.triggerId)!.consumption!
    expect(terminal).toMatchObject({commandId:command.id,payloadHash:command.hash,outcome,reason,outcomeRevision:1})
    if (outcome === 'ignored' || outcome === 'unavailable') {
      expect(terminal.decisionId).toEqual(expect.any(String))
      expect(terminal.ticketId).toBeUndefined()
    } else {
      expect(terminal.decisionId).toBeUndefined()
      expect(terminal.ticketId).toBe(ticketId)
    }
    expect(h.ledger.command(result.commandId)?.consumption).toBeUndefined()
    h.reopen(); h.advance(); await h.pump().tick()
    expect(h.ledger.command(result.commandId)).toMatchObject({transport:'recorded',consumption:terminal})
    expect(h.ledger.command(result.commandId)?.error).toBeUndefined()
    const delivery = h.ledger.reserve('conversation-1',1,'session-1')!
    expect(delivery.events).toHaveLength(1)
    expect(delivery.events[0]).toMatchObject({id:`command:${command.id}:1`,workRef:initial.workRef,kind:'failure',actionable:true})
    expect(delivery.events[0]?.text).toContain(outcome)
    expect(delivery.events[0]?.text).toContain(reason)
    h.reopen(); h.advance(); await h.pump().tick()
    expect(h.ledger.reserve('conversation-1',1,'session-1')).toEqual(delivery)
    h.ledger.saveDelivery({...delivery,state:'projected'})
    h.reopen(); h.advance(); await h.pump().tick()
    expect(h.ledger.reserve('conversation-1',1,'session-1')).toBeUndefined()
    expect(h.ledger.pendingCount('conversation-1')).toBe(0)
    expect(h.ledger.deliveries('conversation-1')).toEqual([{...delivery,state:'projected'}])
    expect(h.ledger.eventPage('conversation-1',0,50).items.filter(event => event.kind === 'failure')).toHaveLength(1)
    expect(h.service().query({operation:'get',workRef:initial.workRef})).toMatchObject({status:outcome === 'conflict' ? 'stopped' : before.status})
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual(inputs)
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.submit).toHaveBeenCalledTimes(2)
    expect(h.outbox.send).not.toHaveBeenCalled()
  })
  it('keeps continuous progress snapshots quiet and batches deduplicated questions and results by their actual identities', async () => {
    const h = fixture(), tasks: {workRef:string;ticketId:string;command:Command}[] = []
    for (let index=0;index<12;index++) {
      const receipt = h.enqueue(`feedback-${index}`)
      if (!('commandId' in receipt)) throw new Error('receipt missing')
      await h.pump().tick()
      const command = h.ledger.command(receipt.commandId)!.command
      const ticketId = h.accept(command.triggerId).ticketId!
      h.engine.assignmentStarted(ticketId,h.repo.tickets.get(ticketId)!.assignments[0]!.id)
      h.advance(); await h.pump().tick()
      tasks.push({workRef:receipt.workRef,ticketId,command})
    }
    for (let round=0;round<25;round++) {
      for (const task of tasks) h.engine.report(task.ticketId,{state:'progress',summary:`常规检查进度 ${round+1}/25`})
      await h.pump().tick()
      expect(h.ledger.pendingCount('conversation-1')).toBe(0)
      expect(h.ledger.reserve('conversation-1',1,'session-1')).toBeUndefined()
    }
    h.reopen()
    expect(h.ledger.deliveries('conversation-1')).toEqual([])
    for (const task of tasks) expect(h.service().query({operation:'get',workRef:task.workRef}))
      .toMatchObject({result:{state:'progress',summary:'常规检查进度 25/25'}})
    const expected: {workRef:string;kind:'question'|'failure'|'result';attentionId?:string;reportRef?:string}[] = []
    for (const [index,task] of tasks.entries()) {
      const ticket = h.engine.report(task.ticketId,index<6
        ? {state:'blocked',summary:`等待决定 ${index}`,question:`请选择方案 ${index}`}
        : {state:'ready',summary:`已验证结果 ${index}`})
      const ref = reportReference(ticket.assignments.at(-1)!)!
      if (index<6) expected.push({workRef:task.workRef,kind:'question',attentionId:ticket.attention!.id})
      expected.push({workRef:task.workRef,kind:index<6?'failure':'result',reportRef:ref})
    }
    // Repeated bounded snapshot pages must not turn one saved report into repeated notifications.
    for (let repeat=0;repeat<20;repeat++) await h.pump().tick()
    const kind = jarvisKind(h.ledger,identity)
    for (const [index,task] of tasks.entries()) {
      const ticket = h.repo.tickets.get(task.ticketId)!, ref = reportReference(ticket.assignments.at(-1)!)!
      const message = {id:`feedback-outbox-${index}`,channel:triggerFor(task.command).channel!,ticketId:task.ticketId,
        kind:'reply' as const,text:index<6 ? ticket.attention!.question : ticket.assignments.at(-1)!.report!.summary,
        context:index<6 ? {purpose:'attention' as const,attentionId:ticket.attention!.id}
          : {purpose:'result' as const,reportRef:ref}}
      await kind.channel!.send({} as never,message)
      await kind.channel!.send({} as never,message)
    }
    h.reopen()
    expect(h.ledger.pendingCount('conversation-1')).toBe(18)
    const batches = []
    while (h.ledger.pendingCount('conversation-1')) {
      const batch = h.ledger.reserve('conversation-1',1,'session-1')!
      expect(batch.events.length).toBeLessThanOrEqual(10)
      expect(h.service().reviewDelivery(batch)).toBe(true)
      batches.push(batch)
      h.ledger.saveDelivery({...batch,state:'projected'})
    }
    expect(batches.map(batch => batch.events.length)).toEqual([10,8])
    const events = batches.flatMap(batch => batch.events)
    expect(events.map(({workRef,kind,attentionId,reportRef}) => ({workRef,kind,...attentionId?{attentionId}:{},...reportRef?{reportRef}:{}})))
      .toEqual(expect.arrayContaining(expected))
    expect(events).toHaveLength(expected.length)
    expect(new Set(events.map(event => event.id)).size).toBe(18)
    for (let repeat=0;repeat<5;repeat++) await h.pump().tick()
    h.reopen()
    expect(h.ledger.reserve('conversation-1',1,'session-1')).toBeUndefined()
    expect(h.ledger.deliveries('conversation-1')).toHaveLength(2)
    expect(h.outbox.send).not.toHaveBeenCalled()
  })
  it('keeps the actual user-selected work fixed even when the text mentions another work', async () => {
    const h = fixture(), first = h.enqueue('first'), second = h.enqueue('second')
    if (!('commandId' in first) || !('commandId' in second)) throw new Error('receipt missing')
    await h.pump().tick()
    h.accept(h.ledger.command(first.commandId)!.command.triggerId)
    h.accept(h.ledger.command(second.commandId)!.command.triggerId)
    h.advance(); await h.pump().tick()
    const target = h.service().query({operation:'get',workRef:second.workRef}) as {targetToken:string}
    const origin = {...h.origin('selected-work',`参考 ${second.workRef} 的方式，补充测试`),selectedWorkRef:first.workRef}
    const request = {quote:'补充测试',summary:'补充测试'}
    expect(h.service().submit({operation:'new',request},origin).status).toBe('needs_clarification')
    expect(h.service().submit({operation:'append',targetToken:target.targetToken,request},origin).status).toBe('needs_clarification')
    expect(h.ledger.command(commandId(identity,origin))).toBeUndefined()
    expect(h.ledger.works()).toHaveLength(2)
  })
  it('merges snapshot and Outbox questions, rejects conflicting producer payloads and preserves immutable batches', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    await h.pump().tick()
    const command = h.ledger.command(result.commandId)!.command
    const decision = h.accept(command.triggerId)
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    ticket.attention = {id:'question-1',question:'请选择方案'}; h.repo.tickets.save(ticket)
    h.advance(); await h.pump().tick()
    const kind = jarvisKind(h.ledger,identity)
    const message = {id:'reply-1',channel:triggerFor(command).channel!,ticketId:ticket.id,text:'请选择方案',kind:'reply' as const,
      context:{purpose:'attention' as const,attentionId:'question-1'}}
    await kind.channel!.send({} as never,message)
    await expect(kind.channel!.send({} as never,{...message,text:'changed'})).rejects.toThrow(/immutable/)
    const delivery = h.ledger.reserve('conversation-1',1,'session-1')!
    expect(delivery.events).toHaveLength(1)
    expect(() => h.ledger.saveDelivery({...delivery,generation:2})).toThrow(/immutable/)
    ticket.updatedAt = '2026-11-14T00:00:00Z'; h.repo.tickets.save(ticket)
    h.advance(); await expect(h.pump().tick()).resolves.toBeUndefined()
  })
  it('waits for the authoritative Ticket binding before accepting early Outbox feedback', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    await h.pump().tick()
    const command = h.ledger.command(result.commandId)!.command
    const decision = h.accept(command.triggerId)
    const kind = jarvisKind(h.ledger,identity)
    const message = {id:'early',channel:triggerFor(command).channel!,ticketId:decision.ticketId!,text:'接收回执',kind:'acknowledgement' as const}
    await expect(kind.channel!.send({} as never,message)).rejects.toThrow(/binding/)
    h.advance(); await h.pump().tick()
    await expect(kind.channel!.send({} as never,message)).resolves.toBe('sent')
    await expect(kind.channel!.send({} as never,{...message,id:'wrong',ticketId:'other-ticket'})).rejects.toThrow(/original work/)
    expect(h.ledger.reserve('conversation-1',1,'session-1')).toBeUndefined()
  })
  it('retains the entire original user message for review alongside the narrower quoted request', async () => {
    const h = fixture(), text = '请修复登录问题；不要更换认证框架，完成后给我测试结果。'
    const result = h.service().submit({operation:'new',request:{quote:'请修复登录问题',summary:'登录修复'}},h.origin('scoped',text))
    if (!('commandId' in result)) throw new Error('receipt missing')
    const command = h.ledger.command(result.commandId)!.command
    const context = await jarvisKind(h.ledger,identity).threadContext!.read({} as never,triggerFor(command),'root',undefined,identity)
    expect(context.messages[0]?.text).toBe(text)
    expect(context.body).toMatchObject({request:'请修复登录问题',originalMessage:text})
  })
  it('does not report acceptance when the backend is unavailable', () => {
    const h = fixture(); h.offline()
    expect(h.enqueue().status).toBe('unavailable')
    expect(h.ledger.works()).toEqual([])
  })
  it('matches external task references by complete URL rather than issue-number prefixes', () => {
    const context = { tickets:{open:()=>[{id:'issue-10',title:'External',origin:{triggerId:'trigger-10'}}]},
      triggers:{get:()=>({source:'github',text:'See https://github.com/example/repo/issues/10',url:'https://github.com/example/repo/issues/10'})} }
    const backend = new SourceBackend(context as never,identity)
    expect(backend.related(['https://github.com/example/repo/issues/1'])).toEqual([])
    expect(backend.related(['https://github.com/example/repo/issues/10#issuecomment-123'])).toEqual([{ticketId:'issue-10',title:'External'}])
  })
  it('requires the complete user URL and rejects prefix, fragment and query substitutions', () => {
    const h = fixture(), url = 'https://github.com/example/repo/issues/10#issuecomment-123'
    const origin = h.origin('reference','请处理 [问题](' + url + ')。保留测试。')
    const submit = (reference: string) => h.service().submit({operation:'new',request:{quote:'请处理',summary:'处理问题'},references:[reference]},origin)
    for (const wrong of ['https://github.com/example/repo/issues/1',url.replace('123','12'),url + '?other=1']) {
      expect(submit(wrong).status).toBe('denied')
    }
    expect(h.ledger.works()).toHaveLength(0)
    expect(submit(url).status).toBe('queued')
    expect(h.ledger.works()).toHaveLength(1)
  })
  it('does not apply the trusted reply to question Q1 to a replacement Q2 or an already answered question', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    await h.pump().tick()
    const ticketId = h.accept(h.ledger.command(result.commandId)!.command.triggerId).ticketId!
    h.advance(); await h.pump().tick()
    const ticket = h.repo.tickets.get(ticketId)!
    ticket.attention = { id:'Q2',question:'新的问题' }; h.repo.tickets.save(ticket)
    const target = h.service().query({operation:'get',workRef:result.workRef}) as {targetToken:string}
    const answer = {operation:'answer',targetToken:target.targetToken,questionToken:'Q2',request:{quote:'同意',summary:'同意方案'}}
    const origin = {...h.origin('answer','同意'),selectedWorkRef:result.workRef,selectedQuestionId:'Q1'}
    expect(h.service().submit(answer,origin).status).toBe('conflict')
    for (const operation of ['append','stop']) {
      expect(h.service().submit({operation,targetToken:target.targetToken,request:answer.request},origin).status).toBe('needs_clarification')
    }
    expect(h.service().submit({operation:'new',request:answer.request},origin).status).toBe('needs_clarification')
    expect(h.service().submit(answer,{...origin,selectedQuestionId:undefined}).status).toBe('needs_clarification')
    ticket.attention.answeredBy = {commandId:'other',triggerId:'other-trigger',at:ticket.updatedAt}; h.repo.tickets.save(ticket)
    expect(h.service().submit(answer,{...origin,selectedQuestionId:'Q2'}).status).toBe('conflict')
    expect(h.service().query({operation:'get',workRef:result.workRef})).not.toHaveProperty('question',expect.anything())
    expect(snapshotEvents(h.ledger.work(result.workRef)!,ticket).filter(event => event.kind === 'question')).toEqual([])
    expect(h.ledger.works()).toHaveLength(1)
  })
  it('records permanent ingress refusal once and never retries it after restart', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    h.submit.mockImplementation(async () => { throw new GatewayFault('conflict','入口关联冲突') })
    await h.pump().tick(); h.reopen(); h.advance(); await h.pump().tick()
    expect(h.submit).toHaveBeenCalledOnce()
    expect(h.ledger.command(result.commandId)).toMatchObject({transport:'rejected',error:'入口关联冲突'})
    expect(h.ledger.command(result.commandId)?.consumption).toBeUndefined()
    expect(h.service().query({operation:'get',workRef:result.workRef})).toMatchObject({status:'rejected'})
    const batch = h.ledger.reserve('conversation-1',1,'session-1')!
    expect(batch.events).toHaveLength(1)
    expect(batch.events[0]).toMatchObject({kind:'failure',actionable:true})
  })
  it('refuses a work reference collision without rebinding or partially saving the second command', () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    const original = h.ledger.command(result.commandId)!.command
    const second = {...original,id:'jc_other',triggerId:'jarvis:jc_other',threadId:'jc_other',hash:'other-hash'}
    expect(h.ledger.enqueue(second)).toBe('conflict')
    expect(h.ledger.command(second.id)).toBeUndefined()
    expect(h.ledger.work(result.workRef)?.commandId).toBe(original.id)
  })
  it('reconciles a terminal receipt before treating an ambiguous permanent ingress response as rejection', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    h.submit.mockImplementation(async command => {
      h.engine.receive(triggerFor(command))
      h.engine.decide(command.triggerId,{kind:'ignore',reason:'已撤回'})
      throw new GatewayFault('conflict','response lost')
    })
    await h.pump().tick()
    expect(h.ledger.command(result.commandId)?.consumption?.outcome).toBe('ignored')
    expect(h.ledger.command(result.commandId)?.transport).toBe('recorded')
    expect(h.ledger.reserve('conversation-1',1,'session-1')?.events).toEqual([expect.objectContaining({kind:'failure',text:expect.stringContaining('已撤回')})])
  })
  it('retires an obsolete never-admitted question without dropping a result in the same immutable batch', async () => {
    const h = fixture(), result = h.enqueue()
    if (!('commandId' in result)) throw new Error('receipt missing')
    await h.pump().tick()
    const ticketId = h.accept(h.ledger.command(result.commandId)!.command.triggerId).ticketId!
    const ticket = h.repo.tickets.get(ticketId)!
    ticket.attention = {id:'Q1',question:'旧问题'}; h.repo.tickets.save(ticket)
    h.advance(); await h.pump().tick()
    const ready: GatewayEvent = { id:'result-1',semanticKey:'result-1',workRef:result.workRef,conversationId:'conversation-1',
      kind:'result',text:'可审查结果',at:ticket.updatedAt,actionable:true }
    h.ledger.receiveEvent('report-1','report-1',ready)
    const first = {...h.ledger.reserve('conversation-1',1,'session-1')!,failureAttempts:1,lastFailure:'前次表达失败'}
    h.ledger.saveDelivery(first)
    expect(first.events).toHaveLength(2)
    ticket.attention = {id:'Q2',question:'当前问题'}; h.repo.tickets.save(ticket)
    expect(h.service().reviewDelivery(first)).toBe(false)
    expect(h.ledger.deliveries('conversation-1')[0]).toMatchObject({batchId:first.batchId,events:first.events,state:'parked'})
    expect(h.ledger.deliveries('conversation-1')[0]).not.toHaveProperty('lastFailure')
    h.advance(); await h.pump().tick()
    const second = h.ledger.reserve('conversation-1',1,'session-1')!
    expect(second.events.map(event => event.id)).toContain('result-1')
    expect(second.events.filter(event => event.kind === 'question').map(event => event.attentionId)).toEqual(['Q2'])
    expect(h.service().reviewDelivery(second)).toBe(true)
    h.ledger.saveDelivery({...second,state:'admitted'})
    expect(() => h.ledger.supersede(second.batchId,second.events.map(event => event.id))).toThrow(/admitted/)
  })
  it('clears only projected history and transfers parked unexpressed events once across generations', () => {
    const h = fixture()
    const event = (id:string):GatewayEvent => ({id,semanticKey:id,workRef:'JW-1',conversationId:'conversation-1',kind:'result',text:id,at:'2026-11-13',actionable:true})
    h.ledger.receiveEvent('p1','p1',event('already-shown'))
    const first = h.ledger.reserve('conversation-1',1,'session-1')!
    h.ledger.saveDelivery({...first,state:'projected'})
    h.ledger.receiveEvent('p2','p2',event('pending'))
    const second = h.ledger.reserve('conversation-1',1,'session-1')!
    expect(() => h.ledger.transfer('conversation-1',1,{generation:2,sessionId:'session-2'},'switch-1')).toThrow(/unreconciled/)
    h.ledger.saveDelivery({...second,state:'parked'})
    h.ledger.transfer('conversation-1',1,{generation:2,sessionId:'session-2'},'switch-1')
    h.reopen()
    h.ledger.transfer('conversation-1',1,{generation:2,sessionId:'session-2'},'switch-1')
    expect(() => h.ledger.transfer('conversation-1',1,{generation:2,sessionId:'other'},'switch-1')).toThrow(/conflict/)
    const third = h.ledger.reserve('conversation-1',2,'session-2')!
    expect(third.events.map(item => item.id)).toEqual(['pending'])
    expect(third).toMatchObject({generation:2,sessionId:'session-2'})
    h.ledger.saveDelivery({...third,state:'projected'})
    expect(h.ledger.reserve('conversation-1',2,'session-2')).toBeUndefined()
    expect(h.ledger.pendingCount('conversation-1')).toBe(0)
    const page = h.ledger.eventPage('conversation-1',0,1)
    expect(page.items.map(item => item.id)).toEqual(['already-shown'])
    expect(h.ledger.eventPage('conversation-1',page.nextCursor,1).items.map(item => item.id)).toEqual(['pending'])
  })
})
