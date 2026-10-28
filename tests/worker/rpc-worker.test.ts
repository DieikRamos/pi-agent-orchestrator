import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  RpcWorker,
  WorkerAbortedError,
  WorkerBusyError,
  WorkerRunFailedError,
  WorkerStartError,
  WorkerTimeoutError,
  buildFeedbackPrompt,
  buildTaskPrompt,
  truncatePayload,
  type RpcClientLike,
  type RpcSessionEventLike,
  type RpcSessionStateLike,
} from "../../src/worker/rpc-worker.js";
import type {
  AgentRuntime,
  Task,
  WorkerEvent,
  WorkerResult,
} from "../../src/types.js";

class FakeRpcClient implements RpcClientLike {
  readonly calls: string[] = [];
  readonly prompts: string[] = [];
  readonly listeners = new Set<(event: RpcSessionEventLike) => void>();
  state: RpcSessionStateLike = {
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    messageCount: 0,
    thinkingLevel: "medium",
  };
  lastText: string | null = "final text";
  available: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  promptResult: unknown = "started";
  promptError?: Error;
  startError?: Error;
  resetResult: { cancelled?: boolean } = { cancelled: false };
  stderr = "";
  process = { pid: 4242 };
  sessionCounter = 1;

  async start(): Promise<void> {
    this.calls.push("start");
    if (this.startError) throw this.startError;
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
  }

  onEvent(listener: (event: RpcSessionEventLike) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message: string): Promise<unknown> {
    this.calls.push("prompt");
    this.prompts.push(message);
    if (this.promptError) throw this.promptError;
    return this.promptResult;
  }

  async abort(): Promise<void> {
    this.calls.push("abort");
  }

  async newSession(): Promise<{ cancelled?: boolean }> {
    this.calls.push("newSession");
    if (!this.resetResult.cancelled) {
      this.sessionCounter += 1;
      this.state = {
        ...this.state,
        sessionId: `session-${this.sessionCounter}`,
        sessionFile: `/tmp/session-${this.sessionCounter}.jsonl`,
        messageCount: 0,
      };
    }
    return this.resetResult;
  }

  async getState(): Promise<RpcSessionStateLike> {
    this.calls.push("getState");
    return { ...this.state };
  }

  async getLastAssistantText(): Promise<string | null> {
    this.calls.push("getLastAssistantText");
    return this.lastText;
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.calls.push(`thinking:${level}`);
    this.state = { ...this.state, thinkingLevel: level };
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    this.calls.push("availableThinking");
    return [...this.available];
  }

  getStderr(): string {
    return this.stderr;
  }

  emit(event: RpcSessionEventLike): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  settled(aborted = false): void {
    this.emit({ type: "agent_settled", aborted });
  }

  assistantMessage(options: {
    text?: string;
    stopReason?: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
    errorMessage?: string;
  } = {}): void {
    if (options.text !== undefined) this.lastText = options.text;
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: options.text ? [{ type: "text", text: options.text }] : [],
        stopReason: options.stopReason ?? "stop",
        ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
      },
    });
  }
}

function makeAgent(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "developer#1",
    role: "developer",
    replica: 1,
    config: {
      role: "developer",
      description: "Implement assigned work and run the relevant checks.",
      model: "anthropic/claude-sonnet-4-5",
      replicas: 1,
      cwd: ".",
      tools: ["read", "edit", "bash"],
    },
    status: "idle",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Add CSV export",
    role: "developer",
    prompt: "Implement CSV export for the report page.",
    acceptance: "Export round-trips and tests pass.",
    status: "running",
    createdAt: new Date(0).toISOString(),
    attempts: 1,
    logs: [],
    ...overrides,
  };
}

let tmpRoot: string;
let workers: RpcWorker[] = [];

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-worker-test-"));
  workers = [];
});

