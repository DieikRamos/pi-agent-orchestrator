import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CONFIG_PATH, STATE_DIR } from "../config.js";
import type {
  AgentView,
  HealthView,
  OrchestratorConfig,
  ReviewDecision,
  SubmitTaskInput,
  Task,
  TaskFilter,
  TaskStatus,
  TaskView,
} from "../types.js";

/** Descriptor written by the broker at `<project>/.pi/agent-orchestrator/broker.json`. */
export interface BrokerDescriptor {
  pid: number;
  port: number;
  token?: string;
  /** ISO timestamp. */
  startedAt: string;
  configPath: string;
}

export interface BrokerClientOptions {
  /** Project root used to locate `.pi/agent-orchestrator/broker.json`. */
  cwd?: string;
  /** Explicit descriptor path (mainly for tests). */
  descriptorPath?: string;
  /** Explicit loopback base URL. Remote URLs are rejected. */
  baseUrl?: string;
  /** Optional bearer token. Usually read from the descriptor. */
  token?: string;
  /** Per-request timeout. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Poll interval for `waitForReview`. Defaults to 500 ms. */
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

/** `GET /api/config` returns the normalized config plus its fingerprint. */
export interface BrokerConfigView {
  config: OrchestratorConfig;
  configFingerprint?: string;
}

/** Snapshot assembled from the broker's documented HTTP routes. */
export interface BrokerSnapshot {
  health: HealthView;
  agents: AgentView[];
  tasks: TaskView[];
  config?: BrokerConfigView;
}

export interface WaitForReviewOptions {
  signal?: AbortSignal;
  /** Poll interval override. */
  pollIntervalMs?: number;
}

export class BrokerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrokerUnavailableError";
  }
}

export class BrokerHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "BrokerHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class BrokerTimeoutError extends Error {
  readonly task?: TaskView;

  constructor(message: string, task?: TaskView) {
    super(message);
    this.name = "BrokerTimeoutError";
    this.task = task;
  }
}

export function brokerStateDir(cwd: string): string {
  return path.resolve(cwd, STATE_DIR);
}

export function brokerDescriptorPath(cwd: string): string {
  return path.join(brokerStateDir(cwd), "broker.json");
}

export function brokerLogPath(cwd: string): string {
  return path.join(brokerStateDir(cwd), "broker.log");
}

/** Validate that a URL points at loopback only. */
export function assertLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrokerUnavailableError(`Invalid broker URL: ${raw}`);
  }
  if (url.protocol !== "http:") {
    throw new BrokerUnavailableError(
      `Broker URL must use http:// loopback, got protocol ${url.protocol}`,
    );
  }
  const host = url.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new BrokerUnavailableError(
      `Refusing remote broker host "${url.hostname}": pi-agent-orchestrator only connects to loopback`,
    );
  }
  return url;
}

export function normalizeDescriptor(raw: unknown, source: string): BrokerDescriptor {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BrokerUnavailableError(`Broker descriptor at ${source} is not a JSON object`);
  }
  const value = raw as Record<string, unknown>;
  const pid = value.pid;
  const port = value.port;
  const startedAt = value.startedAt;
  const configPath = value.configPath;
  const token = value.token;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new BrokerUnavailableError(`Broker descriptor at ${source} has an invalid pid`);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrokerUnavailableError(`Broker descriptor at ${source} has an invalid port`);
  }
  if (typeof startedAt !== "string" || startedAt.length === 0) {
    throw new BrokerUnavailableError(`Broker descriptor at ${source} has an invalid startedAt`);
  }
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new BrokerUnavailableError(`Broker descriptor at ${source} has an invalid configPath`);
  }
  if (token !== undefined && typeof token !== "string") {
    throw new BrokerUnavailableError(`Broker descriptor at ${source} has an invalid token`);
  }
  const descriptor: BrokerDescriptor = { pid, port, startedAt, configPath };
  if (typeof token === "string" && token.length > 0) descriptor.token = token;
  return descriptor;
}

