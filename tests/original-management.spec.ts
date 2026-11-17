import { createServer, request as httpRequest, type RequestListener } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createProcessRuntime } from '../src/process-runtime/runtime.ts'
import { defaultPrompts } from '../src/app/prompts.ts'
import { controlledNative } from './fixtures/native-ports.ts'

// These are shipped directly as ESM rather than TypeScript build entries.
const facadePath = new URL('../jarvis/dsh/original-management.mjs', import.meta.url).href
const indexPath = new URL('../jarvis/dsh/index.mjs', import.meta.url).href
const { createOriginalManagementHandler, registerOriginalManagement } = await import(facadePath)
const { createJarvisHandler } = await import(indexPath)

it('registers the compatibility API only after trusted adoption, leaving the standalone owner untouched', () => {
  const registrations: { path: string; handler: RequestListener }[] = []
  let removed = 0
  const ctx = { webServer: { register: (route: { path: string; handler: RequestListener }) => { registrations.push(route); return () => { removed++ } } } }
  registerOriginalManagement(ctx)()
  expect(registrations).toEqual([])
  const dispose = registerOriginalManagement(ctx, { adoption: { instanceId: 'root' } })
  expect(registrations.map(item => item.path)).toEqual(['/orchestrator'])
  dispose(); expect(removed).toBe(1)
})

it('serves both original and scoped paths from one real complete Store with shared prompt/settings/deployment CAS and original request limits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'original-facade-')), workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const controlled = controlledNative(), runtime = createProcessRuntime({ instanceId: 'root', organizationName: 'Root', brainName: 'Jarvis',
    stateDir: join(directory, 'state'), workspace, model: { provider: 'fixture', model: 'fixture' }, workerTools: ['read'], maxWorkers: 2 },
  { run: async () => ({ text: '', status: 'complete' }), cancel: async () => ({ cancelled: true }) }, { native: controlled.native, managementOnly: true })
  let calls = 0
  const system = { management: async (id: string, input: Parameters<typeof runtime.management>[0]) => { expect(id).toBe('root'); calls++; return runtime.management(input) } }
  const ctx: { webServer: { port: number }; connection: { requestRejection?: (req: { headers: Record<string, string> }) => number | undefined } } = {
    webServer: { port: 0 }, connection: { requestRejection: req => req.headers['x-login'] === 'yes' ? undefined : 401 } }
  const original: RequestListener = createOriginalManagementHandler(ctx, { system })
  const scoped: RequestListener = createJarvisHandler(ctx, {}, { csrf: 'scoped-csrf', system })
  const server = createServer((req, res) => req.url?.startsWith('/orchestrator') ? original(req, res) : scoped(req, res))
  try {
    await runtime.ready
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address')
    ctx.webServer.port = address.port
    const request = (base: 'old' | 'scoped', path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: Record<string, any> }>((done, reject) => {
        const req = httpRequest(`http://127.0.0.1:${address.port}/${base === 'old' ? 'orchestrator/api' : 'jarvis/api/system/instances/root/superagent'}/${path}`, {
          method, headers: { 'x-login': 'yes', 'x-orchestrator-request': '1', 'x-jarvis-csrf': 'scoped-csrf', 'content-type': 'application/json', ...headers },
        }, res => {
          let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
          res.on('end', () => { try { done({ status: res.statusCode!, body: JSON.parse(text) }) } catch (error) { reject(error) } })
        })
        req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
      })
    for (const path of ['state', 'overview', 'sources', 'settings', 'prompts', 'deployment', 'configuration-migrations', 'threads', 'decisions', 'tickets']) {
      const first = await request('old', path), second = await request('scoped', path)
      expect(first.status, path).toBe(200); expect(second).toEqual(first)
    }
    expect((await request('old', 'state')).body.setup.machineApi).toBe(true)
    const executor = (await request('old', 'settings')).body.blocks.executor
    const changed = { ...executor.value, maxWorkers: 4 }
    expect((await request('old', 'settings/executor', 'PUT', { revision: executor.revision, value: changed }, { 'x-jarvis-csrf': '' })).status).toBe(200)
    const after = (await request('scoped', 'settings')).body.blocks.executor
    expect(after.value.maxWorkers).toBe(4); expect(after.revision).toBe(executor.revision + 1)
    expect((await request('scoped', 'settings/executor', 'PUT', { revision: executor.revision, value: changed })).status).toBe(409)
    const prompts = { ...defaultPrompts(), communication: '文'.repeat(60000) }
    expect((await request('old', 'prompts', 'PUT', { baseRevision: 0, config: prompts })).status).toBe(200)
    const currentPrompts = (await request('scoped', 'prompts')).body
    expect(currentPrompts.current.config.communication).toBe(prompts.communication)
    expect(currentPrompts.revisions[0].revision).toBe(1)
    expect((await request('old', 'prompts?revision=0')).body.current.config.communication).toBe(defaultPrompts().communication)
    expect((await request('scoped', 'prompts', 'PUT', { baseRevision: 0, config: defaultPrompts() })).status).toBe(409)
    expect((await request('old', 'deployment', 'PUT', { revision: 0, values: { promptMaxChars: 120000 } })).status).toBe(200)
    const deployment = await request('scoped', 'deployment')
    expect(deployment.body).toMatchObject({ revision: 1, effective: { promptMaxChars: 120000 }, effect: 'next-use' })
    expect((await request('scoped', 'deployment', 'PUT', { revision: 0, values: {} })).status).toBe(409)

    const beforeAuth = calls
    const refusedHeaders: Record<string, string>[] = [{ 'x-login': '' }, { 'x-orchestrator-request': '' }, { origin: 'http://external.invalid' }, { host: 'external.invalid' }, { 'sec-fetch-site': 'cross-site' }]
    for (const headers of refusedHeaders) {
      expect((await request('old', 'settings', 'GET', undefined, headers)).status).toBe(headers['x-login'] === '' ? 401 : 403)
      expect((await request('old', 'settings/executor', 'PUT', {}, headers)).status).toBe(headers['x-login'] === '' ? 401 : 403)
    }
    expect(calls).toBe(beforeAuth)
    const authenticate = ctx.connection.requestRejection
    delete ctx.connection.requestRejection
    expect((await request('old', 'settings')).status).toBe(503)
    ctx.connection.requestRejection = authenticate
    expect(calls).toBe(beforeAuth)
    expect((await request('scoped', 'deployment', 'PUT', { revision: 1, values: {} }, { 'x-jarvis-csrf': '' })).status).toBe(403)
    expect((await request('old', 'deployment', 'PUT', '{invalid')).status).toBe(400)
    expect((await request('old', 'deployment', 'PUT', ' '.repeat(128 * 1024) + '{}')).status).toBe(400)
    expect((await request('old', 'github/connection', 'POST', JSON.stringify({ token: 'x'.repeat(20 * 1024) }))).status).toBe(400)
    expect((await request('old', 'github/connection/cancel', 'POST', JSON.stringify({ id: 'x'.repeat(1024) }))).status).toBe(400)
    expect((await request('old', 'prompts', 'PUT', { baseRevision: 1, config: { ...defaultPrompts(), communication: '文'.repeat(180000) } })).status).toBe(400)
    expect((await request('scoped', 'prompts')).body.current.revision).toBe(1)
    expect(controlled.sessions.size).toBe(0); expect(controlled.deliveries).toEqual([])
  } finally {
    await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) })
    await runtime.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('original-facade-')) throw new Error('Unsafe fixture cleanup')
    rmSync(directory, { recursive: true, force: true })
  }
})