afterEach(async () => {
  await Promise.allSettled(workers.map((worker) => worker.stop()));
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeWorker(
  client: FakeRpcClient,
  overrides: Partial<ConstructorParameters<typeof RpcWorker>[0]> = {},
): RpcWorker {
  const worker = new RpcWorker({
    agent: makeAgent(),
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    thinkingLevel: "high",
    projectRoot: tmpRoot,
    sessionsDir: path.join(tmpRoot, "sessions"),
    clientFactory: () => client,
    ...overrides,
  });
  workers.push(worker);
  return worker;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("worker prompt construction", () => {
  it("includes role, task, acceptance and the result contract", () => {
    const prompt = buildTaskPrompt(makeTask(), makeAgent());
    expect(prompt).toContain("`developer` agent (developer#1)");
    expect(prompt).toContain("Implement assigned work and run the relevant checks.");
    expect(prompt).toContain("Add CSV export");
    expect(prompt).toContain("Implement CSV export for the report page.");
    expect(prompt).toContain("Export round-trips and tests pass.");
    expect(prompt).toContain("Summary:");
    expect(prompt).toContain("Files changed:");
    expect(prompt).toContain("Tests run:");
    expect(prompt).toContain("Blockers:");
    expect(prompt).toContain("Do not delegate to other agents or start the orchestrator broker.");
  });

  it("builds feedback for the same task without a fresh task prompt", () => {
    const prompt = buildFeedbackPrompt(makeTask(), "Handle empty rows too.");
    expect(prompt).toContain("Review feedback for task `Add CSV export` (task-1).");
    expect(prompt).toContain("Handle empty rows too.");
    expect(prompt).toContain("same session");
  });

  it("truncates large tool payloads safely", () => {
    const text = truncatePayload({ content: "x".repeat(100) }, 20);
    expect(text.length).toBeLessThan(100);
    expect(text).toContain("truncated");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => truncatePayload(circular)).not.toThrow();
  });
});

describe("RpcWorker lifecycle", () => {
  it("starts a long-lived client, records pid/session and applies thinking level", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);

    await worker.start();

    expect(client.calls).toEqual(expect.arrayContaining(["start", "getState", "availableThinking", "thinking:high"]));
    expect(worker.workerPid).toBe(4242);
    expect(worker.workerSessionFile).toBe("/tmp/session-1.jsonl");
    expect(worker.status).toBe("idle");
  });

  it("fails start when the requested thinking level is unavailable", async () => {
    const client = new FakeRpcClient();
    client.available = ["off", "low", "medium"];
    const worker = makeWorker(client);
    await expect(worker.start()).rejects.toBeInstanceOf(WorkerStartError);
    expect(client.calls).toContain("stop");
  });

  it("maps text, tools, usage and completion events", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client, { maxPayloadChars: 40 });
    await worker.start();

    const events: WorkerEvent[] = [];
    const runPromise = worker.run(makeTask(), (event) => events.push(event));

    await flush();
    client.lastText = "Implemented CSV export.";
    client.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Implemented " },
    });
    client.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "CSV export." } });
    client.emit({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: `echo ${"x".repeat(200)}` },
    });
    client.emit({
      type: "tool_execution_end",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    client.assistantMessage({
      text: "Implemented CSV export.",
      usage: { input: 120, output: 30, cost: { total: 0.012 } },
    });
    client.settled();

    const result = await runPromise;
    expect(result.finalText).toBe("Implemented CSV export.");
    expect(result.sessionFile).toBe("/tmp/session-1.jsonl");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, cost: 0.012 });
    expect(result.stopReason).toBe("stop");

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "started",
      "text",
      "text",
      "tool_start",
      "tool_end",
      "usage",
      "completed",
    ]);
    const toolStart = events.find((event) => event.type === "tool_start");
    expect(toolStart).toMatchObject({ type: "tool_start", tool: "bash" });
    if (toolStart?.type === "tool_start") {
      expect(String(toolStart.input)).toContain("truncated");
    }
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({
      type: "tool_end",
      tool: "bash",
      status: "ok",
      text: "ok",
    });
  });

  it("maps assistant errors to a failed run", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);
    await worker.start();

    const events: WorkerEvent[] = [];
    const runPromise = worker.run(makeTask(), (event) => events.push(event));
    await flush();
    client.assistantMessage({ stopReason: "error", errorMessage: "provider exploded" });
    client.settled();

    await expect(runPromise).rejects.toThrow(/provider exploded/);
    await expect(runPromise).rejects.toBeInstanceOf(WorkerRunFailedError);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "failed", error: expect.stringContaining("provider exploded") }),
    );
    expect(worker.status).toBe("idle");
  });

  it("maps aborted runs to a typed aborted error", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);
    await worker.start();

    const events: WorkerEvent[] = [];
    const runPromise = worker.run(makeTask(), (event) => events.push(event));
    await flush();
    client.assistantMessage({ stopReason: "aborted" });
    client.settled(true);

    await expect(runPromise).rejects.toBeInstanceOf(WorkerAbortedError);
    expect(events.some((event) => event.type === "failed")).toBe(true);
  });

  it("enforces a timeout and aborts the client", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client, { timeoutMs: 20 });
    await worker.start();

    const events: WorkerEvent[] = [];
    const runPromise = worker.run(makeTask(), (event) => events.push(event));

    await expect(runPromise).rejects.toBeInstanceOf(WorkerTimeoutError);
    expect(client.calls).toContain("abort");
    expect(events.some((event) => event.type === "failed")).toBe(true);
  });

  it("rejects a second concurrent run without touching the first", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);
    await worker.start();

    const first = worker.run(makeTask(), () => {});
    await flush();
    await expect(worker.run(makeTask({ id: "task-2" }), () => {})).rejects.toBeInstanceOf(WorkerBusyError);

    client.assistantMessage({ text: "done" });
    client.settled();
    await expect(first).resolves.toMatchObject({ finalText: "done" });
    expect(client.prompts).toHaveLength(1);
  });

  it("rejects an unexpected process exit with stderr context", async () => {
    const client = new FakeRpcClient();
    client.promptError = new Error("Agent process exited unexpectedly");
    client.stderr = "Error: model auth missing";
    const worker = makeWorker(client);
    await worker.start();

    const error = await worker.run(makeTask(), () => {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WorkerRunFailedError);
    expect((error as Error).message).toMatch(/Agent process exited unexpectedly/);
    expect((error as WorkerRunFailedError).stderr).toContain("model auth missing");
  });
});