export async function readBrokerDescriptor(
  cwd: string,
  descriptorPath = brokerDescriptorPath(cwd),
): Promise<BrokerDescriptor> {
  let source: string;
  try {
    source = await readFile(descriptorPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BrokerUnavailableError(
        `No broker descriptor at ${descriptorPath}. Start it with /agents start.`,
        { cause: error },
      );
    }
    throw new BrokerUnavailableError(
      `Could not read broker descriptor ${descriptorPath}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new BrokerUnavailableError(
      `Broker descriptor ${descriptorPath} is not valid JSON. Remove it and run /agents start.`,
      { cause: error },
    );
  }
  return normalizeDescriptor(raw, descriptorPath);
}

function buildQuery(filter?: TaskFilter): string {
  if (!filter) return "";
  const params = new URLSearchParams();
  const status = filter.status;
  if (Array.isArray(status)) {
    for (const item of status) params.append("status", item);
  } else if (status) {
    params.set("status", status);
  }
  if (filter.role) params.set("role", filter.role);
  if (filter.agentId) params.set("agentId", filter.agentId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function normalizeConfigResponse(raw: unknown): BrokerConfigView {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    if (value.config && typeof value.config === "object") {
      const view: BrokerConfigView = { config: value.config as OrchestratorConfig };
      if (typeof value.configFingerprint === "string") {
        view.configFingerprint = value.configFingerprint;
      }
      return view;
    }
    if (value.agents && typeof value.agents === "object") {
      return { config: value as unknown as OrchestratorConfig };
    }
  }
  throw new BrokerUnavailableError("Broker returned an invalid config response");
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: string }).name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

function statusFromTask(task: TaskView): TaskStatus {
  return task.status;
}

/**
 * HTTP client for the local broker. The client never accepts a remote host and
 * turns fetch/network failures into actionable `BrokerUnavailableError`s.
 */
export class BrokerClient {
  readonly baseUrl: string;
  private token?: string;
  private readonly descriptorPath?: string;
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BrokerClientOptions = {}) {
    this.cwd = options.cwd ? path.resolve(options.cwd) : undefined;
    this.descriptorPath = options.descriptorPath;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ? assertLoopbackUrl(options.baseUrl).origin : "";
  }

  /** Load a descriptor and create a connected client. */
  static async connect(options: BrokerClientOptions = {}): Promise<BrokerClient> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const descriptorPath = options.descriptorPath ?? brokerDescriptorPath(cwd);
    const descriptor = await readBrokerDescriptor(cwd, descriptorPath);
    return new BrokerClient({
      ...options,
      cwd,
      descriptorPath,
      baseUrl: `http://127.0.0.1:${descriptor.port}`,
      token: options.token ?? descriptor.token,
    });
  }

  static forDescriptor(descriptor: BrokerDescriptor, options: BrokerClientOptions = {}): BrokerClient {
    return new BrokerClient({
      ...options,
      baseUrl: `http://127.0.0.1:${descriptor.port}`,
      token: options.token ?? descriptor.token,
    });
  }

  /** Ensure a URL is available before making a request. */
  private async resolveBaseUrl(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    if (!this.cwd) {
      throw new BrokerUnavailableError(
        "Broker client has no URL or project directory. Construct it with cwd or baseUrl.",
      );
    }
    const descriptor = await readBrokerDescriptor(
      this.cwd,
      this.descriptorPath ?? brokerDescriptorPath(this.cwd),
    );
    const url = `http://127.0.0.1:${descriptor.port}`;
    if (!this.token && descriptor.token) {
      // Adopt the token written by the broker for this project.
      this.token = descriptor.token;
    }
    return url;
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
    baseUrlOverride?: string,
  ): Promise<T> {
    const base = baseUrlOverride ?? (await this.resolveBaseUrl());
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = init.signal;
    const onAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${base}${pathname}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        if (externalSignal?.aborted) {
          throw new BrokerTimeoutError(`Request to ${pathname} was aborted`);
        }
        throw new BrokerTimeoutError(
          `Broker request ${pathname} timed out after ${timeoutMs}ms`,
        );
      }
      throw new BrokerUnavailableError(
        `Cannot reach the agent orchestrator broker at ${base}. Is it running? Try /agents start.`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }

    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new BrokerHttpError(
            response.status,
            "invalid_response",
            `Broker returned HTTP ${response.status} with a non-JSON body`,
          );
        }
        throw new BrokerUnavailableError(
          `Broker returned a non-JSON response for ${pathname}`,
        );
      }
    }

    if (!response.ok) {
      const errorBody = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } })
        ?.error;
      const code =
        typeof errorBody?.code === "string" ? errorBody.code : `http_${response.status}`;
      const message =
        typeof errorBody?.message === "string"
          ? errorBody.message
          : `Broker request ${pathname} failed with HTTP ${response.status}`;
      throw new BrokerHttpError(response.status, code, message, errorBody?.details);
    }

    return body as T;
  }

  async health(): Promise<HealthView> {
    const health = await this.request<HealthView>("/api/health");
    if (!health || typeof health !== "object" || health.name !== "pi-agent-orchestrator") {
      throw new BrokerUnavailableError(
        `The server at ${this.baseUrl || "the descriptor port"} is not a pi-agent-orchestrator broker`,
      );
    }
    return health;
  }

  async submit(input: SubmitTaskInput & { clientRequestId?: string }): Promise<Task> {
    const body: Record<string, unknown> = {
      title: input.title,
      role: input.role,
      prompt: input.prompt,
    };
    if (input.acceptance !== undefined) body.acceptance = input.acceptance;
    if (input.clientRequestId !== undefined) body.clientRequestId = input.clientRequestId;
    return this.request<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async listAgents(): Promise<AgentView[]> {
    return this.request<AgentView[]>("/api/agents");
  }

  async listTasks(filter?: TaskFilter): Promise<TaskView[]> {
    return this.request<TaskView[]>(`/api/tasks${buildQuery(filter)}`);
  }

  async getTask(taskId: string): Promise<TaskView> {
    if (!taskId) throw new BrokerUnavailableError("taskId is required");
    return this.request<TaskView>(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async review(
    taskId: string,
    decision: ReviewDecision,
    feedback?: string,
  ): Promise<Task> {
    if (!taskId) throw new BrokerUnavailableError("taskId is required");
    const body: Record<string, unknown> = { decision };
    if (feedback !== undefined) body.feedback = feedback;
    return this.request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/review`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async cancel(taskId: string): Promise<Task> {
    if (!taskId) throw new BrokerUnavailableError("taskId is required");
    return this.request<Task>(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  /**
   * Poll until the task reaches `awaiting_review` (or a terminal state).
   * The broker API intentionally has no long-poll route, so this is a small
   * bounded polling loop that works against the documented routes.
   */
  async waitForReview(
    taskId: string,
    timeoutMs = 120_000,
    options: WaitForReviewOptions = {},
  ): Promise<Task> {
    if (!taskId) throw new BrokerUnavailableError("taskId is required");
    const started = Date.now();
    const interval = Math.max(25, options.pollIntervalMs ?? this.pollIntervalMs);
    let lastTask: TaskView | undefined;

    while (true) {
      if (options.signal?.aborted) {
        throw new BrokerTimeoutError(`Waiting for task ${taskId} was aborted`, lastTask);
      }
      try {
        lastTask = await this.getTask(taskId);
      } catch (error) {
        if (error instanceof BrokerHttpError && error.status === 404) throw error;
        if (!(error instanceof BrokerUnavailableError)) throw error;
        // Transient broker restart: keep polling until the deadline.
      }

      if (lastTask) {
        if (lastTask.status === "awaiting_review" || lastTask.status === "closed") {
          return lastTask;
        }
        if (lastTask.status === "failed" || lastTask.status === "cancelled") {
          const reason = lastTask.error ? `: ${lastTask.error}` : "";
          throw new BrokerHttpError(
            409,
            lastTask.status,
            `Task ${taskId} ended as ${statusFromTask(lastTask)}${reason}`,
            { task: lastTask },
          );
        }
      }

      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        throw new BrokerTimeoutError(
          `Timed out after ${timeoutMs}ms waiting for task ${taskId} to await review. Use agent_status or the dashboard to inspect progress.`,
          lastTask,
        );
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(interval, timeoutMs - elapsed));
        options.signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }

  /** Compose health, agents, tasks, and config from the documented routes. */
  async getSnapshot(): Promise<BrokerSnapshot> {
    const [health, agents, tasks] = await Promise.all([
      this.health(),
      this.listAgents(),
      this.listTasks(),
    ]);
    let config: BrokerConfigView | undefined;
    try {
      config = await this.getConfig();
    } catch {
      config = undefined;
    }
    const snapshot: BrokerSnapshot = { health, agents, tasks };
    if (config) snapshot.config = config;
    return snapshot;
  }

  async getConfig(): Promise<BrokerConfigView> {
    return normalizeConfigResponse(await this.request<unknown>("/api/config"));
  }

  async reload(): Promise<BrokerConfigView> {
    const response = await this.request<unknown>(
      "/api/reload",
      { method: "POST", body: JSON.stringify({}) },
      60_000,
    );
    return normalizeConfigResponse(response);
  }

  async shutdown(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/api/shutdown", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }
}

/** The config path used when a client only knows the project directory. */
export function defaultConfigPath(cwd: string): string {
  return path.resolve(cwd, DEFAULT_CONFIG_PATH);
}
