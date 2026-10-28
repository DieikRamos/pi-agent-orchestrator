import { spawn as nodeSpawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG_PATH } from "../config.js";
import {
  BrokerClient,
  brokerDescriptorPath,
  brokerLogPath,
  normalizeDescriptor,
  type BrokerDescriptor,
} from "../client/broker-client.js";

/** Set by the broker when spawning long-lived Pi worker processes. */
export const WORKER_ENV = "PI_AGENT_ORCHESTRATOR_WORKER";

/** Optional override for the built broker entry point (development / tests). */
export const BROKER_ENTRY_ENV = "PI_AGENT_ORCHESTRATOR_BROKER_ENTRY";

/** Set when the broker is managed externally (Docker Compose) and must not be spawned. */
export const NO_AUTOSTART_ENV = "PI_ORCHESTRATOR_NO_AUTOSTART";

export interface BrokerChild {
  pid?: number;
  once?(event: "error" | "exit", listener: (...args: unknown[]) => void): unknown;
  unref?(): void;
}

export type SpawnBroker = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    detached: boolean;
    stdio: "ignore";
    env: NodeJS.ProcessEnv;
  },
) => BrokerChild;

export interface EnsureBrokerOptions {
  /** Project root. */
  cwd: string;
  /** Config path; defaults to `<cwd>/.pi/agents.yml`. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Explicit broker entry; defaults to `<package>/dist/broker/main.js`. */
  brokerEntry?: string;
  spawn?: SpawnBroker;
  /** Read the descriptor; return undefined when absent or invalid. */
  readDescriptor?: (descriptorPath: string) => Promise<BrokerDescriptor | undefined>;
  /** Check that a descriptor points at a healthy compatible broker. */
  health?: (descriptor: BrokerDescriptor) => Promise<boolean>;
  fileExists?: (filePath: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface EnsureBrokerResult {
  skipped: boolean;
  started: boolean;
  reused: boolean;
  descriptor?: BrokerDescriptor;
  descriptorPath: string;
  logPath: string;
  configPath: string;
  /** Broker origin when known, e.g. `http://127.0.0.1:8787`. */
  url?: string;
  reason?: string;
}

export class BrokerStartError extends Error {
  readonly descriptorPath: string;
  readonly logPath: string;
  readonly configPath: string;

  constructor(
    message: string,
    details: { descriptorPath: string; logPath: string; configPath: string },
  ) {
    super(message);
    this.name = "BrokerStartError";
    this.descriptorPath = details.descriptorPath;
    this.logPath = details.logPath;
    this.configPath = details.configPath;
  }
}

const inFlight = new Map<string, Promise<EnsureBrokerResult>>();

function defaultFileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(
  command: string,
  args: string[],
  options: {
    cwd: string;
    detached: boolean;
    stdio: "ignore";
    env: NodeJS.ProcessEnv;
  },
): BrokerChild {
  return nodeSpawn(command, args, {
    cwd: options.cwd,
    detached: options.detached,
    stdio: options.stdio,
    env: options.env,
  }) as unknown as BrokerChild;
}

async function defaultReadDescriptor(
  descriptorPath: string,
): Promise<BrokerDescriptor | undefined> {
  let source: string;
  try {
    source = await readFile(descriptorPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return normalizeDescriptor(JSON.parse(source), descriptorPath);
  } catch {
    return undefined;
  }
}

async function defaultHealth(descriptor: BrokerDescriptor): Promise<boolean> {
  try {
    const client = BrokerClient.forDescriptor(descriptor, { timeoutMs: 1_500 });
    const health = await client.health();
    return health.ok === true && health.pid === descriptor.pid;
  } catch {
    return false;
  }
}

/** Walk up from this module to the package root that owns dist/broker/main.js. */
export function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    // In the bundled extension this starts at `<package>/dist`; in source it
    // starts at `<package>/src/extension`.
    if (path.basename(directory) === "dist") {
      return path.dirname(directory);
    }
    if (path.basename(directory) === "src") {
      return path.dirname(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.resolve(directory, "..");
}

/**
 * Resolve the broker entry point. Only the built file is used; set
 * `PI_AGENT_ORCHESTRATOR_BROKER_ENTRY` to override it during development.
 * There is deliberately no `.ts` fallback because spawning `node file.ts` is
 * not reliable across Node versions.
 */
export function resolveBrokerEntry(
  options: { brokerEntry?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  return path.resolve(
    options.brokerEntry ??
      env[BROKER_ENTRY_ENV] ??
      path.join(packageRoot(), "dist", "broker", "main.js"),
  );
}

function isWorkerProcess(env: NodeJS.ProcessEnv): boolean {
  return env[WORKER_ENV] === "1";
}

function isAutostartDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[NO_AUTOSTART_ENV];
  if (value === undefined) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

/**
 * Ensure exactly one broker is running for a project.
 *
 * The broker itself owns the atomic broker.json / lock file, so concurrent
 * extension processes converge on one daemon. Within this process concurrent
 * calls additionally share one in-flight promise, so a burst of tools never
 * spawns a second child.
 */
export function ensureBroker(options: EnsureBrokerOptions): Promise<EnsureBrokerResult> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd);
  const configPath = path.resolve(cwd, options.configPath ?? DEFAULT_CONFIG_PATH);
  const descriptorPath = brokerDescriptorPath(cwd);

  if (isWorkerProcess(env)) {
    return Promise.resolve({
      skipped: true,
      started: false,
      reused: false,
      descriptorPath,
      logPath: brokerLogPath(cwd),
      configPath,
      reason:
        "PI_AGENT_ORCHESTRATOR_WORKER=1: worker processes never start another broker",
    });
  }

  if (isAutostartDisabled(env)) {
    return Promise.resolve({
      skipped: true,
      started: false,
      reused: false,
      descriptorPath,
      logPath: brokerLogPath(cwd),
      configPath,
      reason:
        `${NO_AUTOSTART_ENV}=1: broker is managed externally (for example Docker Compose); ` +
        "run `docker compose up -d` or /agents start after enabling autostart",
    });
  }

  const key = `${descriptorPath}\u0000${configPath}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = ensureBrokerInternal({ ...options, cwd, configPath, env }).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function ensureBrokerInternal(
  options: EnsureBrokerOptions & { cwd: string; configPath: string; env: NodeJS.ProcessEnv },
): Promise<EnsureBrokerResult> {
  const cwd = options.cwd;
  const configPath = options.configPath;
  const env = options.env;
  const descriptorPath = brokerDescriptorPath(cwd);
  const logPath = brokerLogPath(cwd);
  const readDescriptor = options.readDescriptor ?? defaultReadDescriptor;
  const health = options.health ?? defaultHealth;
  const fileExists = options.fileExists ?? defaultFileExists;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 100);
  const spawnBroker = options.spawn ?? defaultSpawn;

  if (!(await fileExists(configPath))) {
    throw new BrokerStartError(
      `No agent config found at ${configPath}. Create .pi/agents.yml with at least one agent role.`,
      { descriptorPath, logPath, configPath },
    );
  }

  const before = await readDescriptor(descriptorPath);
  if (before && (await health(before))) {
    return {
      skipped: false,
      started: false,
      reused: true,
      descriptor: before,
      descriptorPath,
      logPath,
      configPath,
      url: `http://127.0.0.1:${before.port}`,
    };
  }

  const brokerEntry = resolveBrokerEntry({
    ...(options.brokerEntry !== undefined ? { brokerEntry: options.brokerEntry } : {}),
    env,
  });
  if (!(await fileExists(brokerEntry))) {
    throw new BrokerStartError(
      `Broker entry not found at ${brokerEntry}. Run "npm run build" in the pi-agent-orchestrator package, or set ${BROKER_ENTRY_ENV}.`,
      { descriptorPath, logPath, configPath },
    );
  }
  let childExit: { code?: number; signal?: string; error?: string } | undefined;
  let child: BrokerChild;
  try {
    child = spawnBroker(
      process.execPath,
      [brokerEntry, "--workdir", cwd, "--config", configPath, "--daemon"],
      {
        cwd,
        detached: true,
        stdio: "ignore",
        env: { ...env },
      },
    );
  } catch (error) {
    throw new BrokerStartError(
      `Could not spawn the broker: ${(error as Error).message}. See ${logPath}.`,
      { descriptorPath, logPath, configPath },
    );
  }

  child.once?.("error", (...args: unknown[]) => {
    childExit = { error: String(args[0] instanceof Error ? args[0].message : args[0]) };
  });
  child.once?.("exit", (...args: unknown[]) => {
    childExit = {
      ...(typeof args[0] === "number" ? { code: args[0] } : {}),
      ...(typeof args[1] === "string" ? { signal: args[1] } : {}),
    };
  });
  child.unref?.();

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const descriptor = await readDescriptor(descriptorPath);
    if (descriptor && (await health(descriptor))) {
      return {
        skipped: false,
        started: true,
        reused: false,
        descriptor,
        descriptorPath,
        logPath,
        configPath,
        url: `http://127.0.0.1:${descriptor.port}`,
      };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  const stale = await readDescriptor(descriptorPath);
  const staleNote = stale
    ? ` Found a descriptor for pid ${stale.pid} on port ${stale.port}, but its health check failed.`
    : "";
  const exitNote = childExit
    ? ` Broker child exited (${childExit.error ?? `code ${childExit.code ?? "unknown"}${childExit.signal ? `, signal ${childExit.signal}` : ""}`}).`
    : child.pid
      ? ` Started pid ${child.pid}, but it did not become healthy.`
      : " The broker child was started, but it did not become healthy.";
  throw new BrokerStartError(
    `Agent orchestrator broker did not become healthy within ${timeoutMs}ms.${staleNote}${exitNote} Check ${logPath} and ${descriptorPath}.`,
    { descriptorPath, logPath, configPath },
  );
}

/** Forget any in-process in-flight spawn state (tests only). */
export function resetEnsureBrokerState(): void {
  inFlight.clear();
}
