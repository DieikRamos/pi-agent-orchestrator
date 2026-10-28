import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { parseModelSpec } from "../config.js";
import {
  EFFORTS,
  type AgentConfig,
  type Effort,
  type ModelResolver,
  type ResolvedModel,
} from "../types.js";

/**
 * Model resolution for worker replicas.
 *
 * The broker validates every role's model and effort once at startup, before
 * any worker process is spawned. Runtime lookups are intentionally structural:
 * production uses `ModelRuntime`, tests inject a tiny fake catalogue with no
 * credentials, network access or model calls.
 */

/** Minimal model fields the resolver needs from Pi's model catalogue. */
export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  /**
   * Pi maps thinking levels to provider-specific values. A `null` value marks
   * the level as unsupported; a missing key uses the provider default.
   */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/** The subset of `ModelRuntime` used for resolution (also satisfied by fakes). */
export interface ModelCatalog {
  getModels(provider?: string): readonly CatalogModel[];
  getModel?(provider: string, id: string): CatalogModel | undefined;
  getAvailable?(provider?: string): Promise<readonly CatalogModel[]>;
  getAvailableSnapshot?(): readonly CatalogModel[];
}

export interface ResolvedAgentModel extends ResolvedModel {
  /** Effective Pi thinking level derived from the role's effort. */
  thinkingLevel: ThinkingLevel;
  /** The catalogue entry selected for the role. */
  modelInfo: CatalogModel;
}

export interface ResolveWithThinkingOptions {
  /**
   * Thinking levels reported by the running worker (`get_available_thinking_levels`).
   * When supplied, the requested level is validated against this list.
   */
  availableThinkingLevels?: readonly string[];
}

export class ModelResolutionError extends Error {
  readonly candidates: string[];
  readonly role?: string;

  constructor(message: string, options: { candidates?: readonly string[]; role?: string } = {}) {
    super(options.role ? `agent "${options.role}": ${message}` : message);
    this.name = "ModelResolutionError";
    this.candidates = [...(options.candidates ?? [])];
    if (options.role !== undefined) this.role = options.role;
  }
}

export class ThinkingLevelError extends ModelResolutionError {
  readonly level: string;
  readonly supported: string[];

  constructor(message: string, level: string, supported: readonly string[], role?: string) {
    super(message, { candidates: supported, role });
    this.name = "ThinkingLevelError";
    this.level = level;
    this.supported = [...supported];
  }
}

const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

