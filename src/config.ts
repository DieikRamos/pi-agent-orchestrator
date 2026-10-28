import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  EFFORTS,
  type AgentConfig,
  type Effort,
  type LoadedConfig,
  type OrchestratorConfig,
  type OrchestratorDefaults,
  type ParsedModelSpec,
  type ScheduleConfig,
  type ServerConfig,
} from "./types.js";

/** Default project config location, relative to the project root. */
export const DEFAULT_CONFIG_PATH = ".pi/agents.yml";
/** Default durable state location, relative to the project root. */
export const STATE_DIR = ".pi/agent-orchestrator";
export const CONFIG_VERSION = 1;
export const MAX_REPLICAS = 16;
/** Minimum recurring interval. Prevents accidental tight loops. */
export const MIN_SCHEDULE_EVERY_MS = 1_000;
export const LOOPBACK_HOST = "127.0.0.1" as const;

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a compact duration such as `500ms`, `30s`, `15m`, `2h` or `1d`.
 * Returns milliseconds; throws with an actionable message for invalid input.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i.exec(value.trim());
  if (!match) {
    throw new Error(`invalid duration "${value}" (expected e.g. "30s", "15m", "2h" or "1d")`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = DURATION_UNITS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || multiplier === undefined) {
    throw new Error(`invalid duration "${value}"`);
  }
  return Math.round(amount * multiplier);
}

export interface LoadConfigOptions {
  /** Explicit config path. Relative paths resolve against `cwd`. */
  path?: string;
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid agent orchestrator config:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

interface MutableConfig {
  version: number;
  server: ServerConfig;
  defaults?: OrchestratorDefaults;
  agents: Record<string, AgentConfig>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (key.startsWith("x-")) continue;
    if (!allowed.includes(key)) {
      issues.push(
        `${where}: unknown key "${key}" (allowed: ${allowed.join(", ")}; custom keys must start with "x-")`,
      );
    }
  }
}

function normalizeEffort(value: unknown, where: string, issues: string[]): Effort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`${where}: effort must be a string, got ${typeof value}`);
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!(EFFORTS as readonly string[]).includes(normalized)) {
    issues.push(`${where}: invalid effort "${value}" (allowed: ${EFFORTS.join(", ")})`);
    return undefined;
  }
  return normalized as Effort;
}

function normalizeReplicas(
  value: unknown,
  where: string,
  issues: string[],
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push(`${where}: replicas must be an integer, got ${String(value)}`);
    return fallback;
  }
  if (value < 1 || value > MAX_REPLICAS) {
    issues.push(`${where}: replicas must be between 1 and ${MAX_REPLICAS}, got ${value}`);
    return fallback;
  }
  return value;
}

function normalizeTools(value: unknown, where: string, issues: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`${where}: tools must be an array of tool names`);
    return undefined;
  }
  const tools: string[] = [];
  value.forEach((tool, index) => {
    if (!isNonEmptyString(tool)) {
      issues.push(`${where}.tools[${index}]: expected a non-empty string`);
      return;
    }
    const name = tool.trim();
    if (!tools.includes(name)) tools.push(name);
  });
  return tools;
}

