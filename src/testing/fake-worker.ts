import type {
  AgentRuntime,
  Task,
  WorkerAdapter,
  WorkerEventListener,
  WorkerEvent,
  WorkerFactory,
  WorkerResult,
  WorkerUsage,
} from "../types.js";

/**
 * Deterministic in-memory worker used by unit and integration tests.
 *
 * It models the important runtime semantics without spawning processes:
 * - one context epoch per worker, incremented only by `reset()`;
 * - `feedback()` continues the same epoch/context;
 * - injected delays and failures;
 * - text and tool events with timestamps from an injectable clock.
 */

export interface FakeWorkerDelays {
  start?: number;
  run?: number;
  feedback?: number;
  reset?: number;
  stop?: number;
}

/** A number fails that many initial calls; a string fails every call. */
export type FakeWorkerFailure = number | string;

export interface FakeWorkerFailures {
  start?: FakeWorkerFailure;
  run?: FakeWorkerFailure;
  feedback?: FakeWorkerFailure;
  reset?: FakeWorkerFailure;
  stop?: FakeWorkerFailure;
}

export interface FakeWorkerCall {
  kind: "run" | "feedback";
  agentId: string;
  /** Present for `run`. */
  task?: Task;
  /** Present for `feedback`. */
  message?: string;
  epoch: number;
  /** 1-based attempt number within the current task, or 0 for feedback. */
  attempt: number;
}

export interface FakeWorkerToolCall {
  name: string;
  input?: unknown;
}

export interface FakeWorkerOptions {
  /** Injectable clock; defaults to `() => new Date()`. */
  clock?: () => Date;
  delays?: FakeWorkerDelays;
  failures?: FakeWorkerFailures;
  /** Tool events emitted on every run. Defaults to one `fake_tool` call; use [] for none. */
  tools?: FakeWorkerToolCall[];
  /** Override final text for run/feedback. */
  response?: (call: FakeWorkerCall) => string;
  usage?: WorkerUsage;
  stopReason?: string;
  /** Session file reported in started/completed events. */
  sessionFile?: string;
}

export interface FakeWorkerFeedbackRecord {
  message: string;
  epoch: number;
  /** ISO timestamp. */
  at: string;
}

export interface FakeWorkerSnapshot {
  agentId: string;
  epoch: number;
  status: "new" | "starting" | "idle" | "running" | "stopped";
  activeTaskId?: string;
  starts: number;
  runs: number;
  feedbacks: number;
  resets: number;
  stops: number;
  aborts: number;
  feedbacksReceived: FakeWorkerFeedbackRecord[];
  lastResult?: WorkerResult;
}

/** A WorkerEvent without the adapter-assigned timestamp. */
type WorkerEventPayload = WorkerEvent extends infer E
  ? E extends { at: string }
    ? Omit<E, "at">
    : never
  : never;

export class FakeWorkerAbortedError extends Error {
  constructor(agentId: string) {
    super(`fake worker ${agentId} aborted`);
    this.name = "FakeWorkerAbortedError";
  }
}

export class FakeWorker implements WorkerAdapter {
  readonly agent: AgentRuntime;
  readonly delays: FakeWorkerDelays;
  readonly failures: FakeWorkerFailures;

