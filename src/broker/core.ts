import path from "node:path";

import { STATE_DIR } from "../config.js";
import type {
  AgentView,
  BrokerState,
  LoadedConfig,
  OrchestratorConfig,
  OrchestratorCore,
  ReviewDecision,
  SSEListener,
  Task,
  TaskFilter,
  TaskView,
  WorkerFactory,
} from "../types.js";
import { EventBus } from "./event-bus.js";
import {
  BrokerError,
  Scheduler,
  type BrokerSubmitInput,
  type SchedulerRecovery,
} from "./scheduler.js";
import { StateStore, type BrokerAction } from "./state-store.js";

export interface BrokerCoreOptions {
  /** Already loaded/validated config. */
  config: LoadedConfig;
  workerFactory: WorkerFactory;
  /** State directory; defaults to `<cwd>/.pi/agent-orchestrator`. */
  stateDir?: string;
  clock?: () => Date;
  idGenerator?: () => string;
  maxActions?: number;
  maxTaskLogs?: number;
  /**
   * Reload loader used by `reload()`. The host (HTTP/CLI/extension) decides how
   * to read config; the core validates state and applies the roster changes.
   */
  reloadConfig?: () => Promise<LoadedConfig>;
}

/**
 * OrchestratorCore implementation.
 *
 * This class is transport-agnostic: the HTTP server and Pi extension depend on
 * it, while worker subprocesses only ever see the WorkerAdapter contract.
 */
export class BrokerCore implements OrchestratorCore {
  private config: LoadedConfig;
  private readonly workerFactory: WorkerFactory;
  private readonly stateStore: StateStore;
  private readonly events: EventBus;
  private readonly scheduler: Scheduler;
  private readonly reloadConfig?: () => Promise<LoadedConfig>;
  private started = false;
  private stopped = false;

  constructor(options: BrokerCoreOptions) {
    this.config = options.config;
    this.workerFactory = options.workerFactory;
    this.stateStore = new StateStore({
      dir: options.stateDir ?? path.join(process.cwd(), STATE_DIR),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.maxActions !== undefined ? { maxActions: options.maxActions } : {}),
    });
    this.events = new EventBus({
      ...(options.clock ? { clock: options.clock } : {}),
    });
    this.scheduler = new Scheduler({
      config: options.config.config,
      configFingerprint: options.config.configFingerprint,
      workerFactory: options.workerFactory,
      stateStore: this.stateStore,
      events: this.events,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      ...(options.maxActions !== undefined ? { maxActions: options.maxActions } : {}),
      ...(options.maxTaskLogs !== undefined ? { maxTaskLogs: options.maxTaskLogs } : {}),
    });
    if (options.reloadConfig) this.reloadConfig = options.reloadConfig;
  }

  get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  get configFingerprint(): string {
    return this.config.configFingerprint;
  }

  async start(): Promise<void> {
    if (this.started && !this.stopped) return;
    const loaded = await this.stateStore.init(this.config.configFingerprint);
    this.events.setSeq(loaded.state?.seq ?? 0);
    const recovery: SchedulerRecovery = {
      ...(loaded.state ? { state: loaded.state } : {}),
      actions: loaded.actions,
      clientRequests: loaded.clientRequests,
      ...(loaded.fingerprintMatches === undefined
        ? {}
        : { fingerprintMatches: loaded.fingerprintMatches }),
    };
    await this.scheduler.start(recovery);
    this.started = true;
    this.stopped = false;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.scheduler.stop();
    this.started = false;
    this.stopped = true;
  }

  submit(input: BrokerSubmitInput): Promise<Task> {
    this.assertRunning();
    return this.scheduler.submit(input);
  }

  waitForReview(taskId: string, timeoutMs?: number): Promise<Task> {
    this.assertRunning();
    return this.scheduler.waitForReview(taskId, timeoutMs);
  }

  review(taskId: string, decision: ReviewDecision, feedback?: string): Promise<Task> {
    this.assertRunning();
    return this.scheduler.review(taskId, decision, feedback);
  }

  cancel(taskId: string): Promise<Task> {
    this.assertRunning();
    return this.scheduler.cancel(taskId);
  }

  listAgents(): AgentView[] {
    return this.scheduler.listAgents();
  }

  listTasks(filter?: TaskFilter): TaskView[] {
    return this.scheduler.listTasks(filter);
  }

  getTask(taskId: string): TaskView | undefined {
    return this.scheduler.getTask(taskId);
  }

  getSnapshot(): BrokerState {
    return this.scheduler.getSnapshot();
  }

  subscribe(listener: SSEListener): () => void {
    return this.events.subscribe(listener);
  }

  /** Retained events for SSE Last-Event-ID reconnects. */
  replayEvents(lastSeq?: number): ReturnType<EventBus["replay"]> {
    return this.events.replay(lastSeq);
  }

  getActionLog(): BrokerAction[] {
    return this.scheduler.getActionLog();
  }

  getClientRequests(): Record<string, string> {
    return this.scheduler.getClientRequests();
  }

  async reload(config?: LoadedConfig): Promise<OrchestratorConfig> {
    this.assertRunning();
    if (this.scheduler.hasLockedTasks()) {
      throw new BrokerError(
        "conflict",
        "cannot reload while tasks are assigned, running or awaiting review",
      );
    }
    let loaded = config;
    if (!loaded) {
      if (!this.reloadConfig) {
        throw new BrokerError(
          "invalid_request",
          "reload is not configured for this broker instance; pass a loaded config",
        );
      }
      loaded = await this.reloadConfig();
    }
    const applied = await this.scheduler.applyConfig(loaded);
    this.config = loaded;
    return applied;
  }

  private assertRunning(): void {
    if (!this.started || this.stopped) {
      throw new BrokerError("conflict", "broker is not running");
    }
  }
}

export function createBrokerCore(options: BrokerCoreOptions): BrokerCore {
  return new BrokerCore(options);
}

export { BrokerError } from "./scheduler.js";
export type { BrokerSubmitInput } from "./scheduler.js";
export type { BrokerAction } from "./state-store.js";
