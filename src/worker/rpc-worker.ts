import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  RpcClient,
  getPackageDir,
  type RpcClientOptions,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentRuntime,
  ResolvedModel,
  Task,
  WorkerAdapter,
  WorkerEvent,
  WorkerEventListener,
  WorkerResult,
  WorkerUsage,
} from "../types.js";

/**
 * Real Pi worker adapter.
 *
 * One `RpcWorker` owns one long-lived Pi RPC subprocess. Tasks and rework
 * feedback are prompts in the same session; `reset()` starts a genuinely new
 * session before an unrelated task is allowed to reuse the replica.
 *
 * The adapter is deliberately tolerant of a thin fake client in tests: it only
 * uses the public `RpcClient` surface below.
 */

export interface RpcSessionStateLike {
  sessionFile?: string;
  sessionId?: string;
  messageCount?: number;
  thinkingLevel?: string;
  isStreaming?: boolean;
}

export interface RpcUsageLike {
  input?: number;
  output?: number;
  cost?: number | { total?: number };
}

export interface RpcMessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: RpcUsageLike;
}

export interface RpcSessionEventLike {
  type?: string;
  aborted?: boolean;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    content?: string;
  };
  message?: RpcMessageLike;
  usage?: RpcUsageLike;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  level?: string;
}

/** Minimal RpcClient surface used by this adapter. */
export interface RpcClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: RpcSessionEventLike) => void): () => void;
  prompt(message: string): Promise<unknown>;
  abort(): Promise<void>;
  newSession(parentSession?: string): Promise<{ cancelled?: boolean }>;
  getState(): Promise<RpcSessionStateLike>;
  getLastAssistantText(): Promise<string | null>;
  setThinkingLevel?(level: ThinkingLevel): Promise<void>;
  getAvailableThinkingLevels?(): Promise<ThinkingLevel[]>;
  getStderr?(): string;
}

export type RpcClientFactory = (options: RpcClientOptions) => RpcClientLike;

export interface RpcWorkerOptions {
  agent: AgentRuntime;
  /** Resolved `/model` pair from `ModelResolver`. */
  model: ResolvedModel;
  /** Effective thinking level; validated by the factory before spawning. */
  thinkingLevel?: ThinkingLevel;
  /** Project root used to resolve a role-relative `cwd`. */
  projectRoot: string;
  /** Directory that holds worker session files. */
  sessionsDir: string;
  /** Defaults to `<projectRoot>/<agent.config.cwd>`. */
  cwd?: string;
  /** Per-run deadline, including feedback runs. Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Startup deadline. Defaults to 60 seconds. */
  startTimeoutMs?: number;
  /** Reset/new-session deadline. Defaults to 60 seconds. */
  resetTimeoutMs?: number;
  /** Extra environment variables for the worker process. */
  env?: Record<string, string>;
  /** Explicit Pi CLI path; defaults to the installed package's dist/cli.js. */
  cliPath?: string;
  /** Extra CLI args appended after the required worker args. */
  args?: string[];
  clientFactory?: RpcClientFactory;
  clock?: () => Date;
  maxPayloadChars?: number;
}

export class WorkerRuntimeError extends Error {
  readonly code: string;
  readonly stderr?: string;

  constructor(message: string, options: { code?: string; cause?: unknown; stderr?: string } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkerRuntimeError";
    this.code = options.code ?? "worker_error";
    if (options.stderr !== undefined) this.stderr = options.stderr;
  }
}

export class WorkerStartError extends WorkerRuntimeError {
  constructor(message: string, options: { cause?: unknown; stderr?: string } = {}) {
    super(message, { ...options, code: "worker_start_failed" });
    this.name = "WorkerStartError";
  }
}

export class WorkerBusyError extends WorkerRuntimeError {
  readonly taskId?: string;

  constructor(message: string, taskId?: string) {
    super(message, { code: "worker_busy" });
    this.name = "WorkerBusyError";
    if (taskId !== undefined) this.taskId = taskId;
  }
}

export class WorkerAbortedError extends WorkerRuntimeError {
  constructor(message = "worker run aborted") {
    super(message, { code: "worker_aborted" });
    this.name = "WorkerAbortedError";
  }
}

