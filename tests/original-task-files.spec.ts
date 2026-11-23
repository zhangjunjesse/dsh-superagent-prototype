import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TaskFiles } from '../src/process-runtime/task-files.ts'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('keeps original executor directories and artifacts across restart and refuses an index-only rebind', () => {
  const root = mkdtempSync(join(tmpdir(), 'original-task-files-')); roots.push(root)
  const stateDir = join(root, 'state'), workspace = join(root, 'workspace'), legacy = join(root, 'old-worktree'), other = join(root, 'other')
  for (const path of [stateDir, workspace, legacy, other]) mkdirSync(path)
  writeFileSync(join(legacy, 'result.html'), 'Original result')
  const options = { executionDirectory: (id: string) => id === 'old-ticket' ? legacy : undefined }
  const files = new TaskFiles(stateDir, workspace, options)
  const actual = files.bind('old-ticket', legacy)
  expect(files.register('old-ticket', [{ path: 'result.html' }])).toEqual([{ path: 'result.html' }])
  expect(new TaskFiles(stateDir, workspace, options).directory('old-ticket')).toBe(actual)
  expect(readFileSync(join(actual, 'result.html'), 'utf8')).toBe('Original result')
  expect(() => files.bind('old-ticket', other)).toThrow('matching execution binding')
  expect(() => files.bind('unknown-ticket', legacy)).toThrow('matching execution binding')
  expect(() => files.register('old-ticket', [{ path: '../other/file.txt' }])).toThrow()
  const index = JSON.parse(readFileSync(join(stateDir, 'task-files.json'), 'utf8'))
  index.tasks['old-ticket'].workspace = other
  writeFileSync(join(stateDir, 'task-files.json'), JSON.stringify(index))
  expect(() => new TaskFiles(stateDir, workspace, options)).toThrow('Invalid task workspace binding')
})
it('keeps registered assignment versions immutable and imports the exact bytes into the receiving task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-task-files-')); roots.push(root)
  const state = join(root, 'state'), workspace = join(root, 'workspace'), receiverState = join(root, 'receiver-state'), receiverWorkspace = join(root, 'receiver')
  for (const path of [state, workspace, receiverState, receiverWorkspace]) mkdirSync(path)
  const files = new TaskFiles(state, workspace, { assignmentId: () => 'producer-a', assignmentExists: (ticket, assignment) => ticket === 'source' && assignment === 'producer-a' })
  const directory = files.directory('source'), bytes = Buffer.from('version-one\n'), sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(directory, 'result.txt'), bytes)
  files.register('source', [{ path: 'result.txt' }])
  const link = files.links('producer', 'source')[0]!
  expect(link.version?.sha256).toBe(sha256)
  expect(link.url).toContain(`/@version/producer-a/${link.version!.bundle}/result.txt`)
  writeFileSync(join(directory, 'result.txt'), 'later mutation')
  const artifact = { instanceId: 'producer', ticketId: 'source', assignmentId: link.assignmentId!, version: link.version! }
  const receiver = new TaskFiles(receiverState, receiverWorkspace), imported = await receiver.materialize('receiving', [artifact], async input => files.read(input))
  expect(readFileSync(join(receiver.directory('receiving'), imported[0]!.path))).toEqual(bytes)
  expect(() => files.read({ artifact: { ...artifact, ticketId: 'other-task' }, offset: 0, limit: 100 })).toThrow()
  expect(() => files.read({ artifact: { ...artifact, assignmentId: 'other-assignment' }, offset: 0, limit: 100 })).toThrow()
  expect(() => files.read({ artifact: { ...artifact, version: { ...artifact.version, path: 'private.txt' } }, offset: 0, limit: 100 })).toThrow()
  const reopened = new TaskFiles(state, workspace, { assignmentId: () => 'producer-a', assignmentExists: (ticket, assignment) => ticket === 'source' && assignment === 'producer-a' })
  expect(Buffer.from(reopened.read({ artifact, offset: 0, limit: 100 }).data, 'base64')).toEqual(bytes)
  const snapshot = join(state, 'task-artifact-versions', createHash('sha256').update('source').digest('hex'), createHash('sha256').update('producer-a').digest('hex'), sha256, 'result.txt')
  chmodSync(snapshot, 0o600); writeFileSync(snapshot, 'tampered version')
  expect(() => reopened.read({ artifact, offset: 0, limit: 100 })).toThrow('digest changed')
  const escaped = new TaskFiles(receiverState, receiverWorkspace), escapedWorkspace = escaped.directory('escaped')
  symlinkSync(workspace, join(escapedWorkspace, '.handoff'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(escaped.materialize('escaped', [artifact], async input => files.read(input))).rejects.toThrow('replaced or linked')
  expect(() => readFileSync(join(workspace, createHash('sha256').update(JSON.stringify([artifact.instanceId, artifact.ticketId, artifact.assignmentId, artifact.version])).digest('hex'), 'result.txt'))).toThrow()
})
