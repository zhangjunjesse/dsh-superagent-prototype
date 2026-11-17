import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessRuntime, defaultEngineConfig, Store, type ProcessRuntime, type ProcessRun } from '../src/process-runtime/runtime.ts'
import { TaskFiles } from '../src/process-runtime/task-files.ts'
import { defaultPrompts } from '../src/app/prompts.ts'
import { controlledNative, type NativeTurn } from './fixtures/native-ports.ts'

const runtimes: ProcessRuntime[] = []
afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())) })
function paths() {
  const root = mkdtempSync(join(tmpdir(), 'superjarvis-engine-')), stateDir = join(root, 'state'), workspace = join(root, 'workspace')
  mkdirSync(stateDir); mkdirSync(workspace)
  return { root, stateDir, workspace }
}

async function route(turn: NativeTurn) {
  if (!turn.text.startsWith('{')) return
  const card = JSON.parse(turn.text)
  if (card.kind !== 'candidate') return
  const decision = card.dispatch?.operation === 'append'
    ? { kind: 'attach', trigger_id: card.trigger_id, ticket_id: card.dispatch.target_ticket_id }
    : { kind: 'accept', trigger_id: card.trigger_id, title: 'Local game', worktree_name: 'local-game', acknowledgement: 'Creating the local game.' }
  const result = await turn.tool('orchestrator_route', { decisions: [decision] }) as { results: object[] }
  expect(result.results[0]).not.toHaveProperty('refused')
}

