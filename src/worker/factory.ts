import path from "node:path";

import type {
  AgentConfig,
  AgentRuntime,
  ModelResolver,
  OrchestratorConfig,
  WorkerAdapter,
  WorkerFactory,
} from "../types.js";
import { STATE_DIR } from "../config.js";
import {
  FakeWorkerFactory,
  type FakeWorkerOptions,
  type FakeWorkerOptionsFactory,
} from "../testing/fake-worker.js";
import {
  ModelRuntimeResolver,
  createModelResolver,
  resolveThinkingLevel,
  type ResolvedAgentModel,
} from "../models/resolve.js";
import {
  RpcWorker,
  WorkerStartError,
  type RpcClientFactory,
  type RpcWorkerOptions,
} from "./rpc-worker.js";

/**
 * Worker factory selection and startup validation.
 *
 * Real Pi RPC workers are the default. `PI_ORCHESTRATOR_FAKE_WORKER=1` (or an
 * explicit `fake` option) selects the deterministic fake factory used by
 * integration tests. The real factory validates model and effort for every
 * role before the broker spawns anything.
 */

export interface RpcWorkerFactoryOptions {
  /** Project root used for session/state paths and role cwd resolution. */
  projectRoot: string;
  /** Durable broker state directory. Defaults to `<projectRoot>/.pi/agent-orchestrator`. */
  stateDir?: string;
  /** Session directory override. Defaults to `<stateDir>/sessions`. */
  sessionsDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  startTimeoutMs?: number;
  resetTimeoutMs?: number;
  cliPath?: string;
  args?: string[];
  clientFactory?: RpcClientFactory;
  clock?: () => Date;
  maxPayloadChars?: number;
}

export interface CreateWorkerFactoryOptions extends RpcWorkerFactoryOptions {
  config: OrchestratorConfig;
  /**
   * `true`/options/factory force fake workers. A boolean `false` forces real
   * workers even when the environment variable is set.
   */
  fake?: boolean | FakeWorkerOptions | FakeWorkerOptionsFactory;
  /** Injected resolver; defaults to a real ModelRuntime-backed resolver. */
  resolver?: ModelResolver;
}

/** `PI_ORCHESTRATOR_FAKE_WORKER` accepts `1`/`true`/`yes`. */
export function isFakeWorkerMode(value = process.env.PI_ORCHESTRATOR_FAKE_WORKER): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

function fakeOptionsFrom(
  fake: boolean | FakeWorkerOptions | FakeWorkerOptionsFactory | undefined,
): FakeWorkerOptions | FakeWorkerOptionsFactory | undefined {
  if (fake === undefined || typeof fake === "boolean") return undefined;
  return fake;
}

/**
 * Real worker factory.
 *
 * Call `prepare(config)` before `create(...)`; this is what the broker does in
 * its startup path so an invalid model/effort fails fast with an actionable
 * error instead of a half-started process pool.
 */
export class RpcWorkerFactory implements WorkerFactory {
  readonly options: RpcWorkerFactoryOptions;
  private readonly resolver: ModelResolver | undefined;
  private readonly resolved = new Map<string, ResolvedAgentModel>();
  private readonly sessionsDir: string;

  constructor(options: RpcWorkerFactoryOptions, resolver?: ModelResolver) {
    this.options = options;
    this.resolver = resolver;
    this.sessionsDir =
      options.sessionsDir ??
      path.join(options.stateDir ?? path.join(options.projectRoot, STATE_DIR), "sessions");
  }

  /** Resolve and validate every role once, before any worker is spawned. */
  async prepare(config: OrchestratorConfig): Promise<Map<string, ResolvedAgentModel>> {
    const resolver = this.resolver ?? (await createModelResolver());
    this.resolved.clear();
    for (const agent of Object.values(config.agents)) {
      const value = await this.resolveAgent(agent, resolver);
      this.resolved.set(agent.role, value);
    }
    return new Map(this.resolved);
  }

  /** Validate a single role (useful for reload of a changed role). */
  async prepareAgent(agent: AgentConfig): Promise<ResolvedAgentModel> {
    const resolver = this.resolver ?? (await createModelResolver());
    const value = await this.resolveAgent(agent, resolver);
    this.resolved.set(agent.role, value);
    return value;
  }

  resolvedModel(role: string): ResolvedAgentModel | undefined {
    return this.resolved.get(role);
  }

  create(agent: AgentRuntime): WorkerAdapter {
    const resolved = this.resolved.get(agent.role);
    if (!resolved) {
      throw new WorkerStartError(
        `worker ${agent.id}: model for role "${agent.role}" was not validated. ` +
          "Call RpcWorkerFactory.prepare(config) at broker startup before creating workers.",
      );
    }
    const options: RpcWorkerOptions = {
      agent,
      model: { provider: resolved.provider, model: resolved.model },
      thinkingLevel: resolved.thinkingLevel,
      projectRoot: this.options.projectRoot,
      sessionsDir: this.sessionsDir,
    };
    if (this.options.timeoutMs !== undefined) options.timeoutMs = this.options.timeoutMs;
    if (this.options.startTimeoutMs !== undefined) options.startTimeoutMs = this.options.startTimeoutMs;
    if (this.options.resetTimeoutMs !== undefined) options.resetTimeoutMs = this.options.resetTimeoutMs;
    if (this.options.env !== undefined) options.env = this.options.env;
    if (this.options.cliPath !== undefined) options.cliPath = this.options.cliPath;
    if (this.options.args !== undefined) options.args = this.options.args;
    if (this.options.clientFactory !== undefined) options.clientFactory = this.options.clientFactory;
    if (this.options.clock !== undefined) options.clock = this.options.clock;
    if (this.options.maxPayloadChars !== undefined) options.maxPayloadChars = this.options.maxPayloadChars;
    return new RpcWorker(options);
  }

  private async resolveAgent(
    agent: AgentConfig,
    resolver: ModelResolver,
  ): Promise<ResolvedAgentModel> {
    if (resolver instanceof ModelRuntimeResolver) {
      return resolver.resolveWithThinking(agent);
    }
    const resolved = await resolver.resolve(agent);
    // A custom resolver only returns provider/model, so validate the effort
    // syntax and map it without a catalogue-specific thinking-level check.
    const thinkingLevel = resolveThinkingLevel(agent.effort);
    return {
      ...resolved,
      thinkingLevel,
      modelInfo: {
        provider: resolved.provider,
        id: resolved.model,
      },
    };
  }
}

/**
 * Create the worker factory the broker should use.
 *
 * Fake workers are selected deterministically by env/option and do not spawn
 * processes. Real workers are validated eagerly; this function rejects before
 * the broker starts listening when a role's model or effort is invalid.
 */
export async function createWorkerFactory(
  options: CreateWorkerFactoryOptions,
): Promise<WorkerFactory> {
  const { config, fake, resolver, ...rpcOptions } = options;
  const useFake =
    typeof fake === "boolean" ? fake : fake !== undefined || isFakeWorkerMode();
  if (useFake) {
    return new FakeWorkerFactory(fakeOptionsFrom(fake) ?? {});
  }
  const factory = new RpcWorkerFactory(rpcOptions, resolver);
  await factory.prepare(config);
  return factory;
}
