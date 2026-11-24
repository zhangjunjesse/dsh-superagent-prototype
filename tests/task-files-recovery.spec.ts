import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskFiles } from '../src/process-runtime/task-files.ts'
import type { ArtifactReference, ArtifactVerification } from '../src/process-runtime/artifact-contract.ts'

const io = vi.hoisted(() => ({
  beforeWrite: undefined as undefined | ((args: Parameters<typeof writeFileSync>, write: typeof writeFileSync) => void),
  afterRead: undefined as undefined | (() => void),
  beforeRename: undefined as undefined | (() => void),
  afterRename: undefined as undefined | (() => void),
  bytesRead: 0,
  snapshotHandles: new Set<number>(),
}))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const snapshot = (path: unknown) => String(path).includes('task-artifact-versions')
  return { ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => { io.beforeWrite?.(args, fs.writeFileSync); return fs.writeFileSync(...args) },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { io.beforeRename?.(); fs.renameSync(...args); io.afterRename?.() },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args)
      if (snapshot(args[0])) { io.bytesRead += Buffer.byteLength(result); io.afterRead?.() }
      return result
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (snapshot(args[0])) io.snapshotHandles.add(fd)
      return fd
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const length = fs.readSync(...args)
      if (io.snapshotHandles.has(args[0])) { io.bytesRead += length; io.afterRead?.() }
      return length
    },
    closeSync: (fd: number) => { io.snapshotHandles.delete(fd); return fs.closeSync(fd) },
  }
})