describe('organization task engine settings', () => {
  it('archives previous role guidance and uses saved original prompts to create verified local deliverables without GitHub', async () => {
    const directories = paths(), engine = defaultEngineConfig(), calls: NativeTurn[] = []
    engine.prompts.router = 'Custom routing rule 73'; engine.prompts.worker = 'Custom worker rule 41'
    engine.prompts.communication = 'Shared communication 19'
    let runtime: ProcessRuntime
    const call = (request: ProcessRun, name: string, args: unknown) => runtime.tool({ sessionKey: request.sessionKey, role: request.role, requestId: request.requestId, name, args })
    const native = controlledNative(async turn => {
      calls.push(turn)
      if (turn.policy.role === 'orchestrator') return route(turn)
      expect(turn.policy.cwd).not.toBe(directories.workspace)
      writeFileSync(join(turn.policy.cwd, 'index.html'), '<!doctype html><button>play</button>')
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'Local game created', artifacts: [{ path: 'index.html', title: '小游戏' }] })
    })
    runtime = createProcessRuntime({ instanceId:'root', organizationName:'Local studio', brainName:'Jarvis', stateDir:directories.stateDir, workspace:directories.workspace,
      model:{ provider:'fixture', model:'local' }, workerTools:['read', 'write'], maxWorkers:1, engine,
    }, {
      async run(request) {
        if (request.role === 'jarvis') await call(request, 'jarvis_work_submit', { operation:'new', request:{ quote:request.text, summary:'Create local HTML' } })
        return { status:'complete', text:'Done' }
      }, cancel:async () => {},
    }, { native: native.native }); runtimes.push(runtime)
    await runtime.ready
    expect((await runtime.management({ method: 'GET', path: 'configuration-migrations' })).body).toMatchObject({ items: [{ status: 'pending', legacyEngine: engine }] })
    expect((await runtime.management({ method: 'PUT', path: 'prompts', body: { baseRevision: 0, config: {
      ...defaultPrompts(), communication: 'Original shared communication 19', overrides: {
        'runtime/orchestrator': { text: 'Original routing rule 73' }, 'runtime/worker': { text: 'Original worker rule 41' },
      },
    } } })).status).toBe(200)
    await runtime.chat({ id:'local-game', text:'帮我用 html 做一个简单的小游戏' })
    await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout:5000 })
    expect(calls.find(call => call.policy.role === 'orchestrator')?.policy.prompt).toContain('Original routing rule 73')
    expect(calls.find(call => call.policy.role === 'worker')?.policy.prompt).toContain('Original worker rule 41')
    expect(calls.every(call => call.policy.prompt.includes('Original shared communication 19') && call.policy.promptRevision === 1)).toBe(true)
    expect(calls.every(call => !call.policy.prompt.includes('Custom routing rule 73') && !call.policy.prompt.includes('Custom worker rule 41'))).toBe(true)
    const ticket = (await runtime.state()).tickets[0]!
    expect(ticket.assignments.at(-1)?.report?.summary).toContain(`/jarvis/api/system/root/artifacts/${ticket.id}/index.html`)
    expect(readFileSync(join(calls.find(call => call.policy.role === 'worker')!.policy.cwd, 'index.html'), 'utf8')).toContain('play')
    expect(native.errors).toEqual([])
  })

  it('keeps task directory identity after restart and rejects files outside that task', () => {
    const { stateDir, workspace } = paths(), first = new TaskFiles(stateDir, workspace)
    const a = first.directory('ticket-a'), b = first.directory('ticket-b')
    expect(a).not.toBe(b)
    writeFileSync(join(a, 'index.html'), 'a'); writeFileSync(join(b, 'other.html'), 'b')
    expect(first.register('ticket-a', [{ path:'index.html' }])).toEqual([{ path:'index.html' }])
    expect(() => first.register('ticket-a', [{ path:join(b, 'other.html') }])).toThrow('relative')
    expect(() => first.register('ticket-a', [{ path:'../../missing.html' }])).toThrow()
    expect(() => first.register('ticket-a', [{ path:'absent.html' }])).toThrow()
    expect(new TaskFiles(stateDir, workspace).directory('ticket-a')).toBe(a)
    expect(new TaskFiles(stateDir, workspace).directory('ticket-b')).toBe(b)
  })

  it('continues a completed local deliverable in its original task directory on an explicit selected follow-up', async () => {
    const directories = paths(), workspaces: string[] = []
    let runtime: ProcessRuntime
    const native = controlledNative(async turn => {
      if (turn.policy.role === 'orchestrator') return route(turn)
      if (!turn.text.startsWith('{') || !JSON.parse(turn.text).ticket_id) return
      workspaces.push(turn.policy.cwd)
      if (workspaces.length > 1) expect(readFileSync(join(turn.policy.cwd, 'index.html'), 'utf8')).toBe(`version ${workspaces.length - 1}`)
      writeFileSync(join(turn.policy.cwd, 'index.html'), `version ${workspaces.length}`)
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'Updated local game', artifacts: [{ path: 'index.html' }] })
    })
    const create = () => createProcessRuntime({ instanceId:'root', organizationName:'Local studio', brainName:'Jarvis', stateDir:directories.stateDir,
      workspace:directories.workspace, model:{ provider:'fixture', model:'local' }, workerTools:['read', 'write'], maxWorkers:1 }, {
      async run() { return { status:'complete', text:'Done' } }, cancel:async () => {},
    }, { native: native.native }); runtime=create(); runtimes.push(runtime)
    const origin = (id:string, text:string, selectedWorkRef?:string) => ({ conversationId:'local-conversation', userMessageId:id, text,
      at:new Date().toISOString(), source:'user', ...(selectedWorkRef ? { selectedWorkRef } : {}) })
    const first = await runtime.gatewayRequest({ operation:'submit', input:{ operation:'new', request:{ quote:'Make a local game', summary:'Local game' } },
      origin:origin('first', 'Make a local game') }) as { workRef:string; status:string }
    expect(first.status).toBe('queued')
    await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout:5000 })
    let view!: { canSubmit:boolean; targetToken:string }
    await vi.waitFor(async () => {
      view = await runtime.gatewayRequest({ operation:'query', input:{ operation:'get', workRef:first.workRef } }) as typeof view
      expect(view.canSubmit).toBe(true)
    }, { timeout: 4000, interval: 25 })
    const followup = await runtime.gatewayRequest({ operation:'submit', input:{ operation:'append', targetToken:view.targetToken,
      request:{ quote:'Change the game color', summary:'Change color' } }, origin:origin('followup', 'Change the game color', first.workRef) })
    expect(followup).toMatchObject({ status:'queued', workRef:first.workRef })
    await vi.waitFor(async () => {
      const state = await runtime.state()
      expect(workspaces).toHaveLength(2)
      expect(state.tickets).toHaveLength(1)
      expect(state.tickets[0]?.assignments).toHaveLength(2)
      expect(state.tickets[0]?.ended?.outcome).toBe('completed')
    }, { timeout:5000 })
    expect(workspaces[1]).toBe(workspaces[0])
    expect(readFileSync(join(workspaces[0]!, 'index.html'), 'utf8')).toBe('version 2')
    const ticketId = (await runtime.state()).tickets[0]!.id
    // Historical original Core metadata is authoritative even when an old task used the organization root.
    // A missing artifact index alone must never relocate a task.
    await runtime.close()
    unlinkSync(join(directories.stateDir,'task-files.json'))
    writeFileSync(join(directories.workspace,'index.html'),'version 2')
    const store = new Store(join(directories.stateDir, 'orchestrator.sqlite')), historicalTicket = store.tickets.get(ticketId)!
    store.tickets.save({ ...historicalTicket, execution: { ...historicalTicket.execution!, directory: realpathSync.native(directories.workspace) } })
    store.close()
    runtime=create();runtimes.push(runtime)
    const historical = await runtime.gatewayRequest({operation:'query',input:{operation:'get',workRef:first.workRef}}) as {targetToken:string}
    expect(await runtime.gatewayRequest({operation:'submit',input:{operation:'append',targetToken:historical.targetToken,
      request:{quote:'Update the existing game',summary:'Update game'}},origin:origin('after-upgrade','Update the existing game',first.workRef)})).toMatchObject({status:'queued'})
    await vi.waitFor(async()=>{
      expect(workspaces).toHaveLength(3)
      expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed')
    },{timeout:5000})
    expect(workspaces[2]).toBe(realpathSync.native(directories.workspace))
    expect(readFileSync(join(directories.workspace,'index.html'),'utf8')).toBe('version 3')
    expect(native.errors).toEqual([])
  })

  it('preserves the existing workspace for historical tickets instead of relocating them', () => {
    const { stateDir, workspace } = paths(), files = new TaskFiles(stateDir, workspace)
    files.preserveLegacy(['old-ticket'])
    expect(files.directory('old-ticket')).toBe(realpathSync.native(workspace))
    expect(files.directory('new-ticket')).not.toBe(realpathSync.native(workspace))
  })
})
