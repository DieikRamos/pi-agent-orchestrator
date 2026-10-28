import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config.js";
import { BrokerCore } from "../../src/broker/core.js";
import { BrokerError } from "../../src/broker/scheduler.js";
import { STATE_SCHEMA_VERSION, StateStore } from "../../src/broker/state-store.js";
import { FakeWorkerFactory, type FakeWorkerOptions } from "../../src/testing/fake-worker.js";
import type { BrokerState, SSEEvent, Task } from "../../src/types.js";

const dirs: string[] = [];
const clock = () => new Date("2026-05-06T07:08:09.000Z");

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-core-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    }),
  );
});

function config(replicas = 1) {
  return parseConfig({
    agents: {
      dev: { description: "Developer", model: "fake/model", replicas },
    },
  });
}

function makeCore(
  dir: string,
  options: {
    replicas?: number;
    worker?: FakeWorkerOptions;
    maxActions?: number;
    reloadConfig?: () => Promise<ReturnType<typeof config>>;
  } = {},
) {
  let nextId = 0;
  const loadedConfig = config(options.replicas ?? 1);
  const factory = new FakeWorkerFactory({ clock, tools: [], ...options.worker });
  const core = new BrokerCore({
    config: loadedConfig,
    workerFactory: factory,
    stateDir: dir,
    clock,
    idGenerator: () => `task-${++nextId}`,
    ...(options.maxActions !== undefined ? { maxActions: options.maxActions } : {}),
    ...(options.reloadConfig ? { reloadConfig: options.reloadConfig } : {}),
  });
  return { core, factory, loadedConfig };
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

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    role: "dev",
    prompt: "work",
    status: "queued",
    createdAt: "2026-05-06T07:00:00.000Z",
    attempts: 0,
    logs: [],
    ...overrides,
  };
}