const roots: string[] = []
afterEach(() => {
  io.beforeWrite = undefined; io.afterRead = undefined; io.beforeRename = undefined; io.afterRename = undefined
  io.bytesRead = 0; io.snapshotHandles.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function producer(bytes = Buffer.from('complete immutable result')) {
  const root = mkdtempSync(join(tmpdir(), 'task-file-recovery-')); roots.push(root)
  const state = join(root, 'state'), workspace = join(root, 'workspace')
  mkdirSync(state); mkdirSync(workspace)
  const options = { assignmentId: () => 'assignment', assignmentExists: (ticket: string, assignment: string) => ticket === 'ticket' && assignment === 'assignment' }
  const files = new TaskFiles(state, workspace, options), directory = files.directory('ticket')
  writeFileSync(join(directory, 'result.bin'), bytes)
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  const snapshot = join(state, 'task-artifact-versions', digest('ticket'), digest('assignment'), digest(bytes), 'result.bin')
  const reopen = () => new TaskFiles(state, workspace, options)
  const register = (target = files) => target.register('ticket', [{ path: 'result.bin' }])
  const reference = (target = files): ArtifactReference => {
    const link = target.links('producer', 'ticket')[0]!
    return { instanceId: 'producer', ticketId: 'ticket', assignmentId: link.assignmentId!, version: link.version! }
  }
  return { root, state, workspace, files, bytes, snapshot, reopen, register, reference }
}

it('retries registration after a partial ENOSPC write and a business-owner restart', () => {
  const f = producer()
  io.beforeWrite = (args, write) => {
    if (!String(args[0]).includes('task-artifact-versions')) return
    write(args[0], f.bytes.subarray(0, 4), args[2]); throw new Error('injected ENOSPC after 4 bytes')
  }
  expect(() => f.register()).toThrow('ENOSPC')
  expect(f.files.links('producer', 'ticket')).toEqual([])
  io.beforeWrite = undefined
  const reopened = f.reopen()
  f.register(reopened)
  expect(Buffer.from(reopened.read({ artifact: f.reference(reopened), offset: 0, limit: 262144 }).data, 'base64')).toEqual(f.bytes)
})

it('recovers an unpublished partial snapshot left by the previous direct-write implementation', () => {
  const f = producer()
  mkdirSync(join(f.snapshot, '..'), { recursive: true }); writeFileSync(f.snapshot, f.bytes.subarray(0, 4), { mode: 0o400 })
  const reopened = f.reopen()
  f.register(reopened)
  expect(readFileSync(f.snapshot)).toEqual(f.bytes)
  expect(reopened.links('producer', 'ticket')).toHaveLength(1)
})

it('retries after the producer process exits in the middle of the snapshot write', () => {
  const f = producer()
  const child = spawnSync(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./fixtures/task-files-crash.mjs', import.meta.url)), f.state, f.workspace], { timeout: 15000, encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(74)
  const reopened = f.reopen()
  expect(reopened.links('producer', 'ticket')).toEqual([])
  f.register(reopened)
  expect(readFileSync(f.snapshot)).toEqual(f.bytes)
})

it('keeps a competing complete publication when the interrupted publisher fails', () => {
  const f = producer()
  io.beforeWrite = (args, write) => {
    if (!String(args[0]).includes('task-artifact-versions')) return
    io.beforeWrite = undefined
    write(args[0], f.bytes.subarray(0, 4), args[2])
    f.register(f.reopen())
    throw new Error('injected ENOSPC after competitor completed')
  }
  expect(() => f.register()).toThrow('ENOSPC after competitor completed')
  const reopened = f.reopen()
  expect(reopened.links('producer', 'ticket')).toHaveLength(1)
  expect(readFileSync(f.snapshot)).toEqual(f.bytes)
  expect(Buffer.from(reopened.read({ artifact: f.reference(reopened), offset: 0, limit: 262144 }).data, 'base64')).toEqual(f.bytes)
})

it('keeps an already published snapshot continuously available when legacy recovery races with another publisher', () => {
  const f = producer(), observations: (Buffer | string)[] = []
  mkdirSync(join(f.snapshot, '..'), { recursive: true }); writeFileSync(f.snapshot, f.bytes.subarray(0, 4), { mode: 0o400 })
  io.beforeRename = () => {
    io.beforeRename = undefined
    f.register(f.reopen())
    io.afterRename = () => {
      io.afterRename = undefined
      const reader = f.reopen()
      try { observations.push(Buffer.from(reader.read({ artifact: f.reference(reader), offset: 0, limit: 262144 }).data, 'base64')) }
      catch { observations.push('unavailable') }
    }
  }
  f.register()
  expect(readFileSync(f.snapshot)).toEqual(f.bytes)
  expect(observations).toEqual([f.bytes])
})

it('does not silently repair the contents of a registered immutable snapshot', () => {
  const f = producer(); f.register()
  chmodSync(f.snapshot, 0o600); writeFileSync(f.snapshot, f.bytes.subarray(0, 4))
  expect(() => f.register(f.reopen())).toThrow('digest changed')
})

it.each(['snapshot', 'index'])('keeps the last committed bundle in memory and on disk after a later %s write fails', failure => {
  const f = producer(); f.register()
  const before = f.files.links('producer', 'ticket')
  const directory = f.files.directory('ticket')
  writeFileSync(join(directory, 'result.bin'), 'a revised result'); writeFileSync(join(directory, 'second.txt'), 'second result')
  io.beforeWrite = (args, write) => {
    if (failure === 'snapshot' ? !String(args[0]).includes('second.txt') : !String(args[0]).includes('task-files.json.')) return
    write(args[0], Buffer.from(args[1] as string).subarray(0, 4), args[2]); throw new Error('injected ENOSPC before bundle commit')
  }
  expect(() => f.files.register('ticket', [{ path: 'result.bin' }, { path: 'second.txt' }])).toThrow('ENOSPC')
  expect(f.files.links('producer', 'ticket')).toEqual(before)
  expect(f.reopen().links('producer', 'ticket')).toEqual(before)
  io.beforeWrite = undefined
  f.files.register('ticket', [{ path: 'result.bin' }, { path: 'second.txt' }])
  expect(f.reopen().links('producer', 'ticket')).toHaveLength(3)
})

it('bounds source disk reads while transferring sixteen chunks with full version verification', async () => {
  const f = producer(Buffer.alloc(4 * 1024 * 1024, 0x6b)); f.register()
  const reopened = f.reopen(), artifact = f.reference(reopened)
  const receiverState = join(f.root, 'receiver-state'), receiverWorkspace = join(f.root, 'receiver')
  mkdirSync(receiverState); mkdirSync(receiverWorkspace)
  const receiver = new TaskFiles(receiverState, receiverWorkspace)
  io.bytesRead = 0
  let chunks = 0
  const [handoff] = await receiver.materialize('receiving', [artifact], async input => { chunks++; return reopened.read(input) })
  const sourceBytesRead = io.bytesRead
  console.info(JSON.stringify({ artifactBytes: f.bytes.length, chunks, sourceBytesRead }))
  expect(readFileSync(join(receiver.directory('receiving'), handoff!.path))).toEqual(f.bytes)
  expect(chunks).toBe(16)
  expect(sourceBytesRead, JSON.stringify({ artifactBytes: f.bytes.length, chunks, sourceBytesRead })).toBeLessThanOrEqual(f.bytes.length * 2)
}, 30000)

it('bounds the whole transfer when every chunk reopens the stopped producer and only its host retains verification', async () => {
  const f = producer(Buffer.alloc(4 * 1024 * 1024, 0x6b)); f.register()
  const artifact = f.reference(), receiverState = join(f.root, 'receiver-state'), receiverWorkspace = join(f.root, 'receiver')
  mkdirSync(receiverState); mkdirSync(receiverWorkspace)
  const receiver = new TaskFiles(receiverState, receiverWorkspace)
  let verification: ArtifactVerification | undefined, chunks = 0
  io.bytesRead = 0
  const [handoff] = await receiver.materialize('receiving', [artifact], async input => {
    chunks++
    const result = f.reopen().readForHost(input, verification)
    verification = result.verification
    return result.chunk
  })
  const sourceBytesRead = io.bytesRead
  expect(readFileSync(join(receiver.directory('receiving'), handoff!.path))).toEqual(f.bytes)
  expect(chunks).toBe(16)
  expect(sourceBytesRead, JSON.stringify({ artifactBytes: f.bytes.length, chunks, sourceBytesRead })).toBe(f.bytes.length * 2)
}, 30000)

it('fully verifies cold old data again when the host lost its private verification on restart', () => {
  const f = producer(); f.register()
  const input = { artifact: f.reference(), offset: 0, limit: 1 }
  const index = readFileSync(join(f.state, 'task-files.json'))
  for (let restart = 0; restart < 2; restart++) {
    io.bytesRead = 0
    expect(Buffer.from(f.reopen().readForHost(input).chunk.data, 'base64')).toEqual(f.bytes.subarray(0, 1))
    expect(io.bytesRead).toBe(f.bytes.length + 1)
  }
  expect(readFileSync(join(f.state, 'task-files.json'))).toEqual(index)
})

it.each(['producer', 'ticket', 'assignment', 'path', 'digest', 'size', 'bundle', 'file'] as const)('does not reuse host verification with a changed %s binding', kind => {
  const f = producer(); f.register()
  const input = { artifact: f.reference(), offset: 0, limit: 1 }
  const { verification } = f.reopen().readForHost(input)
  const changed = structuredClone(verification)
  if (kind === 'producer') changed.artifact.instanceId = 'other-producer'
  if (kind === 'ticket') changed.artifact.ticketId = 'other-ticket'
  if (kind === 'assignment') changed.artifact.assignmentId = 'other-assignment'
  if (kind === 'path') changed.artifact.version.path = 'other.bin'
  if (kind === 'digest') changed.artifact.version.sha256 = 'f'.repeat(64)
  if (kind === 'size') changed.artifact.version.size++
  if (kind === 'bundle') changed.artifact.version.bundle = 'f'.repeat(64)
  if (kind === 'file') changed.file = join(f.root, 'another-file')
  io.bytesRead = 0
  expect(Buffer.from(f.reopen().readForHost(input, changed).chunk.data, 'base64')).toEqual(f.bytes.subarray(0, 1))
  expect(io.bytesRead).toBe(f.bytes.length + 1)
  io.bytesRead = 0
  f.reopen().readForHost(input, verification)
  expect(io.bytesRead).toBe(1)
})

it.each(['edit', 'replace'] as const)('rejects a same-size %s across producer restarts even with prior host verification', kind => {
  const f = producer(); f.register()
  const input = { artifact: f.reference(), offset: 0, limit: 1 }, { verification } = f.reopen().readForHost(input)
  const before = statSync(f.snapshot), changed = Buffer.alloc(f.bytes.length, 0x7f)
  chmodSync(f.snapshot, 0o600)
  if (kind === 'edit') writeFileSync(f.snapshot, changed)
  else { writeFileSync(`${f.snapshot}.replacement`, changed); renameSync(`${f.snapshot}.replacement`, f.snapshot) }
  utimesSync(f.snapshot, before.atime, before.mtime)
  expect(() => f.reopen().readForHost(input, verification)).toThrow('digest changed')
})

it('rechecks Core authority after reopening even when the host has a matching producer verification', () => {
  const f = producer(); f.register()
  let allowed = true, execution = f.files.directory('ticket')
  const options = { executionDirectory: () => execution, assignmentExists: () => allowed }
  const input = { artifact: f.reference(), offset: 0, limit: 1 }
  const { verification } = new TaskFiles(f.state, f.workspace, options).readForHost(input)
  allowed = false; io.bytesRead = 0
  expect(() => new TaskFiles(f.state, f.workspace, options).readForHost(input, verification)).toThrow('assignment binding')
  allowed = true; execution = f.workspace
  expect(() => new TaskFiles(f.state, f.workspace, options).readForHost(input, verification)).toThrow('workspace binding')
  expect(io.bytesRead).toBe(0)
})

it('invalidates a verified file after a same-size edit even when its modified time is restored', () => {
  const f = producer(); f.register()
  const files = f.reopen(), artifact = f.reference(files)
  files.read({ artifact, offset: 0, limit: 1 })
  const before = statSync(f.snapshot)
  chmodSync(f.snapshot, 0o600); writeFileSync(f.snapshot, Buffer.alloc(f.bytes.length, 0x7f)); utimesSync(f.snapshot, before.atime, before.mtime)
  expect(() => files.read({ artifact, offset: 1, limit: 1 })).toThrow('digest changed')
})

it.each(['cold', 'verified'])('rejects a snapshot changed during a %s read', cache => {
  const f = producer(); f.register()
  const files = f.reopen(), artifact = f.reference(files)
  if (cache === 'verified') files.read({ artifact, offset: 0, limit: 1 })
  io.afterRead = () => {
    io.afterRead = undefined
    chmodSync(f.snapshot, 0o600); writeFileSync(f.snapshot, Buffer.alloc(f.bytes.length, 0x7f))
  }
  expect(() => files.read({ artifact, offset: 1, limit: 3 })).toThrow('digest changed')
})

it('verifies distinct snapshot files separately even when they have the same digest', () => {
  const f = producer(), directory = f.files.directory('ticket')
  writeFileSync(join(directory, 'other.bin'), f.bytes)
  f.files.register('ticket', [{ path: 'result.bin' }, { path: 'other.bin' }])
  const files = f.reopen(), artifact = f.reference(files)
  files.read({ artifact, offset: 0, limit: 1 })
  const otherFile = join(f.snapshot, '..', 'other.bin')
  chmodSync(otherFile, 0o600); writeFileSync(otherFile, Buffer.alloc(f.bytes.length, 0x7f))
  const otherVersion = files.links('producer', 'ticket').find(link => link.version?.path === 'other.bin')!.version!
  expect(() => files.read({ artifact: { ...artifact, version: otherVersion }, offset: 0, limit: 1 })).toThrow('digest changed')
})

it('rechecks the exact path and assignment authority for every range after verification', () => {
  const f = producer(); f.register()
  let allowed = true, execution = f.files.directory('ticket')
  const files = new TaskFiles(f.state, f.workspace, { executionDirectory: () => execution, assignmentExists: () => allowed }), artifact = f.reference(files)
  expect(Buffer.from(files.read({ artifact, offset: 3, limit: 7 }).data, 'base64')).toEqual(f.bytes.subarray(3, 10))
  allowed = false
  expect(() => files.read({ artifact, offset: 10, limit: 1 })).toThrow('assignment is unavailable')
  allowed = true
  execution = f.workspace
  expect(() => files.read({ artifact, offset: 10, limit: 1 })).toThrow('execution binding')
  execution = f.files.directory('ticket')
  expect(() => files.read({ artifact: { ...artifact, assignmentId: 'other-assignment' }, offset: 0, limit: 1 })).toThrow('registered version')
  expect(() => files.read({ artifact, offset: f.bytes.length + 1, limit: 1 })).toThrow('outside')
  expect(files.read({ artifact, offset: f.bytes.length, limit: 1 })).toEqual({ data: '', nextOffset: null })
  const directory = join(f.snapshot, '..'), moved = `${directory}-moved`
  renameSync(directory, moved); symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => files.read({ artifact, offset: 0, limit: 1 })).toThrow('replaced or linked')
})
