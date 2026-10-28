import { randomUUID } from "node:crypto";

import {
  AgentLockError,
  assertTaskTransition,
  canTransitionTask,
  isTerminalTaskStatus,
  taskHoldsAgentLock,
} from "../state.js";
import { canonicalJson } from "../config.js";
import type {
  AgentConfig,
  AgentRuntime,
  AgentStats,
  AgentView,
  BrokerState,
  LoadedConfig,
  OrchestratorConfig,
  SubmitTaskInput,
  Task,
  TaskFilter,
  TaskLogEntry,
  TaskStatus,
  TaskView,
  WorkerAdapter,
  WorkerEvent,
  WorkerFactory,
  WorkerResult,
  WorkerUsage,
  ScheduleConfig,
  ScheduleRuntime,
  ScheduleView,
} from "../types.js";
import type { EventBus } from "./event-bus.js";
import {
  STATE_SCHEMA_VERSION,
  type BrokerAction,
  type StateStore,
} from "./state-store.js";

export type BrokerErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "config_error"
  | "timeout"
  | "internal_error";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly details?: unknown;

  constructor(code: BrokerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Optional fields accepted by `submit` in addition to the shared input shape. */
export interface BrokerSubmitInput extends Omit<SubmitTaskInput, "title"> {
  /** Defaults to the first line of the prompt. */
  title?: string;
  /** Idempotency key. Re-submitting the same key returns the original task. */
  clientRequestId?: string;
  /** Optional client metadata attached to the task for display/debugging. */
  metadata?: Record<string, unknown>;
}

type StoredTask = Task & { metadata?: Record<string, unknown> };

export interface SchedulerRecovery {
  state?: BrokerState;
  actions?: BrokerAction[];
  clientRequests?: Record<string, string>;
  fingerprintMatches?: boolean;
}

export interface SchedulerOptions {
  config: OrchestratorConfig;
  configFingerprint: string;
  workerFactory: WorkerFactory;
  stateStore?: StateStore;
  events?: EventBus;
  clock?: () => Date;
  idGenerator?: () => string;
  maxActions?: number;
  maxTaskLogs?: number;
}

interface AgentSlot {
  runtime: AgentRuntime;
  worker: WorkerAdapter;
  /** False when a recovered awaiting-review task outlived its worker context. */
  contextValid: boolean;
  configKey: string;
}

const DEFAULT_MAX_ACTIONS = 100;
const DEFAULT_MAX_TASK_LOGS = 1_000;

function defaultStats(): AgentStats {
  return { tasksCompleted: 0, tasksFailed: 0, tasksCancelled: 0 };
}

/** Identity of a replica's runtime configuration; replica count is roster-level. */
function agentShapeKey(config: AgentConfig): string {
  const { replicas: _replicas, ...shape } = config;
  return canonicalJson(shape);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toAgentView(agent: AgentRuntime): AgentView {
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
  if (agent.stats !== undefined) view.stats = { ...agent.stats };
  return view;
}

function truncate(text: string, length = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}

function defaultTitle(input: BrokerSubmitInput): string {
  if (input.title !== undefined && input.title.trim()) return input.title.trim();
  const firstLine = input.prompt.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine ? truncate(firstLine, 80) : "Untitled task";
}

function taskMatchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(task.status)) return false;
  }
  if (filter.role !== undefined && task.role !== filter.role) return false;
  if (filter.agentId !== undefined && task.agentId !== filter.agentId) return false;
  return true;
}

