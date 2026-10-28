#!/usr/bin/env node
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrokerClient, type BrokerDescriptor } from "../client/broker-client.js";
import {
  DEFAULT_CONFIG_PATH,
  STATE_DIR,
  loadConfig,
  type LoadConfigOptions,
} from "../config.js";
import { createBrokerCore, type BrokerCore } from "./core.js";
import { createWorkerFactory, RpcWorkerFactory } from "../worker/factory.js";
import { createServer, type BrokerHttpServer } from "../server/http.js";
import type { LoadedConfig } from "../types.js";

/** Name used in broker.json and health responses. */
const BROKER_NAME = "pi-agent-orchestrator";
const BROKER_VERSION = "0.1.0";

export interface BrokerCliOptions {
  configPath: string;
  stateDir: string;
  /** Project/workspace root used for config/state/worker cwd resolution. */
  workdir?: string;
  /** Bind host override. Non-loopback requires PI_ORCHESTRATOR_ALLOW_REMOTE_BIND=1. */
  host?: string;
  /** CLI override; undefined means use the config's `server.port`. */
  port?: number;
  daemon: boolean;
  fakeWorker: boolean;
  help: boolean;
}

export interface BrokerPaths {
  configPath: string;
  stateDir: string;
  descriptorPath: string;
  logPath: string;
}

export const USAGE = `Usage: pi-agent-orchestrator [options]

Run the local agent orchestrator broker (loopback only).

Options:
  --workdir <path>     Project/workspace root (default: PI_ORCHESTRATOR_WORKDIR or cwd)
  --config <path>      Agent config file (default: <workdir>/${DEFAULT_CONFIG_PATH})
  --state-dir <path>   Durable state directory (default: <workdir>/${STATE_DIR})
  --host <host>        Bind host (default: config server.host, loopback only)
  --port <number>      HTTP port; 0 picks a free port (default: config server.port)
  --daemon             Run detached-friendly without terminal assumptions
  --fake-worker        Use deterministic in-memory workers (no model calls)
  -h, --help           Show this help

Docker: pass --host 0.0.0.0 with PI_ORCHESTRATOR_ALLOW_REMOTE_BIND=1 and publish
the port only on host loopback (see docker-compose.yml).
`;

export class BrokerCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "BrokerCliError";
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv: string[]): BrokerCliOptions {
  const options: BrokerCliOptions = {
    configPath: DEFAULT_CONFIG_PATH,
    stateDir: STATE_DIR,
    daemon: false,
    fakeWorker: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith("-")) {
      throw new BrokerCliError(`Unexpected argument "${raw}".\n\n${USAGE}`);
    }
    const equals = raw.indexOf("=");
    const flag = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new BrokerCliError(`Option ${flag} requires a value.\n\n${USAGE}`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "--workdir":
        options.workdir = takeValue();
        break;
      case "--config":
        options.configPath = takeValue();
        break;
      case "--host":
        options.host = takeValue();
        break;
      case "--state-dir":
        options.stateDir = takeValue();
        break;
      case "--port": {
        const rawPort = takeValue();
        const value = Number(rawPort);
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new BrokerCliError(`--port must be an integer from 0 to 65535, got "${rawPort}"`);
        }
        options.port = value;
        break;
      }
      case "--daemon":
        options.daemon = true;
        break;
      case "--fake-worker":
        options.fakeWorker = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new BrokerCliError(`Unknown option "${flag}".\n\n${USAGE}`);
    }
  }
  return options;
}