function normalizeDefaults(
  raw: unknown,
  issues: string[],
): OrchestratorDefaults | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push("defaults: expected an object");
    return undefined;
  }
  checkKeys(raw, ["effort", "replicas", "tools"], "defaults", issues);
  const defaults: OrchestratorDefaults = {};
  const effort = normalizeEffort(raw.effort, "defaults.effort", issues);
  if (effort !== undefined) defaults.effort = effort;
  if (raw.replicas !== undefined) {
    defaults.replicas = normalizeReplicas(raw.replicas, "defaults.replicas", issues, 1);
  }
  const tools = normalizeTools(raw.tools, "defaults", issues);
  if (tools !== undefined) defaults.tools = tools;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function normalizeServer(raw: unknown, issues: string[]): ServerConfig {
  if (raw === undefined) {
    return { host: LOOPBACK_HOST, port: 0, dashboard: true };
  }
  if (!isPlainObject(raw)) {
    issues.push("server: expected an object");
    return { host: LOOPBACK_HOST, port: 0, dashboard: true };
  }
  checkKeys(raw, ["host", "port", "dashboard"], "server", issues);

  let host: "127.0.0.1" = LOOPBACK_HOST;
  if (raw.host !== undefined) {
    if (raw.host !== "127.0.0.1" && raw.host !== "localhost") {
      issues.push(
        `server.host: only loopback is supported in v1 (use "127.0.0.1" or "localhost"), got ${JSON.stringify(raw.host)}`,
      );
    }
  }

  let port = 0;
  if (raw.port !== undefined) {
    if (
      typeof raw.port !== "number" ||
      !Number.isInteger(raw.port) ||
      raw.port < 0 ||
      raw.port > 65535
    ) {
      issues.push(`server.port: expected an integer between 0 and 65535, got ${String(raw.port)}`);
    } else {
      port = raw.port;
    }
  }

  let dashboard = true;
  if (raw.dashboard !== undefined) {
    if (typeof raw.dashboard !== "boolean") {
      issues.push(`server.dashboard: expected a boolean, got ${typeof raw.dashboard}`);
    } else {
      dashboard = raw.dashboard;
    }
  }

  return { host, port, dashboard };
}

function normalizeAgent(
  key: string,
  raw: unknown,
  index: number,
  defaults: OrchestratorDefaults | undefined,
  issues: string[],
): AgentConfig | undefined {
  const where = `agents.${key}`;
  if (!isNonEmptyString(key)) {
    issues.push(`agents: role key #${index + 1} must be a non-empty string`);
    return undefined;
  }
  if (key.includes("#")) {
    issues.push(`${where}: role key must not contain "#" (reserved for replica ids)`);
  }
  if (!isPlainObject(raw)) {
    issues.push(`${where}: expected an object`);
    return undefined;
  }
  checkKeys(
    raw,
    ["role", "description", "model", "provider", "effort", "replicas", "cwd", "tools"],
    where,
    issues,
  );

  let role = key.trim();
  if (raw.role !== undefined) {
    if (!isNonEmptyString(raw.role)) {
      issues.push(`${where}.role: expected a non-empty string`);
    } else {
      role = raw.role.trim();
    }
  }
  if (role.includes("#")) {
    issues.push(`${where}.role: must not contain "#" (reserved for replica ids)`);
  }

  if (!isNonEmptyString(raw.description)) {
    issues.push(`${where}.description: required non-empty string describing the role's work instructions`);
  }

  if (!isNonEmptyString(raw.model)) {
    issues.push(`${where}.model: required non-empty model spec, e.g. "anthropic/claude-sonnet-4-5"`);
  }

  let provider: string | undefined;
  if (raw.provider !== undefined) {
    if (!isNonEmptyString(raw.provider)) {
      issues.push(`${where}.provider: expected a non-empty string`);
    } else {
      provider = raw.provider.trim();
    }
  }

  const effort = normalizeEffort(raw.effort, `${where}.effort`, issues) ?? defaults?.effort;
  const replicas = normalizeReplicas(
    raw.replicas,
    `${where}.replicas`,
    issues,
    defaults?.replicas ?? 1,
  );
  const tools = normalizeTools(raw.tools, where, issues) ?? defaults?.tools;

  let cwd: string | undefined;
  if (raw.cwd !== undefined) {
    if (!isNonEmptyString(raw.cwd)) {
      issues.push(`${where}.cwd: expected a non-empty path string`);
    } else {
      cwd = raw.cwd.trim();
    }
  }

  if (
    !isNonEmptyString(raw.description) ||
    !isNonEmptyString(raw.model) ||
    !isNonEmptyString(key)
  ) {
    return undefined;
  }

  const agent: AgentConfig = {
    role,
    description: raw.description.trim(),
    model: raw.model.trim(),
    replicas,
  };
  if (provider !== undefined) agent.provider = provider;
  if (effort !== undefined) agent.effort = effort;
  if (cwd !== undefined) agent.cwd = cwd;
  if (tools !== undefined) agent.tools = tools;
  return agent;
}