describe("RpcWorker feedback, reset and stop", () => {
  it("sends feedback in the same context without newSession", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);
    await worker.start();

    const runPromise = worker.run(makeTask(), () => {});
    await flush();
    client.assistantMessage({ text: "first result" });
    client.settled();
    await runPromise;

    const feedbackPromise = worker.feedback("Handle empty rows.", () => {});
    await flush();
    client.lastText = "second result";
    client.assistantMessage({ text: "second result" });
    client.settled();
    const result = await feedbackPromise;

    expect(result.finalText).toBe("second result");
    expect(client.calls).not.toContain("newSession");
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]).toContain("Handle empty rows.");
    expect(client.prompts[1]).toContain("same session");
  });

  it("resets with newSession and verifies the new context", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);
    await worker.start();

    const runPromise = worker.run(makeTask(), () => {});
    await flush();
    client.assistantMessage({ text: "first" });
    client.settled();
    await runPromise;

    await worker.reset();
    expect(client.calls).toContain("newSession");
    expect(client.calls.filter((call) => call === "thinking:high").length).toBeGreaterThanOrEqual(2);
    expect(worker.workerSessionFile).toBe("/tmp/session-2.jsonl");

    const nextRun = worker.run(makeTask({ id: "task-2", title: "Second task" }), () => {});
    await flush();
    client.assistantMessage({ text: "second" });
    client.settled();
    await expect(nextRun).resolves.toMatchObject({ finalText: "second" });
    expect(client.prompts[1]).toContain("Second task");
  });

  it("refuses to reuse the old context when newSession is cancelled", async () => {
    const client = new FakeRpcClient();
    client.resetResult = { cancelled: true };
    const worker = makeWorker(client);
    await worker.start();

    const error = await worker.reset().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cancelled by an extension/);
    expect(worker.status).toBe("error");
  });

  it("stop aborts an active run, disposes the client and blocks reuse", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);
    await worker.start();

    const runPromise = worker.run(makeTask(), () => {});
    await flush();
    await worker.stop();

    await expect(runPromise).rejects.toBeInstanceOf(WorkerAbortedError);
    expect(client.calls).toContain("stop");
    expect(worker.status).toBe("stopped");
    await expect(worker.run(makeTask({ id: "task-2" }), () => {})).rejects.toBeInstanceOf(WorkerStartError);
  });

  it("abort before a run is honoured once", async () => {
    const client = new FakeRpcClient();
    const worker = makeWorker(client);
    await worker.abort();
    await expect(worker.run(makeTask(), () => {})).rejects.toBeInstanceOf(WorkerAbortedError);
  });
});
