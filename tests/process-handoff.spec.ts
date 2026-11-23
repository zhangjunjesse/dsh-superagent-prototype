/** Actual original Sessions transfer verified work to a different direct department without overlapping execution. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { acceptOriginalReview, controlledNative, originalText, routeOriginal } from './fixtures/native-ports.ts'

const roots: string[] = [], owners: ProcessRuntime[] = [], release: (() => void)[] = []
afterEach(async () => {
  release.splice(0).forEach(done => done())
  for (const owner of owners.splice(0).reverse()) await owner.close()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

it.each(['partial', 'unmodified', 'disconnect', 'cleanup-failure'] as const)('hands off %s work on the same verified version under the original grant', async mode => {
  type Id = 'management' | 'author' | 'inspector'
  const nodes = {} as Record<Id, ProcessRuntime>, natives = {} as Record<Id, ReturnType<typeof controlledNative>>
  const gate = Promise.withResolvers<void>(); release.push(() => gate.resolve())
  const configs = {} as Record<Id, ProcessRuntimeConfig>
  for (const id of ['management', 'author', 'inspector'] as const) {
    const root = mkdtempSync(join(tmpdir(), `handoff-${id}-`)); roots.push(root)
    const workspace = join(root, 'workspace'); mkdirSync(workspace)
    configs[id] = { instanceId: id, organizationName: id, brainName: id, stateDir: join(root, 'state'), workspace,
      model: { provider: 'fixture', model: id }, workerTools: id === 'author' ? ['read', 'write'] : id === 'inspector' ? ['read', 'grep'] : ['read', 'write', 'grep'], maxWorkers: 1,
      ...(id === 'management' ? { delegationTargets: [{ instanceId: 'author', organizationName: 'author', description: 'Produces and corrects files', tools: ['read', 'write'] },
        { instanceId: 'inspector', organizationName: 'inspector', description: 'Reads and inspects delivered versions', tools: ['read', 'grep'] }] } : { allowedParents: ['management'] }) }
  }
  let sourceFile = '', expected = '', oldRunning = false, inspectorStarted = 0, attempts = 0, disconnected = false, cleanupFailure = false, stopRequested = false, done = false
  const commands: { target: string; operation: string; tools: string[] }[] = []
  function open(id: Id) {
    const host: ProcessHost = {
      run: async request => {
        const tool = (name: string, args: unknown) => nodes[id].tool({ sessionKey: request.sessionKey, requestId: request.requestId, role: request.role, name, args })
        if (request.sessionKey.startsWith('delegation:')) await tool('delegation_prepare', { summary: 'Continue the assigned scope from verified prior work.' })
        else await tool('jarvis_work_submit', { operation: 'new', request: { quote: request.text, summary: request.text } })
        return { status: 'complete', text: 'Accepted.' }
      }, cancel: async () => ({ cancelled: true }),
      readArtifact: async input => { nodes[id].authorizeArtifact(input); return nodes[input.artifact.instanceId as Id].readArtifact({ artifact: input.artifact, offset: input.offset, limit: input.limit }) },
      delegationCatalog: async () => ({ targets: configs[id].delegationTargets ?? [], readyInstanceIds: id === 'management' ? ['author', 'inspector'] : [] }),
      delegate: async request => {
        commands.push({ target: request.targetInstanceId, operation: request.operation, tools: request.tools })
        if (disconnected) throw new Error('IPC connection unavailable; execution outcome unknown')
        stopRequested = request.operation === 'stop'
        try { return ['query', 'stop'].includes(request.operation) ? await nodes[request.targetInstanceId as Id].lifecycleDelegation({ sourceInstanceId: id, request })
          : await nodes[request.targetInstanceId as Id].delegation({ sourceInstanceId: id, request }) }
        finally { stopRequested = false }
      },
    }
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const card = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (card.kind === 'candidate') { await routeOriginal(turn, 'Produce and inspect a stable result', id === 'management' ? 'author' : undefined); return }
        if (card.kind !== 'result_review') return
        if (id !== 'management') { await acceptOriginalReview(turn); return }
        await originalText(turn, card.read)
        if (!inspectorStarted) {
          expect(oldRunning).toBe(true)
          expect(card.execution_targets.find((item: { instanceId: string }) => item.instanceId === 'inspector').tools).toContain('grep')
          const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
            decision: { kind: 'continue', summary: 'Production cannot complete inspection; hand off the original remaining scope.', instructions: 'Inspect the exact registered version and report the tested SHA-256. Do not change the original goal.', target_instance_id: 'inspector' } }
          disconnected = mode === 'disconnect'; cleanupFailure = mode === 'cleanup-failure'
          if (disconnected || cleanupFailure) {
            attempts++
            await expect(turn.tool('orchestrator_result_review', args)).rejects.toThrow(disconnected ? 'unknown' : 'cleanup fixture')
            expect((await nodes.management.state()).tickets[0]?.assignments).toHaveLength(1)
            expect(inspectorStarted).toBe(0)
            disconnected = false; cleanupFailure = false
          }
          if (sourceFile) writeFileSync(sourceFile, 'a later unregistered mutation\n')
          await turn.tool('orchestrator_result_review', args)
        } else { await acceptOriginalReview(turn, `The original production and inspection conditions are met at ${expected}.`); done = true }
        return
      }
      if (!card.ticket_id) return
      if (id === 'author') {
        oldRunning = true
        await expect(turn.authorize('grep')).rejects.toThrow()
        if (mode !== 'unmodified') {
          sourceFile = join(turn.policy.cwd, 'result.txt'); const bytes = Buffer.from('the registered result\n')
          writeFileSync(sourceFile, bytes); expected = createHash('sha256').update(bytes).digest('hex')
          await turn.tool('orchestrator_report', { state: 'ready', summary: 'Production finished; inspection remains under the original scope.', artifacts: [{ path: 'result.txt' }] })
        } else await turn.tool('orchestrator_report', { state: 'blocked', summary: 'This department cannot perform the assigned inspection and has made no changes.' })
        await gate.promise; oldRunning = false
      } else {
        inspectorStarted++; expect(oldRunning).toBe(false)
        await turn.authorize('grep'); await expect(turn.authorize('write')).rejects.toThrow()
        if (mode !== 'unmodified') {
          const [file] = card.execution.handoff
          expect(isAbsolute(file.path)).toBe(false)
          expect(file.instanceId).toBe('author'); expect(file.assignmentId).toBeTruthy()
          const received = readFileSync(join(turn.policy.cwd, file.path))
          expect(createHash('sha256').update(received).digest('hex')).toBe(expected)
          expect(file.version.sha256).toBe(expected)
          expect(received.toString()).toBe('the registered result\n')
          expect(readFileSync(sourceFile, 'utf8')).toBe('a later unregistered mutation\n')
        }
        await turn.tool('orchestrator_report', { state: 'ready', summary: `Inspected the original result, SHA-256 ${expected}; the original remaining condition passed.` })
      }
    }, { cancel: () => { if (id === 'author') gate.resolve() } })
    const stop = native.native.executor.stopBackground.bind(native.native.executor)
    native.native.executor.stopBackground = async (...args) => { if (id === 'author' && stopRequested && cleanupFailure) throw new Error('cleanup fixture rejected'); await stop(...args) }
    natives[id] = native; nodes[id] = createProcessRuntime(configs[id], host, { native: native.native }); owners.push(nodes[id])
  }
  open('author'); open('inspector'); open('management')
  await nodes.management.chat({ id: 'original-work', text: 'Produce the result and inspect that exact version under the existing task authority.' })
  await vi.waitFor(() => { for (const id of ['management', 'author', 'inspector'] as const) expect(natives[id].errors).toEqual([]); expect(done).toBe(true) }, { timeout: 12000 })
  const ticket = (await nodes.management.state()).tickets[0]!
  expect(ticket.assignments).toHaveLength(2); expect(ticket.ended?.outcome).toBe('completed')
  expect(ticket.assignments[0]!.resultReviews?.[0]?.decision?.kind).toBe('continue')
  expect(ticket.assignments[1]!.executionTarget).toBe('inspector')
  expect(commands.filter(command => command.operation === 'submit').map(command => [command.target, command.tools])).toEqual([
    ['author', ['read', 'write']], ['inspector', ['read', 'grep']],
  ])
  expect(commands.findIndex(command => command.operation === 'stop' && command.target === 'author')).toBeLessThan(commands.findIndex(command => command.operation === 'submit' && command.target === 'inspector'))
  expect(inspectorStarted).toBe(1); expect(attempts).toBe(['disconnect', 'cleanup-failure'].includes(mode) ? 1 : 0)
}, 18000)