describe("BrokerCore", () => {
  it("provides an end-to-end locked review cycle with ordered events", async () => {
    const { core, factory } = makeCore(await tempDir(), { worker: { delays: { run: 5 } } });
    await core.start();
    const events: SSEEvent[] = [];
    core.subscribe((event) => events.push(event));

    const submitted = await core.submit({ role: "dev", prompt: "implement", title: "implement" });
    expect(submitted.status).toBe("queued");
    const reviewed = await core.waitForReview(submitted.id);
    expect(reviewed.status).toBe("awaiting_review");
    expect(reviewed.result).toContain("dev#1 completed");
    expect(core.listAgents()[0]).toMatchObject({
      status: "awaiting_review",
      currentTaskId: submitted.id,
    });

    const closed = await core.review(submitted.id, "close");
    expect(closed.status).toBe("closed");
    expect(factory.get("dev#1")?.epoch).toBe(2);
    expect(core.listAgents()[0]).toMatchObject({ status: "idle" });

    const next = await core.submit({ role: "dev", prompt: "next", title: "next" });
    await core.waitForReview(next.id);
    expect(factory.get("dev#1")?.epoch).toBe(2);
    await core.review(next.id, "close");

    expect(events.length).toBeGreaterThan(5);
    expect(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq)).toBe(
      true,
    );
    expect(events.map((event) => event.type)).toContain("task.log");
    expect(events.map((event) => event.type)).toContain("agent.updated");
    expect(core.getSnapshot().seq).toBe(events.at(-1)?.seq);
    await core.stop();
  });

  it("is idempotent only when clientRequestId is supplied", async () => {
    const { core } = makeCore(await tempDir(), { worker: { delays: { run: 5 } } });
    await core.start();

    const first = await core.submit({
      role: "dev",
      prompt: "same",
      title: "same",
      clientRequestId: "request-1",
    } as Parameters<BrokerCore["submit"]>[0]);
    const repeated = await core.submit({
      role: "dev",
      prompt: "same",
      title: "same",
      clientRequestId: "request-1",
    } as Parameters<BrokerCore["submit"]>[0]);
    const distinct = await core.submit({ role: "dev", prompt: "different", title: "different" });

    expect(repeated.id).toBe(first.id);
    expect(distinct.id).not.toBe(first.id);
    expect(core.listTasks()).toHaveLength(2);
    expect(core.getClientRequests()).toEqual({ "request-1": first.id });

    await core.waitForReview(first.id);
    await core.review(first.id, "close");
    await core.waitForReview(distinct.id);
    await core.review(distinct.id, "close");
    await core.stop();
  });

  it("recovers queued and awaiting-review tasks and fails in-flight tasks", async () => {
    const dir = await tempDir();
    const loadedConfig = config(2);
    const store = new StateStore({ dir, clock, maxActions: 10 });
    await store.init();
    const actions = Array.from({ length: 10 }, (_, index) => ({
      at: "2026-05-06T07:00:00.000Z",
      type: "prior",
      message: `action-${index}`,
    }));
    const snapshot: BrokerState = {
      version: STATE_SCHEMA_VERSION,
      configFingerprint: loadedConfig.configFingerprint,
      agents: [],
      tasks: [
        task({ id: "assigned", status: "assigned", agentId: "dev#1", attempts: 1 }),
        task({ id: "running", status: "running", agentId: "dev#2", attempts: 1 }),
        task({ id: "queued", status: "queued" }),
        task({ id: "review", status: "awaiting_review", agentId: "dev#1", attempts: 1 }),
      ],
      seq: 42,
      startedAt: "2026-05-06T07:00:00.000Z",
    };
    await store.save(snapshot, { actions });

    const factory = new FakeWorkerFactory({ clock, tools: [] });
    const core = new BrokerCore({
      config: loadedConfig,
      workerFactory: factory,
      stateDir: dir,
      clock,
      idGenerator: () => "unused",
      maxActions: 10,
    });
    await core.start();

    expect(core.getTask("assigned")?.status).toBe("failed");
    expect(core.getTask("assigned")?.error).toBe("broker_restarted");
    expect(core.getTask("running")?.status).toBe("failed");
    expect(core.getTask("running")?.error).toBe("broker_restarted");
    expect(core.getTask("review")?.status).toBe("awaiting_review");
    expect(core.getTask("review")?.agentId).toBe("dev#1");

    await core.waitForReview("queued", 2_000);
    expect(core.getTask("queued")?.agentId).toBe("dev#2");
    expect(core.getSnapshot().seq).toBeGreaterThanOrEqual(42);
    const actionMessages = core.getActionLog().map((action) => action.message);
    expect(actionMessages).toContain("action-7");
    expect(actionMessages).toContain("action-9");
    expect(actionMessages).toContain("Broker scheduler started");
    expect(actionMessages).not.toContain("action-0");
    expect(actionMessages.length).toBeLessThanOrEqual(10);

    // Worker context is not durable across restart. Rework must still make
    // progress in a fresh context and return to review with the feedback.
    await core.review("review", "rework", "please revise");
    const reworked = await core.waitForReview("review", 2_000);
    expect(reworked.attempts).toBe(2);
    expect(reworked.logs.some((entry) => entry.text.includes("fresh context"))).toBe(true);

    await core.review("review", "close");
    await core.review("queued", "close");
    await core.stop();
  });

  it("applies config reload only when no task holds a replica lock", async () => {
    const dir = await tempDir();
    let reloaded = config(2);
    const { core, factory } = makeCore(dir, {
      worker: { delays: { run: 5 } },
      reloadConfig: async () => reloaded,
    });
    await core.start();
    expect(core.listAgents()).toHaveLength(1);

    const task1 = await core.submit({ role: "dev", prompt: "locked", title: "locked" });
    await core.waitForReview(task1.id);
    await expect(core.reload()).rejects.toBeInstanceOf(BrokerError);
    await expect(core.reload()).rejects.toThrow(/cannot reload/);

    await core.review(task1.id, "close");
    const applied = await core.reload();
    expect(Object.keys(applied.agents)).toEqual(["dev"]);
    expect(core.listAgents()).toHaveLength(2);
    expect(core.listAgents().map((agent) => agent.id)).toEqual(["dev#1", "dev#2"]);
    expect(factory.created).toHaveLength(2);
    await core.stop();
  });

  it("stop marks in-flight work failed and persists it for the next start", async () => {
    const dir = await tempDir();
    const { core } = makeCore(dir, { worker: { delays: { run: 5_000 } } });
    await core.start();
    const running = await core.submit({ role: "dev", prompt: "slow", title: "slow" });
    await waitFor(() => core.getTask(running.id)?.status === "running", "task to run");
    await core.stop();
    expect(core.getTask(running.id)?.status).toBe("failed");
    expect(core.getTask(running.id)?.error).toBe("broker_shutdown");

    const { core: restarted } = makeCore(dir);
    await restarted.start();
    expect(restarted.getTask(running.id)?.status).toBe("failed");
    expect(restarted.getTask(running.id)?.error).toBe("broker_shutdown");
    await restarted.stop();
  });
  it("persists schedule state and preserves the next run across restart", async () => {
    const dir = await tempDir();
    const loadedConfig = parseConfig({
      agents: {
        dev: { description: "Developer", model: "fake/model", replicas: 1 },
      },
      schedules: [
        {
          id: "regression",
          role: "dev",
          every: "15m",
          prompt: "Review recent changes.",
        },
      ],
    });
    const make = () =>
      new BrokerCore({
        config: loadedConfig,
        workerFactory: new FakeWorkerFactory({ clock, tools: [] }),
        stateDir: dir,
        clock,
        idGenerator: () => "task-1",
      });

    const first = make();
    await first.start();
    const initial = first.listSchedules()[0]!;
    expect(initial.nextRunAt).toBe("2026-05-06T07:23:09.000Z");
    const scheduled = await first.runSchedule("regression");
    expect(scheduled.status).toBe("queued");
    expect(first.listSchedules()[0]?.lastTaskId).toBe(scheduled.id);
    const disabled = await first.setScheduleEnabled("regression", false);
    expect(disabled.enabled).toBe(false);
    await first.stop();

    const second = make();
    await second.start();
    expect(second.listSchedules()[0]).toMatchObject({
      id: "regression",
      enabled: false,
      nextRunAt: initial.nextRunAt,
      lastTaskId: scheduled.id,
    });
    await second.stop();
  });

});
