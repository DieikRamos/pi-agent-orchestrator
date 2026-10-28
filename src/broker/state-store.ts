import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BrokerState, TaskLogEntry } from "../types.js";
import { STATE_DIR } from "../config.js";

/** Current on-disk state schema. A mismatch refuses to load rather than guessing. */
export const STATE_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_ACTIONS = 100;

/**
 * A human-readable broker action retained across restarts. Actions are separate
 * from task logs: they are a bounded, cross-task activity feed for the
 * dashboard/debugging, not a durable task audit trail.
 */
export interface BrokerAction {
  at: string;
  type: string;
  message: string;
  agentId?: string;
  taskId?: string;
}

export interface PersistedBrokerState {
  schemaVersion: number;
  savedAt: string;
  state: BrokerState;
  actions: BrokerAction[];
  /** clientRequestId -> task id, for idempotent submissions. */
  clientRequests: Record<string, string>;
}

export interface LoadStateResult {
  found: boolean;
  state?: BrokerState;
  actions: BrokerAction[];
  clientRequests: Record<string, string>;
  /** Undefined when no state exists or no expected fingerprint was supplied. */
  fingerprintMatches?: boolean;
  /** Absolute path of the state file. */
  path: string;
}

export interface StateStoreOptions {
  /** State directory. Defaults to `<cwd>/.pi/agent-orchestrator`. */
  dir?: string;
  /** Alias for `dir`, for callers that prefer an explicit name. */
  stateDir?: string;
  clock?: () => Date;
  maxActions?: number;
}

export interface SaveExtras {
  actions?: BrokerAction[];
  clientRequests?: Record<string, string>;
}

export class StateStoreError extends Error {
  readonly path: string;

  constructor(message: string, statePath: string) {
    super(message);
    this.name = "StateStoreError";
    this.path = statePath;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeActions(value: unknown, maxActions: number): BrokerAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(-maxActions) as unknown as BrokerAction[];
}

function normalizeClientRequests(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

/**
 * Durable broker state in a JSON directory.
 *
 * Layout:
 * - `<dir>/state.json` — atomic snapshot (temp file + rename)
 * - `<dir>/tasks/<taskId>.jsonl` — append-only per-task log
 *
 * Writes are serialized internally so callers may fire-and-forget without
 * producing interleaved temp files. Reads are safe while writes are pending
 * because a rename is atomic.
 */
export class StateStore {
  readonly dir: string;
  readonly stateFile: string;
  readonly tasksDir: string;

  private readonly clock: () => Date;
  private readonly maxActions: number;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly logChains = new Map<string, Promise<void>>();

  constructor(options: StateStoreOptions = {}) {
    this.dir = path.resolve(
      options.dir ?? options.stateDir ?? path.join(process.cwd(), STATE_DIR),
    );
    this.stateFile = path.join(this.dir, "state.json");
    this.tasksDir = path.join(this.dir, "tasks");
    this.clock = options.clock ?? (() => new Date());
    this.maxActions = options.maxActions ?? DEFAULT_MAX_ACTIONS;
  }

  /**
   * Ensure the state directory exists and load any existing state. This is the
   * normal startup entry point. Passing the current config fingerprint enables
   * the caller to detect a config/state mismatch in the returned result.
   */
  async init(expectedFingerprint?: string): Promise<LoadStateResult> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.tasksDir, { recursive: true });
    return this.load(expectedFingerprint);
  }

  async load(expectedFingerprint?: string): Promise<LoadStateResult> {
    let source: string;
    try {
      source = await readFile(this.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          found: false,
          actions: [],
          clientRequests: {},
          path: this.stateFile,
        };
      }
      throw new StateStoreError(
        `could not read broker state ${this.stateFile}: ${(error as Error).message}`,
        this.stateFile,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new StateStoreError(
        `broker state ${this.stateFile} is not valid JSON: ${(error as Error).message}`,
        this.stateFile,
      );
    }
    if (!isRecord(raw)) {
      throw new StateStoreError(
        `broker state ${this.stateFile} must be a JSON object`,
        this.stateFile,
      );
    }
    if (raw.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new StateStoreError(
        `unsupported broker state schema version ${String(raw.schemaVersion)} ` +
          `(expected ${STATE_SCHEMA_VERSION}); remove ${this.dir} or run a compatible version`,
        this.stateFile,
      );
    }
    const state = raw.state;
    if (!isRecord(state) || !Array.isArray(state.tasks) || !Array.isArray(state.agents)) {
      throw new StateStoreError(
        `broker state ${this.stateFile} is missing a valid state snapshot`,
        this.stateFile,
      );
    }
    if (state.version !== STATE_SCHEMA_VERSION) {
      throw new StateStoreError(
        `broker state snapshot version ${String(state.version)} is unsupported ` +
          `(expected ${STATE_SCHEMA_VERSION})`,
        this.stateFile,
      );
    }

    const fingerprintMatches =
      typeof expectedFingerprint === "string" &&
      typeof state.configFingerprint === "string"
        ? state.configFingerprint === expectedFingerprint
        : undefined;

    return {
      found: true,
      state: state as unknown as BrokerState,
      actions: normalizeActions(raw.actions, this.maxActions),
      clientRequests: normalizeClientRequests(raw.clientRequests),
      ...(fingerprintMatches === undefined ? {} : { fingerprintMatches }),
      path: this.stateFile,
    };
  }

  /**
   * Store a full snapshot. The payload is serialized immediately so later
   * caller mutations cannot leak into a queued write. Temp-file + rename keeps
   * readers from seeing a partial snapshot.
   */
  save(state: BrokerState, extras: SaveExtras = {}): Promise<void> {
    const payload: PersistedBrokerState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      savedAt: this.clock().toISOString(),
      state,
      actions: (extras.actions ?? []).slice(-this.maxActions),
      clientRequests: extras.clientRequests ?? {},
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const write = async (): Promise<void> => {
      await mkdir(this.dir, { recursive: true });
      const temp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temp, serialized, "utf8");
        await rename(temp, this.stateFile);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new StateStoreError(
          `could not write broker state ${this.stateFile}: ${(error as Error).message}`,
          this.stateFile,
        );
      }
    };
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }

  /** Append one entry to a task's JSONL log. Writes per task are serialized. */
  appendTaskLog(taskId: string, entry: TaskLogEntry): Promise<void> {
    const file = this.taskLogPath(taskId);
    const line = `${JSON.stringify(entry)}\n`;
    const previous = this.logChains.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.tasksDir, { recursive: true });
      await appendFile(file, line, "utf8");
    });
    this.logChains.set(taskId, next);
    const cleanup = (): void => {
      if (this.logChains.get(taskId) === next) this.logChains.delete(taskId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  async readTaskLog(taskId: string): Promise<TaskLogEntry[]> {
    let source: string;
    try {
      source = await readFile(this.taskLogPath(taskId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: TaskLogEntry[] = [];
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as TaskLogEntry);
      } catch {
        // Ignore a torn trailing line; the snapshot remains authoritative.
      }
    }
    return entries;
  }

  taskLogPath(taskId: string): string {
    return path.join(this.tasksDir, `${encodeURIComponent(taskId)}.jsonl`);
  }

  /** Wait for every queued state snapshot write to settle. */
  async flush(): Promise<void> {
    await this.writeChain;
    await Promise.allSettled([...this.logChains.values()]);
  }
}
