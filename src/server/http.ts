import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigError, LOOPBACK_HOST } from "../config.js";
import { AgentLockError, TaskTransitionError } from "../state.js";
import type {
  AgentConfig,
  HealthView,
  OrchestratorConfig,
  OrchestratorCore,
  ReviewDecision,
  SSEEvent,
  Task,
  TaskFilter,
  TaskStatus,
} from "../types.js";

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const NAME = "pi-agent-orchestrator";
const VERSION = "0.1.0";

const STATIC_ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

export interface BrokerServerOptions {
  /** Loopback host. `localhost`/`::1` are normalized to 127.0.0.1. */
  host?: string;
  /** Port to bind. `0` (the default) asks the OS for an ephemeral port. */
  port?: number;
  /** Serve the dashboard. Defaults to the loaded config's `server.dashboard`. */
  dashboard?: boolean;
  /** Explicit dashboard asset directory. Resolved from import.meta.url by default. */
  webRoot?: string;
  /** Display name used by health/SSE payloads. */
  name?: string;
  /** Display version used by health/SSE payloads. */
  version?: string;
  /** Maximum JSON request body size in bytes. Defaults to 1 MiB. */
  bodyLimitBytes?: number;
  /** SSE heartbeat comment interval in milliseconds. Defaults to 15s. */
  heartbeatMs?: number;
  /** Request/error logger. Defaults to stderr. */
  logger?: (message: string) => void;
  /** Normalized config for /api/config and roster validation. */
  config?: OrchestratorConfig;
  /** Supplies the normalized config for /api/config and roster validation. */
  getConfig?: () => OrchestratorConfig | Promise<OrchestratorConfig>;
  /** Called after /api/shutdown responds. The server is closed afterwards. */
  onShutdown?: () => void | Promise<void>;
}

