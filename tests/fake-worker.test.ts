import { describe, expect, it } from "vitest";

import {
  FakeWorker,
  FakeWorkerAbortedError,
  FakeWorkerFactory,
} from "../src/testing/fake-worker.js";
import type { AgentRuntime, Task, WorkerEvent } from "../src/types.js";

const clock = () => new Date("2026-01-02T03:04:05.000Z");

function agent(id = "dev#1"): AgentRuntime {
  return {
    id,
    role: "dev",
    replica: 1,
    status: "idle",
    config: { role: "dev", description: "Dev", model: "m", replicas: 1 },
  };
}

function task(id = "task-1"): Task {
  return {
    id,
    title: `Title ${id}`,
    role: "dev",
    prompt: "Do work",
    status: "assigned",
    attempts: 1,
    createdAt: "2026-01-02T03:00:00.000Z",
    logs: [],
  };
}

async function collect(
  worker: FakeWorker,
  operation: (events: WorkerEvent[]) => Promise<unknown>,
): Promise<WorkerEvent[]> {
  const events: WorkerEvent[] = [];
  await operation(events);
  return events;
}

describe("FakeWorker", () => {
  it("emits deterministic text/tool/completed events", async () => {
    const worker = new FakeWorker(agent(), { clock, usage: { inputTokens: 10, outputTokens: 4 } });
    const events = await collect(worker, (sink) =>
      worker.run(task(), (event) => sink.push(event)),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_start",
      "tool_end",
      "text",
      "usage",
      "completed",
    ]);
    expect(events.every((event) => event.at === "2026-01-02T03:04:05.000Z")).toBe(true);
    expect(worker.snapshot()).toMatchObject({ epoch: 1, status: "idle", runs: 1 });
    expect(worker.snapshot().lastResult?.finalText).toContain("dev#1 completed");
  });

  it("increments the context epoch only on reset", async () => {
    const worker = new FakeWorker(agent(), { clock, tools: [] });
    await worker.start();
    await worker.run(task("t1"), () => undefined);
    expect(worker.epoch).toBe(1);

    await worker.run(task("t2"), () => undefined);
    expect(worker.epoch).toBe(1);

    await worker.reset();
    expect(worker.epoch).toBe(2);
    await worker.run(task("t3"), () => undefined);
    expect(worker.epoch).toBe(2);
  });

  it("keeps feedback in the same context and records it", async () => {
    const worker = new FakeWorker(agent(), { clock, tools: [] });
    await worker.run(task(), () => undefined);
    const result = await worker.feedback("tighten the tests", () => undefined);
    expect(result.finalText).toContain("tighten the tests");
    expect(worker.epoch).toBe(1);
    expect(worker.snapshot().feedbacksReceived).toHaveLength(1);
    expect(worker.snapshot().feedbacksReceived[0]?.epoch).toBe(1);
  });

  it("supports injected failures and reports a failed event", async () => {
    const worker = new FakeWorker(agent(), {
      clock,
      failures: { run: "model exploded" },
    });
    const events: WorkerEvent[] = [];
    await expect(
      worker.run(task(), (event) => events.push(event)),
    ).rejects.toThrow("model exploded");
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
  });

  it("can be aborted during a delayed run", async () => {
    const worker = new FakeWorker(agent(), { clock, delays: { run: 5_000 } });
    const run = worker.run(task(), () => undefined);
    await worker.abort();
    await expect(run).rejects.toBeInstanceOf(FakeWorkerAbortedError);
    expect(worker.snapshot().aborts).toBe(1);
  });

  it("factory creates one worker per replica and exposes snapshots", async () => {
    const factory = new FakeWorkerFactory({ clock, tools: [] });
    const first = factory.create(agent("dev#1"));
    const second = factory.create(agent("dev#2"));
    expect(first).not.toBe(second);
    expect(factory.created).toHaveLength(2);
    expect(factory.get("dev#2")).toBe(second);
    expect(factory.snapshots().map((snapshot) => snapshot.agentId)).toEqual([
      "dev#1",
      "dev#2",
    ]);
  });
});