function normalizeProvider(provider: string | undefined): string | undefined {
  if (provider === undefined) return undefined;
  const normalized = provider.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function modelLabel(model: CatalogModel): string {
  return `${model.provider}/${model.id}`;
}

function modelDescription(model: CatalogModel): string {
  return model.name && model.name !== model.id
    ? `${modelLabel(model)} (${model.name})`
    : modelLabel(model);
}

function dedupeModels(models: readonly CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  const result: CatalogModel[] = [];
  for (const model of models) {
    const key = `${normalizeProvider(model.provider) ?? model.provider}\u0000${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

function describeCandidates(models: readonly CatalogModel[], limit = 12): string[] {
  return dedupeModels(models)
    .slice(0, limit)
    .map(modelDescription);
}

function uniqueProviders(models: readonly CatalogModel[]): string[] {
  return [...new Set(models.map((model) => normalizeProvider(model.provider) ?? model.provider))].sort();
}

function matchesPattern(value: string, pattern: string): boolean {
  const lowerValue = value.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  if (lowerPattern.includes("*") || lowerPattern.includes("?")) {
    const escaped = lowerPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return regex.test(lowerValue);
  }
  return lowerValue.includes(lowerPattern);
}

function exactIdMatch(models: readonly CatalogModel[], spec: string): CatalogModel[] {
  const exact = models.filter((model) => model.id === spec);
  if (exact.length > 0) return exact;
  const lower = spec.toLowerCase();
  return models.filter((model) => model.id.toLowerCase() === lower);
}

function exactNameMatch(models: readonly CatalogModel[], spec: string): CatalogModel[] {
  const lower = spec.toLowerCase();
  return models.filter((model) => (model.name ?? "").toLowerCase() === lower);
}

function patternMatch(models: readonly CatalogModel[], spec: string): CatalogModel[] {
  return models.filter(
    (model) => matchesPattern(model.id, spec) || matchesPattern(model.name ?? "", spec),
  );
}

function selectUnique(
  matches: readonly CatalogModel[],
  spec: string,
  role: string,
  provider: string | undefined,
): CatalogModel {
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new ModelResolutionError(
      `model spec "${spec}" is ambiguous: ${matches.length} models match (${describeCandidates(matches).join(", ")}). ` +
        (provider
          ? `Use the exact model id from provider "${provider}".`
          : "Use \"provider/model\" to disambiguate."),
      { candidates: matches.map(modelLabel), role },
    );
  }
  throw new ModelResolutionError(`model spec "${spec}" did not match a model`, { role });
}

/**
 * Convert a role effort to Pi's thinking level. Case-insensitive; an absent
 * effort defaults to `medium` for reasoning models and `off` otherwise.
 */
export function resolveThinkingLevel(
  effort: string | undefined,
  model?: Pick<CatalogModel, "reasoning">,
): ThinkingLevel {
  if (effort === undefined || effort.trim().length === 0) {
    return model?.reasoning === false ? "off" : DEFAULT_THINKING_LEVEL;
  }
  const normalized = effort.trim().toLowerCase();
  if (!(EFFORTS as readonly string[]).includes(normalized)) {
    throw new ThinkingLevelError(
      `invalid effort "${effort}" (allowed: ${EFFORTS.join(", ")})`,
      effort,
      EFFORTS,
    );
  }
  return normalized as ThinkingLevel;
}

/** Thinking levels a catalogue model can run, in Pi order. */
export function supportedThinkingLevels(
  model: Pick<CatalogModel, "reasoning" | "thinkingLevelMap">,
): ThinkingLevel[] {
  return EFFORTS.filter((level) => isThinkingLevelSupported(model, level)) as ThinkingLevel[];
}

export function isThinkingLevelSupported(
  model: Pick<CatalogModel, "reasoning" | "thinkingLevelMap">,
  level: string,
): boolean {
  const normalized = level.trim().toLowerCase();
  if (!(EFFORTS as readonly string[]).includes(normalized)) return false;
  if (normalized === "off") return true;
  if (model.reasoning === false) return false;
  const map = model.thinkingLevelMap;
  if (map && Object.prototype.hasOwnProperty.call(map, normalized)) {
    return map[normalized as ThinkingLevel] !== null;
  }
  return true;
}

/**
 * Validate an effort/thinking level against a model entry and, when available,
 * the levels reported by a running RpcClient.
 */
export function assertThinkingLevelSupported(
  model: Pick<CatalogModel, "provider" | "id" | "reasoning" | "thinkingLevelMap">,
  level: string,
  options: ResolveWithThinkingOptions & { role?: string } = {},
): ThinkingLevel {
  const normalized = resolveThinkingLevel(level, model);
  const supported = supportedThinkingLevels(model);
  if (!isThinkingLevelSupported(model, normalized)) {
    throw new ThinkingLevelError(
      `effort "${level}" is not supported by model ${modelLabel(model)}; supported levels: ${supported.join(", ")}`,
      level,
      supported,
      options.role,
    );
  }
  if (options.availableThinkingLevels) {
    const available = options.availableThinkingLevels.map((item) => item.trim().toLowerCase());
    if (!available.includes(normalized)) {
      throw new ThinkingLevelError(
        `thinking level "${normalized}" is not available for model ${modelLabel(model)}; available levels: ${available.join(", ")}`,
        normalized,
        available,
        options.role,
      );
    }
  }
  return normalized;
}

/**
 * `ModelResolver` backed by Pi's `ModelRuntime`.
 *
 * Resolution order for a bare spec: exact model id, exact display name, then
 * substring/glob match on id or display name. Multiple matches are an error
 * that tells the user how to disambiguate; they are never silently picked.
 */
export class ModelRuntimeResolver implements ModelResolver {
  readonly runtime: ModelCatalog;

  constructor(runtime: ModelCatalog) {
    this.runtime = runtime;
  }

  async resolve(agent: AgentConfig): Promise<ResolvedModel> {
    const resolved = await this.resolveWithThinking(agent);
    return { provider: resolved.provider, model: resolved.model };
  }

  async resolveWithThinking(
    agent: AgentConfig,
    options: ResolveWithThinkingOptions = {},
  ): Promise<ResolvedAgentModel> {
    const modelInfo = await this.selectModel(agent);
    const thinkingLevel = assertThinkingLevelSupported(modelInfo, agent.effort ?? "", {
      ...options,
      role: agent.role,
    });
    return {
      provider: normalizeProvider(modelInfo.provider) ?? modelInfo.provider,
      model: modelInfo.id,
      thinkingLevel,
      modelInfo,
    };
  }

  private async selectModel(agent: AgentConfig): Promise<CatalogModel> {
    const spec = parseModelSpec(agent.model);
    const specProvider = normalizeProvider(spec.provider);
    const explicitProvider = normalizeProvider(agent.provider);

    if (specProvider && explicitProvider && specProvider !== explicitProvider) {
      throw new ModelResolutionError(
        `model spec "${agent.model}" names provider "${specProvider}" but agent.provider is "${explicitProvider}"`,
        { role: agent.role },
      );
    }
    const provider = explicitProvider ?? specProvider;

    const allModels = this.runtime.getModels(provider);
    const available = await this.getAvailable(provider, agent.role);

    const narrow = (models: readonly CatalogModel[]): CatalogModel[] =>
      provider
        ? models.filter((model) => (normalizeProvider(model.provider) ?? model.provider) === provider)
        : [...models];

    const availableModels = narrow(available);
    const allForProvider = narrow(allModels);

    const choose = (matches: readonly CatalogModel[]): CatalogModel | undefined => {
      if (matches.length === 0) return undefined;
      return selectUnique(matches, spec.model, agent.role, provider);
    };

    let selected =
      choose(exactIdMatch(availableModels, spec.model)) ??
      choose(exactNameMatch(availableModels, spec.model)) ??
      choose(patternMatch(availableModels, spec.model));

    if (selected) return selected;

    // Distinguish "no such model" from "model exists but has no usable
    // credentials", which are very different fixes for the user.
    const unavailableMatches = dedupeModels([
      ...exactIdMatch(allForProvider, spec.model),
      ...exactNameMatch(allForProvider, spec.model),
      ...patternMatch(allForProvider, spec.model),
    ]);
    if (unavailableMatches.length > 0) {
      throw new ModelResolutionError(
        `model "${spec.model}" matched ${describeCandidates(unavailableMatches).join(", ")} but none are available. ` +
          "Configure credentials for the provider (pi auth) or choose another model.",
        { candidates: unavailableMatches.map(modelLabel), role: agent.role },
      );
    }

    const knownProviders = uniqueProviders(this.runtime.getModels());
    const hint =
      knownProviders.length > 0
        ? ` Known providers: ${knownProviders.join(", ")}.`
        : " No models are configured in Pi.";
    throw new ModelResolutionError(
      `model "${spec.model}"${provider ? ` (provider "${provider}")` : ""} was not found.` +
        hint +
        (allModels.length > 0
          ? ` Candidates: ${describeCandidates(allModels).join(", ")}.`
          : ""),
      { candidates: describeCandidates(allModels), role: agent.role },
    );
  }

  private async getAvailable(
    provider: string | undefined,
    role: string,
  ): Promise<readonly CatalogModel[]> {
    if (this.runtime.getAvailable) {
      try {
        return await this.runtime.getAvailable(provider);
      } catch (error) {
        throw new ModelResolutionError(
          `could not check model availability${provider ? ` for provider "${provider}"` : ""}: ${(error as Error).message}`,
          { role },
        );
      }
    }
    if (this.runtime.getAvailableSnapshot) {
      const snapshot = this.runtime.getAvailableSnapshot();
      if (snapshot.length > 0) return snapshot;
    }
    return this.runtime.getModels(provider);
  }
}

export interface CreateModelResolverOptions {
  /** Inject a catalogue (tests, or a caller-owned ModelRuntime). */
  runtime?: ModelCatalog;
  /** Passed to `ModelRuntime.create`; network refresh is off by default. */
  runtimeOptions?: Parameters<typeof ModelRuntime.create>[0];
}

/** Build a resolver backed by a real `ModelRuntime`. */
export async function createModelResolver(
  options: CreateModelResolverOptions = {},
): Promise<ModelRuntimeResolver> {
  const runtime =
    options.runtime ??
    (await ModelRuntime.create({
      allowModelNetwork: false,
      refreshOnCreate: false,
      ...options.runtimeOptions,
    }));
  return new ModelRuntimeResolver(runtime);
}

async function resolveWithCustomResolver(
  resolver: ModelResolver,
  agent: AgentConfig,
): Promise<ResolvedAgentModel> {
  const resolved = await resolver.resolve(agent);
  return {
    ...resolved,
    thinkingLevel: resolveThinkingLevel(agent.effort),
    modelInfo: { provider: resolved.provider, id: resolved.model },
  };
}

/** Resolve every role once so startup fails before any worker is spawned. */
export async function resolveConfigModels(
  resolver: ModelResolver,
  agents: Iterable<AgentConfig>,
): Promise<Map<string, ResolvedAgentModel>> {
  const resolved = new Map<string, ResolvedAgentModel>();
  for (const agent of agents) {
    const value =
      resolver instanceof ModelRuntimeResolver
        ? await resolver.resolveWithThinking(agent)
        : await resolveWithCustomResolver(resolver, agent);
    resolved.set(agent.role, value);
  }
  return resolved;
}

export type { Effort };
