/**
 * Shared domain contract for pi-agent-orchestrator.
 *
 * Every module (config, broker core, HTTP API, worker adapters, extension)
 * builds against these types. Keep them stable and serializable: the broker
 * state, HTTP DTOs and SSE payloads are all JSON.
 */

/** Reasoning effort accepted by Pi. Normalized to lower case by config loading. */
export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: readonly Effort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** A fixed role from `.pi/agents.yml`, after defaults are applied. */
export interface AgentConfig {
  /** Unique role name; defaults to the key in the `agents` map. */
  role: string;
  /** Instructions / description of the role's responsibilities. Required. */
  description: string;
  /** Model spec as written by the user, e.g. `anthropic/claude-sonnet-4-5`. */
  model: string;
  /** Optional explicit provider. May also be encoded in `model` as `provider/model`. */
  provider?: string;
  /** Reasoning effort; resolved to a Pi thinking level by the worker runtime. */
  effort?: Effort;
  /** Number of long-lived worker replicas for this role, 1..16. */
  replicas: number;
  /** Working directory for the role, relative to the broker/project root. */
  cwd?: string;
  /** Optional allow-list of Pi tool names. */
  tools?: string[];
}

export interface OrchestratorDefaults {
  effort?: Effort;
  replicas?: number;
  tools?: string[];
}

export interface ServerConfig {
  /** Loopback only in v1. */
  host: "127.0.0.1";
  /** 0 asks the OS for an ephemeral port. */
  port: number;
  dashboard: boolean;
}

/** Normalized project configuration returned by `loadConfig`. */
export interface OrchestratorConfig {
  version: number;
  server: ServerConfig;
  defaults?: OrchestratorDefaults;
  /** Keyed by role name. */
  agents: Record<string, AgentConfig>;
}

/** Result of loading and validating a config file. */
export interface LoadedConfig {
  config: OrchestratorConfig;
  /** sha256 of canonical JSON of `config`. */
  configFingerprint: string;
  /** Absolute path of the loaded file. */
  path: string;
}

export interface ParsedModelSpec {
  provider?: string;
  model: string;
}

export interface ResolvedModel {
  provider: string;
  model: string;
}

/**
 * Model resolution belongs to the worker runtime, not config parsing. The
 * runtime implementation decides how to map a model spec onto Pi's model
 * registry.
 */
export interface ModelResolver {
  resolve(agent: AgentConfig): Promise<ResolvedModel>;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentStatus =
  | "idle"
  | "starting"
  | "busy"
  | "awaiting_review"
  | "resetting"
  | "error"
  | "stopped";

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  tasksCancelled: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: number;
}

