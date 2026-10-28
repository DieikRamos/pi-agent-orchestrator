import { describe, expect, it, vi } from "vitest";

import { BrokerUnavailableError } from "../../src/client/broker-client.js";
import {
  COMMAND_NAME,
  formatStatus,
  handleAgentsCommand,
  registerCommands,
  type CommandBrokerClient,
  type CommandDependencies,
} from "../../src/extension/commands.js";
import type { EnsureBrokerResult } from "../../src/extension/autostart.js";
import type { AgentView, HealthView, Task } from "../../src/types.js";

const health: HealthView = {
  ok: true,
  name: "pi-agent-orchestrator",
  version: "0.1.0",
  pid: 12,
  startedAt: "2026-01-01T00:00:00.000Z",
  uptimeMs: 65_000,
  configFingerprint: "f",
  agents: { total: 2, idle: 1, busy: 1, awaitingReview: 0, error: 0 },
  tasks: { total: 1, queued: 0, running: 1, awaitingReview: 0, closed: 0, failed: 0, cancelled: 0 },
};

const agents: AgentView[] = [
  {
    id: "developer#1",
    role: "developer",
    replica: 1,
    model: "anthropic/claude-sonnet-4-5",
    status: "busy",
    currentTaskId: "t1",
    lastAction: "running tests",
  },
  {
    id: "developer#2",
    role: "developer",
    replica: 2,
    model: "anthropic/claude-sonnet-4-5",
    status: "idle",
  },
];

const tasks: Task[] = [
  {
    id: "t1",
    title: "Implement thing",
    role: "developer",
    prompt: "Do it",
    status: "running",
    agentId: "developer#1",
    createdAt: "2026-01-01T00:00:00.000Z",
    attempts: 1,
    logs: [],
  },
];

function client(overrides: Partial<CommandBrokerClient> = {}): CommandBrokerClient {
  return {
    baseUrl: "http://127.0.0.1:8787",
    health: vi.fn(async () => health),
    submit: vi.fn(),
    waitForReview: vi.fn(),
    review: vi.fn(),
    cancel: vi.fn(),
    listAgents: vi.fn(async () => agents),
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(),
    reload: vi.fn(async () => ({ version: 1, server: { host: "127.0.0.1" as const, port: 0, dashboard: true }, agents: {} })),
    shutdown: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as CommandBrokerClient;
}

function ready(overrides: Partial<EnsureBrokerResult> = {}): EnsureBrokerResult {
  return {
    skipped: false,
    started: true,
    reused: false,
    descriptorPath: "/tmp/broker.json",
    logPath: "/tmp/broker.log",
    configPath: "/tmp/agents.yml",
    url: "http://127.0.0.1:8787",
    ...overrides,
  };
}

function harness(overrides: Partial<CommandDependencies> = {}) {
  const notify = vi.fn<(message: string, type?: "info" | "warning" | "error") => void>();
  const deps: CommandDependencies = {
    getClient: vi.fn(() => client()),
    ensureBroker: vi.fn(async () => ready()),
    readLog: vi.fn(async () => "log tail"),
    openUrl: vi.fn(),
    ...overrides,
  };
  return {
    deps,
    notify,
    ctx: { cwd: "/tmp/project", ui: { notify } },
  };
}

describe("formatStatus", () => {
  it("summarizes health, replicas and open tasks", () => {
    const text = formatStatus(health, agents, tasks);
    expect(text).toContain("Broker healthy · pid 12 · uptime 65s");
    expect(text).toContain("Agents 2: 1 idle, 1 busy");
    expect(text).toContain("developer#1 [busy] task t1 · running tests");
    expect(text).toContain("developer#2 [idle]");
    expect(text).toContain("t1 [running] developer · developer#1 · Implement thing");
  });

  it("omits terminal tasks and handles no replicas", () => {
    const text = formatStatus(
      health,
      [],
      [{ ...tasks[0]!, status: "closed", agentId: "developer#1" }],
    );
    expect(text).toContain("No replicas.");
    expect(text).not.toContain("Open tasks:");
  });
});

describe("/agents command", () => {
  it("defaults to status and emits a notification", async () => {
    const { deps, notify, ctx } = harness();
    await handleAgentsCommand("", ctx, deps);
    expect(deps.getClient).toHaveBeenCalledWith("/tmp/project");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Broker healthy"), "info");
  });

  it("opens and prints the dashboard URL", async () => {
    const { deps, notify, ctx } = harness();
    await handleAgentsCommand("dashboard", ctx, deps);
    expect(deps.ensureBroker).toHaveBeenCalledWith("/tmp/project");
    expect(deps.openUrl).toHaveBeenCalledWith("http://127.0.0.1:8787");
    expect(notify).toHaveBeenCalledWith("Dashboard: http://127.0.0.1:8787", "info");
  });

  it("starts, reuses, stops and reloads", async () => {
    const start = harness();
    await handleAgentsCommand("start", start.ctx, start.deps);
    expect(start.notify).toHaveBeenCalledWith(expect.stringContaining("started"), "info");

    const reuse = harness({ ensureBroker: vi.fn(async () => ready({ started: false, reused: true })) });
    await handleAgentsCommand("start", reuse.ctx, reuse.deps);
    expect(reuse.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "info");

    const stopped = harness();
    await handleAgentsCommand("stop", stopped.ctx, stopped.deps);
    expect(stopped.notify).toHaveBeenCalledWith(expect.stringContaining("shutting down"), "info");

    const reloaded = harness();
    await handleAgentsCommand("reload", reloaded.ctx, reloaded.deps);
    expect(reloaded.notify).toHaveBeenCalledWith(expect.stringContaining("Reloaded config"), "info");
  });

  it("reports stop when the broker is already down", async () => {
    const { deps, notify, ctx } = harness({
      getClient: () =>
        client({
          shutdown: vi.fn(async () => {
            throw new BrokerUnavailableError("No broker");
          }),
        }),
    });
    await handleAgentsCommand("stop", ctx, deps);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not running"), "warning");
  });

  it("reads logs with a bounded line count", async () => {
    const { deps, notify, ctx } = harness();
    await handleAgentsCommand("logs 12", ctx, deps);
    expect(deps.readLog).toHaveBeenCalledWith("/tmp/project", 12);
    expect(notify).toHaveBeenCalledWith("log tail", "info");
  });

  it("reports unknown subcommands and handler failures without throwing", async () => {
    const unknown = harness();
    await handleAgentsCommand("bogus", unknown.ctx, unknown.deps);
    expect(unknown.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown"), "warning");

    const failing = harness({
      getClient: () =>
        client({
          health: vi.fn(async () => {
            throw new BrokerUnavailableError("down");
          }),
        }),
    });
    await expect(handleAgentsCommand("status", failing.ctx, failing.deps)).resolves.toBeUndefined();
    expect(failing.notify).toHaveBeenCalledWith(expect.stringContaining("/agents status failed"), "error");
  });

  it("registers the command with completions", () => {
    const commands: Array<{ name: string; options: { getArgumentCompletions?: (p: string) => unknown } }> = [];
    registerCommands(
      { registerCommand: (name: string, options: unknown) => commands.push({ name, options: options as never }) } as never,
      harness().deps,
    );
    expect(commands[0]?.name).toBe(COMMAND_NAME);
    expect(commands[0]?.options.getArgumentCompletions?.("dash")).toEqual([
      { label: "dashboard", value: "dashboard" },
    ]);
  });
});