export class WorkerTimeoutError extends WorkerRuntimeError {
  constructor(message = "worker run timed out") {
    super(message, { code: "worker_timeout" });
    this.name = "WorkerTimeoutError";
  }
}

export class WorkerRunFailedError extends WorkerRuntimeError {
  constructor(message: string, options: { cause?: unknown; stderr?: string } = {}) {
    super(message, { ...options, code: "worker_run_failed" });
    this.name = "WorkerRunFailedError";
  }
}

type WorkerState = "new" | "starting" | "idle" | "running" | "resetting" | "stopped" | "error";

/** A WorkerEvent without the adapter-assigned timestamp. */
type WorkerEventPayload = WorkerEvent extends infer E
  ? E extends { at: string }
    ? Omit<E, "at">
    : never
  : never;

interface ActiveRun {
  onEvent: WorkerEventListener;
  text: string;
  usage?: WorkerUsage;
  usageKey?: string;
  assistantError?: string;
  aborted: boolean;
  abortRequested: boolean;
  abortError?: Error;
  failureEmitted: boolean;
  timedOut: boolean;
  settled: boolean;
  stopReason?: string;
  sessionFile?: string;
  settledPromise: Promise<void>;
  settle: () => void;
}

const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_RESET_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PAYLOAD_CHARS = 2_000;

/** Build the prompt for a fresh task. Exported for prompt tests and docs. */
export function buildTaskPrompt(task: Task, agent: AgentRuntime): string {
  const acceptance = task.acceptance?.trim()
    ? task.acceptance.trim()
    : "Use the task description as the acceptance criteria.";
  return [
    `You are the \`${agent.role}\` agent (${agent.id}) in a fixed local agent pool.`,
    "",
    "## Role",
    agent.config.description.trim(),
    "",
    `## Task: ${task.title}`,
    `Task id: ${task.id}`,
    `Role: ${agent.role}`,
    "",
    task.prompt.trim(),
    "",
    "## Acceptance criteria",
    acceptance,
    "",
    "## Working agreement",
    `- Work in the current directory (${agent.config.cwd ?? "."}).`,
    "- Make the changes needed for this task, then run the relevant checks.",
    "- Do not delegate to other agents or start the orchestrator broker.",
    "",
    "## Result contract",
    "Your final message must contain these sections:",
    "- Summary: what you changed and why.",
    "- Files changed: exact paths, or \"none\".",
    "- Tests run: exact commands and pass/fail results, or \"not run\" with the reason.",
    "- Blockers: anything you could not complete, or \"none\".",
  ].join("\n");
}

/** Build a rework prompt for the SAME session/context. */
export function buildFeedbackPrompt(task: Task, message: string): string {
  return [
    `Review feedback for task \`${task.title}\` (${task.id}).`,
    "",
    message.trim(),
    "",
    "Continue in this same session: apply the feedback, re-run the relevant checks,",
    "and reply with an updated final message containing Summary, Files changed,",
    "Tests run and Blockers.",
  ].join("\n");
}

