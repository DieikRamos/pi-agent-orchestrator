import type { AgentRuntime, Task, TaskStatus } from "./types.js";

/**
 * Pure task/agent state-machine invariants.
 *
 * The scheduler owns mutation and persistence; these helpers are the shared
 * contract used by the scheduler, review flow and tests.
 */

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["assigned", "cancelled", "failed"],
  assigned: ["running", "cancelled", "failed"],
  running: ["awaiting_review", "cancelled", "failed"],
  awaiting_review: ["closed", "running", "cancelled", "failed"],
  closed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["closed", "failed", "cancelled"]);
const LOCKING_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "assigned",
  "running",
  "awaiting_review",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * A replica is locked to a task from assignment until review closes/rejects the
 * task or the task fails/is cancelled. Only `awaiting_review -> running`
 * (rework) is a valid transition while keeping the same worker context.
 */
export function taskHoldsAgentLock(status: TaskStatus): boolean {
  return LOCKING_STATUSES.has(status);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export class TaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`invalid task transition ${from} -> ${to}`);
    this.name = "TaskTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new TaskTransitionError(from, to);
}

export class AgentLockError extends Error {
  readonly agentId: string;
  readonly currentTaskId?: string;
  readonly requestedTaskId?: string;

  constructor(agentId: string, currentTaskId?: string, requestedTaskId?: string) {
    super(
      currentTaskId
        ? `agent ${agentId} is locked to task ${currentTaskId}` +
            (requestedTaskId ? ` and cannot take task ${requestedTaskId}` : "")
        : `task ${requestedTaskId ?? "<unknown>"} cannot be attached to agent ${agentId} without a lock`,
    );
    this.name = "AgentLockError";
    this.agentId = agentId;
    this.currentTaskId = currentTaskId;
    this.requestedTaskId = requestedTaskId;
  }
}

/**
 * Enforce the one-task-per-replica lock. Call before assigning a task to an
 * agent and before any operation that assumes the agent still owns the task.
 */
export function assertAgentTaskLock(
  agent: Pick<AgentRuntime, "id" | "currentTaskId">,
  task: Pick<Task, "id" | "status">,
): void {
  const locked = taskHoldsAgentLock(task.status);
  if (locked && agent.currentTaskId !== task.id) {
    throw new AgentLockError(agent.id, agent.currentTaskId, task.id);
  }
  if (agent.currentTaskId !== undefined && agent.currentTaskId !== task.id) {
    throw new AgentLockError(agent.id, agent.currentTaskId, task.id);
  }
}