export interface AgentRuntime {
  /** Stable replica id: `${role}#${replica}` with replica starting at 1. */
  id: string;
  role: string;
  /** 1-based replica number. */
  replica: number;
  config: AgentConfig;
  status: AgentStatus;
  currentTaskId?: string;
  /** Short human-readable description of the latest worker activity. */
  lastAction?: string;
  /** ISO timestamp of `lastAction`. */
  lastActionAt?: string;
  pid?: number;
  sessionFile?: string;
  error?: string;
  /** ISO timestamp when the worker process/context started. */
  startedAt?: string;
  stats?: AgentStats;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "awaiting_review"
  | "closed"
  | "failed"
  | "cancelled";

export type ReviewDecision = "close" | "rework";

export interface TaskLogEntry {
  /** ISO timestamp. */
  at: string;
  type: "text" | "tool_start" | "tool_end" | "status" | "error" | "review";
  text: string;
  tool?: string;
  input?: unknown;
  status?: string;
}

export interface WorkerUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface TaskReview {
  decision: ReviewDecision;
  feedback?: string;
  /** ISO timestamp. */
  at: string;
  /** Attempt number the review applies to. */
  attempt: number;
}

export interface Task {
  id: string;
  title: string;
  role: string;
  prompt: string;
  acceptance?: string;
  status: TaskStatus;
  agentId?: string;
  /** ISO timestamps. */
  createdAt: string;
  assignedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  review?: TaskReview;
  /** Attempts started, including reworks. Starts at 0 while queued. */
  attempts: number;
  logs: TaskLogEntry[];
  usage?: WorkerUsage;
}

export interface SubmitTaskInput {
  title: string;
  role: string;
  prompt: string;
  acceptance?: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  role?: string;
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Worker adapter contract
// ---------------------------------------------------------------------------

export interface WorkerResult {
  finalText: string;
  sessionFile?: string;
  usage?: WorkerUsage;
  stopReason?: string;
}

export interface WorkerEventBase {
  /** ISO timestamp assigned by the worker adapter. */
  at: string;
}

export type WorkerEvent =
  | (WorkerEventBase & { type: "started"; sessionFile?: string })
  | (WorkerEventBase & { type: "text"; text: string })
  | (WorkerEventBase & { type: "tool_start"; tool: string; input?: unknown })
  | (WorkerEventBase & { type: "tool_end"; tool: string; status?: string; text?: string })
  | (WorkerEventBase & { type: "usage"; usage: WorkerUsage })
  | (WorkerEventBase & { type: "completed"; result: WorkerResult })
  | (WorkerEventBase & { type: "failed"; error: string });

export type WorkerEventListener = (event: WorkerEvent) => void;

/**
 * One long-lived worker process/context for one agent replica.
 *
 * `run` starts a task and resolves after the model run settles. `feedback`
 * continues the SAME context for a rework. `reset` discards context before the
 * next unrelated task. Only `feedback` preserves context.
 */
export interface WorkerAdapter {
  start(): Promise<void>;
  run(task: Task, onEvent: WorkerEventListener): Promise<WorkerResult>;
  feedback(message: string, onEvent: WorkerEventListener): Promise<WorkerResult>;
  reset(): Promise<void>;
  stop(): Promise<void>;
  abort?(): Promise<void>;
}

export interface WorkerFactory {
  create(agent: AgentRuntime): WorkerAdapter;
}

// ---------------------------------------------------------------------------
// Broker state and API/SSE DTOs
// ---------------------------------------------------------------------------

export interface BrokerState {
  version: number;
  configFingerprint: string;
  agents: AgentRuntime[];
  tasks: Task[];
  /** Monotonic event/state sequence number, starts at 0. */
  seq: number;
  /** ISO timestamp when the broker started. */
  startedAt: string;
}

export interface AgentView {
  id: string;
  role: string;
  replica: number;
  model: string;
  provider?: string;
  effort?: Effort;
  status: AgentStatus;
  currentTaskId?: string;
  lastAction?: string;
  lastActionAt?: string;
  pid?: number;
  sessionFile?: string;
  error?: string;
  startedAt?: string;
  stats?: AgentStats;
}

/** API representation of a task. Currently identical to the domain task. */
export type TaskView = Task;

export interface HealthView {
  ok: boolean;
  name: string;
  version: string;
  pid: number;
  /** ISO timestamp. */
  startedAt: string;
  uptimeMs: number;
  configFingerprint: string;
  agents: {
    total: number;
    idle: number;
    busy: number;
    awaitingReview: number;
    error: number;
  };
  tasks: {
    total: number;
    queued: number;
    running: number;
    awaitingReview: number;
    closed: number;
    failed: number;
    cancelled: number;
  };
}

export interface ReviewRequest {
  decision: ReviewDecision;
  feedback?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface SSEEventMap {
  snapshot: BrokerState;
  "agent.updated": { agent: AgentView };
  "task.updated": { task: TaskView };
  "task.log": { taskId: string; entry: TaskLogEntry };
  "broker.updated": { health: HealthView };
}

export type SSEEventType = keyof SSEEventMap;

export type SSEEvent = {
  [K in SSEEventType]: {
    /** Monotonic broker sequence number. */
    seq: number;
    /** ISO timestamp. */
    at: string;
    type: K;
    data: SSEEventMap[K];
  };
}[SSEEventType];

export type SSEListener = (event: SSEEvent) => void;

// ---------------------------------------------------------------------------
// Core interface used by the HTTP API and the Pi extension
// ---------------------------------------------------------------------------

export interface OrchestratorCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  submit(input: SubmitTaskInput): Promise<Task>;
  /** Resolves when the task enters `awaiting_review`; rejects on timeout. */
  waitForReview(taskId: string, timeoutMs?: number): Promise<Task>;
  review(taskId: string, decision: ReviewDecision, feedback?: string): Promise<Task>;
  cancel(taskId: string): Promise<Task>;
  listAgents(): AgentView[];
  listTasks(filter?: TaskFilter): TaskView[];
  getTask(taskId: string): TaskView | undefined;
  getSnapshot(): BrokerState;
  /** Returns an unsubscribe function. */
  subscribe(listener: SSEListener): () => void;
  reload(): Promise<OrchestratorConfig>;
}
