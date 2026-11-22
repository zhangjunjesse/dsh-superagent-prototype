import { describe, expect, it } from 'vitest'
import { resolveDeployment, type Probe } from '../src/deployment.ts'
import { testMachine } from './fixtures/deployment.ts'

const github = { repository: 'acme/previous', cli: process.execPath }
const identity = '{"login":"Agent-Bot","id":7}'
const writable = '{"name":"acme/current","push":true}'
const machine = () => testMachine({ stateDir: process.cwd() })

describe('independent GitHub startup reads', () => {
  it('starts both checks before either returns and still uses canonical repository and identity', async () => {
    const user = Promise.withResolvers<string>(), repository = Promise.withResolvers<string>(), calls: string[][] = []
    const probe: Probe = argv => { calls.push(argv); return argv[2] === 'user' ? user.promise : repository.promise }
    const result = resolveDeployment(machine(), github, probe)
    expect(calls.map(argv => argv.slice(1))).toEqual([
      ['api', 'user'], ['api', 'repos/acme/previous', '--jq', '{name: .full_name, push: .permissions.push}'],
    ])
    repository.resolve(writable); user.resolve(identity)
    expect(await result).toMatchObject({ repository: 'acme/current', github: { login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
  })

  it('keeps identity failure first even if repository failure arrives earlier', async () => {
    const user = Promise.withResolvers<string>(), repository = Promise.withResolvers<string>()
    const result = resolveDeployment(machine(), github, argv => argv[2] === 'user' ? user.promise : repository.promise)
    repository.reject(new Error('repository failed first'))
    await Promise.resolve()
    user.reject(new Error('identity failure'))
    await expect(result).rejects.toMatchObject({ code: 'agentCliSignedOut', values: { output: 'identity failure' } })
  })

  it('keeps malformed identity ahead of a rejected repository read', async () => {
    await expect(resolveDeployment(machine(), github, async argv => {
      if (argv[2] === 'user') return '{}'
      throw new Error('repository unavailable')
    })).rejects.toMatchObject({ code: 'agentCliNoAccount' })
  })

  it.each([
    ['unreadable', undefined, 'repositoryUnreadable'],
    ['malformed', '{}', 'repositoryUnreported'],
    ['read only', '{"name":"acme/current","push":false}', 'repositoryReadOnly'],
    ['unknown permission', '{"name":"acme/current","push":null}', 'repositoryReadOnly'],
  ])('retains %s repository validation', async (_name, repository, code) => {
    await expect(resolveDeployment(machine(), github, async argv => {
      if (argv[2] === 'user') return identity
      if (repository === undefined) throw new Error('HTTP 404')
      return repository
    })).rejects.toMatchObject({ code })
  })
})