function usageTotal(current: WorkerUsage | undefined, next: WorkerUsage | undefined): WorkerUsage | undefined {
  if (!next) return current;
  if (!current) return { ...next };
  const merged: WorkerUsage = {};
  const input = (current.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const output = (current.outputTokens ?? 0) + (next.outputTokens ?? 0);
  const cost = (current.cost ?? 0) + (next.cost ?? 0);
  if (input !== 0) merged.inputTokens = input;
  if (output !== 0) merged.outputTokens = output;
  if (cost !== 0) merged.cost = cost;
  return merged;
}

/** Advance a recurring due time past `now` without replaying every missed slot. */
function advanceAfter(after: Date, everyMs: number, now: Date): Date {
  let next = after.getTime() + everyMs;
  if (next <= now.getTime()) {
    const missed = Math.floor((now.getTime() - next) / everyMs) + 1;
    next += missed * everyMs;
  }
  return new Date(next);
}

/**
 * Broker scheduler and runner.
 *
 * Responsibilities:
 * - one long-lived worker per configured replica;
 * - strict FIFO dispatch per role to idle, unlocked replicas;
 * - task lock from assignment until close/cancel/failure;
 * - worker events -> task logs/agent activity + SSE;
 * - review rework in the same worker context;
 * - close/cancel/failure reset the worker before the replica is reused;
 * - durable snapshots/actions through StateStore.
 *
 * HTTP, CLI and extension code live outside this module.
 */
export class Scheduler {
  private config: OrchestratorConfig;
  private configFingerprint: string;
  private readonly workerFactory: WorkerFactory;
  private readonly store?: StateStore;
  private readonly events?: EventBus;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly maxActions: number;
  private readonly maxTaskLogs: number;

  private readonly slots: AgentSlot[] = [];
  private tasks: StoredTask[] = [];
  private actions: BrokerAction[] = [];
  private clientRequests = new Map<string, string>();
  private schedules: ScheduleRuntime[] = [];
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleTickInFlight = false;

  private startedAt = new Date().toISOString();
  private started = false;
  private starting = false;
  private stopping = false;
  private stopped = false;
  private drainQueued = false;
  private draining = false;

  constructor(options: SchedulerOptions) {
    this.config = options.config;
    this.configFingerprint = options.configFingerprint;
    this.workerFactory = options.workerFactory;
    if (options.stateStore) this.store = options.stateStore;
    if (options.events) this.events = options.events;
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
    this.maxTaskLogs = options.maxTaskLogs ?? DEFAULT_MAX_TASK_LOGS;
  }

  get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  get fingerprint(): string {
    return this.configFingerprint;
  }

  get currentConfig(): OrchestratorConfig {
    return this.config;
  }

  async start(recovery: SchedulerRecovery = {}): Promise<void> {
    if (this.started && !this.stopped) return;
    this.starting = true;
    this.stopped = false;
    this.stopping = false;
    this.startedAt = this.nowIso();
    this.actions = (recovery.actions ?? []).slice(-this.maxActions);
    this.clientRequests = new Map(Object.entries(recovery.clientRequests ?? {}));
    this.tasks = (recovery.state?.tasks ?? []).map((task) => ({
      ...clone(task),
      logs: Array.isArray(task.logs) ? task.logs.map((entry) => ({ ...entry })) : [],
    }));

    if (recovery.state && recovery.fingerprintMatches === false) {
      this.recordAction(
        "config.changed",
        "Broker restarted with a different config fingerprint; persisted tasks were retained.",
      );
    }

    // A scheduler instance may be restarted after stop(); old stopped slots are
    // replaced with fresh workers below.
    this.slots.length = 0;

    // In-flight work cannot survive a process restart. Preserve queued and
    // awaiting-review tasks; fail the rest with an explicit reason.
    for (const task of this.tasks) {
      if (task.status === "assigned" || task.status === "running") {
        task.status = "failed";
        task.error = "broker_restarted";
        task.finishedAt = this.nowIso();
        this.pushLog(task, {
          at: task.finishedAt,
          type: "error",
          text: "Broker restarted while this task was in flight; task marked failed.",
        });
      }
    }

    const persistedAgents = recovery.state?.agents ?? [];
    await this.createAgents(persistedAgents);

    // Restore locks for tasks that were awaiting review. Worker context is not
    // durable across a broker restart, so mark the replica for a fresh run if
    // the reviewer chooses rework.
    for (const task of this.tasks) {
      if (task.status !== "awaiting_review") continue;
      let slot = this.slots.find((candidate) => candidate.runtime.id === task.agentId);
      if (!slot || slot.runtime.role !== task.role) {
        slot = this.slots.find(
          (candidate) =>
            candidate.runtime.role === task.role &&
            candidate.runtime.status === "idle" &&
            candidate.runtime.currentTaskId === undefined,
        );
      }
      if (slot) {
        task.agentId = slot.runtime.id;
        slot.runtime.currentTaskId = task.id;
        slot.runtime.status = "awaiting_review";
        slot.contextValid = false;
      } else {
        task.agentId = undefined;
      }
    }

    const knownRoles = new Set(Object.keys(this.config.agents));
    for (const task of this.tasks) {
      if (task.status === "queued" && !knownRoles.has(task.role)) {
        task.status = "failed";
        task.error = "role_removed";
        task.finishedAt = this.nowIso();
        this.pushLog(task, {
          at: task.finishedAt,
          type: "error",
          text: `Role "${task.role}" is no longer configured; queued task failed.`,
        });
      }
    }

    this.recordAction("broker.started", "Broker scheduler started");
    this.started = true;
    this.starting = false;

    // Preserve dashboard enable/disable across restarts when the config did not
    // change; a changed YAML config is authoritative.
    const scheduleMode = recovery.fingerprintMatches === false ? "reload" : "start";
    this.reconcileSchedules(recovery.state?.schedules ?? [], this.clock(), scheduleMode);
    for (const task of this.tasks) this.emitTask(task);
    await this.persist();
    this.scheduleNextTick();
    this.scheduleDrain();
  }

  async stop(): Promise<void> {
    if (this.stopped || this.stopping) return;
    this.stopping = true;
    this.clearScheduleTimer();

    for (const task of this.tasks) {
      if (task.status !== "assigned" && task.status !== "running") continue;
      task.status = "failed";
      task.error = "broker_shutdown";
      task.finishedAt = this.nowIso();
      this.pushLog(task, {
        at: task.finishedAt,
        type: "error",
        text: "Broker shut down while this task was in flight; task marked failed.",
      });
      this.emitTask(task);
    }

    const busy = this.slots.filter(
      (slot) =>
        slot.runtime.currentTaskId !== undefined ||
        slot.runtime.status === "busy" ||
        slot.runtime.status === "starting",
    );
    await Promise.allSettled(
      busy.map(async (slot) => {
        try {
          await slot.worker.abort?.();
        } catch {
          // The worker may already be gone; stop below is authoritative.
        }
      }),
    );

    await Promise.allSettled(
      this.slots.map(async (slot) => {
        try {
          await slot.worker.stop();
        } catch {
          // Best-effort shutdown; state still records the stopped runtime.
        }
        slot.runtime.currentTaskId = undefined;
        slot.runtime.status = "stopped";
        slot.contextValid = false;
        this.emitAgent(slot);
      }),
    );

    this.recordAction("broker.stopped", "Broker scheduler stopped");
    await this.persist();
    this.stopping = false;
    this.stopped = true;
    this.started = false;
  }

  async submit(input: BrokerSubmitInput): Promise<Task> {
    this.assertRunning();
    const role = typeof input.role === "string" ? input.role.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!role) throw new BrokerError("invalid_request", "role is required");
    if (!prompt) throw new BrokerError("invalid_request", "prompt is required");
    if (!this.config.agents[role]) {
      throw new BrokerError("invalid_request", `role "${role}" is not defined in the agent config`, {
        role,
      });
    }
    if (
      input.acceptance !== undefined &&
      typeof input.acceptance !== "string"
    ) {
      throw new BrokerError("invalid_request", "acceptance must be a string");
    }

    const clientRequestId =
      typeof input.clientRequestId === "string" && input.clientRequestId.trim()
        ? input.clientRequestId.trim()
        : undefined;
    if (clientRequestId) {
      const existingId = this.clientRequests.get(clientRequestId);
      const existing = existingId ? this.tasks.find((task) => task.id === existingId) : undefined;
      if (existing) return clone(existing);
    }

    const now = this.nowIso();
    const task: StoredTask = {
      id: this.idGenerator(),
      title: defaultTitle(input),
      role,
      prompt,
      status: "queued",
      createdAt: now,
      attempts: 0,
      logs: [],
    };
    if (input.acceptance !== undefined && input.acceptance.trim()) {
      task.acceptance = input.acceptance.trim();
    }
    if (input.metadata !== undefined) task.metadata = clone(input.metadata);
    this.tasks.push(task);
    if (clientRequestId) this.clientRequests.set(clientRequestId, task.id);

    this.pushLog(task, {
      at: now,
      type: "status",
      text: `Queued for role "${role}".`,
      status: "queued",
    });
    this.recordAction("task.queued", `Task "${task.title}" queued`, { taskId: task.id });
    this.emitTask(task);
    await this.persist();
    this.scheduleDrain();
    return clone(task);
  }

  async review(taskId: string, decision: "close" | "rework", feedback?: string): Promise<Task> {
    this.assertRunning();
    const task = this.requireTask(taskId);
    if (task.status !== "awaiting_review") {
      throw new BrokerError(
        "conflict",
        `task ${taskId} is ${task.status}; review requires awaiting_review`,
        { taskId, status: task.status },
      );
    }
    const slot = this.slotForTask(task);
    if (!slot) {
      throw new BrokerError(
        "conflict",
        `task ${taskId} has no locked agent replica; cannot ${decision}`,
        { taskId, agentId: task.agentId },
      );
    }

    const now = this.nowIso();
    if (decision === "close") {
      assertTaskTransition(task.status, "closed");
      task.review = { decision: "close", at: now, attempt: task.attempts };
      task.status = "closed";
      task.finishedAt = now;
      task.error = undefined;
      this.pushLog(task, {
        at: now,
        type: "review",
        text: "Review accepted; task closed.",
        status: "closed",
      });
      this.recordAction("task.closed", `Task "${task.title}" closed`, {
        taskId: task.id,
        agentId: slot.runtime.id,
      });
      slot.runtime.stats = slot.runtime.stats ?? defaultStats();
      slot.runtime.stats.tasksCompleted += 1;
      slot.runtime.lastAction = `Closed "${truncate(task.title, 60)}"`;
      slot.runtime.lastActionAt = now;
      this.emitAgent(slot);
      this.emitTask(task);
      await this.persist();
      await this.releaseSlot(slot, task, { reset: true, abort: false });
      return clone(task);
    }

    if (decision !== "rework") {
      throw new BrokerError("invalid_request", `unknown review decision "${String(decision)}"`);
    }
    const message = typeof feedback === "string" ? feedback.trim() : "";
    if (!message) {
      throw new BrokerError("invalid_request", "rework requires non-empty feedback");
    }

    assertTaskTransition(task.status, "running");
    task.review = { decision: "rework", feedback: message, at: now, attempt: task.attempts };
    task.status = "running";
    task.attempts += 1;
    task.finishedAt = undefined;
    task.result = undefined;
    task.error = undefined;
    this.pushLog(task, {
      at: now,
      type: "review",
      text: `Rework requested: ${message}`,
      status: "running",
    });
    this.recordAction("task.rework", `Task "${task.title}" sent back for rework`, {
      taskId: task.id,
      agentId: slot.runtime.id,
    });
    slot.runtime.status = "busy";
    slot.runtime.lastAction = `Reworking "${truncate(task.title, 60)}"`;
    slot.runtime.lastActionAt = now;
    this.emitAgent(slot);
    this.emitTask(task);
    await this.persist();

    if (slot.contextValid) {
      void this.executeFeedback(slot, task, message);
    } else {
      // The worker context did not survive a broker restart. Rerun the task in
      // a fresh context with the reviewer feedback appended to the prompt.
      this.pushLog(task, {
        at: now,
        type: "status",
        text: "Worker context was not available after restart; rerunning in a fresh context with reviewer feedback.",
        status: "running",
      });
      void this.executeRun(slot, task, {
        promptSuffix: `\n\nReviewer feedback after the previous attempt:\n${message}`,
        rework: true,
      });
    }
    return clone(task);
  }

  async cancel(taskId: string): Promise<Task> {
    this.assertRunning();
    const task = this.requireTask(taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("conflict", `task ${taskId} is already ${task.status}`, {
        taskId,
        status: task.status,
      });
    }
    const slot = this.slotForTask(task);
    const wasRunning = task.status === "assigned" || task.status === "running";
    assertTaskTransition(task.status, "cancelled");
    const now = this.nowIso();
    task.status = "cancelled";
    task.finishedAt = now;
    this.pushLog(task, {
      at: now,
      type: "status",
      text: "Task cancelled.",
      status: "cancelled",
    });
    this.recordAction("task.cancelled", `Task "${task.title}" cancelled`, {
      taskId: task.id,
      ...(slot ? { agentId: slot.runtime.id } : {}),
    });
    if (slot) {
      slot.runtime.stats = slot.runtime.stats ?? defaultStats();
      slot.runtime.stats.tasksCancelled += 1;
      slot.runtime.lastAction = `Cancelled "${truncate(task.title, 60)}"`;
      slot.runtime.lastActionAt = now;
      this.emitAgent(slot);
    }
    this.emitTask(task);
    await this.persist();

    if (slot) {
      await this.releaseSlot(slot, task, { reset: true, abort: wasRunning });
    } else {
      this.scheduleDrain();
    }
    return clone(task);
  }

  /**
   * Apply a validated config reload. Reload is rejected while any task holds a
   * replica lock (assigned/running/awaiting_review); closing or cancelling those
   * tasks first avoids silently destroying worker context.
   */
  async applyConfig(loaded: LoadedConfig): Promise<OrchestratorConfig> {
    this.assertRunning();
    if (this.hasLockedTasks()) {
      throw new BrokerError(
        "conflict",
        "cannot reload while tasks are assigned, running or awaiting review",
      );
    }
    if (loaded.configFingerprint === this.configFingerprint) {
      this.config = loaded.config;
      return this.config;
    }

    const desired = new Map<string, AgentConfig>();
    for (const agentConfig of Object.values(loaded.config.agents)) {
      for (let replica = 1; replica <= agentConfig.replicas; replica += 1) {
        desired.set(`${agentConfig.role}#${replica}`, agentConfig);
      }
    }

    for (const slot of [...this.slots]) {
      const desiredConfig = desired.get(slot.runtime.id);
      const keep = desiredConfig && agentShapeKey(desiredConfig) === slot.configKey;
      if (keep) continue;
      await this.stopSlot(slot);
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
    }

    const existingIds = new Set(this.slots.map((slot) => slot.runtime.id));
    for (const [id, agentConfig] of desired) {
      if (existingIds.has(id)) continue;
      const replica = Number(id.slice(id.lastIndexOf("#") + 1));
      await this.addSlot(agentConfig, replica);
    }

    this.config = loaded.config;
    this.configFingerprint = loaded.configFingerprint;
    this.reconcileSchedules(this.schedules, this.clock(), "reload");
    const roles = new Set(Object.keys(this.config.agents));
    for (const task of this.tasks) {
      if (task.status === "queued" && !roles.has(task.role)) {
        task.status = "failed";
        task.error = "role_removed";
        task.finishedAt = this.nowIso();
        this.pushLog(task, {
          at: task.finishedAt,
          type: "error",
          text: `Role "${task.role}" was removed by reload; queued task failed.`,
        });
        this.emitTask(task);
      }
    }
    this.recordAction("config.reloaded", "Agent config reloaded");
    await this.persist();
    this.scheduleDrain();
    return this.config;
  }

  hasLockedTasks(): boolean {
    return (
      this.tasks.some((task) => taskHoldsAgentLock(task.status)) ||
      this.slots.some((slot) => slot.runtime.currentTaskId !== undefined)
    );
  }

  listAgents(): AgentView[] {
    return this.slots.map((slot) => toAgentView(slot.runtime));
  }

  listSchedules(): ScheduleView[] {
    return this.schedules.map((schedule) => clone(schedule));
  }

  /** Trigger one occurrence immediately, regardless of `nextRunAt` or enabled. */
  async runSchedule(scheduleId: string): Promise<Task> {
    this.assertRunning();
    const schedule = this.requireSchedule(scheduleId);
    const task = await this.createScheduledTask(schedule, this.nowIso(), "manual");
    this.recordAction("schedule.manual", `Schedule "${schedule.id}" triggered manually`, {
      taskId: task.id,
    });
    this.emitSchedule(schedule);
    await this.persist();
    return clone(task);
  }

  async setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<ScheduleView> {
    this.assertRunning();
    const schedule = this.requireSchedule(scheduleId);
    if (schedule.enabled === enabled) return clone(schedule);
    schedule.enabled = enabled;
    if (enabled && schedule.runOnStart) {
      schedule.nextRunAt = this.nowIso();
    }
    this.recordAction(
      enabled ? "schedule.enabled" : "schedule.disabled",
      `Schedule "${schedule.id}" ${enabled ? "enabled" : "disabled"}`,
    );
    this.emitSchedule(schedule);
    await this.persist();
    this.scheduleNextTick();
    return clone(schedule);
  }

  /**
   * Evaluate due schedules. Public and clock-driven so tests can advance time
   * deterministically; the broker also calls this from a timer.
   */
  async tickSchedules(now: Date = this.clock()): Promise<void> {
    if (!this.isStarted || this.scheduleTickInFlight) return;
    this.scheduleTickInFlight = true;
    try {
      let changed = false;
      for (const schedule of this.schedules) {
        if (!schedule.enabled) continue;
        const next = new Date(schedule.nextRunAt);
        if (!Number.isFinite(next.getTime()) || next.getTime() > now.getTime()) continue;

        const scheduledFor = schedule.nextRunAt;
        schedule.nextRunAt = advanceAfter(next, schedule.everyMs, now).toISOString();
        changed = true;

        const previous = schedule.lastTaskId
          ? this.tasks.find((task) => task.id === schedule.lastTaskId)
          : undefined;
        if (schedule.overlap === "skip" && previous && !isTerminalTaskStatus(previous.status)) {
          schedule.skippedRuns += 1;
          schedule.lastSkippedAt = scheduledFor;
          this.pushLog(previous, {
            at: this.nowIso(),
            type: "status",
            text: `Skipped scheduled occurrence ${scheduledFor}: previous task is still ${previous.status}.`,
          });
          this.recordAction(
            "schedule.skipped",
            `Schedule "${schedule.id}" skipped ${scheduledFor}: previous task still ${previous.status}`,
            { taskId: previous.id },
          );
          this.emitSchedule(schedule);
          continue;
        }

        await this.createScheduledTask(schedule, scheduledFor, "scheduled");
      }
      if (changed) await this.persist();
    } finally {
      this.scheduleTickInFlight = false;
      this.scheduleNextTick();
    }
  }

  listTasks(filter: TaskFilter = {}): TaskView[] {
    return this.tasks.filter((task) => taskMatchesFilter(task, filter)).map((task) => clone(task));
  }

  getTask(taskId: string): TaskView | undefined {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    return task ? clone(task) : undefined;
  }

  getOriginalTask(taskId: string): Task | undefined {
    return this.tasks.find((candidate) => candidate.id === taskId);
  }

  getActionLog(): BrokerAction[] {
    return this.actions.map((action) => ({ ...action }));
  }

  getClientRequests(): Record<string, string> {
    return Object.fromEntries(this.clientRequests);
  }

  getSnapshot(): BrokerState {
    return {
      version: STATE_SCHEMA_VERSION,
      configFingerprint: this.configFingerprint,
      agents: this.slots.map((slot) => clone(slot.runtime)),
      tasks: this.tasks.map((task) => clone(task)),
      schedules: this.schedules.map((schedule) => clone(schedule)),
      seq: this.events?.seq ?? 0,
      startedAt: this.startedAt,
    };
  }

  /** Delegated by the core; long-polls without polling the task array. */
  waitForReview(taskId: string, timeoutMs?: number): Promise<Task> {
    const initial = this.tasks.find((task) => task.id === taskId);
    if (!initial) {
      return Promise.reject(
        new BrokerError("not_found", `task ${taskId} was not found`, { taskId }),
      );
    }
    if (initial.status === "awaiting_review") return Promise.resolve(clone(initial));
    if (isTerminalTaskStatus(initial.status)) return Promise.reject(this.terminalError(initial));

    const events = this.events;
    if (!events) {
      return Promise.reject(
        new BrokerError("internal_error", "scheduler has no event bus for waitForReview"),
      );
    }

    const effectiveTimeout = timeoutMs === undefined ? 300_000 : timeoutMs;
    return new Promise<Task>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = events.subscribe((event) => {
        if (event.type !== "task.updated" || event.data.task.id !== taskId) return;
        const task = this.tasks.find((candidate) => candidate.id === taskId);
        if (!task) return;
        if (task.status === "awaiting_review") {
          cleanup();
          resolve(clone(task));
        } else if (isTerminalTaskStatus(task.status)) {
          cleanup();
          reject(this.terminalError(task));
        }
      });
      const cleanup = (): void => {
        unsubscribe();
        if (timer !== undefined) clearTimeout(timer);
      };
      if (effectiveTimeout > 0) {
        timer = setTimeout(() => {
          cleanup();
          const current = this.tasks.find((candidate) => candidate.id === taskId);
          reject(
            new BrokerError(
              "timeout",
              `timed out after ${effectiveTimeout}ms waiting for task ${taskId} review`,
              { taskId, status: current?.status },
            ),
          );
        }, effectiveTimeout);
        timer.unref?.();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Worker lifecycle
  // -------------------------------------------------------------------------

  private async createAgents(persistedAgents: AgentRuntime[]): Promise<void> {
    const previous = new Map(persistedAgents.map((agent) => [agent.id, agent]));
    for (const agentConfig of Object.values(this.config.agents)) {
      for (let replica = 1; replica <= agentConfig.replicas; replica += 1) {
        const id = `${agentConfig.role}#${replica}`;
        await this.addSlot(agentConfig, replica, previous.get(id));
      }
    }
  }

  private async addSlot(
    agentConfig: AgentConfig,
    replica: number,
    previous?: AgentRuntime,
  ): Promise<AgentSlot> {
    const id = `${agentConfig.role}#${replica}`;
    const runtime: AgentRuntime = {
      id,
      role: agentConfig.role,
      replica,
      config: { ...agentConfig },
      status: "starting",
      stats: previous?.stats ? { ...previous.stats } : defaultStats(),
      startedAt: this.nowIso(),
    };
    if (previous?.lastAction !== undefined) runtime.lastAction = previous.lastAction;
    if (previous?.lastActionAt !== undefined) runtime.lastActionAt = previous.lastActionAt;

    let worker: WorkerAdapter;
    try {
      worker = this.workerFactory.create(runtime);
    } catch (error) {
      runtime.status = "error";
      runtime.error = `worker_factory_failed: ${(error as Error).message}`;
      const broken: AgentSlot = {
        runtime,
        worker: {
          async start() {},
          async run() {
            throw new Error("worker factory failed");
          },
          async feedback() {
            throw new Error("worker factory failed");
          },
          async reset() {},
          async stop() {},
        },
        contextValid: false,
        configKey: agentShapeKey(agentConfig),
      };
      this.slots.push(broken);
      this.emitAgent(broken);
      return broken;
    }

    const slot: AgentSlot = {
      runtime,
      worker,
      contextValid: true,
      configKey: agentShapeKey(agentConfig),
    };
    this.slots.push(slot);
    this.emitAgent(slot);

    try {
      await worker.start();
      runtime.status = "idle";
      runtime.startedAt = this.nowIso();
      runtime.error = undefined;
      this.recordAction("agent.started", `Replica ${id} started`, { agentId: id });
    } catch (error) {
      runtime.status = "error";
      runtime.error = `worker_start_failed: ${(error as Error).message}`;
      this.recordAction("agent.error", `Replica ${id} failed to start: ${runtime.error}`, {
        agentId: id,
      });
    }
    this.emitAgent(slot);
    return slot;
  }

  private async stopSlot(slot: AgentSlot): Promise<void> {
    try {
      await slot.worker.stop();
    } catch {
      // Removal still proceeds; the process may already be dead.
    }
    slot.runtime.currentTaskId = undefined;
    slot.runtime.status = "stopped";
    slot.contextValid = false;
    this.emitAgent(slot);
  }

  private async recreateSlot(slot: AgentSlot): Promise<boolean> {
    try {
      await slot.worker.stop().catch(() => undefined);
    } catch {
      // best effort
    }
    try {
      slot.worker = this.workerFactory.create(slot.runtime);
      await slot.worker.start();
      slot.contextValid = true;
      slot.runtime.error = undefined;
      return true;
    } catch (error) {
      slot.contextValid = false;
      slot.runtime.error = `worker_restart_failed: ${(error as Error).message}`;
      return false;
    }
  }

  /**
   * Release a replica lock. The worker is reset (fresh context) before the
   * replica becomes dispatchable again. If reset fails, the replica is replaced;
   * if replacement also fails it stays in `error` and takes no work.
   */
  private async releaseSlot(
    slot: AgentSlot,
    task: Task,
    options: { reset: boolean; abort: boolean },
  ): Promise<void> {
    if (slot.runtime.currentTaskId !== task.id) {
      this.scheduleDrain();
      return;
    }
    slot.runtime.status = "resetting";
    slot.runtime.lastAction = `Releasing "${truncate(task.title, 60)}"`;
    slot.runtime.lastActionAt = this.nowIso();
    this.emitAgent(slot);

    if (options.abort) {
      try {
        await slot.worker.abort?.();
      } catch {
        // Reset/replacement below is the fallback.
      }
    }

    let resetOk = !options.reset;
    if (options.reset) {
      try {
        await slot.worker.reset();
        resetOk = true;
        slot.contextValid = true;
      } catch {
        resetOk = await this.recreateSlot(slot);
      }
    }

    slot.runtime.currentTaskId = undefined;
    if (resetOk) {
      slot.runtime.status = "idle";
      slot.runtime.error = undefined;
    } else {
      slot.runtime.status = "error";
    }
    this.emitAgent(slot);
    await this.persist();
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.stopping || this.stopped || !this.started) return;
    if (this.draining) {
      this.drainQueued = true;
      return;
    }
    queueMicrotask(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.stopping || this.stopped || !this.started) return;
    if (this.draining) {
      this.drainQueued = true;
      return;
    }
    this.draining = true;
    try {
      let dispatched = true;
      while (dispatched) {
        dispatched = false;
        for (const task of this.tasks) {
          if (task.status !== "queued") continue;
          const slot = this.slots.find(
            (candidate) =>
              candidate.runtime.role === task.role &&
              candidate.runtime.status === "idle" &&
              candidate.runtime.currentTaskId === undefined,
          );
          if (!slot) continue;
          this.dispatch(slot, task);
          dispatched = true;
        }
      }
    } finally {
      this.draining = false;
      if (this.drainQueued) {
        this.drainQueued = false;
        this.scheduleDrain();
      }
    }
  }

  private dispatch(slot: AgentSlot, task: StoredTask): void {
    if (slot.runtime.status !== "idle" || slot.runtime.currentTaskId !== undefined) {
      throw new AgentLockError(slot.runtime.id, slot.runtime.currentTaskId, task.id);
    }
    assertTaskTransition(task.status, "assigned");
    const now = this.nowIso();
    task.status = "assigned";
    task.agentId = slot.runtime.id;
    task.assignedAt = now;
    task.attempts += 1;
    task.error = undefined;
    slot.runtime.currentTaskId = task.id;
    slot.runtime.status = "busy";
    slot.runtime.lastAction = `Starting "${truncate(task.title, 60)}"`;
    slot.runtime.lastActionAt = now;
    this.pushLog(task, {
      at: now,
      type: "status",
      text: `Assigned to ${slot.runtime.id} (attempt ${task.attempts}).`,
      status: "assigned",
    });
    this.recordAction("task.assigned", `Task "${task.title}" assigned to ${slot.runtime.id}`, {
      taskId: task.id,
      agentId: slot.runtime.id,
    });
    this.emitAgent(slot);
    this.emitTask(task);
    void this.persist();
    void this.executeRun(slot, task);
  }

  private async executeRun(
    slot: AgentSlot,
    task: StoredTask,
    options: { promptSuffix?: string; rework?: boolean } = {},
  ): Promise<void> {
    const workerTask: Task =
      options.promptSuffix !== undefined
        ? { ...task, prompt: `${task.prompt}${options.promptSuffix}` }
        : task;
    try {
      const result = await slot.worker.run(workerTask, (event) =>
        this.handleWorkerEvent(slot, task, event),
      );
      await this.completeTask(slot, task, result);
    } catch (error) {
      await this.failTask(slot, task, error);
    }
  }

  private async executeFeedback(slot: AgentSlot, task: StoredTask, message: string): Promise<void> {
    try {
      const result = await slot.worker.feedback(message, (event) =>
        this.handleWorkerEvent(slot, task, event),
      );
      await this.completeTask(slot, task, result);
    } catch (error) {
      await this.failTask(slot, task, error);
    }
  }

  private handleWorkerEvent(slot: AgentSlot, task: StoredTask, event: WorkerEvent): void {
    if (event.type === "started") {
      if (task.status === "assigned" && canTransitionTask("assigned", "running")) {
        task.status = "running";
      }
      if (!task.startedAt) task.startedAt = event.at;
      slot.runtime.status = "busy";
      slot.runtime.sessionFile = event.sessionFile;
      slot.runtime.lastAction = `Running "${truncate(task.title, 60)}"`;
      slot.runtime.lastActionAt = event.at;
      this.pushLog(task, {
        at: event.at,
        type: "status",
        text: `Worker started for ${slot.runtime.id}.`,
        status: "running",
      });
      this.emitAgent(slot);
      this.emitTask(task);
      return;
    }

    if (event.type === "text") {
      slot.runtime.lastAction = truncate(event.text);
      slot.runtime.lastActionAt = event.at;
      this.pushLog(task, { at: event.at, type: "text", text: event.text });
      this.emitAgent(slot);
      return;
    }

    if (event.type === "tool_start") {
      slot.runtime.lastAction = `Tool ${event.tool}`;
      slot.runtime.lastActionAt = event.at;
      this.pushLog(task, {
        at: event.at,
        type: "tool_start",
        tool: event.tool,
        input: event.input,
        text: `Started ${event.tool}`,
      });
      this.emitAgent(slot);
      return;
    }

    if (event.type === "tool_end") {
      slot.runtime.lastAction = `Tool ${event.tool} ${event.status ?? "finished"}`;
      slot.runtime.lastActionAt = event.at;
      this.pushLog(task, {
        at: event.at,
        type: "tool_end",
        tool: event.tool,
        status: event.status,
        text: event.text ?? `${event.tool} ${event.status ?? "finished"}`,
      });
      this.emitAgent(slot);
      return;
    }

    if (event.type === "usage") {
      task.usage = usageTotal(task.usage, event.usage);
      slot.runtime.stats = slot.runtime.stats ?? defaultStats();
      if (event.usage.inputTokens !== undefined) {
        slot.runtime.stats.totalInputTokens =
          (slot.runtime.stats.totalInputTokens ?? 0) + event.usage.inputTokens;
      }
      if (event.usage.outputTokens !== undefined) {
        slot.runtime.stats.totalOutputTokens =
          (slot.runtime.stats.totalOutputTokens ?? 0) + event.usage.outputTokens;
      }
      if (event.usage.cost !== undefined) {
        slot.runtime.stats.totalCost = (slot.runtime.stats.totalCost ?? 0) + event.usage.cost;
      }
      return;
    }

    if (event.type === "completed") {
      slot.runtime.lastAction = `Completed "${truncate(task.title, 60)}"`;
      slot.runtime.lastActionAt = event.at;
      this.emitAgent(slot);
      return;
    }

    if (event.type === "failed") {
      task.error = event.error;
      slot.runtime.lastAction = `Failed: ${truncate(event.error)}`;
      slot.runtime.lastActionAt = event.at;
      this.pushLog(task, { at: event.at, type: "error", text: event.error });
      this.emitAgent(slot);
      this.emitTask(task);
    }
  }

  private async completeTask(
    slot: AgentSlot,
    task: StoredTask,
    result: WorkerResult,
  ): Promise<void> {
    if (isTerminalTaskStatus(task.status)) return;
    if (task.status !== "assigned" && task.status !== "running") return;

    if (task.status === "assigned") {
      if (!canTransitionTask("assigned", "running")) return;
      task.status = "running";
      if (!task.startedAt) task.startedAt = this.nowIso();
    }
    assertTaskTransition(task.status, "awaiting_review");
    const now = this.nowIso();
    task.status = "awaiting_review";
    task.result = result.finalText;
    task.finishedAt = now;
    task.error = undefined;
    if (result.usage && !task.usage) task.usage = { ...result.usage };
    if (result.sessionFile) slot.runtime.sessionFile = result.sessionFile;
    slot.runtime.status = "awaiting_review";
    slot.runtime.lastAction = `Awaiting review for "${truncate(task.title, 60)}"`;
    slot.runtime.lastActionAt = now;
    this.pushLog(task, {
      at: now,
      type: "status",
      text: "Result ready for review.",
      status: "awaiting_review",
    });
    this.recordAction("task.awaiting_review", `Task "${task.title}" ready for review`, {
      taskId: task.id,
      agentId: slot.runtime.id,
    });
    this.emitAgent(slot);
    this.emitTask(task);
    await this.persist();
  }

  private async failTask(slot: AgentSlot, task: StoredTask, error: unknown): Promise<void> {
    if (isTerminalTaskStatus(task.status)) return;
    if (!taskHoldsAgentLock(task.status) && task.status !== "queued") return;
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
    const now = this.nowIso();
    if (task.status !== "queued") {
      assertTaskTransition(task.status, "failed");
    }
    task.status = "failed";
    task.error = message;
    task.finishedAt = now;
    if (!task.logs.some((entry) => entry.type === "error" && entry.text === message)) {
      this.pushLog(task, { at: now, type: "error", text: message });
    }
    slot.runtime.stats = slot.runtime.stats ?? defaultStats();
    slot.runtime.stats.tasksFailed += 1;
    slot.runtime.lastAction = `Failed "${truncate(task.title, 60)}": ${truncate(message)}`;
    slot.runtime.lastActionAt = now;
    this.recordAction("task.failed", `Task "${task.title}" failed: ${truncate(message)}`, {
      taskId: task.id,
      agentId: slot.runtime.id,
    });
    this.emitTask(task);
    this.emitAgent(slot);
    await this.persist();
    await this.releaseSlot(slot, task, { reset: true, abort: false });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireTask(taskId: string): StoredTask {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new BrokerError("not_found", `task ${taskId} was not found`, { taskId });
    }
    return task;
  }

  private slotForTask(task: Task): AgentSlot | undefined {
    if (!task.agentId) return undefined;
    const slot = this.slots.find((candidate) => candidate.runtime.id === task.agentId);
    if (!slot) return undefined;
    if (slot.runtime.currentTaskId !== task.id && taskHoldsAgentLock(task.status)) {
      throw new AgentLockError(slot.runtime.id, slot.runtime.currentTaskId, task.id);
    }
    return slot;
  }

  private terminalError(task: Task): BrokerError {
    if (task.status === "failed") {
      return new BrokerError("conflict", `task ${task.id} failed: ${task.error ?? "unknown error"}`, {
        taskId: task.id,
        status: task.status,
        error: task.error,
      });
    }
    if (task.status === "cancelled") {
      return new BrokerError("conflict", `task ${task.id} was cancelled`, {
        taskId: task.id,
        status: task.status,
      });
    }
    return new BrokerError("conflict", `task ${task.id} is ${task.status}`, {
      taskId: task.id,
      status: task.status,
    });
  }

  private assertRunning(): void {
    if (!this.started || this.stopped || this.stopping) {
      throw new BrokerError("conflict", "broker is not running");
    }
  }

  private pushLog(task: StoredTask, entry: TaskLogEntry): void {
    task.logs.push(entry);
    if (task.logs.length > this.maxTaskLogs) {
      task.logs.splice(0, task.logs.length - this.maxTaskLogs);
    }
    this.events?.emit("task.log", { taskId: task.id, entry });
    void this.store?.appendTaskLog(task.id, entry).catch(() => undefined);
    this.emitTask(task);
  }

  private recordAction(
    type: string,
    message: string,
    ids: { taskId?: string; agentId?: string } = {},
  ): void {
    const action: BrokerAction = { at: this.nowIso(), type, message };
    if (ids.taskId !== undefined) action.taskId = ids.taskId;
    if (ids.agentId !== undefined) action.agentId = ids.agentId;
    this.actions.push(action);
    if (this.actions.length > this.maxActions) {
      this.actions.splice(0, this.actions.length - this.maxActions);
    }
  }

  private emitAgent(slot: AgentSlot): void {
    this.events?.emit("agent.updated", { agent: toAgentView(slot.runtime) });
    void this.persist().catch(() => undefined);
  }

  private emitTask(task: StoredTask): void {
    this.syncScheduleTask(task);
    this.events?.emit("task.updated", { task: clone(task) });
    void this.persist().catch(() => undefined);
  }

  private emitSchedule(schedule: ScheduleRuntime): void {
    this.events?.emit("schedule.updated", { schedule: clone(schedule) });
  }

  private syncScheduleTask(task: StoredTask): void {
    for (const schedule of this.schedules) {
      if (schedule.lastTaskId !== task.id) continue;
      if (schedule.lastTaskStatus === task.status) continue;
      schedule.lastTaskStatus = task.status;
      this.emitSchedule(schedule);
    }
  }

  private requireSchedule(scheduleId: string): ScheduleRuntime {
    const schedule = this.schedules.find((candidate) => candidate.id === scheduleId);
    if (!schedule) {
      throw new BrokerError("not_found", `schedule ${scheduleId} was not found`, { scheduleId });
    }
    return schedule;
  }

  private async createScheduledTask(
    schedule: ScheduleRuntime,
    scheduledFor: string,
    kind: "scheduled" | "manual",
  ): Promise<StoredTask> {
    const existing = schedule.lastTaskId
      ? this.tasks.find((task) => task.id === schedule.lastTaskId)
      : undefined;
    if (kind === "scheduled" && schedule.overlap === "skip" && existing && !isTerminalTaskStatus(existing.status)) {
      return existing;
    }

    const task = (await this.submit({
      role: schedule.role,
      title: schedule.title,
      prompt: schedule.prompt,
      ...(schedule.acceptance !== undefined ? { acceptance: schedule.acceptance } : {}),
      clientRequestId: `schedule:${schedule.id}:${kind}:${scheduledFor}`,
      metadata: { scheduleId: schedule.id, scheduledFor, trigger: kind },
    })) as StoredTask;

    schedule.lastRunAt = scheduledFor;
    schedule.lastTaskId = task.id;
    schedule.lastTaskStatus = task.status;
    this.recordAction("schedule.triggered", `Schedule "${schedule.id}" created task "${task.title}"`, {
      taskId: task.id,
    });
    this.pushLog(task, {
      at: this.nowIso(),
      type: "status",
      text: `Created by schedule "${schedule.id}" (${kind}, occurrence ${scheduledFor}).`,
      status: task.status,
    });
    this.emitSchedule(schedule);
    return task;
  }

  private reconcileSchedules(
    persisted: ScheduleRuntime[],
    now: Date,
    mode: "start" | "reload",
  ): void {
    const previous = new Map(persisted.map((schedule) => [schedule.id, schedule]));
    const configured = this.config.schedules ?? [];
    const next: ScheduleRuntime[] = [];
    for (const config of configured) {
      const old = previous.get(config.id);
      const runtime = this.createScheduleRuntime(config, old, now, mode);
      next.push(runtime);
      this.emitSchedule(runtime);
    }
    this.schedules = next;
    this.clearScheduleTimer();
  }

  private createScheduleRuntime(
    config: ScheduleConfig,
    previous: ScheduleRuntime | undefined,
    now: Date,
    mode: "start" | "reload",
  ): ScheduleRuntime {
    // Runtime enable/disable survives a broker restart, but an explicit
    // /agents reload applies the YAML value again.
    const enabled =
      mode === "start" && previous !== undefined ? previous.enabled : config.enabled;
    const runtime: ScheduleRuntime = {
      id: config.id,
      role: config.role,
      title: config.title,
      prompt: config.prompt,
      every: config.every,
      everyMs: config.everyMs,
      enabled,
      runOnStart: config.runOnStart,
      overlap: config.overlap,
      nextRunAt: new Date(now.getTime() + config.everyMs).toISOString(),
      skippedRuns: 0,
      createdAt: now.toISOString(),
    };
    if (config.acceptance !== undefined) runtime.acceptance = config.acceptance;
    if (!previous) {
      if (config.enabled && config.runOnStart) runtime.nextRunAt = now.toISOString();
      return runtime;
    }

    runtime.createdAt = previous.createdAt;
    runtime.lastRunAt = previous.lastRunAt;
    runtime.lastSkippedAt = previous.lastSkippedAt;
    runtime.lastTaskId = previous.lastTaskId;
    runtime.lastTaskStatus = previous.lastTaskStatus;
    runtime.skippedRuns = previous.skippedRuns ?? 0;

    const persistedNext = Date.parse(previous.nextRunAt);
    const intervalChanged = previous.everyMs !== config.everyMs;
    const reEnabled = config.enabled && !previous.enabled;
    if (!intervalChanged && !reEnabled && Number.isFinite(persistedNext)) {
      runtime.nextRunAt = previous.nextRunAt;
    } else {
      const anchor = runtime.lastRunAt ? Date.parse(runtime.lastRunAt) : now.getTime();
      runtime.nextRunAt = new Date(anchor + config.everyMs).toISOString();
      if (reEnabled && config.runOnStart) runtime.nextRunAt = now.toISOString();
    }
    return runtime;
  }

  private clearScheduleTimer(): void {
    if (this.scheduleTimer !== undefined) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
  }

  private scheduleNextTick(): void {
    if (this.stopping || this.stopped || !this.started) return;
    this.clearScheduleTimer();
    const due = this.schedules
      .filter((schedule) => schedule.enabled)
      .map((schedule) => Date.parse(schedule.nextRunAt))
      .filter((value) => Number.isFinite(value));
    if (due.length === 0) return;
    const delay = Math.max(0, Math.min(...due) - this.clock().getTime());
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = undefined;
      void this.tickSchedules();
    }, Math.min(delay, 2_147_483_647));
    this.scheduleTimer.unref?.();
  }

  private persist(): Promise<void> {
    if (!this.store) return Promise.resolve();
    return this.store.save(this.getSnapshot(), {
      actions: this.actions,
      clientRequests: this.getClientRequests(),
    });
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}
