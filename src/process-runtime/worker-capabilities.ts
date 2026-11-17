import { z } from 'zod'
import { DELEGATION_TOOLS } from '../core/model.ts'

/** Native tools with adapters in the shared DSH bridge. New tools are never enabled by default. */
export const WORKER_TOOL_NAMES = DELEGATION_TOOLS
export const WorkerToolSchema = z.enum(WORKER_TOOL_NAMES)
export const WorkerSkillsSchema = z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(200)).max(40)

export interface EffectiveWorkerTool {
  name: string
  source: 'configured' | 'automatic'
  requires: string[]
  constraint: 'configured-capability' | 'same-session-jobs' | 'load-without-authority' | 'internal-state' | 'same-ticket-intersection'
}
/** Native management tools retain the original mechanism without granting a new execution capability. */
export function effectiveWorkerTools(configured: readonly string[]): { names: string[]; tools: EffectiveWorkerTool[] } {
  const selected = [...new Set(configured)].filter(name => (WORKER_TOOL_NAMES as readonly string[]).includes(name))
  const tools: EffectiveWorkerTool[] = selected.map(name => ({ name, source: 'configured', requires: [name], constraint: 'configured-capability' }))
  const automatic = (names: string[], requires: string[], constraint: EffectiveWorkerTool['constraint']) => {
    for (const name of names) tools.push({ name, source: 'automatic', requires, constraint })
  }
  const shells = selected.filter(name => name === 'bash' || name === 'pwsh')
  if (shells.length) automatic(['job_output', 'job_list', 'job_kill'], shells, 'same-session-jobs')
  automatic(['skill'], [], 'load-without-authority')
  automatic(['todo_write'], [], 'internal-state')
  if (selected.length) automatic(['subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent'], selected, 'same-ticket-intersection')
  return { names: tools.map(tool => tool.name), tools }
}
