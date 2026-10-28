import type {
  AgentConfig,
  AgentRuntime,
  AgentView,
  BrokerState,
  OrchestratorConfig,
  OrchestratorCore,
  ReviewDecision,
  SSEEvent,
  SSEListener,
  SubmitTaskInput,
  Task,
  TaskFilter,
  TaskLogEntry,
  TaskStatus,
  TaskView,
} from "../../src/types.js";

export const developerConfig: AgentConfig = {
  role: "developer",
  description: "Implement assigned work.",
  model: "test/fake-model",
  effort: "medium",
  replicas: 1,
};

export function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 0, dashboard: true },
    agents: { developer: developerConfig },
    ...overrides,
  };
}

export function makeRuntimeAgent(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  const config = overrides.config ?? developerConfig;
  return {
    id: "developer#1",
    role: "developer",
    replica: 1,
    config,
    status: "idle",
    startedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** In-memory OrchestratorCore used by HTTP/dashboard tests. */
export class StubCore implements OrchestratorCore {
  agents: AgentRuntime[];
  tasks: Task[] = [];
  listeners = new Set<SSEListener>();
  startedAt: string;
  configFingerprint = "stub-fingerprint";
  seq = 0;
  reloadCalls = 0;
  private nextTaskId = 1;

  constructor(agents: AgentRuntime[] = [makeRuntimeAgent()], startedAt?: string) {
    this.agents = agents;
    this.startedAt = startedAt ?? new Date().toISOString();
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async submit(input: SubmitTaskInput): Promise<Task> {
    const task: Task = {
      id: `task-${this.nextTaskId++}`,
      title: input.title,
      role: input.role,
      prompt: input.prompt,
      status: "queued",
      createdAt: new Date().toISOString(),
      attempts: 0,
      logs: [],
    };
    if (input.acceptance !== undefined) task.acceptance = input.acceptance;
    this.tasks.push(task);
    this.emit("task.updated", { task });
    return task;
  }

  async waitForReview(taskId: string): Promise<Task> {
    const task = this.getTaskOrThrow(taskId);
    return task;
  }

  async review(taskId: string, decision: ReviewDecision, feedback?: string): Promise<Task> {
    const task = this.getTaskOrThrow(taskId);
    if (task.status !== "awaiting_review") {
      throw new Error(`task ${taskId} is not awaiting review (status ${task.status})`);
    }
    task.review = {
      decision,
      at: new Date().toISOString(),
      attempt: Math.max(1, task.attempts),
    };
    if (decision === "rework") {
      if (!feedback || feedback.trim().length === 0) {
        throw new Error("rework requires non-empty feedback");
      }
      task.review.feedback = feedback;
      task.status = "running";
      task.attempts += 1;
      this.setAgentStatus(task.agentId, "busy");
    } else {
      task.status = "closed";
      task.finishedAt = new Date().toISOString();
      this.releaseAgent(task.agentId);
    }
    this.emit("task.updated", { task });
    return task;
  }

  async cancel(taskId: string): Promise<Task> {
    const task = this.getTaskOrThrow(taskId);
    if (task.status === "closed" || task.status === "failed" || task.status === "cancelled") {
      throw new Error(`task ${taskId} is already ${task.status}`);
    }
    task.status = "cancelled";
    task.finishedAt = new Date().toISOString();
    this.releaseAgent(task.agentId);
    this.emit("task.updated", { task });
    return task;
  }

  listAgents(): AgentView[] {
    return this.agents.map((agent) => {
      const view: AgentView = {
        id: agent.id,
        role: agent.role,
        replica: agent.replica,
        model: agent.config.model,
        status: agent.status,
      };
      if (agent.config.provider !== undefined) view.provider = agent.config.provider;
      if (agent.config.effort !== undefined) view.effort = agent.config.effort;
      if (agent.currentTaskId !== undefined) view.currentTaskId = agent.currentTaskId;
      if (agent.lastAction !== undefined) view.lastAction = agent.lastAction;
      if (agent.lastActionAt !== undefined) view.lastActionAt = agent.lastActionAt;
      if (agent.pid !== undefined) view.pid = agent.pid;
      if (agent.sessionFile !== undefined) view.sessionFile = agent.sessionFile;
      if (agent.error !== undefined) view.error = agent.error;
      if (agent.startedAt !== undefined) view.startedAt = agent.startedAt;
      if (agent.stats !== undefined) view.stats = agent.stats;
      return view;
    });
  }

  listTasks(filter: TaskFilter = {}): TaskView[] {
    const statuses =
      filter.status === undefined
        ? undefined
        : Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
    return this.tasks.filter((task) => {
      if (statuses && !statuses.includes(task.status)) return false;
      if (filter.role && task.role !== filter.role) return false;
      if (filter.agentId && task.agentId !== filter.agentId) return false;
      return true;
    });
  }

  getTask(taskId: string): TaskView | undefined {
    return this.tasks.find((task) => task.id === taskId);
  }

  getSnapshot(): BrokerState {
    return {
      version: 1,
      configFingerprint: this.configFingerprint,
      agents: this.agents,
      tasks: this.tasks,
      seq: this.seq,
      startedAt: this.startedAt,
    };
  }

  subscribe(listener: SSEListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async reload(): Promise<OrchestratorConfig> {
    this.reloadCalls += 1;
    return makeConfig();
  }

  /** Test helper: emit an arbitrary SSE event and advance the broker sequence. */
  emit<T extends SSEEvent["type"]>(
    type: T,
    data: Extract<SSEEvent, { type: T }>["data"],
  ): SSEEvent {
    this.seq += 1;
    const event = {
      seq: this.seq,
      at: new Date().toISOString(),
      type,
      data,
    } as SSEEvent;
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Test helper: put a task straight into a state that needs review. */
  markAwaitingReview(taskId: string, agentId = "developer#1"): Task {
    const task = this.getTaskOrThrow(taskId);
    task.status = "awaiting_review";
    task.agentId = agentId;
    task.assignedAt = task.assignedAt ?? new Date().toISOString();
    task.startedAt = task.startedAt ?? new Date().toISOString();
    task.attempts = Math.max(1, task.attempts);
    task.logs.push({
      at: new Date().toISOString(),
      type: "text",
      text: "stub result ready for review",
    });
    task.result = "stub result";
    const agent = this.agents.find((entry) => entry.id === agentId);
    if (agent) {
      agent.currentTaskId = task.id;
      agent.status = "awaiting_review";
      agent.lastAction = "awaiting review";
      agent.lastActionAt = new Date().toISOString();
    }
    return task;
  }

  addLog(taskId: string, entry: TaskLogEntry): void {
    const task = this.getTaskOrThrow(taskId);
    task.logs.push(entry);
    this.emit("task.log", { taskId, entry });
  }

  private getTaskOrThrow(taskId: string): Task {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error(`task "${taskId}" was not found`);
    return task;
  }

  private releaseAgent(agentId: string | undefined): void {
    if (!agentId) return;
    const agent = this.agents.find((entry) => entry.id === agentId);
    if (!agent) return;
    agent.currentTaskId = undefined;
    agent.status = "idle";
    agent.lastAction = "idle";
    agent.lastActionAt = new Date().toISOString();
  }

  private setAgentStatus(agentId: string | undefined, status: AgentRuntime["status"]): void {
    if (!agentId) return;
    const agent = this.agents.find((entry) => entry.id === agentId);
    if (agent) agent.status = status;
  }
}

export async function readSseEvents(
  response: Response,
  count: number,
  timeoutMs = 4000,
): Promise<SSEEvent[]> {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SSEEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (events.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out after reading ${events.length} SSE events`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out waiting for SSE data")),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) events.push(JSON.parse(data) as SSEEvent);
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released.
    }
  }
  return events;
}

export type { TaskStatus };
