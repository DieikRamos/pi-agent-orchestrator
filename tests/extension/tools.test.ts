import { describe, expect, it, vi } from "vitest";

import {
  BrokerTimeoutError,
  BrokerUnavailableError,
} from "../../src/client/broker-client.js";
import {
  TOOL_NAMES,
  createToolDefinitions,
  registerTools,
  type ToolBrokerClient,
} from "../../src/extension/tools.js";
import type { AgentView, HealthView, Task, TaskView } from "../../src/types.js";

const health: HealthView = {
  ok: true,
  name: "pi-agent-orchestrator",
  version: "0.1.0",
  pid: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  uptimeMs: 1000,
  configFingerprint: "f",
  agents: { total: 2, idle: 1, busy: 1, awaitingReview: 0, error: 0 },
  tasks: { total: 1, queued: 0, running: 1, awaitingReview: 0, closed: 0, failed: 0, cancelled: 0 },
};

const agent: AgentView = {
  id: "developer#1",
  role: "developer",
  replica: 1,
  model: "anthropic/claude-sonnet-4-5",
  status: "busy",
  currentTaskId: "t1",
  lastAction: "running tests",
};
const idleAgent: AgentView = { ...agent, id: "developer#2", replica: 2, status: "idle", currentTaskId: undefined };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Implement thing",
    role: "developer",
    prompt: "Do it",
    status: "awaiting_review",
    agentId: "developer#1",
    createdAt: "2026-01-01T00:00:00.000Z",
    attempts: 1,
    logs: [{ at: "2026-01-01T00:00:01.000Z", type: "text", text: "done" }],
    result: "Implemented",
    ...overrides,
  };
}

function stubClient(overrides: Partial<ToolBrokerClient> = {}): ToolBrokerClient {
  return {
    health: vi.fn(async () => health),
    submit: vi.fn(async () => makeTask({ status: "queued", agentId: undefined })),
    waitForReview: vi.fn(async () => makeTask()),
    review: vi.fn(async () => makeTask({ status: "closed" })),
    cancel: vi.fn(async () => makeTask({ status: "cancelled" })),
    listAgents: vi.fn(async () => [agent, idleAgent]),
    listTasks: vi.fn(async () => [makeTask()]),
    getTask: vi.fn(async () => makeTask()),
    ...overrides,
  };
}

function tools(client: ToolBrokerClient) {
  return createToolDefinitions({ getClient: () => client });
}

async function call(
  client: ToolBrokerClient,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const definition = tools(client).find((tool) => tool.name === name);
  if (!definition) throw new Error(`missing tool ${name}`);
  return definition.execute(
    "call-1",
    params as never,
    signal,
    undefined,
    { cwd: "/tmp/project" } as never,
  ) as Promise<{ content: Array<{ type: string; text?: string }>; details: unknown; isError?: boolean }>;
}

describe("agent extension tools", () => {
  it("registers every expected tool", () => {
    const registered: Array<{ name: string }> = [];
    registerTools(
      { registerTool: (tool: unknown) => registered.push(tool as { name: string }) } as never,
      { getClient: () => stubClient() },
    );
    expect(registered.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  it("dispatches with a default title and returns task/agent details", async () => {
    const client = stubClient();
    const result = await call(client, "agent_dispatch", {
      role: "developer",
      prompt: "Implement the feature\nwith tests",
      acceptance: "tests pass",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Dispatched task t1");
    expect(client.submit).toHaveBeenCalledWith({
      title: "Implement the feature",
      role: "developer",
      prompt: "Implement the feature\nwith tests",
      acceptance: "tests pass",
    });
    expect(result.details).toMatchObject({ taskId: "t1", status: "queued" });
  });

  it("returns actionable errors instead of throwing when the broker is down", async () => {
    const client = stubClient({
      submit: vi.fn(async () => {
        throw new BrokerUnavailableError("No broker descriptor. Start it with /agents start.");
      }),
    });
    const result = await call(client, "agent_dispatch", { role: "developer", prompt: "work" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("agent_dispatch failed");
    expect(result.content[0]?.text).toContain("/agents start");
  });

  it("waits and returns review details, clamping the timeout", async () => {
    const client = stubClient();
    const result = await call(client, "agent_wait", { taskId: "t1", timeoutMs: 999_999 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("awaiting_review");
    expect(result.content[0]?.text).toContain("Implemented");
    expect(client.waitForReview).toHaveBeenCalledWith("t1", 600_000, {});
  });

  it("reports wait timeouts with guidance and keeps task details", async () => {
    const task = makeTask({ status: "running" });
    const client = stubClient({
      waitForReview: vi.fn(async () => {
        throw new BrokerTimeoutError("Timed out waiting", task);
      }),
    });
    const result = await call(client, "agent_wait", { taskId: "t1", timeoutMs: 100 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("still running");
    expect((result.details as { task: Task }).task.status).toBe("running");
  });

  it("validates rework feedback locally and forwards close", async () => {
    const client = stubClient();
    const invalid = await call(client, "agent_review", { taskId: "t1", decision: "rework" });
    expect(invalid.isError).toBe(true);
    expect(client.review).not.toHaveBeenCalled();

    const closed = await call(client, "agent_review", { taskId: "t1", decision: "close" });
    expect(closed.content[0]?.text).toContain("released");
    expect(client.review).toHaveBeenCalledWith("t1", "close", undefined);
  });

  it("formats status for agents and tasks, filtering by role and task id", async () => {
    const client = stubClient();
    const result = await call(client, "agent_status", { role: "developer" });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Broker: healthy");
    expect(text).toContain("developer#1 [busy]");
    expect(text).toContain("t1 [awaiting_review]");
    expect(result.details).toMatchObject({ health, tasks: expect.any(Array) });

    await call(client, "agent_status", { taskId: "t1" });
    expect(client.getTask).toHaveBeenCalledWith("t1");
  });

  it("cancels tasks and maps cancel errors", async () => {
    const client = stubClient();
    const result = await call(client, "agent_cancel", { taskId: "t1" });
    expect(result.content[0]?.text).toContain("cancelled");
    expect(client.cancel).toHaveBeenCalledWith("t1");

    const failing = stubClient({
      cancel: vi.fn(async () => {
        throw new Error("conflict");
      }),
    });
    const failed = await call(failing, "agent_cancel", { taskId: "t1" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).toContain("conflict");
  });

  it("passes an abort signal through to wait", async () => {
    const controller = new AbortController();
    const client = stubClient();
    await call(client, "agent_wait", { taskId: "t1", timeoutMs: 10 }, controller.signal);
    expect(client.waitForReview).toHaveBeenCalledWith("t1", 10, {
      signal: controller.signal,
    });
  });
});