function normalizeSchedules(
  raw: unknown,
  agents: Record<string, AgentConfig>,
  issues: string[],
): ScheduleConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push("schedules: expected an array of recurring schedule definitions");
    return undefined;
  }

  const schedules: ScheduleConfig[] = [];
  const seenIds = new Set<string>();
  raw.forEach((entry, index) => {
    const where = `schedules[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(`${where}: expected an object`);
      return;
    }
    checkKeys(
      entry,
      ["id", "role", "title", "prompt", "acceptance", "every", "enabled", "runOnStart", "overlap"],
      where,
      issues,
    );

    const id = isNonEmptyString(entry.id) ? entry.id.trim() : "";
    if (!id) {
      issues.push(`${where}.id: required non-empty unique schedule id`);
    } else if (id.includes(":")) {
      issues.push(`${where}.id: must not contain ":" (reserved for client request ids)`);
    } else if (seenIds.has(id)) {
      issues.push(`${where}.id: duplicate schedule id "${id}"`);
    } else {
      seenIds.add(id);
    }

    const role = isNonEmptyString(entry.role) ? entry.role.trim() : "";
    if (!role) {
      issues.push(`${where}.role: required non-empty role name`);
    } else if (!agents[role]) {
      const known = Object.keys(agents).sort().join(", ") || "<none>";
      issues.push(`${where}.role: unknown role "${role}" (known roles: ${known})`);
    }

    if (!isNonEmptyString(entry.prompt)) {
      issues.push(`${where}.prompt: required non-empty work instructions`);
    }

    let every = "";
    let everyMs = 0;
    if (!isNonEmptyString(entry.every)) {
      issues.push(`${where}.every: required interval such as "30s", "15m", "2h" or "1d"`);
    } else {
      every = entry.every.trim();
      try {
        everyMs = parseDuration(every);
        if (everyMs < MIN_SCHEDULE_EVERY_MS) {
          issues.push(
            `${where}.every: interval must be at least ${MIN_SCHEDULE_EVERY_MS}ms, got "${every}"`,
          );
        }
      } catch (error) {
        issues.push(`${where}.every: ${(error as Error).message}`);
      }
    }

    let title = "";
    if (entry.title !== undefined) {
      if (!isNonEmptyString(entry.title)) {
        issues.push(`${where}.title: expected a non-empty string`);
      } else {
        title = entry.title.trim();
      }
    } else if (isNonEmptyString(entry.prompt)) {
      const firstLine = entry.prompt.trim().split(/\r?\n/, 1)[0] ?? "Scheduled check";
      title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    }

    let acceptance: string | undefined;
    if (entry.acceptance !== undefined) {
      if (typeof entry.acceptance !== "string") {
        issues.push(`${where}.acceptance: expected a string`);
      } else if (entry.acceptance.trim()) {
        acceptance = entry.acceptance.trim();
      }
    }

    let enabled = true;
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== "boolean") {
        issues.push(`${where}.enabled: expected a boolean`);
      } else {
        enabled = entry.enabled;
      }
    }

    let runOnStart = false;
    if (entry.runOnStart !== undefined) {
      if (typeof entry.runOnStart !== "boolean") {
        issues.push(`${where}.runOnStart: expected a boolean`);
      } else {
        runOnStart = entry.runOnStart;
      }
    }

    let overlap: "skip" | "queue" = "skip";
    if (entry.overlap !== undefined) {
      if (entry.overlap !== "skip" && entry.overlap !== "queue") {
        issues.push(`${where}.overlap: expected "skip" or "queue"`);
      } else {
        overlap = entry.overlap;
      }
    }

    if (
      id &&
      role &&
      agents[role] &&
      isNonEmptyString(entry.prompt) &&
      everyMs >= MIN_SCHEDULE_EVERY_MS
    ) {
      const schedule: ScheduleConfig = {
        id,
        role,
        title: title || `${role} scheduled check`,
        prompt: entry.prompt.trim(),
        every,
        everyMs,
        enabled,
        runOnStart,
        overlap,
      };
      if (acceptance !== undefined) schedule.acceptance = acceptance;
      schedules.push(schedule);
    }
  });

  return schedules.length > 0 ? schedules : undefined;
}

function normalizeConfig(raw: unknown, issues: string[]): OrchestratorConfig | undefined {
  if (!isPlainObject(raw)) {
    issues.push("root: expected a YAML mapping with version, server, defaults, agents and optional schedules");
    return undefined;
  }
  checkKeys(raw, ["version", "server", "defaults", "agents", "schedules"], "root", issues);

  let version = CONFIG_VERSION;
  if (raw.version !== undefined) {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version)) {
      issues.push(`version: expected an integer, got ${String(raw.version)}`);
    } else if (raw.version !== CONFIG_VERSION) {
      issues.push(`version: unsupported config version ${raw.version} (expected ${CONFIG_VERSION})`);
    } else {
      version = raw.version;
    }
  }

  const server = normalizeServer(raw.server, issues);
  const defaults = normalizeDefaults(raw.defaults, issues);

  if (raw.agents === undefined) {
    issues.push(`agents: required mapping of role names to agent definitions`);
    return undefined;
  }
  if (!isPlainObject(raw.agents)) {
    issues.push("agents: expected a mapping of role names to agent definitions");
    return undefined;
  }
  const entries = Object.entries(raw.agents);
  if (entries.length === 0) {
    issues.push("agents: at least one agent role is required");
  }

  const agents: Record<string, AgentConfig> = {};
  const seenRoles = new Map<string, string>();
  entries.forEach(([key, value], index) => {
    const agent = normalizeAgent(key, value, index, defaults, issues);
    if (!agent) return;
    const previous = seenRoles.get(agent.role);
    if (previous !== undefined) {
      issues.push(
        `agents.${key}.role: duplicate role "${agent.role}" (already defined by agents.${previous})`,
      );
      return;
    }
    seenRoles.set(agent.role, key);
    agents[agent.role] = agent;
  });

  if (issues.length > 0) return undefined;

  const config: OrchestratorConfig = { version, server, agents };
  if (defaults !== undefined) config.defaults = defaults;
  const schedules = normalizeSchedules(raw.schedules, agents, issues);
  if (schedules !== undefined) config.schedules = schedules;
  if (issues.length > 0) return undefined;
  return config;
}

/** Recursively sort object keys so the fingerprint is independent of YAML order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeConfigFingerprint(config: OrchestratorConfig): string {
  return createHash("sha256").update(canonicalJson(config), "utf8").digest("hex");
}

/**
 * Parse and validate a raw config object (for example from `YAML.parse`).
 * Throws ConfigError with all actionable issues.
 */
export function parseConfig(raw: unknown): LoadedConfig {
  const issues: string[] = [];
  const config = normalizeConfig(raw, issues);
  if (!config || issues.length > 0) throw new ConfigError(issues);
  return {
    config,
    configFingerprint: computeConfigFingerprint(config),
    path: "",
  };
}

/** Load and validate `.pi/agents.yml` (or an explicit path). */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const requested = options.path ?? DEFAULT_CONFIG_PATH;
  const absolutePath = path.resolve(cwd, requested);

  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError([
        `config file not found: ${absolutePath}. Create ${DEFAULT_CONFIG_PATH} or pass an explicit path.`,
      ]);
    }
    throw new ConfigError([
      `could not read config file ${absolutePath}: ${(error as Error).message}`,
    ]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new ConfigError([
      `${absolutePath}: failed to parse YAML: ${(error as Error).message}`,
    ]);
  }

  let loaded: LoadedConfig;
  try {
    loaded = parseConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(error.issues.map((issue) => `${absolutePath}: ${issue}`));
    }
    throw error;
  }
  return { ...loaded, path: absolutePath };
}

/**
 * Split a model spec such as `anthropic/claude-sonnet-4-5` into provider and
 * model id. Only the first slash is treated as the provider separator so
 * provider-specific model ids containing slashes keep working. The actual
 * model lookup is intentionally left to `ModelResolver`.
 */
export function parseModelSpec(spec: string): ParsedModelSpec {
  if (!isNonEmptyString(spec)) {
    throw new Error("model spec must be a non-empty string");
  }
  const trimmed = spec.trim();
  const separator = trimmed.indexOf("/");
  if (separator < 0) return { model: trimmed };
  const provider = trimmed.slice(0, separator).trim();
  const model = trimmed.slice(separator + 1).trim();
  if (!provider || !model) {
    throw new Error(`invalid model spec "${spec}" (expected "provider/model" or "model")`);
  }
  return { provider, model };
}
