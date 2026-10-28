import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config.js";
import { EventBus } from "../../src/broker/event-bus.js";
import { Scheduler } from "../../src/broker/scheduler.js";
import { FakeWorkerFactory, type FakeWorkerOptions } from "../../src/testing/fake-worker.js";
import type { TaskStatus } from "../../src/types.js";

const clock = () => new Date("2026-04-05T06:07:08.000Z");

function loaded(replicas = 1) {
  return parseConfig({
    agents: {
      dev: {
        description: "Developer",
        model: "fake/model",
        replicas,
      },
    },
  });
}

function makeScheduler(replicas = 1, workerOptions: FakeWorkerOptions = {}) {
  let nextId = 0;
  const factory = new FakeWorkerFactory({ clock, tools: [], ...workerOptions });
  const events = new EventBus({ clock });
  const config = loaded(replicas);
  const scheduler = new Scheduler({
    config: config.config,
    configFingerprint: config.configFingerprint,
    workerFactory: factory,
    events,
    clock,
    idGenerator: () => `task-${++nextId}`,
  });
  return { scheduler, factory, events };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForStatus(
  scheduler: Scheduler,
  taskId: string,
  status: TaskStatus,
  timeoutMs = 2_000,
): Promise<void> {
  await waitFor(
    () => scheduler.getTask(taskId)?.status === status,
    `task ${taskId} to be ${status}`,
    timeoutMs,
  );
}

describe("Scheduler", () => {
  it("runs replicas concurrently, queues the surplus, and unlocks on close", async () => {
    const { scheduler, factory } = makeScheduler(2, { delays: { run: 40 } });
    await scheduler.start();

    await scheduler.submit({ role: "dev", prompt: "one", title: "one" });
    await scheduler.submit({ role: "dev", prompt: "two", title: "two" });
    await scheduler.submit({ role: "dev", prompt: "three", title: "three" });

    await waitFor(
      () =>
        factory.snapshots().filter((snapshot) => snapshot.status === "running").length === 2,
      "two replicas to run concurrently",
    );
    expect(scheduler.getTask("task-1")?.status).toBe("running");
    expect(scheduler.getTask("task-2")?.status).toBe("running");
    expect(scheduler.getTask("task-3")?.status).toBe("queued");
    expect(factory.get("dev#1")?.activeTaskId).toBe("task-1");
    expect(factory.get("dev#2")?.activeTaskId).toBe("task-2");

    await scheduler.waitForReview("task-1");
    await scheduler.waitForReview("task-2");
    expect(scheduler.getTask("task-1")?.status).toBe("awaiting_review");
    expect(scheduler.getTask("task-2")?.status).toBe("awaiting_review");
    expect(scheduler.listAgents().map((agent) => agent.status)).toEqual([
      "awaiting_review",
      "awaiting_review",
    ]);
    expect(factory.get("dev#1")?.epoch).toBe(1);

    await scheduler.review("task-1", "close");
    await scheduler.waitForReview("task-3");
    expect(factory.get("dev#1")?.epoch).toBe(2);
    expect(scheduler.getTask("task-3")?.agentId).toBe("dev#1");
    expect(scheduler.getTask("task-3")?.attempts).toBe(1);

    await scheduler.review("task-2", "close");
    await scheduler.review("task-3", "close");
    await scheduler.stop();
  });

  it("rework keeps the context epoch and close resets before the next task", async () => {
    const { scheduler, factory } = makeScheduler(1, { delays: { run: 5, feedback: 5 } });
    await scheduler.start();

    await scheduler.submit({ role: "dev", prompt: "build", title: "build" });
    await scheduler.waitForReview("task-1");
    expect(factory.get("dev#1")?.epoch).toBe(1);

    const rework = await scheduler.review("task-1", "rework", "add coverage");
    expect(rework.status).toBe("running");
    await scheduler.waitForReview("task-1");
    const reviewed = scheduler.getTask("task-1");
    expect(reviewed?.attempts).toBe(2);
    expect(reviewed?.result).toContain("add coverage");
    expect(factory.get("dev#1")?.epoch).toBe(1);
    expect(factory.get("dev#1")?.snapshot().feedbacksReceived).toHaveLength(1);
    expect(factory.get("dev#1")?.snapshot().feedbacksReceived[0]?.epoch).toBe(1);

    await scheduler.review("task-1", "close");
    expect(factory.get("dev#1")?.epoch).toBe(2);

    await scheduler.submit({ role: "dev", prompt: "next", title: "next" });
    await scheduler.waitForReview("task-2");
    expect(scheduler.getTask("task-2")?.agentId).toBe("dev#1");
    expect(factory.get("dev#1")?.epoch).toBe(2);
    await scheduler.review("task-2", "close");
    await scheduler.stop();
  });

  it("cancel aborts, resets, releases the lock and allows a new task", async () => {
    const { scheduler, factory } = makeScheduler(1, { delays: { run: 5_000 } });
    await scheduler.start();

    await scheduler.submit({ role: "dev", prompt: "long", title: "long" });
    await waitForStatus(scheduler, "task-1", "running");

    const cancelled = await scheduler.cancel("task-1");
    expect(cancelled.status).toBe("cancelled");
    expect(factory.get("dev#1")?.snapshot().aborts).toBe(1);
    expect(factory.get("dev#1")?.epoch).toBe(2);
    expect(scheduler.listAgents()[0]?.status).toBe("idle");
    expect(scheduler.listAgents()[0]?.currentTaskId).toBeUndefined();

    // The first task deliberately ran for a long time; the replacement should
    // finish quickly under the same fake worker configuration object.
    factory.get("dev#1")!.delays.run = 5;
    await scheduler.submit({ role: "dev", prompt: "replacement", title: "replacement" });
    await scheduler.waitForReview("task-2", 2_000);
    expect(scheduler.getTask("task-2")?.agentId).toBe("dev#1");
    await scheduler.review("task-2", "close");
    await scheduler.stop();
  });

  it("worker failure fails the task, releases the replica and resets context", async () => {
    const { scheduler, factory } = makeScheduler(1, {
      failures: { run: 1 },
      delays: { run: 1 },
    });
    await scheduler.start();

    await scheduler.submit({ role: "dev", prompt: "explode", title: "explode" });
    await expect(scheduler.waitForReview("task-1", 1_000)).rejects.toThrow(/injected failure/);
    expect(scheduler.getTask("task-1")?.status).toBe("failed");
    expect(scheduler.getTask("task-1")?.error).toBe("injected failure");
    await waitFor(
      () => scheduler.listAgents()[0]?.status === "idle",
      "failed replica to reset to idle",
    );
    expect(factory.get("dev#1")?.epoch).toBe(2);

    await scheduler.submit({ role: "dev", prompt: "recover", title: "recover" });
    await scheduler.waitForReview("task-2", 2_000);
    expect(scheduler.getTask("task-2")?.status).toBe("awaiting_review");
    expect(scheduler.getTask("task-2")?.agentId).toBe("dev#1");
    await scheduler.review("task-2", "close");
    await scheduler.stop();
  });

  it("strictly enforces FIFO and never assigns two tasks to one replica", async () => {
    const { scheduler, factory } = makeScheduler(1, { delays: { run: 15 } });
    await scheduler.start();
    for (let index = 1; index <= 3; index += 1) {
      await scheduler.submit({ role: "dev", prompt: `p${index}`, title: `t${index}` });
    }
    expect(scheduler.getTask("task-2")?.status).toBe("queued");
    expect(scheduler.getTask("task-3")?.status).toBe("queued");
    expect(factory.get("dev#1")?.activeTaskId).toBe("task-1");

    await scheduler.waitForReview("task-1");
    await scheduler.review("task-1", "close");
    await scheduler.waitForReview("task-2");
    expect(scheduler.getTask("task-2")?.agentId).toBe("dev#1");
    expect(scheduler.getTask("task-3")?.status).toBe("queued");

    await scheduler.review("task-2", "close");
    await scheduler.waitForReview("task-3");
    await scheduler.review("task-3", "close");
    await scheduler.stop();
  });
});
