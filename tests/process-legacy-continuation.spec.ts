/** Legacy file indexes are reusable only in the same Core-bound task directory, never as transfer evidence. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createProcessRuntime, type ProcessRuntime, type ProcessRuntimeConfig } from '../src/process-runtime/runtime.ts'
import { controlledNative, routeOriginal } from './fixtures/native-ports.ts'

const roots: string[] = [], owners: ProcessRuntime[] = [], releases: (() => void)[] = []
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  for (const owner of owners.splice(0).reverse()) await owner.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('legacy-continuation-')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
function configuration(): ProcessRuntimeConfig {
  const root = mkdtempSync(join(tmpdir(), 'legacy-continuation-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  return { instanceId: 'root', organizationName: 'Root', brainName: 'Legacy task fixture', workspace, stateDir: join(root, 'state'),
    model: { provider: 'fixture', model: 'fixture' }, workerTools: ['read', 'write'], maxWorkers: 1 }
}
const host = { run: async () => ({ text: 'conversation', status: 'complete' as const }), cancel: async () => ({ cancelled: true }) }
const origin = (id: string, text: string, workRef?: string) => ({ conversationId: 'legacy-continuation', userMessageId: id, text,
  source: 'user', at: new Date().toISOString(), ...(workRef ? { selectedWorkRef: workRef } : {}) })

it('reopens a legacy completed task in its original workspace without inventing a transferable result version', async () => {
  const config = configuration(), workspaces: string[] = [], release = Promise.withResolvers<void>()
  releases.push(() => release.resolve())
  const native = controlledNative(async turn => {
    if (!turn.text.startsWith('{')) return
    if (turn.policy.role === 'orchestrator') { await routeOriginal(turn, 'Create a document'); return }
    const input = JSON.parse(turn.text)
    if (!input.ticket_id) return
    workspaces.push(turn.policy.cwd)
    if (workspaces.length === 1) {
      writeFileSync(join(turn.policy.cwd, 'result.txt'), 'original document')
      await turn.tool('orchestrator_report', { state: 'ready', summary: 'Created the original document.' })
      return
    }
    expect(turn.policy.cwd).toBe(workspaces[0])
    expect(readFileSync(join(turn.policy.cwd, 'result.txt'), 'utf8')).toBe('original document')
    expect(input.execution.handoff).toBeUndefined()
    await release.promise
    await turn.authorize('write')
    writeFileSync(join(turn.policy.cwd, 'result.txt'), 'updated document')
    await turn.tool('orchestrator_report', { state: 'ready', summary: 'Updated the original document.', artifacts: [{ path: 'result.txt' }] })
  })
  let runtime = createProcessRuntime(config, host, { native: native.native }); owners.push(runtime)
  const admission = await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'new', request: { quote: 'Create a document', summary: 'Document' } },
    origin: origin('first', 'Create a document') }) as { workRef: string }
  await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 4000, interval: 20 })
  await native.idle()
  const original = (await runtime.state()).tickets[0]!
  await runtime.close()
  // Replay the pre-versioning index written by the original application. The
  // persisted Core ticket and its execution directory remain authoritative.
  const index = { version: 1, tasks: { [original.id]: { workspace: original.execution!.directory, artifacts: [{ path: 'result.txt' }] } } }
  writeFileSync(join(config.stateDir, 'task-files.json'), JSON.stringify(index))
  runtime = createProcessRuntime(config, host, { native: native.native }); owners.push(runtime)
  let targetToken = ''
  await vi.waitFor(async () => {
    const detail = await runtime.gatewayRequest({ operation: 'query', input: { operation: 'get', workRef: admission.workRef } }) as { targetToken?: string }
    expect(detail.targetToken).toBeTypeOf('string'); targetToken = detail.targetToken!
  }, { timeout: 4000, interval: 20 })
  expect(await runtime.gatewayRequest({ operation: 'submit', input: { operation: 'append', targetToken,
    request: { quote: 'Update the document', summary: 'Update document' } }, origin: origin('append', 'Update the document', admission.workRef) }))
    .toMatchObject({ status: 'queued', workRef: admission.workRef })
  await vi.waitFor(async () => {
    expect(native.errors).toEqual([])
    expect((await runtime.state()).tickets[0]?.assignments.at(-1)?.report?.state).not.toBe('failed')
    expect(workspaces).toHaveLength(2)
  }, { timeout: 4000, interval: 20 })
  const current = (await runtime.state()).tickets[0]!, bytes = Buffer.from('original document')
  const artifact = { instanceId: config.instanceId, ticketId: original.id, assignmentId: original.assignments[0]!.id,
    version: { path: 'result.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  const read = { artifact, offset: 0, limit: 100 }
  // Knowing legacy paths and bytes does not grant a version to this task,
  // another task, or another organization, even while local reuse is allowed.
  expect(() => runtime.readArtifact(read)).toThrow('not a registered version')
  expect(() => runtime.readArtifact({ ...read, artifact: { ...artifact, ticketId: 'different-task' } })).toThrow('matching original task execution binding')
  expect(() => runtime.readArtifact({ ...read, artifact: { ...artifact, instanceId: 'different-organization' } })).toThrow('producer identity')
  expect(() => runtime.authorizeArtifact({ ...read, ticketId: original.id, assignmentId: current.assignments.at(-1)!.id })).toThrow('no verified version')
  expect(JSON.parse(readFileSync(join(config.stateDir, 'task-files.json'), 'utf8'))).toEqual(index)
  release.resolve()
  await vi.waitFor(async () => expect((await runtime.state()).tickets[0]?.ended?.outcome).toBe('completed'), { timeout: 4000, interval: 20 })
  expect((await runtime.state()).tickets).toHaveLength(1)
  expect(readFileSync(join(workspaces[1]!, 'result.txt'), 'utf8')).toBe('updated document')
  const updated = JSON.parse(readFileSync(join(config.stateDir, 'task-files.json'), 'utf8')).tasks[original.id]
  expect(updated.workspace).toBe(original.execution!.directory)
  expect(updated.versions).toHaveLength(1)
  expect(updated.versions[0].assignmentId).toBe(current.assignments.at(-1)!.id)
  expect(native.errors).toEqual([])
}, 12000)
