/** Missing departments use the original native tools, durable task bindings and Gateway. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createProcessRuntime, type ProcessHost, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { acceptOriginalReview, controlledNative, originalText, routeOriginal, type NativeTurn } from './fixtures/native-ports.ts'

const directories: string[] = [], owners: ProcessRuntime[] = []
afterEach(async () => {
  for (const owner of owners.splice(0).sort((a, b) => (a.config.allowedParents?.length ?? 0) - (b.config.allowedParents?.length ?? 0))) await owner.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function configuration(id: string): ProcessRuntimeConfig {
  const directory = mkdtempSync(join(tmpdir(), `department-wait-${id}-`)); directories.push(directory)
  const workspace = join(directory, 'workspace'); mkdirSync(workspace)
  return { instanceId: id, organizationName: `Organization ${id}`, brainName: `${id} brain`, stateDir: join(directory, 'state'), workspace,
    description: 'Completes exact task requirements', model: { provider: 'fixture', model: 'original' }, workerTools: ['read', 'write'], maxWorkers: 1 }
}
const requirement = { responsibility: 'Independently measure and certify the repaired marker', required_tools: ['read', 'write'],
  instructions: 'Measure the repaired marker. Retain its exact version and record the observed validation result.' }

it('holds the original newly accepted task once without launching a local Worker or occupying the user conversation', async () => {
  let node: ProcessRuntime, route: unknown, workers = 0
  const native = controlledNative(async turn => {
    if (turn.policy.role === 'worker') { workers++; return }
    if (!turn.text.startsWith('{')) return
    const card = JSON.parse(turn.text)
    if (card.kind === 'candidate') route = await turn.tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: card.trigger_id,
      title: 'Repair and independently certify marker', worktree_name: 'marker', acknowledgement: 'Accepted repair and certification.', missing_department: requirement }] })
  })
  const host: ProcessHost = { run: async request => {
    if (request.text !== 'Hello while waiting') await node.tool({ ...request, name: 'jarvis_work_submit', args: {
      operation: 'new', request: { quote: request.text, summary: request.text } } })
    return { status: 'complete', text: 'Understood.' }
  }, cancel: async () => ({ cancelled: true }), delegationCatalog: async () => ({ targets: [], readyInstanceIds: [] }),
    delegate: async () => { throw new Error('No child exists; no submission is authorized') } }
  node = createProcessRuntime(configuration('root'), host, { native: native.native }); owners.push(node)
  await node.chat({ id: 'original-task', text: 'Repair the marker and independently certify its delivered version.' })
  await vi.waitFor(() => expect(route !== undefined || native.errors.length > 0).toBe(true), { timeout: 3000 })
  expect(native.errors).toEqual([])
  expect((await node.state()).tickets).toHaveLength(1)
  const before = await node.state(), ticket = before.tickets[0]!
  expect(route).toMatchObject({ results: [{ decision: 'accept' }] })
  expect(ticket.ended).toBeUndefined()
  expect(ticket.assignments).toHaveLength(1)
  expect(ticket.assignments[0]?.resultReviews).toHaveLength(1)
  expect(ticket.assignments[0]?.resultReviews?.[0]?.decision).toBeUndefined()
  expect(workers).toBe(0)
  await vi.waitFor(async () => expect((await node.feedback()).items.filter(event => event.kind === 'message')).toHaveLength(1), { timeout: 3000 })
  const waiting = (await node.feedback()).items.filter(event => event.kind === 'message')
  expect(waiting).toHaveLength(1)
  expect(waiting[0]?.text).toContain(requirement.responsibility)
  expect(waiting[0]?.text).toContain('Organization root')
  expect(waiting[0]?.conversationId).toBe('process:root')
  expect((await node.chat({ id: 'next-message', text: 'Hello while waiting' })).status).toBe('complete')
  expect((await node.conversation()).activeUserTurnId).toBeNull()
  expect((await node.feedback()).items.filter(event => event.kind === 'message')).toHaveLength(1)
  expect(native.errors).toEqual([])
}, 10000)

it.each(['cleanup-failure', 'offline'] as const)('reopens a wait and automatically resumes only after matching real responsibility, recovering %s without user input', async mode => {
  const config = configuration('root'), nodes = new Map<string, ProcessRuntime>(), catalogs: NonNullable<ProcessRuntimeConfig['delegationTargets']> = []
  const nativeErrors: unknown[][] = [], submitted: string[] = [], workerCalls: string[] = [], readyCards: NativeTurn[] = []
  let failCleanup = false, failedResume = false, completedResumes = 0, observedOffline = false
  let root: ProcessRuntime
  function open(input: ProcessRuntimeConfig) {
    const host: ProcessHost = { run: async request => {
      const owner = nodes.get(input.instanceId)!
      if (request.sessionKey.startsWith('delegation:')) await owner.tool({ ...request, name: 'delegation_prepare', args: { summary: 'Validate the exact original version only.' } })
      else await owner.tool({ ...request, name: 'jarvis_work_submit', args: { operation: 'new', request: { quote: request.text, summary: request.text } } })
      return { status: 'complete', text: 'Accepted.' }
    }, cancel: async () => ({ cancelled: true }),
      readArtifact: async request => { nodes.get(input.instanceId)!.authorizeArtifact(request); return nodes.get(request.artifact.instanceId)!.readArtifact({ artifact: request.artifact, offset: request.offset, limit: request.limit }) },
      delegationCatalog: async () => ({ targets: input.instanceId === 'root' ? catalogs : [], readyInstanceIds: input.instanceId === 'root'
        ? (await Promise.all(catalogs.map(async target => await nodes.get(target.instanceId)?.delegationReadiness().then(value => value.ready) ? target.instanceId : undefined))).filter((id): id is string => !!id) : [] }),
      delegate: async request => {
        if (request.operation === 'submit') submitted.push(request.delegationId)
        const child = nodes.get(request.targetInstanceId)!
        return ['query', 'stop'].includes(request.operation) ? child.lifecycleDelegation({ sourceInstanceId: input.instanceId, request })
          : child.delegation({ sourceInstanceId: input.instanceId, request })
      } }
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const card = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (card.kind === 'candidate') {
          if (input.instanceId !== 'root') { await routeOriginal(turn, 'Measure original marker'); return }
          await turn.tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: card.trigger_id, title: 'Repair and certify marker',
            worktree_name: 'marker', acknowledgement: 'Accepted repair and certification.', missing_department: requirement }] }); return
        }
        if (card.kind === 'department_ready') {
          readyCards.push(turn)
          expect(await originalText(turn, card.original_request)).toContain('independently certify')
          expect(card.missing_department).toMatchObject(requirement)
          expect(card.execution_targets.every((target: { tools: string[] }) => ['read', 'write'].every(tool => target.tools.includes(tool)))).toBe(true)
          await expect(turn.tool('orchestrator_department_resume', { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
            target_instance_id: 'read-only', summary: 'Read-only is missing a necessary permission.' })).rejects.toThrow('required')
          const target = card.execution_targets.find((item: { description: string }) => item.description === requirement.responsibility)
          if (!target) { if (failedResume) observedOffline = true; return } // Same display name does not satisfy the responsibility.
          const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id, target_instance_id: target.instanceId,
            summary: 'The actual ready direct department is responsible for independent measurement and certification.' }
          if (!failedResume) {
            failedResume = true
            if (mode === 'cleanup-failure') {
              failCleanup = true
              await expect(turn.tool('orchestrator_department_resume', args)).rejects.toThrow('transient native cleanup failure')
            } else {
              const child = nodes.get('certifier')!; await child.close(); owners.splice(owners.indexOf(child), 1); nodes.delete('certifier')
              await expect(turn.tool('orchestrator_department_resume', args)).rejects.toThrow('required')
            }
            return // There is no user message or manual tool retry; the durable owner must drive the next attempt.
          }
          await turn.tool('orchestrator_department_resume', args)
          await turn.tool('orchestrator_department_resume', args)
          completedResumes++
          return
        }
        if (card.kind === 'result_review' && card.summary.includes('Validation passed')) await acceptOriginalReview(turn)
        return
      }
      workerCalls.push(input.instanceId)
      expect(input.instanceId).toBe('certifier')
      writeFileSync(join(turn.policy.cwd, 'certificate.txt'), 'tested_version=marker-v1\npassed=true\n')
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'Validation passed for marker-v1.', artifacts: [{ path: 'certificate.txt', title: 'Versioned certificate' }] })
    })
    native.native.executor.stopBackground = async () => { if (failCleanup) { failCleanup = false; throw new Error('transient native cleanup failure') } }
    nativeErrors.push(native.errors)
    const owner = createProcessRuntime(input, host, { native: native.native }); owners.push(owner); nodes.set(input.instanceId, owner)
    return owner
  }
  root = open(structuredClone(config))
  await root.chat({ id: 'original', text: 'Repair and independently certify the exact delivered marker version.' })
  await vi.waitFor(async () => expect((await root.feedback()).items.filter(event => event.kind === 'message')).toHaveLength(1), { timeout: 4000 })
  const original = (await root.state()).tickets[0]!, oldConversation = (await root.conversation()).turns
  await root.close(); owners.splice(owners.indexOf(root), 1); nodes.delete('root')
  root = open(structuredClone(config)); await root.ready
  expect((await root.state()).tickets[0]!.id).toBe(original.id)
  expect((await root.feedback()).items.filter(event => event.kind === 'message')).toHaveLength(1)
  function configureChild(id: string, tools: string[], description: string, start: boolean) {
    const child = configuration(id); child.allowedParents = ['root']; child.workerTools = tools; child.description = description
    catalogs.push({ instanceId: id, organizationName: 'Certification', description, tools: tools as never })
    if (start) open(child)
    return child
  }
  configureChild('read-only', ['read'], requirement.responsibility, true)
  configureChild('unrelated', ['read', 'write'], 'Archives unrelated personnel records', true)
  const certifier = configureChild('certifier', ['read', 'write'], requirement.responsibility, false)
  await vi.waitFor(() => expect(readyCards.length).toBeGreaterThan(0), { timeout: 3000 })
  expect(submitted).toEqual([]); expect(workerCalls).toEqual([])
  expect((await root.state()).tickets[0]!.assignments).toHaveLength(1)
  const unmatchedTurns = readyCards.length
  for (let attempt = 0; attempt < 3; attempt++) await root.gatewayRequest({ operation: 'query', input: { operation: 'search' } })
  expect(readyCards).toHaveLength(unmatchedTurns)
  open(certifier)
  if (mode === 'offline') {
    await vi.waitFor(() => expect(observedOffline).toBe(true), { timeout: 3000 })
    expect(submitted).toEqual([])
    open(certifier)
  }
  await vi.waitFor(async () => expect((await root.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 6000 })
  const completed = (await root.state()).tickets[0]!
  expect(completed.id).toBe(original.id); expect(completed.decisionId).toBe(original.decisionId); expect(completed.mandate).toEqual(original.mandate)
  expect(completed.assignments).toHaveLength(2)
  expect(completed.assignments[1]?.executionTarget).toBe('certifier')
  expect(completed.assignments[1]?.continuation?.instructions).toContain(requirement.instructions)
  expect(completed.assignments[0]?.resultReviews?.[0]?.decision?.kind).toBe('continue')
  expect(submitted).toHaveLength(1); expect(workerCalls).toEqual(['certifier'])
  expect(failedResume).toBe(true); expect(completedResumes).toBe(1)
  expect((await root.feedback()).items.filter(event => event.kind === 'message')).toHaveLength(1)
  expect((await root.conversation()).turns).toEqual(oldConversation)
  expect(nativeErrors.flat()).toEqual([])
}, 16000)

it('forwards a partial-result department wait up the immutable delegation path and recovers it without a user resend', async () => {
  const configs = { group: configuration('group'), division: configuration('division'), lab: configuration('lab') }
  configs.division.allowedParents = ['group']; configs.lab.allowedParents = ['division']
  configs.group.delegationTargets = [{ instanceId: 'division', organizationName: 'Delivery', description: 'Repair and coordinate certification', tools: ['read', 'write'] }]
  const nodes = {} as Record<keyof typeof configs, ProcessRuntime>, errors: unknown[][] = [], workers: string[] = [], submits: string[] = []
  let repairFile = '', repairHash = '', heldReport: unknown
  const labCapability = { instanceId: 'lab', organizationName: 'Testing', description: requirement.responsibility, tools: ['read', 'write'] as ('read' | 'write')[] }
  const divisionCatalog: typeof labCapability[] = []
  function open(id: keyof typeof configs) {
    const host: ProcessHost = { run: async request => {
      await nodes[id].tool({ ...request, name: request.sessionKey.startsWith('delegation:') ? 'delegation_prepare' : 'jarvis_work_submit', args:
        request.sessionKey.startsWith('delegation:') ? { summary: 'Repair and independently certify the fixed version.' }
          : { operation: 'new', request: { quote: request.text, summary: request.text } } })
      return { status: 'complete', text: 'Accepted.' }
    }, cancel: async () => ({ cancelled: true }),
      readArtifact: async input => { nodes[id].authorizeArtifact(input); return nodes[input.artifact.instanceId as keyof typeof nodes].readArtifact({ artifact: input.artifact, offset: input.offset, limit: input.limit }) },
      delegationCatalog: async () => {
        const targets = id === 'division' ? divisionCatalog : configs[id].delegationTargets ?? []
        const readyInstanceIds: string[] = []
        for (const target of targets) if (nodes[target.instanceId as keyof typeof nodes] && (await nodes[target.instanceId as keyof typeof nodes].delegationReadiness()).ready) readyInstanceIds.push(target.instanceId)
        return { targets, readyInstanceIds }
      }, delegate: async request => {
        const child = nodes[request.targetInstanceId as keyof typeof nodes]
        if (request.operation === 'submit') submits.push(request.delegationId)
        return ['query', 'stop'].includes(request.operation) ? child.lifecycleDelegation({ sourceInstanceId: id, request }) : child.delegation({ sourceInstanceId: id, request })
      } }
    const native = controlledNative(async turn => {
      if (!turn.text.startsWith('{')) return
      const card = JSON.parse(turn.text)
      if (turn.policy.role === 'orchestrator') {
        if (card.kind === 'candidate') { await routeOriginal(turn, 'Repair and certify original marker', id === 'group' ? 'division' : undefined); return }
        if (card.kind === 'department_ready') {
          const review = await originalText(turn, card.read)
          expect(review).toContain(repairHash)
          expect(await originalText(turn, card.original_request)).toContain('independently certify the exact delivered version')
          const args = { ticket_id: card.ticket_id, assignment_id: card.assignment_id, review_id: card.review_id,
            target_instance_id: 'lab', summary: 'The ready laboratory certifies the delivered version within every original permission.' }
          await turn.tool('orchestrator_department_resume', args); await turn.tool('orchestrator_department_resume', args); return
        }
        if (card.kind === 'result_review' && card.summary.includes('Certified sha256')) await acceptOriginalReview(turn)
        return
      }
      workers.push(id)
      if (id === 'division') {
        repairFile = join(turn.policy.cwd, 'repair.txt'); writeFileSync(repairFile, 'repaired-original-marker-v1\n')
        repairHash = createHash('sha256').update('repaired-original-marker-v1\n').digest('hex')
        const args = { state: 'blocked', summary: `Repaired sha256 ${repairHash}; independent certification remains unaccepted.`,
          artifacts: [{ path: 'repair.txt', title: 'Original repaired version' }], missing_department: { ...requirement, instructions: `${requirement.instructions} Test exactly sha256 ${repairHash}.` } }
        heldReport = await turn.tool('orchestrator_report', args)
      } else if (id === 'lab') {
        expect(await originalText(turn, card.trigger.delegation.assignment.read)).toContain(repairHash)
        const [file] = card.execution.handoff
        expect(createHash('sha256').update(readFileSync(join(turn.policy.cwd, file.path))).digest('hex')).toBe(repairHash)
        writeFileSync(join(turn.policy.cwd, 'validation.txt'), `tested_sha256=${repairHash}\npassed=true\nsource=${repairFile}\n`)
        await turn.tool('orchestrator_report', { state: 'ready', summary: `Certified sha256 ${repairHash}; observed the repaired marker.`, artifacts: [{ path: 'validation.txt', title: 'Certification of original version' }] })
      } else throw new Error('The group must not execute a local Worker')
    })
    errors.push(native.errors)
    const owner = createProcessRuntime(structuredClone(configs[id]), host, { native: native.native }); nodes[id] = owner; owners.push(owner)
    return owner
  }
  open('division'); open('group')
  await nodes.group.chat({ id: 'repair-source', text: 'Repair the marker and independently certify the exact delivered version.' })
  await vi.waitFor(() => { expect(errors.flat()).toEqual([]); expect(heldReport).toBeDefined() }, { timeout: 4000 })
  await vi.waitFor(async () => expect((await nodes.group.feedback()).items.filter(event => event.kind === 'message')).toHaveLength(1), { timeout: 4000 })
  const group = (await nodes.group.state()).tickets[0]!, division = (await nodes.division.state()).tickets[0]!
  const notice = (await nodes.group.feedback()).items.find(event => event.kind === 'message')!
  expect(notice.text).toContain('Organization division'); expect(notice.text).toContain(requirement.responsibility)
  expect(notice.conversationId).toBe('process:group')
  expect(workers).toEqual(['division'])
  expect((await nodes.division.state()).departmentWaits).toMatchObject([{ ticketId: division.id, assignmentId: division.assignments[0]!.id, decisionId: division.decisionId }])
  const binding = (await nodes.group.state()).delegations.outgoing[0]!.request
  const duplicate = await nodes.division.delegation({ sourceInstanceId: 'group', request: binding })
  expect(duplicate.departmentWaits).toHaveLength(1)
  await nodes.division.close(); owners.splice(owners.indexOf(nodes.division), 1)
  open('division'); await nodes.division.ready
  expect((await nodes.division.state()).tickets[0]!.id).toBe(division.id)
  divisionCatalog.push(labCapability)
  open('lab')
  await vi.waitFor(async () => { expect(errors.flat()).toEqual([]); expect((await nodes.group.state()).tickets[0]?.ended?.outcome).toBe('completed') }, { timeout: 8000 })
  const finalDivision = (await nodes.division.state()).tickets[0]!, finalGroup = (await nodes.group.state()).tickets[0]!
  expect(finalDivision.id).toBe(division.id); expect(finalDivision.mandate).toEqual(division.mandate)
  expect(finalGroup.id).toBe(group.id); expect(finalGroup.mandate).toEqual(group.mandate)
  expect(finalDivision.assignments).toHaveLength(2); expect(finalGroup.assignments).toHaveLength(1)
  expect(workers).toEqual(['division', 'lab']); expect(new Set(submits).size).toBe(2); expect(submits).toHaveLength(2)
  expect((await nodes.group.feedback()).items.filter(event => event.kind === 'message')).toHaveLength(1)
  const groupState = await nodes.group.state()
  const workRef = 'items' in groupState.works ? groupState.works.items![0]!.workRef : ''
  const projection = await nodes.group.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef } }) as { artifacts: { title: string }[] }
  expect(projection.artifacts.map(item => item.title)).toEqual(expect.arrayContaining(['Original repaired version', 'Certification of original version']))
}, 20000)
