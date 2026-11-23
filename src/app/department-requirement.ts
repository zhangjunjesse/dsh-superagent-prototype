/** Task-specific missing responsibility; creating an organization never grants task authority. */
import { z } from 'zod'
import { WorkerToolSchema } from '../process-runtime/worker-capabilities.ts'

export const DepartmentRequirementSchema = z.object({
  responsibility: z.string().trim().min(1).max(2000),
  required_tools: z.array(WorkerToolSchema).min(1).max(30).refine(tools => new Set(tools).size === tools.length, 'Required tools must be distinct'),
  instructions: z.string().trim().min(1).max(100000),
}).strict()
export type DepartmentRequirement = z.infer<typeof DepartmentRequirementSchema>
