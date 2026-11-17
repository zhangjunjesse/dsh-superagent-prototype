/** Native DSH boundary for the original application mechanisms.
 *
 * The application owns Store/Engine/Settings/Prompts and original execution rules. A transport
 * implements these ports with real DSH Agents, AgentDelivery, jobs and subagents in the host.
 * A session view is an observation, never authority to execute a tool or deliver new work.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RoleModel } from '../policy.ts'
import type { Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { Deployment } from '../deployment.ts'
import type { Store } from './store.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

export interface NativeSession { id: string; status: 'idle' | 'running' }
export type NativeDeliveryMode = 'queue' | 'steer' | { inject: string }
export interface NativeTool { name: string; description: string; parameters: Record<string, unknown> }
export interface NativeSkill { name: string; description: string; content: string; resourceDirectory?: string }
export interface NativeSessionPolicy {
  sessionId: string; role: 'orchestrator' | 'worker'; ticketId?: string; assignmentId?: string; cwd: string;
  promptRevision: number; prompt: string; complete: boolean;
  /** Original Settings/environment.root, sampled with this policy; distinct from a ticket's cwd. */
  skillDirectory: string;
  skills: NativeSkill[]; tools: NativeTool[];
  /** Organization-selected native skills; loading a skill never grants its referenced tools. */
  selectedSkills?: string[];
  /** Original role limits intersected with configured organization/mandate capabilities. */
  allowedTools: string[]; initialModel: RoleModel | null;
  environment: Record<string, string | undefined>;
}
export type NativeSessionEvent =
  /** Captured synchronously on real attachment and ordered before subsequent native events. */
  | { kind: 'restored'; sessionId: string; status: 'idle' | 'running'; events: readonly SessionEvent[] }
  | { kind: 'status'; sessionId: string; status: 'idle' | 'running'; cancelled: boolean }
  | { kind: 'claimed'; sessionId: string; human: boolean }
  | { kind: 'event'; sessionId: string; event: SessionEvent }
  | { kind: 'error'; sessionId: string; error: unknown }
  | { kind: 'disposed'; sessionId: string }

export interface NativeSessionCallbacks {
  /** Called before each real prompt assembly; bind=true persists its original prompt revision. */
  policy(sessionId: string, bind: boolean): Promise<NativeSessionPolicy> | NativeSessionPolicy;
  /** Validate against the actual owner before native execution, never a copied Ticket. */
  authorize(sessionId: string, operation: 'request' | 'tool' | 'delivery', toolName?: string): Promise<void> | void;
  /** Synchronously authorize receipt cancellation; the transport writes its terminal receipt without an await. */
  authorizeCapabilityStop(operationId: string): void;
  /** Synchronous owner state for atomic receipt arbitration; never grants execution authority. */
  capabilityFrozen(): boolean;
  tool(sessionId: string, name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  event(event: NativeSessionEvent): void;
  /** Resolved from the actual instance owner for an already-scoped source image read. */
  sourceContext?(sessionId: string, triggerId: string): NativeSourceContext;
}
export interface NativeSourceContext {
  trigger: Trigger; settings: Settings;
  deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>;
  environment: Record<string, string | undefined>;
}

export interface SessionNativePort {
  /** Installation is scoped to one durable instance binding and is released on owner shutdown. */
  install(callbacks: NativeSessionCallbacks): () => void;
  /** New/rebound Agents publish their actual restored snapshot through the ordered event journal;
   * its owner acknowledgment precedes this return, so a separate history read cannot overwrite newer events.
   */
  ensure(input: { sessionId: string; cwd: string; title: string; role: 'orchestrator' | 'worker'; model: RoleModel | null }): Promise<NativeSession>;
  /** Conservative host observation for display/slot accounting; absence/uncertainty must not grant admission. */
  current(sessionId: string): NativeSession | undefined;
  holds(sessionId: string, requestId: string): Promise<boolean>;
  /** The host uses the original AgentDelivery and flushes real Session persistence before returning.
   * Transport staging, exact operation identity and revocation are durable. The host cannot start
   * the admitted model request before the owning application acknowledges its accepted receipt.
   */
  deliver(input: { sessionId: string; requestId: string; text: string; mode: NativeDeliveryMode },
    callbacks?: { authorize?: () => void; accepted?: () => void }): Promise<void>;
  inspect(sessionId: string): Promise<readonly SessionEvent[]>;
  /** Preserve the original source image reader and actual model/attachment validation. */
  readSourceImage(sessionId: string, input: { trigger: Trigger; message: { id: string; text: string }; imageKey: string; stateDir: string }, signal: AbortSignal): Promise<unknown>;
  flush(): Promise<void>;
  modelCatalog(): Promise<ModelCatalog>;
  resolveModel(model: RoleModel): Promise<RoleModel>;
}

export interface ExecutorNativePort {
  current(sessionId: string): NativeSession | undefined;
  /** Ordered host events have durable cursors; transport retries must not repeat domain effects. */
  listen(listener: (event: NativeSessionEvent) => void): () => void;
  cancel(sessionId: string, keepInbox: boolean): Promise<void>;
  whenIdle(sessionId: string): Promise<void>;
  removePending(sessionId: string, messageIds: string[]): Promise<void>;
  events(sessionId: string): Promise<readonly SessionEvent[]>;
  runPrepare(command: string, cwd: string, environment: Record<string, string | undefined>, signal: AbortSignal): Promise<void>;
  verifyDirectory(directory: string, signal: AbortSignal): Promise<void>;
  stopBackground(sessionId: string, reason: string, keepInbox: boolean): Promise<void>;
  stopSubagents(sessionId: string, keepInbox: boolean): Promise<void>;
  runningJobs(sessionId: string, except?: ReadonlySet<string>): Promise<{ id: string; name: string }[]>;
  collectJob(sessionId: string, job: { id: string; name: string }, signal: AbortSignal): Promise<{ name: string; status: string } | undefined>;
  untilQuiet(sessionId: string, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean>;
  killJobs(sessionId: string, reason: string, except?: ReadonlySet<string>): Promise<void>;
}

/** Setup/Commands need per-operation environments: changing process.env would cross organizations. */
export interface DeploymentNativePort {
  probe(argv: string[], cwd: string, environment: Record<string, string | undefined>, signal: AbortSignal): Promise<string>;
  modelCatalog(): Promise<ModelCatalog>;
  resolveModel(model: RoleModel): Promise<RoleModel>;
}

export interface RuntimeNativePorts {
  sessions: SessionNativePort; executor: ExecutorNativePort; deployment: DeploymentNativePort;
  /** Bind event consumption and its transport cursor to the real owner's transaction. */
  bindStore?(store: Pick<Store, 'atomic' | 'get' | 'set'>): void;
}