export interface BrokerServerAddress {
  host: string;
  port: number;
  url: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface BrokerHttpServer {
  readonly server: Server;
  readonly url: string | undefined;
  listen(): Promise<BrokerServerAddress>;
  close(): Promise<void>;
  address(): AddressInfo | null;
}

/** Normalize accepted loopback spellings and reject everything else. */
export function normalizeLoopbackHost(host: string | undefined): "127.0.0.1" {
  if (host === undefined || host.trim() === "") return LOOPBACK_HOST;
  const value = host.trim().toLowerCase();
  if (value === "127.0.0.1" || value === "localhost" || value === "::1") {
    return LOOPBACK_HOST;
  }
  throw new Error(
    `refusing to bind the broker HTTP server to non-loopback host "${host}" (v1 is loopback-only)`,
  );
}

/** Candidate dashboard directories for a module URL, most specific first. */
export function webRootCandidates(moduleUrl: URL | string, explicit?: string): string[] {
  // `import.meta.url` is a string. Treat URL strings as URLs instead of paths,
  // otherwise resolving from a bundled module prepends the process cwd and the
  // packaged `web/` directory is missed when the broker runs in a project dir.
  const base =
    moduleUrl instanceof URL
      ? moduleUrl
      : /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(moduleUrl)
        ? new URL(moduleUrl)
        : pathToFileURL(path.resolve(moduleUrl));
  const candidates: string[] = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(
    fileURLToPath(new URL("../../web/", base)),
    fileURLToPath(new URL("../web/", base)),
    fileURLToPath(new URL("./web/", base)),
    path.resolve(process.cwd(), "web"),
  );
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

/**
 * Resolve the dashboard directory relative to an arbitrary module URL.
 *
 * Exposed so tests can exercise the real dist layout (`dist/server/http.js`,
 * `dist/broker/main.js`, `dist/extension.js`) without rebuilding the package.
 */
export function resolveWebRootFrom(moduleUrl: URL | string, explicit?: string): string {
  const candidates = webRootCandidates(moduleUrl, explicit);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return candidates[0] ?? path.resolve("web");
}

/**
 * Resolve the dashboard directory in source and bundled layouts.
 *
 * src/server/http.ts -> `<root>/web`
 * dist/broker/main.js -> `<root>/web`
 * dist/extension.js -> `<root>/web`
 */
export function resolveWebRoot(explicit?: string): string {
  return resolveWebRootFrom(import.meta.url, explicit);
}

class BrokerServer implements BrokerHttpServer {
  readonly server: Server;
  private readonly core: OrchestratorCore;
  private readonly options: BrokerServerOptions;
  private readonly logger: (message: string) => void;
  private readonly bodyLimit: number;
  private readonly heartbeatMs: number;
  private readonly sseClients = new Set<ServerResponse>();
  private boundPort: number | undefined;
  private boundHost: string | undefined;
  private webRoot: string;
  private dashboardEnabled = true;
  private listenPromise: Promise<BrokerServerAddress> | undefined;
  private closePromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(core: OrchestratorCore, options: BrokerServerOptions = {}) {
    this.core = core;
    this.options = options;
    this.logger = options.logger ?? ((message) => console.error(message));
    this.bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.webRoot = resolveWebRoot(options.webRoot);
    this.server = createNodeServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("clientError", (error, socket) => {
      this.logger(`[broker] client error: ${error.message}`);
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
  }

  get url(): string | undefined {
    if (this.boundPort === undefined) return undefined;
    return `http://${this.boundHost ?? LOOPBACK_HOST}:${this.boundPort}`;
  }

  address(): AddressInfo | null {
    const address = this.server.address();
    return address && typeof address === "object" ? address : null;
  }

  listen(): Promise<BrokerServerAddress> {
    if (this.listenPromise) return this.listenPromise;
    this.listenPromise = this.doListen();
    return this.listenPromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doListen(): Promise<BrokerServerAddress> {
    const config = await this.getConfig();
    const host = normalizeLoopbackHost(this.options.host ?? config.server.host);
    const port = this.options.port ?? config.server.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid broker port: ${String(port)}`);
    }
    this.dashboardEnabled = this.options.dashboard ?? config.server.dashboard;
    this.webRoot = resolveWebRoot(this.options.webRoot);
    this.boundHost = host;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });

    const address = this.address();
    if (!address) throw new Error("broker HTTP server failed to bind an address");
    this.boundPort = address.port;
    return { host, port: address.port, url: this.url! };
  }

  private async doClose(): Promise<void> {
    this.shuttingDown = true;
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        // Client already disconnected.
      }
    }
    this.sseClients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }

  private async triggerShutdown(): Promise<void> {
    if (!this.shuttingDown) {
      try {
        await this.options.onShutdown?.();
      } catch (error) {
        this.logger(`[broker] shutdown handler failed: ${errorMessage(error)}`);
      }
    }
    await this.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    res.on("close", () => {
      if (!res.writableEnded) return;
      this.logger(
        `[broker] ${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`,
      );
    });

    try {
      await this.route(req, res, url, method);
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.status >= 500) {
        this.logger(`[broker] ${method} ${url.pathname} failed: ${errorMessage(error)}`);
      }
      sendError(res, mapped);
    }
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
  ): Promise<void> {
    const pathname = url.pathname;

    if (pathname === "/api/events") {
      if (method !== "GET") throw methodNotAllowed(method, "GET");
      await this.handleEvents(req, res);
      return;
    }

    if (pathname === "/api/health") {
      if (method !== "GET") throw methodNotAllowed(method, "GET");
      sendJson(res, 200, this.health());
      return;
    }

    if (pathname === "/api/config") {
      if (method !== "GET") throw methodNotAllowed(method, "GET");
      const config = await this.getConfig();
      const fingerprint = this.core.getSnapshot().configFingerprint;
      sendJson(res, 200, {
        ...(redact(config) as Record<string, unknown>),
        configFingerprint: fingerprint,
      });
      return;
    }

    if (pathname === "/api/agents") {
      if (method !== "GET") throw methodNotAllowed(method, "GET");
      sendJson(res, 200, this.core.listAgents());
      return;
    }

    if (pathname === "/api/schedules") {
      if (method !== "GET") throw methodNotAllowed(method, "GET");
      sendJson(res, 200, this.core.listSchedules());
      return;
    }

    const scheduleMatch = /^\/api\/schedules\/([^/]+)(?:\/(run|enable))?$/.exec(pathname);
    if (scheduleMatch) {
      const scheduleId = decodeURIComponent(scheduleMatch[1]!);
      const action = scheduleMatch[2];
      if (action === undefined) {
        if (method !== "GET") throw methodNotAllowed(method, "GET");
        const schedule = this.core.listSchedules().find((entry) => entry.id === scheduleId);
        if (!schedule) throw notFound(`schedule "${scheduleId}" was not found`);
        sendJson(res, 200, schedule);
        return;
      }
      if (action === "run") {
        if (method !== "POST") throw methodNotAllowed(method, "POST");
        sendJson(res, 201, await this.core.runSchedule(scheduleId));
        return;
      }
      if (action === "enable") {
        if (method !== "POST") throw methodNotAllowed(method, "POST");
        const body = await readJsonObject(req, this.bodyLimit);
        if (typeof body.enabled !== "boolean") {
          throw new HttpError(400, "invalid_request", "enabled must be a boolean", {
            field: "enabled",
          });
        }
        sendJson(res, 200, await this.core.setScheduleEnabled(scheduleId, body.enabled));
        return;
      }
    }

    if (pathname === "/api/tasks") {
      if (method === "GET") {
        sendJson(res, 200, this.core.listTasks(parseTaskFilter(url.searchParams)));
        return;
      }
      if (method === "POST") {
        const task = await this.handleSubmit(req);
        sendJson(res, 201, task);
        return;
      }
      throw methodNotAllowed(method, "GET, POST");
    }

    const taskMatch = /^\/api\/tasks\/([^/]+)(?:\/(review|cancel))?$/.exec(pathname);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]!);
      const action = taskMatch[2];
      if (action === undefined) {
        if (method !== "GET") throw methodNotAllowed(method, "GET");
        const task = this.core.getTask(taskId);
        if (!task) throw notFound(`task "${taskId}" was not found`);
        sendJson(res, 200, task);
        return;
      }
      if (action === "review") {
        if (method !== "POST") throw methodNotAllowed(method, "POST");
        sendJson(res, 200, await this.handleReview(req, taskId));
        return;
      }
      if (action === "cancel") {
        if (method !== "POST") throw methodNotAllowed(method, "POST");
        const task = await this.core.cancel(taskId);
        sendJson(res, 200, task);
        return;
      }
    }

    if (pathname === "/api/reload") {
      if (method !== "POST") throw methodNotAllowed(method, "POST");
      const config = await this.core.reload();
      const fingerprint = this.core.getSnapshot().configFingerprint;
      sendJson(res, 200, {
        ok: true,
        config: redact(config),
        configFingerprint: fingerprint,
      });
      return;
    }

    if (pathname === "/api/shutdown") {
      if (method !== "POST") throw methodNotAllowed(method, "POST");
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        throw new HttpError(403, "forbidden", "shutdown is only available on loopback");
      }
      sendJson(res, 200, { ok: true });
      setImmediate(() => {
        void this.triggerShutdown();
      });
      return;
    }

    const asset = STATIC_ASSETS[pathname];
    if (asset) {
      if (method !== "GET") throw methodNotAllowed(method, "GET");
      if (!this.dashboardEnabled) throw notFound("dashboard is disabled");
      await this.serveStatic(res, asset.file, asset.type);
      return;
    }

    throw notFound(`no route for ${method} ${pathname}`);
  }

  private async handleSubmit(req: IncomingMessage): Promise<Task> {
    const body = await readJsonObject(req, this.bodyLimit);
    const title = requiredString(body, "title");
    const role = requiredString(body, "role");
    const prompt = requiredString(body, "prompt");
    const acceptance = optionalString(body, "acceptance");

    const config = await this.getConfig();
    if (!Object.prototype.hasOwnProperty.call(config.agents, role)) {
      const known = Object.keys(config.agents).sort().join(", ") || "<none>";
      throw new HttpError(
        400,
        "invalid_request",
        `role "${role}" is not defined in the agent config (known roles: ${known})`,
        { role },
      );
    }

    const input: { title: string; role: string; prompt: string; acceptance?: string } = {
      title,
      role,
      prompt,
    };
    if (acceptance !== undefined) input.acceptance = acceptance;

    try {
      return await this.core.submit(input);
    } catch (error) {
      throw mapError(error);
    }
  }

  private async handleReview(req: IncomingMessage, taskId: string): Promise<Task> {
    const body = await readJsonObject(req, this.bodyLimit);
    const decision = requiredString(body, "decision");
    if (decision !== "close" && decision !== "rework") {
      throw new HttpError(
        400,
        "invalid_request",
        'decision must be "close" or "rework"',
        { decision },
      );
    }
    const feedback =
      typeof body.feedback === "string" && body.feedback.trim().length > 0
        ? body.feedback.trim()
        : undefined;
    if (decision === "rework" && feedback === undefined) {
      throw new HttpError(400, "invalid_request", "rework requires non-empty feedback");
    }
    try {
      return await this.core.review(
        taskId,
        decision as ReviewDecision,
        decision === "rework" ? feedback : undefined,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  private health(): HealthView {
    const snapshot = this.core.getSnapshot();
    const startedAt = snapshot.startedAt;
    const parsedStart = Date.parse(startedAt);
    const uptimeMs = Number.isFinite(parsedStart) ? Math.max(0, Date.now() - parsedStart) : 0;
    const taskCount = (statuses: readonly TaskStatus[]): number =>
      snapshot.tasks.filter((task) => statuses.includes(task.status)).length;
    const schedules = snapshot.schedules ?? [];
    const enabledSchedules = schedules.filter((schedule) => schedule.enabled);
    const nextRunAt = enabledSchedules
      .map((schedule) => schedule.nextRunAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

    return {
      ok: true,
      name: this.options.name ?? NAME,
      version: this.options.version ?? VERSION,
      pid: process.pid,
      startedAt,
      uptimeMs,
      configFingerprint: snapshot.configFingerprint,
      agents: {
        total: snapshot.agents.length,
        idle: snapshot.agents.filter((agent) => agent.status === "idle").length,
        busy: snapshot.agents.filter(
          (agent) =>
            agent.status === "busy" ||
            agent.status === "starting" ||
            agent.status === "resetting",
        ).length,
        awaitingReview: snapshot.agents.filter((agent) => agent.status === "awaiting_review")
          .length,
        error: snapshot.agents.filter((agent) => agent.status === "error").length,
      },
      tasks: {
        total: snapshot.tasks.length,
        queued: taskCount(["queued"]),
        running: taskCount(["assigned", "running"]),
        awaitingReview: taskCount(["awaiting_review"]),
        closed: taskCount(["closed"]),
        failed: taskCount(["failed"]),
        cancelled: taskCount(["cancelled"]),
      },
      schedules: {
        total: schedules.length,
        enabled: enabledSchedules.length,
        due: enabledSchedules.filter((schedule) => Date.parse(schedule.nextRunAt) <= Date.now()).length,
        ...(nextRunAt ? { nextRunAt } : {}),
      },
    };
  }

  private async serveStatic(
    res: ServerResponse,
    file: string,
    contentType: string,
  ): Promise<void> {
    const resolved = path.resolve(this.webRoot, file);
    const relative = path.relative(this.webRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw notFound("asset was not found");
    }
    let data: Buffer;
    try {
      data = await readFile(resolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new HttpError(503, "dashboard_unavailable", "dashboard assets are not available");
      }
      throw error;
    }
    res.statusCode = 200;
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-cache");
    res.setHeader("content-length", data.byteLength);
    res.end(data);
  }

  private async handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();

    const snapshot = this.core.getSnapshot();
    this.writeEvent(res, {
      seq: snapshot.seq,
      at: new Date().toISOString(),
      type: "snapshot",
      data: snapshot,
    });

    this.sseClients.add(res);
    const unsubscribe = this.core.subscribe((event: SSEEvent) => {
      this.writeEvent(res, event);
    });
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(": heartbeat\n\n");
      } catch {
        // Connection closed between the check and the write.
      }
    }, this.heartbeatMs);
    heartbeat.unref?.();

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.sseClients.delete(res);
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  private writeEvent(res: ServerResponse, event: SSEEvent): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      // The client disconnected; cleanup runs through the close handlers.
    }
  }

  private async getConfig(): Promise<OrchestratorConfig> {
    if (this.options.config) return this.options.config;
    if (this.options.getConfig) return await this.options.getConfig();
    const snapshot = this.core.getSnapshot();
    const agents: Record<string, AgentConfig> = {};
    for (const agent of snapshot.agents) {
      agents[agent.role] = agent.config;
    }
    return {
      version: snapshot.version,
      server: {
        host: LOOPBACK_HOST,
        port: this.boundPort ?? this.options.port ?? 0,
        dashboard: this.dashboardEnabled,
      },
      agents,
      ...(snapshot.schedules && snapshot.schedules.length > 0
        ? {
            schedules: snapshot.schedules.map((schedule) => ({
              id: schedule.id,
              role: schedule.role,
              title: schedule.title,
              prompt: schedule.prompt,
              ...(schedule.acceptance !== undefined ? { acceptance: schedule.acceptance } : {}),
              every: schedule.every,
              everyMs: schedule.everyMs,
              enabled: schedule.enabled,
              runOnStart: schedule.runOnStart,
              overlap: schedule.overlap,
            })),
          }
        : {}),
    };
  }
}

/** Create a loopback-only broker HTTP server. Call `listen()` to bind it. */
export function createServer(
  core: OrchestratorCore,
  options: BrokerServerOptions = {},
): BrokerHttpServer {
  return new BrokerServer(core, options);
}

/** Convenience helper for callers that want a listening server immediately. */
export async function startServer(
  core: OrchestratorCore,
  options: BrokerServerOptions = {},
): Promise<BrokerHttpServer> {
  const server = createServer(core, options);
  await server.listen();
  return server;
}

function parseTaskFilter(params: URLSearchParams): TaskFilter {
  const filter: TaskFilter = {};
  const status = params.get("status");
  if (status) {
    const statuses = status
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is TaskStatus => value.length > 0);
    if (statuses.length === 1) filter.status = statuses[0];
    else if (statuses.length > 1) filter.status = statuses;
  }
  const role = params.get("role");
  if (role) filter.role = role;
  const agentId = params.get("agentId");
  if (agentId) filter.agentId = agentId;
  return filter;
}

async function readJsonObject(
  req: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    req.resume();
    throw new HttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > limit) {
      req.resume();
      throw new HttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new HttpError(400, "invalid_request", `invalid JSON body: ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }
  return parsed;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "invalid_request", `${field} is required and must be a non-empty string`, {
      field,
    });
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_request", `${field} must be a string`, { field });
  }
  return value.trim().length > 0 ? value.trim() : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

function notFound(message: string): HttpError {
  return new HttpError(404, "not_found", message);
}

function methodNotAllowed(method: string, allowed: string): HttpError {
  return new HttpError(405, "method_not_allowed", `${method} is not allowed; use ${allowed}`, {
    allowed,
  });
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ConfigError) {
    return new HttpError(422, "config_error", error.message, { issues: error.issues });
  }
  if (error instanceof TaskTransitionError) {
    return new HttpError(409, "conflict", error.message, {
      from: error.from,
      to: error.to,
    });
  }
  if (error instanceof AgentLockError) {
    return new HttpError(409, "conflict", error.message, {
      agentId: error.agentId,
      currentTaskId: error.currentTaskId,
    });
  }

  const message = errorMessage(error);
  if (/not found|unknown task|no task (?:with|for)|does not exist|missing task/i.test(message)) {
    return new HttpError(404, "not_found", message);
  }
  if (/locked|transition|cannot (?:review|cancel|close|rework)|already|wrong state|not awaiting/i.test(message)) {
    return new HttpError(409, "conflict", message);
  }
  if (/invalid|required|must be|expected|not defined|unknown role|unsupported/i.test(message)) {
    return new HttpError(400, "invalid_request", message);
  }
  if (/not ready|unavailable|not started|shutting down/i.test(message)) {
    return new HttpError(503, "unavailable", message);
  }
  return new HttpError(500, "internal_error", "internal broker error");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(data));
  res.end(data);
}

function sendError(res: ServerResponse, error: HttpError): void {
  if (res.writableEnded) return;
  const payload: { error: { code: string; message: string; details?: unknown } } = {
    error: { code: error.code, message: error.message },
  };
  if (error.details !== undefined) payload.error.details = error.details;
  sendJson(res, error.status, payload);
}

const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|cookie/i;

/** Recursively remove obvious credentials from API responses. */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(entry, seen);
  }
  return output;
}