/** Safe, size-limited rendering for tool inputs/results in the task log. */
export function truncatePayload(value: unknown, maxChars = DEFAULT_MAX_PAYLOAD_CHARS): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) return "";
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}… [truncated ${omitted} chars]`;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    }
  }
  return parts.join("");
}

function extractToolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return extractMessageText(result);
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const text = extractMessageText(record.content);
      if (text) return text;
    }
    return truncatePayload(result);
  }
  return String(result);
}

function normalizeUsage(usage: RpcUsageLike | undefined): WorkerUsage | undefined {
  if (!usage) return undefined;
  const result: WorkerUsage = {};
  if (typeof usage.input === "number") result.inputTokens = usage.input;
  if (typeof usage.output === "number") result.outputTokens = usage.output;
  if (typeof usage.cost === "number") result.cost = usage.cost;
  else if (typeof usage.cost?.total === "number") result.cost = usage.cost.total;
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeUsage(current: WorkerUsage | undefined, next: WorkerUsage | undefined): WorkerUsage | undefined {
  if (!next) return current;
  const merged: WorkerUsage = { ...(current ?? {}), ...next };
  return merged;
}

function readPid(client: RpcClientLike): number | undefined {
  const maybe = client as unknown as { process?: { pid?: number } };
  return typeof maybe.process?.pid === "number" ? maybe.process.pid : undefined;
}

function readStderr(client: RpcClientLike | undefined): string | undefined {
  try {
    const stderr = client?.getStderr?.();
    if (!stderr) return undefined;
    return truncatePayload(stderr, 4_000);
  } catch {
    return undefined;
  }
}

function buildRpcOptions(options: {
  cwd: string;
  model: ResolvedModel;
  sessionsDir: string;
  agent: AgentRuntime;
  cliPath?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}): RpcClientOptions {
  const args = ["--mode", "rpc", "--session-dir", options.sessionsDir, "--offline"];
  if (options.agent.config.tools && options.agent.config.tools.length > 0) {
    args.push("--tools", options.agent.config.tools.join(","));
  }
  if (options.extraArgs) args.push(...options.extraArgs);

  const cliPath = options.cliPath ?? path.join(getPackageDir(), "dist", "cli.js");
  return {
    cliPath,
    cwd: options.cwd,
    provider: options.model.provider,
    model: options.model.model,
    args,
    env: {
      PI_AGENT_ORCHESTRATOR_WORKER: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      ...options.env,
    },
  };
}

export class RpcWorker implements WorkerAdapter {
  readonly agent: AgentRuntime;
  readonly options: RpcWorkerOptions;

  private readonly model: ResolvedModel;
  private readonly thinkingLevel?: ThinkingLevel;
  private readonly cwd: string;
  private readonly clock: () => Date;
  private readonly maxPayloadChars: number;
  private readonly clientFactory: RpcClientFactory;

  private client?: RpcClientLike;
  private unsubscribe?: () => void;
  private state: WorkerState = "new";
  private sessionFile?: string;
  private pid?: number;
  private startedAt?: string;
  private activeRun?: ActiveRun;
  private currentTask?: Task;
  private abortPending = false;

  constructor(options: RpcWorkerOptions) {
    this.options = options;
    this.agent = options.agent;
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel;
    this.cwd = options.cwd ?? path.resolve(options.projectRoot, options.agent.config.cwd ?? ".");
    this.clock = options.clock ?? (() => new Date());
    this.maxPayloadChars = options.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS;
    this.clientFactory =
      options.clientFactory ?? ((clientOptions) => new RpcClient(clientOptions) as unknown as RpcClientLike);
  }

  get status(): WorkerState {
    return this.state;
  }

  get workerPid(): number | undefined {
    return this.pid;
  }

  get workerSessionFile(): string | undefined {
    return this.sessionFile;
  }

  get runPid(): number | undefined {
    return this.pid;
  }

  async start(): Promise<void> {
    if (this.state === "idle") return;
    if (this.state === "stopped") {
      throw new WorkerStartError(`worker ${this.agent.id} is stopped`);
    }
    if (this.state === "starting") {
      throw new WorkerBusyError(`worker ${this.agent.id} is already starting`);
    }
    if (this.state === "running" || this.state === "resetting") {
      throw new WorkerBusyError(`worker ${this.agent.id} cannot start while ${this.state}`);
    }

    this.state = "starting";
    const client = this.clientFactory(
      buildRpcOptions({
        cwd: this.cwd,
        model: this.model,
        sessionsDir: this.options.sessionsDir,
        agent: this.agent,
        cliPath: this.options.cliPath,
        env: this.options.env,
        extraArgs: this.options.args,
      }),
    );
    this.client = client;

    try {
      await mkdir(this.options.sessionsDir, { recursive: true });
      await this.withTimeout(
        client.start(),
        this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        () => new WorkerStartError(`worker ${this.agent.id} did not start in time`),
      );
      this.unsubscribe = client.onEvent((event) => this.handleEvent(event));

      const session = await client.getState();
      this.sessionFile = session.sessionFile;
      this.pid = readPid(client);

      if (this.thinkingLevel !== undefined) {
        const available = client.getAvailableThinkingLevels
          ? await client.getAvailableThinkingLevels()
          : undefined;
        if (available && available.length > 0) {
          const normalized = this.thinkingLevel.trim().toLowerCase();
          const levels = available.map((level) => level.trim().toLowerCase());
          if (!levels.includes(normalized)) {
            throw new WorkerStartError(
              `worker ${this.agent.id}: thinking level "${this.thinkingLevel}" is not available for ` +
                `${this.model.provider}/${this.model.model}; available: ${levels.join(", ")}`,
            );
          }
        }
        if (client.setThinkingLevel) await client.setThinkingLevel(this.thinkingLevel);
      }

      this.startedAt = this.now();
      this.state = "idle";
    } catch (error) {
      this.state = "error";
      try {
        await client.stop();
      } catch {
        // The original startup error is more useful.
      }
      if (error instanceof WorkerRuntimeError) throw error;
      throw new WorkerStartError(
        `worker ${this.agent.id} failed to start: ${(error as Error).message}`,
        { cause: error, stderr: readStderr(client) },
      );
    }
  }

  async run(task: Task, onEvent: WorkerEventListener): Promise<WorkerResult> {
    if (this.state === "running" || this.state === "resetting" || this.state === "starting") {
      throw new WorkerBusyError(
        `worker ${this.agent.id} is ${this.state} and cannot run task ${task.id}`,
        this.currentTask?.id,
      );
    }
    if (this.abortPending) {
      this.abortPending = false;
      throw new WorkerAbortedError(`worker ${this.agent.id} was aborted before task ${task.id}`);
    }
    if (this.state === "new") await this.start();
    if (this.state === "stopped") {
      throw new WorkerStartError(`worker ${this.agent.id} is stopped`);
    }
    if (this.state === "error") {
      throw new WorkerStartError(
        `worker ${this.agent.id} is in an error state; stop it and create a replacement replica`,
      );
    }
    this.currentTask = task;
    return this.executePrompt(buildTaskPrompt(task, this.agent), onEvent, "run");
  }

  async feedback(message: string, onEvent: WorkerEventListener): Promise<WorkerResult> {
    if (this.state === "running" || this.state === "resetting" || this.state === "starting") {
      throw new WorkerBusyError(
        `worker ${this.agent.id} is ${this.state} and cannot accept feedback`,
        this.currentTask?.id,
      );
    }
    if (!this.currentTask) {
      throw new WorkerRunFailedError(
        `worker ${this.agent.id} has no task context for feedback; run a task first`,
      );
    }
    if (this.state === "new") await this.start();
    if (this.state === "error") {
      throw new WorkerStartError(
        `worker ${this.agent.id} is in an error state; stop it and create a replacement replica`,
      );
    }
    return this.executePrompt(
      buildFeedbackPrompt(this.currentTask, message),
      onEvent,
      "feedback",
    );
  }

  async reset(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      throw new WorkerBusyError(`worker ${this.agent.id} cannot reset while ${this.state}`);
    }
    if (this.state === "stopped" || this.state === "error") {
      throw new WorkerStartError(
        `worker ${this.agent.id} is ${this.state}; stop it and create a replacement replica`,
      );
    }
    if (this.state === "new") {
      await this.start();
      return;
    }
    const client = this.requireClient();
    this.state = "resetting";
    try {
      const before = await client.getState();
      const result = await this.withTimeout(
        client.newSession(),
        this.options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS,
        () => new WorkerRuntimeError(`worker ${this.agent.id} newSession timed out`, { code: "worker_reset_timeout" }),
      );
      if (result?.cancelled) {
        throw new WorkerRuntimeError(
          `worker ${this.agent.id}: newSession was cancelled by an extension; refusing to reuse the old context`,
          { code: "worker_reset_cancelled" },
        );
      }
      const after = await client.getState();
      const sessionChanged =
        (after.sessionId !== undefined && after.sessionId !== before.sessionId) ||
        (after.sessionFile !== undefined && after.sessionFile !== before.sessionFile);
      const empty = (after.messageCount ?? 0) === 0;
      if (!sessionChanged && !empty) {
        throw new WorkerRuntimeError(
          `worker ${this.agent.id}: newSession did not take effect (session ${after.sessionId ?? "<unknown>"} still has ` +
            `${after.messageCount ?? "unknown"} messages); refusing to reuse the old context`,
          { code: "worker_reset_failed" },
        );
      }
      this.sessionFile = after.sessionFile ?? this.sessionFile;
      this.currentTask = undefined;
      if (this.thinkingLevel !== undefined && client.setThinkingLevel) {
        await client.setThinkingLevel(this.thinkingLevel);
      }
      this.state = "idle";
    } catch (error) {
      this.state = "error";
      if (error instanceof WorkerRuntimeError) throw error;
      throw new WorkerRuntimeError(
        `worker ${this.agent.id} failed to reset: ${(error as Error).message}`,
        { code: "worker_reset_failed", cause: error, stderr: readStderr(client) },
      );
    }
  }

  async abort(): Promise<void> {
    const active = this.activeRun;
    if (!active) {
      if (this.state === "new" || this.state === "starting") this.abortPending = true;
      return;
    }
    active.abortRequested = true;
    try {
      await this.client?.abort();
    } catch (error) {
      active.abortError = error as Error;
      active.settle();
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    const client = this.client;
    const active = this.activeRun;
    if (active) {
      active.abortRequested = true;
      active.aborted = true;
      try {
        await client?.abort();
      } catch {
        // Continue with stop; the process teardown is what matters.
      }
    }
    let stopError: unknown;
    try {
      await client?.stop();
    } catch (error) {
      stopError = error;
    }
    active?.settle();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.client = undefined;
    this.activeRun = undefined;
    this.state = "stopped";
    if (stopError) {
      throw new WorkerRuntimeError(
        `worker ${this.agent.id} failed to stop cleanly: ${(stopError as Error).message}`,
        { code: "worker_stop_failed", cause: stopError, stderr: readStderr(client) },
      );
    }
  }

  private async executePrompt(
    prompt: string,
    onEvent: WorkerEventListener,
    kind: "run" | "feedback",
  ): Promise<WorkerResult> {
    if (this.activeRun) {
      throw new WorkerBusyError(
        `worker ${this.agent.id} is already running task ${this.currentTask?.id ?? "<unknown>"}`,
        this.currentTask?.id,
      );
    }
    const client = this.requireClient();
    this.state = "running";

    let settle!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const sink: ActiveRun = {
      onEvent,
      text: "",
      aborted: false,
      abortRequested: false,
      failureEmitted: false,
      timedOut: false,
      settled: false,
      sessionFile: this.sessionFile,
      settledPromise,
      settle: () => {
        if (sink.settled) return;
        sink.settled = true;
        settle();
      },
    };
    this.activeRun = sink;
    this.emit(sink, { type: "started", sessionFile: this.sessionFile });

    try {
      const disposition = await client.prompt(prompt);
      if (disposition === "handled") {
        // No run started (for example an extension command). Do not wait for
        // agent_settled; return the current assistant text if there is one.
        const text = (await client.getLastAssistantText()) ?? "";
        const result: WorkerResult = { finalText: text, stopReason: "handled" };
        if (this.sessionFile) result.sessionFile = this.sessionFile;
        this.emit(sink, { type: "completed", result });
        return result;
      }

      await this.waitForSettled(sink, kind);
      this.throwIfRunFailed(sink, client, kind);

      let finalText = sink.text;
      try {
        const last = await client.getLastAssistantText();
        if (typeof last === "string") finalText = last;
      } catch {
        // Fall back to streamed/message text.
      }
      let sessionFile = this.sessionFile;
      try {
        const session = await client.getState();
        if (session.sessionFile) {
          sessionFile = session.sessionFile;
          this.sessionFile = session.sessionFile;
        }
      } catch {
        // Session metadata is best-effort at completion.
      }

      const result: WorkerResult = {
        finalText,
        stopReason: sink.stopReason ?? "stop",
      };
      if (sessionFile) result.sessionFile = sessionFile;
      if (sink.usage) result.usage = sink.usage;
      this.emit(sink, { type: "completed", result });
      return result;
    } catch (error) {
      if (error instanceof WorkerAbortedError || error instanceof WorkerTimeoutError) {
        this.emitFailure(sink, error);
        throw error;
      }
      if (error instanceof WorkerRuntimeError) {
        this.emitFailure(sink, error);
        throw error;
      }
      const failure = new WorkerRunFailedError(
        `worker ${this.agent.id} ${kind} failed: ${(error as Error).message}`,
        { cause: error, stderr: readStderr(client) },
      );
      this.emitFailure(sink, failure);
      throw failure;
    } finally {
      this.activeRun = undefined;
      if (this.state === "running") this.state = "idle";
    }
  }

  private async waitForSettled(sink: ActiveRun, kind: "run" | "feedback"): Promise<void> {
    const timeoutMs =
      kind === "feedback"
        ? this.options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
        : this.options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        sink.timedOut = true;
        sink.abortRequested = true;
        void this.client?.abort().catch(() => {});
        reject(
          new WorkerTimeoutError(
            `worker ${this.agent.id} ${kind} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });
    try {
      await Promise.race([sink.settledPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (sink.abortError) {
      throw new WorkerRunFailedError(
        `worker ${this.agent.id} failed to abort: ${sink.abortError.message}`,
        { cause: sink.abortError, stderr: readStderr(this.client) },
      );
    }
  }

  private throwIfRunFailed(sink: ActiveRun, client: RpcClientLike, kind: "run" | "feedback"): void {
    if (sink.assistantError) {
      throw new WorkerRunFailedError(
        `worker ${this.agent.id} ${kind} failed: ${sink.assistantError}`,
        { stderr: readStderr(client) },
      );
    }
    if (sink.aborted) {
      throw new WorkerAbortedError(
        sink.abortRequested
          ? `worker ${this.agent.id} ${kind} aborted`
          : `worker ${this.agent.id} ${kind} was aborted by the agent`,
      );
    }
  }

  private handleEvent(event: RpcSessionEventLike): void {
    const sink = this.activeRun;
    if (!sink) return;
    const type = event.type;

    if (type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && typeof update.delta === "string" && update.delta.length > 0) {
        sink.text += update.delta;
        this.emit(sink, { type: "text", text: update.delta });
      }
      const usage = normalizeUsage(event.usage);
      if (usage) sink.usage = mergeUsage(sink.usage, usage);
      return;
    }

    if (type === "message_end") {
      const message = event.message;
      if (message?.role !== "assistant") return;
      const text = extractMessageText(message.content);
      if (text) sink.text = text;
      if (message.stopReason) sink.stopReason = message.stopReason;
      if (message.stopReason === "error") {
        sink.assistantError =
          message.errorMessage?.trim() || "assistant message ended with an error";
      } else if (message.stopReason === "aborted") {
        sink.aborted = true;
      }
      const usage = normalizeUsage(message.usage);
      if (usage) {
        sink.usage = mergeUsage(sink.usage, usage);
        const key = JSON.stringify(sink.usage);
        if (key !== sink.usageKey) {
          sink.usageKey = key;
          this.emit(sink, { type: "usage", usage: { ...sink.usage } });
        }
      }
      return;
    }

    if (type === "tool_execution_start") {
      const tool = event.toolName ?? "unknown";
      this.emit(sink, {
        type: "tool_start",
        tool,
        input: truncatePayload(event.args, this.maxPayloadChars),
      });
      return;
    }

    if (type === "tool_execution_end") {
      const tool = event.toolName ?? "unknown";
      const text = truncatePayload(extractToolResultText(event.result), this.maxPayloadChars);
      this.emit(sink, {
        type: "tool_end",
        tool,
        status: event.isError ? "error" : "ok",
        text,
      });
      return;
    }

    if (type === "agent_settled") {
      if (event.aborted) sink.aborted = true;
      sink.settle();
    }
  }

  private emitFailure(sink: ActiveRun, error: Error): void {
    if (sink.failureEmitted) return;
    sink.failureEmitted = true;
    this.emit(sink, { type: "failed", error: error.message });
  }

  private emit(sink: ActiveRun, event: WorkerEventPayload): void {
    sink.onEvent({ ...event, at: this.now() } as WorkerEvent);
  }

  private requireClient(): RpcClientLike {
    if (!this.client) {
      throw new WorkerRuntimeError(
        `worker ${this.agent.id} is not started (state: ${this.state})`,
        { code: "worker_not_started" },
      );
    }
    return this.client;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    makeError: () => Error,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(makeError()), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