  private options: FakeWorkerOptions;
  private currentEpoch = 0;
  private currentStatus: FakeWorkerSnapshot["status"] = "new";
  private currentTask?: Task;
  private currentAttempt = 0;
  private lastResult?: WorkerResult;
  private startCalls = 0;
  private runCalls = 0;
  private feedbackCalls = 0;
  private resetCalls = 0;
  private stopCalls = 0;
  private abortCalls = 0;
  private readonly feedbackRecords: FakeWorkerFeedbackRecord[] = [];
  private abortController?: AbortController;
  private aborted = false;
  private readonly delayTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(agent: AgentRuntime, options: FakeWorkerOptions = {}) {
    this.agent = agent;
    this.options = options;
    this.delays = options.delays ?? {};
    this.failures = options.failures ?? {};
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  get activeTaskId(): string | undefined {
    return this.currentTask?.id;
  }

  extensionCounters(): { starts: number; runs: number; feedbacks: number; resets: number; stops: number; aborts: number } {
    return {
      starts: this.startCalls,
      runs: this.runCalls,
      feedbacks: this.feedbackCalls,
      resets: this.resetCalls,
      stops: this.stopCalls,
      aborts: this.abortCalls,
    };
  }

  snapshot(): FakeWorkerSnapshot {
    const snapshot: FakeWorkerSnapshot = {
      agentId: this.agent.id,
      epoch: this.currentEpoch,
      status: this.currentStatus,
      starts: this.startCalls,
      runs: this.runCalls,
      feedbacks: this.feedbackCalls,
      resets: this.resetCalls,
      stops: this.stopCalls,
      aborts: this.abortCalls,
      feedbacksReceived: [...this.feedbackRecords],
    };
    if (this.currentTask) snapshot.activeTaskId = this.currentTask.id;
    if (this.lastResult) snapshot.lastResult = this.lastResult;
    return snapshot;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    await this.delay(this.delays.start);
    if (this.currentStatus === "stopped") {
      throw new Error(`fake worker ${this.agent.id} is stopped`);
    }
    if (this.currentEpoch === 0) this.currentEpoch = 1;
    this.currentStatus = "idle";
  }

  async run(task: Task, onEvent: WorkerEventListener): Promise<WorkerResult> {
    this.aborted = false;
    if (this.currentStatus === "new") await this.start();
    if (this.aborted) {
      this.currentStatus = "idle";
      throw new FakeWorkerAbortedError(this.agent.id);
    }
    if (this.currentStatus === "running") {
      throw new Error(`fake worker ${this.agent.id} is already running task ${this.currentTask?.id ?? "<unknown>"}`);
    }
    this.runCalls += 1;
    this.currentAttempt = this.runCalls;
    const callIndex = this.runCalls;
    this.currentStatus = "running";
    this.currentTask = task;
    const controller = new AbortController();
    this.abortController = controller;
    this.emit(onEvent, { type: "started", sessionFile: this.options.sessionFile });

    let failureEmitted = false;
    try {
      await this.delay(this.delays.run, controller.signal);
      const failure = resolveFailure(this.failures.run, callIndex);
      if (failure) {
        this.currentStatus = "idle";
        this.emit(onEvent, { type: "failed", error: failure });
        failureEmitted = true;
        throw new Error(failure);
      }

      const tools =
        this.options.tools ?? [
          { name: "fake_tool", input: { agentId: this.agent.id, taskId: task.id, epoch: this.currentEpoch } },
        ];
      for (const tool of tools) {
        this.emit(onEvent, { type: "tool_start", tool: tool.name, input: tool.input });
        this.emit(onEvent, { type: "tool_end", tool: tool.name, status: "ok", text: `${tool.name} ok` });
      }

      const call: FakeWorkerCall = {
        kind: "run",
        agentId: this.agent.id,
        task,
        epoch: this.currentEpoch,
        attempt: this.currentAttempt,
      };
      const finalText =
        this.options.response?.(call) ??
        `${this.agent.id} completed "${task.title}" (epoch ${this.currentEpoch})`;
      const result = this.makeResult(finalText);
      this.emit(onEvent, { type: "text", text: finalText });
      if (result.usage) this.emit(onEvent, { type: "usage", usage: result.usage });
      this.emit(onEvent, { type: "completed", result });
      this.currentStatus = "idle";
      this.lastResult = result;
      return result;
    } catch (error) {
      this.currentStatus = "idle";
      if (!(error instanceof FakeWorkerAbortedError) && !failureEmitted) {
        this.emit(onEvent, { type: "failed", error: (error as Error).message });
      }
      throw error;
    } finally {
      if (this.abortController === controller) this.abortController = undefined;
    }
  }

  async feedback(message: string, onEvent: WorkerEventListener): Promise<WorkerResult> {
    if (this.currentStatus === "new" || this.currentStatus === "stopped") {
      throw new Error(`fake worker ${this.agent.id} has no task context for feedback`);
    }
    if (!this.currentTask) {
      throw new Error(`fake worker ${this.agent.id} has no task context for feedback`);
    }
    this.feedbackCalls += 1;
    const callIndex = this.feedbackCalls;
    this.currentStatus = "running";
    this.feedbackRecords.push({
      message,
      epoch: this.currentEpoch,
      at: this.nowIso(),
    });

    try {
      await this.delay(this.delays.feedback);
      const failure = resolveFailure(this.failures.feedback, callIndex);
      if (failure) {
        this.currentStatus = "idle";
        this.emit(onEvent, { type: "failed", error: failure });
        throw new Error(failure);
      }
      const call: FakeWorkerCall = {
        kind: "feedback",
        agentId: this.agent.id,
        task: this.currentTask,
        message,
        epoch: this.currentEpoch,
        attempt: 0,
      };
      const finalText =
        this.options.response?.(call) ??
        `rework applied in epoch ${this.currentEpoch}: ${message}`;
      const result = this.makeResult(finalText);
      this.emit(onEvent, { type: "text", text: finalText });
      if (result.usage) this.emit(onEvent, { type: "usage", usage: result.usage });
      this.emit(onEvent, { type: "completed", result });
      this.currentStatus = "idle";
      this.lastResult = result;
      return result;
    } catch (error) {
      this.currentStatus = "idle";
      throw error;
    }
  }

  async reset(): Promise<void> {
    if (this.currentStatus === "running") {
      throw new Error(`fake worker ${this.agent.id} cannot reset while running`);
    }
    this.resetCalls += 1;
    await this.delay(this.delays.reset);
    const failure = resolveFailure(this.failures.reset, this.resetCalls);
    if (failure) throw new Error(failure);
    this.currentEpoch += 1;
    this.currentTask = undefined;
    this.currentAttempt = 0;
    this.lastResult = undefined;
    this.currentStatus = "idle";
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    const failure = resolveFailure(this.failures.stop, this.stopCalls);
    this.abortController?.abort();
    await this.delay(this.delays.stop);
    this.currentStatus = "stopped";
    this.currentTask = undefined;
    this.abortController = undefined;
    if (failure) throw new Error(failure);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.aborted = true;
    this.abortController?.abort();
    this.currentStatus = "idle";
  }

  private makeResult(finalText: string): WorkerResult {
    const result: WorkerResult = { finalText };
    if (this.options.sessionFile) result.sessionFile = this.options.sessionFile;
    if (this.options.usage) result.usage = this.options.usage;
    if (this.options.stopReason) result.stopReason = this.options.stopReason;
    return result;
  }

  private nowIso(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }

  private emit(onEvent: WorkerEventListener, event: WorkerEventPayload): void {
    onEvent({ ...event, at: this.nowIso() } as WorkerEvent);
  }

  private delay(ms: number | undefined, signal?: AbortSignal): Promise<void> {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new FakeWorkerAbortedError(this.agent.id));
        return;
      }
      const timer = setTimeout(() => {
        this.delayTimers.delete(timer);
        if (signal?.aborted) reject(new FakeWorkerAbortedError(this.agent.id));
        else resolve();
      }, ms);
      this.delayTimers.add(timer);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.delayTimers.delete(timer);
          reject(new FakeWorkerAbortedError(this.agent.id));
        },
        { once: true },
      );
    });
  }
}

function resolveFailure(failure: FakeWorkerFailure | undefined, callIndex: number): string | undefined {
  if (failure === undefined) return undefined;
  if (typeof failure === "string") return failure;
  return callIndex <= failure ? "injected failure" : undefined;
}

export type FakeWorkerOptionsFactory = (agent: AgentRuntime) => FakeWorkerOptions;

export class FakeWorkerFactory implements WorkerFactory {
  readonly created: FakeWorker[] = [];

  constructor(private readonly options: FakeWorkerOptions | FakeWorkerOptionsFactory = {}) {}

  create(agent: AgentRuntime): FakeWorker {
    const options = typeof this.options === "function" ? this.options(agent) : this.options;
    const worker = new FakeWorker(agent, options);
    this.created.push(worker);
    return worker;
  }

  get(agentId: string): FakeWorker | undefined {
    return this.created.find((worker) => worker.agent.id === agentId);
  }

  snapshots(): FakeWorkerSnapshot[] {
    return this.created.map((worker) => worker.snapshot());
  }
}

export function createFakeWorkerFactory(
  options: FakeWorkerOptions | FakeWorkerOptionsFactory = {},
): FakeWorkerFactory {
  return new FakeWorkerFactory(options);
}
