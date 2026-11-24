/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { GithubConnectionInput, GithubConnectionView } from './github-connection.ts'
import type { MachineSettingsView, MachineValues } from './machine-settings.ts'
import type { EffectiveWorkerTool } from '../process-runtime/worker-capabilities.ts'
import type { OriginalConfigurationMigration } from '../process-runtime/original-config.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** A server-observed activity that may be interrupted when applying Worker authorization. */
export interface WorkerCapabilityAffectedOrganization {
  instanceId: string
  name: string
  running: boolean
  busy: boolean
  work: { id: string; title: string; kind: string; status?: string }[]
  error?: string
}
/** Durable application of one saved Worker authorization, with actions allowed by its current state. */
export interface WorkerCapabilityApplication {
  id: string
  state: 'waiting' | 'applying' | 'failed' | 'applied' | 'cancelled'
  savedAt: string
  appliedAt?: string
  error?: string
  affected: WorkerCapabilityAffectedOrganization[]
  canCancel: boolean
  canRetry: boolean
  canApplyNow: boolean
  confirmation?: string
}
export interface WorkerCapabilitiesView {
  revision: number
  tools: string[]
  skills: string[]
  applied: { tools: string[]; skills: string[] }
  application?: WorkerCapabilityApplication
  effective: { names: string[]; tools: EffectiveWorkerTool[] }
  catalog: { tools: { name: string; label: string; group: string; available: boolean }[];
    skills: { name: string; description: string; source?: unknown }[]; complete: boolean; error?: string }
}
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'GET configuration-migrations': { response: { items: OriginalConfigurationMigration[] } }
  'GET deployment': { response: MachineSettingsView }
  'PUT deployment': { body: { revision: number; values: MachineValues }; response: MachineSettingsView }
  'GET worker-capabilities': { response: WorkerCapabilitiesView }
  'PUT worker-capabilities': { body: { revision: number; tools: string[]; skills: string[] }; response: WorkerCapabilitiesView }
  'POST worker-capabilities/application': { body: { revision: number; applicationId: string;
    action: 'cancel' | 'retry' | 'apply-now'; confirmation?: string }; response: WorkerCapabilitiesView }
  'GET github/connection': { response: GithubConnectionView }
  'POST github/connection': { body: GithubConnectionInput; response: GithubConnectionView }
  'POST github/connection/cancel': { body: { id: string }; response: GithubConnectionView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } | { retried: false; pending: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