export function resolveBrokerPaths(options: {
  configPath: string;
  stateDir: string;
  cwd?: string;
}): BrokerPaths {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return {
    configPath: path.resolve(cwd, options.configPath),
    stateDir: path.resolve(cwd, options.stateDir),
    descriptorPath: path.resolve(cwd, options.stateDir, "broker.json"),
    logPath: path.resolve(cwd, options.stateDir, "broker.log"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDescriptor(raw: unknown): BrokerDescriptor | undefined {
  if (!isRecord(raw)) return undefined;
  const { pid, port, startedAt, configPath, token } = raw;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  if (typeof startedAt !== "string" || startedAt.length === 0) return undefined;
  if (typeof configPath !== "string" || configPath.length === 0) return undefined;
  const descriptor: BrokerDescriptor = { pid, port, startedAt, configPath };
  if (typeof token === "string" && token.length > 0) descriptor.token = token;
  return descriptor;
}

export async function readDescriptor(
  descriptorPath: string,
): Promise<BrokerDescriptor | undefined> {
  let source: string;
  try {
    source = await readFile(descriptorPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseDescriptor(JSON.parse(source));
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Health-check a descriptor; resolves true only for the same broker pid. */
export async function descriptorIsHealthy(
  descriptor: BrokerDescriptor,
  timeoutMs = 1_500,
): Promise<boolean> {
  if (!isProcessAlive(descriptor.pid)) return false;
  try {
    const client = BrokerClient.forDescriptor(descriptor, { timeoutMs });
    const health = await client.health();
    return health.ok === true && health.name === BROKER_NAME && health.pid === descriptor.pid;
  } catch {
    return false;
  }
}

/** Atomically write broker.json (temp file + rename in the same directory). */
export async function writeDescriptor(
  descriptorPath: string,
  descriptor: BrokerDescriptor,
): Promise<void> {
  await mkdir(path.dirname(descriptorPath), { recursive: true });
  const temp = `${descriptorPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  await rename(temp, descriptorPath);
}

/** Remove broker.json only when it still belongs to this broker process. */
export async function removeOwnDescriptor(
  descriptorPath: string,
  pid = process.pid,
): Promise<void> {
  const descriptor = await readDescriptor(descriptorPath);
  if (descriptor && descriptor.pid !== pid) return;
  await rm(descriptorPath, { force: true });
}

function stamp(): string {
  return new Date().toISOString();
}

export interface RunBrokerOptions extends BrokerCliOptions {
  /** Alias for workdir, retained for the existing test/API surface. */
  cwd?: string;
}

export interface RunningBroker {
  core: BrokerCore;
  server: BrokerHttpServer;
  descriptor: BrokerDescriptor;
  url: string;
  /** Resolves after the HTTP server, workers and state writes have stopped. */
  stopped: Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Start a broker in the current process. Exposed for the CLI and tests; the
 * caller owns signal handling and process exit.
 */
export async function runBroker(options: RunBrokerOptions): Promise<RunningBroker | undefined> {
  if (options.fakeWorker) process.env.PI_ORCHESTRATOR_FAKE_WORKER = "1";

  const cwd = path.resolve(
    options.workdir ??
      process.env.PI_ORCHESTRATOR_WORKDIR ??
      options.cwd ??
      process.cwd(),
  );
  const paths = resolveBrokerPaths({
    configPath: options.configPath,
    stateDir: options.stateDir,
    cwd,
  });

  let loaded: LoadedConfig;
  try {
    const configOptions: LoadConfigOptions = { path: paths.configPath, cwd };
    loaded = await loadConfig(configOptions);
  } catch (error) {
    throw new BrokerCliError(
      `${(error as Error).message}\n\nCreate ${DEFAULT_CONFIG_PATH} (see examples/agents.yml) or pass --config <path>.`,
    );
  }

  await mkdir(paths.stateDir, { recursive: true });
  const logStream = createWriteStream(paths.logPath, { flags: "a" });
  const log = (message: string): void => {
    const line = `[${stamp()}] ${message}\n`;
    logStream.write(line);
    if (!options.daemon) process.stderr.write(line);
  };

  // Single-instance guard: reuse a healthy broker, clean up stale descriptors.
  const existing = await readDescriptor(paths.descriptorPath);
  if (existing) {
    if (await descriptorIsHealthy(existing)) {
      log(
        `broker already running for ${paths.configPath} at http://127.0.0.1:${existing.port} (pid ${existing.pid}); exiting`,
      );
      logStream.end();
      return undefined;
    }
    log(
      `removing stale broker descriptor for pid ${existing.pid} (health check failed)`,
    );
    await rm(paths.descriptorPath, { force: true });
  }

  let workerFactory;
  try {
    workerFactory = await createWorkerFactory({
      config: loaded.config,
      projectRoot: cwd,
      stateDir: paths.stateDir,
      fake: options.fakeWorker ? true : undefined,
    });
  } catch (error) {
    log(`worker/model validation failed: ${(error as Error).message}`);
    await new Promise<void>((resolve) => logStream.end(resolve));
    throw new BrokerCliError(
      `Cannot start broker: ${(error as Error).message}`,
      2,
    );
  }

  const reloadConfig = async (): Promise<LoadedConfig> => {
    const next = await loadConfig({ path: paths.configPath, cwd });
    if (workerFactory instanceof RpcWorkerFactory) {
      await workerFactory.prepare(next.config);
    }
    return next;
  };

  const core = createBrokerCore({
    config: loaded,
    workerFactory,
    stateDir: paths.stateDir,
    reloadConfig,
  });

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let descriptor: BrokerDescriptor | undefined;
  let markStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log("shutting down");
      try {
        await server?.close();
      } catch (error) {
        log(`server close failed: ${(error as Error).message}`);
      }
      try {
        await core.stop();
      } catch (error) {
        log(`core stop failed: ${(error as Error).message}`);
      }
      try {
        await removeOwnDescriptor(paths.descriptorPath);
      } catch (error) {
        log(`could not remove descriptor: ${(error as Error).message}`);
      }
      log("stopped");
      await new Promise<void>((resolve) => logStream.end(resolve));
      markStopped();
    })();
    return shutdownPromise;
  };

  const port = options.port ?? loaded.config.server.port;
  const server = createServer(core, {
    config: loaded.config,
    port,
    host: options.host ?? loaded.config.server.host,
    allowNonLoopbackHost: process.env.PI_ORCHESTRATOR_ALLOW_REMOTE_BIND === "1",
    dashboard: loaded.config.server.dashboard,
    logger: log,
    onShutdown: () => {
      // The HTTP response is written before the server closes; shutdown runs
      // from the event loop so the client receives { ok: true } first.
      setTimeout(() => {
        void shutdown().then(() => {
          process.exitCode = 0;
        });
      }, 25);
    },
  });

  try {
    await core.start();
    const address = await server.listen();
    descriptor = {
      pid: process.pid,
      port: address.port,
      startedAt: new Date().toISOString(),
      configPath: paths.configPath,
    };
    await writeDescriptor(paths.descriptorPath, descriptor);
    log(
      `broker listening at ${address.url} (pid ${process.pid}, config ${paths.configPath}, dashboard ${loaded.config.server.dashboard ? "on" : "off"})`,
    );
  } catch (error) {
    await shutdown();
    throw new BrokerCliError(`Broker startup failed: ${(error as Error).message}`, 1);
  }

  return {
    core,
    server,
    descriptor: descriptor!,
    url: `http://127.0.0.1:${descriptor!.port}`,
    stopped,
    shutdown,
  };
}

/** CLI entry point. Returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: BrokerCliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return (error as BrokerCliError).exitCode ?? 2;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let running: RunningBroker | undefined;
  try {
    running = await runBroker(options);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return (error as BrokerCliError).exitCode ?? 1;
  }

  // Another broker is already healthy for this project.
  if (!running) return 0;

  const broker = running;
  let exitCode = 0;
  const stop = (signal: string, code: number): void => {
    if (exitCode === 0) exitCode = code;
    void broker.shutdown().catch((error: unknown) => {
      process.stderr.write(`shutdown failed: ${(error as Error).message}\n`);
    });
    void signal;
  };

  process.once("SIGINT", () => stop("SIGINT", 0));
  process.once("SIGTERM", () => stop("SIGTERM", 0));
  if (options.daemon) {
    // A detached broker should survive its launching terminal.
    process.on("SIGHUP", () => undefined);
  }

  process.on("uncaughtException", (error) => {
    process.stderr.write(`uncaught exception: ${error.stack ?? error.message}\n`);
    stop("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandled rejection: ${String(reason)}\n`);
    stop("unhandledRejection", 1);
  });

  await broker.stopped;
  return exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
