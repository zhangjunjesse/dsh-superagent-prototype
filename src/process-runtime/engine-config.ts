/** Legacy five-section schema and defaults retained for lossless configuration archives. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { packagePath } from '../infra/paths.ts'

export const ENGINE_PROMPT_KEYS = ['router', 'worker', 'communication', 'scope', 'delivery'] as const
const prompt = z.string().max(20000).refine(value => !value.includes('\0'), 'Prompt contains a null character')
export const EngineConfigSchema = z.object({ prompts: z.object({
  router: prompt, worker: prompt, communication: prompt, scope: prompt, delivery: prompt,
}).strict() }).strict()
export type EngineConfig = z.infer<typeof EngineConfigSchema>

export function defaultEngineConfig(): EngineConfig {
  return { prompts: Object.fromEntries(ENGINE_PROMPT_KEYS.map(key => [key,
    readFileSync(packagePath('prompts', 'process-runtime', `${key}.md`), 'utf8').replaceAll('\r\n', '\n').trim(),
  ])) as EngineConfig['prompts'] }
}

export function normalizeEngineConfig(value: unknown): EngineConfig {
  return EngineConfigSchema.parse(value === undefined ? defaultEngineConfig() : value)
}
