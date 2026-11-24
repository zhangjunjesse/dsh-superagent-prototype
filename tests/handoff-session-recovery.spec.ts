/** The original durable Session relay and department-ready path both recover an interrupted producer handoff. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OriginalProcess } from '../src/process-runtime/original-runtime.ts'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { acceptOriginalReview, controlledNative, originalText, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

const roots: string[] = [], parents: OriginalProcess[] = [], children: ProcessRuntime[] = [], release: (() => void)[] = []
afterEach(async () => {
  release.splice(0).forEach(done => done())
  for (const parent of parents.splice(0).reverse()) await parent.close()
  for (const child of children.splice(0).reverse()) await child.close()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

it.each(['review', 'department_wait'] as const)('reopens SQLite and resumes the original %s through its native Session without new user input', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-session-recovery-')); roots.push(root)
  function configuration(id: string): ProcessRuntimeConfig {
    const workspace = join(root, id, 'work'), stateDir = join(root, id, 'state')
    mkdirSync(workspace, { recursive: true }); mkdirSync(stateDir, { recursive: true })
    return { instanceId: id, organizationName: id, brainName: id, stateDir, workspace, workerTools: ['read', 'write'], maxWorkers: 1,
      model: { provider: 'controlled', model: 'original-router-and-worker' }, ...(id === 'management' ? { delegationTargets: [
        { instanceId: 'producer', organizationName: 'Producer', description: 'Produces the original version', tools: ['read', 'write'] },
        { instanceId: 'inspector', organizationName: 'Inspector', description: 'Independently validates the registered original version', tools: ['read', 'write'] },
      ] } : { allowedParents: ['management'] }) }
  }
  const config = configuration('management'), nodes = new Map<string, ProcessRuntime>(), errors: unknown[][] = []
  const workerGate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), parked = Promise.withResolvers<never>()
  release.push(() => workerGate.resolve())
  const cards: { boot: number; kind: string; reviewId: string; turn: NativeTurn }[] = [], submits: string[] = [], stops: string[] = [], workers: string[] = []
  let parent: OriginalProcess, boot = 0, ready = mode === 'review', suspendQuery = false, version = '', resumed = false, finished = false
  const requirement = { responsibility: 'Independently validates the registered original version', required_tools: ['read', 'write'],
    instructions: 'Validate the registered original version and retain its exact SHA-256 in the report.' }
  function child(id: string) {
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const card = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') { await routeOriginal(turn, 'Original bounded work'); return }
      if (!card.ticket_id) return
      workers.push(id)
      if (id === 'producer') {
        writeFileSync(join(turn.policy.cwd, 'result.txt'), 'registered-original-version\n')
        version = createHash('sha256').update('registered-original-version\n').digest('hex')
        await turn.tool('orchestrator_report', { state: 'ready', summary: `Produced sha256 ${version}; independent validation remains.`, artifacts: [{ path: 'result.txt' }] })
        await workerGate.promise // Completion text is not proof that the original native execution has drained.
      } else {
        const [file] = card.execution.handoff
        expect(createHash('sha256').update(readFileSync(join(turn.policy.cwd, file.path))).digest('hex')).toBe(version)
        expect(file.version.sha256).toBe(version)
        await turn.tool('orchestrator_report', { state: 'ready', summary: `Validated sha256 ${version}; the original conditions passed.` })
      }
    }, { cancel: () => { if (id === 'producer') workerGate.resolve() } })
    errors.push(native.errors)
    let node: ProcessRuntime
    const host: ProcessHost = { run: async request => {
      await node.tool({ ...request, name: 'delegation_prepare', args: { summary: 'Continue only the exact authorized original work.' } })
      return { status: 'complete', text: 'Prepared.' }
    }, cancel: async () => ({ cancelled: true }), delegationCatalog: async () => ({ targets: [], readyInstanceIds: [] }),
      readArtifact: async input => { node.authorizeArtifact(input); return nodes.get(input.artifact.instanceId)!.readArtifact({ artifact: input.artifact, offset: input.offset, limit: input.limit }) } }
    node = createProcessRuntime(configuration(id), host, { native: native.native }); children.push(node); nodes.set(id, node)
  }
  function open() {
    const generation = ++boot
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const card = JSON.parse(turn.text)
      if (card.kind === 'candidate') { await routeOriginal(turn, 'Produce and validate the original exact version', 'producer'); return }
      if (!['result_review', 'department_ready'].includes(card.kind)) return
      cards.push({ boot: generation, kind: card.kind, reviewId: card.review_id, turn })
      if (generation === 1) {
        if (mode === 'department_wait' && card.kind === 'result_review') await turn.tool('orchestrator_department_wait', {
          ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id, ...requirement, summary: 'The registered version still requires independent validation.' })
        return // The first admitted ready/review turn is deliberately consumed before the owner is interrupted.
      }
      expect(await originalText(turn, card.original_request)).toContain('original exact version')
      const review = await originalText(turn, card.read)
      expect(review).toContain(version)
      if (card.kind === 'result_review' && card.summary.includes('Validated sha256')) { await acceptOriginalReview(turn); finished = true; return }
      if (mode === 'department_wait') {
        expect(card.kind).toBe('department_ready')
        expect(card.missing_department).toMatchObject(requirement)
        await turn.tool('orchestrator_department_resume', { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
          target_instance_id: 'inspector', summary: 'The current ready Inspector fulfills the original retained responsibility and permissions.' })
      } else await turn.tool('orchestrator_result_review', { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
        decision: { kind: 'continue', summary: 'The registered version is present; original validation remains.', instructions: requirement.instructions, target_instance_id: 'inspector' } })
      resumed = true
    })
    errors.push(native.errors)
    const host: ProcessHost = { run: async () => { throw new Error('Daily chat is not used to resume this original task') }, cancel: async () => ({ cancelled: true }),
      delegationCatalog: async () => ({ targets: config.delegationTargets!, readyInstanceIds: ready ? ['producer', 'inspector'] : ['producer'] }),
      delegate: async request => {
        if (request.operation === 'submit') submits.push(request.delegationId)
        if (request.operation === 'stop') stops.push(request.delegationId)
        if (suspendQuery && request.targetInstanceId === 'producer' && request.operation === 'query') { suspendQuery = false; entered.resolve(); return parked.promise }
        const node = nodes.get(request.targetInstanceId)!, envelope = { sourceInstanceId: 'management', request }
        return ['query', 'stop'].includes(request.operation) ? node.lifecycleDelegation(envelope) : node.delegation(envelope)
      } }
    const owner = new OriginalProcess(structuredClone(config), host, { native: native.native }, {
      prepare: async () => ({ status: 'complete', text: 'Prepared exact task.' }), cancel: async () => ({ cancelled: true }),
    })
    parents.push(owner); return owner
  }
  async function tick() { await parent.pump.tick(); await parent.delegated.tick(); await parent.reconcileDepartments() }
  child('producer'); child('inspector'); parent = open(); await parent.ready
  const text = 'Produce and independently validate the original exact version.'
  expect(parent.gateway.submit({ operation: 'new', request: { quote: text, summary: text } }, {
    conversationId: 'original-conversation', userMessageId: 'original-request', text, at: new Date().toISOString(), source: 'user',
  }).status).toBe('queued')
  await vi.waitFor(async () => { await tick(); expect(errors.flat()).toEqual([]); expect(cards.some(card => card.kind === 'result_review')).toBe(true) }, { timeout: 6000 })
  if (mode === 'department_wait') {
    ready = true
    await vi.waitFor(async () => { await tick(); expect(errors.flat()).toEqual([]); expect(cards.some(card => card.kind === 'department_ready')).toBe(true) }, { timeout: 4000 })
  }
  const original = parent.runtime.store.tickets.list()[0]!, assignment = original.assignments[0]!, review = assignment.resultReviews!.at(-1)!, master = parent.runtime.masterId
  suspendQuery = true
  void parent.prepareReview(original.id, 'inspector', assignment.id, review.id).catch(() => {})
  await entered.promise
  await parent.close(); parents.splice(parents.indexOf(parent), 1)
  parent = open(); await parent.ready
  expect(parent.runtime.masterId).toBe(master)
  await vi.waitFor(async () => { await tick(); expect(errors.flat()).toEqual([]); expect(finished).toBe(true) }, { timeout: 7000 })
  const final = parent.runtime.store.tickets.get(original.id)!
  expect(resumed).toBe(true); expect(final.ended?.outcome).toBe('completed'); expect(final.mandate).toEqual(original.mandate)
  expect(final.assignments).toHaveLength(2); expect(final.assignments[1]!.executionTarget).toBe('inspector')
  expect(cards.filter(card => card.boot === 2 && (mode === 'review' ? card.kind === 'result_review' : card.kind === 'department_ready'))[0]!.reviewId).not.toBe(review.id)
  expect(workers).toEqual(['producer', 'inspector']); expect(submits).toHaveLength(2); expect(new Set(submits).size).toBe(2)
  expect(stops.length).toBeGreaterThan(0); expect(parent.ledger.works('', 0, 20)).toHaveLength(1)
}, 20000)
