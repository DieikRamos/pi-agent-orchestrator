import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  STATE_SCHEMA_VERSION,
  StateStore,
  StateStoreError,
} from "../../src/broker/state-store.js";
import type { BrokerState, Task } from "../../src/types.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-state-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const clock = () => new Date("2026-02-03T04:05:06.000Z");

function task(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    role: "dev",
    prompt: "Do it",
    status: "queued",
    createdAt: "2026-02-03T04:00:00.000Z",
    attempts: 0,
    logs: [],
  };
}

function state(fingerprint = "fingerprint-a"): BrokerState {
  return {
    version: STATE_SCHEMA_VERSION,
    configFingerprint: fingerprint,
    agents: [],
    tasks: [task("t1")],
    seq: 7,
    startedAt: "2026-02-03T04:00:00.000Z",
  };
}

describe("StateStore", () => {
  it("initializes an empty directory and reports no state", async () => {
    const store = new StateStore({ dir: await tempDir(), clock });
    const loaded = await store.init("fingerprint-a");
    expect(loaded.found).toBe(false);
    expect(loaded.actions).toEqual([]);
    expect(loaded.clientRequests).toEqual({});
    expect(loaded.path).toBe(store.stateFile);
    expect((await readdir(store.dir)).sort()).toEqual(["tasks"]);
  });

  it("atomically persists and reloads a snapshot with fingerprint check", async () => {
    const store = new StateStore({ dir: await tempDir(), clock });
    await store.init();
    await store.save(state(), {
      actions: [{ at: "2026-02-03T04:00:00.000Z", type: "task.queued", message: "queued" }],
      clientRequests: { "client-1": "t1" },
    });

    const matching = await store.load("fingerprint-a");
    expect(matching.found).toBe(true);
    expect(matching.fingerprintMatches).toBe(true);
    expect(matching.state?.seq).toBe(7);
    expect(matching.state?.tasks[0]?.id).toBe("t1");
    expect(matching.actions).toHaveLength(1);
    expect(matching.clientRequests).toEqual({ "client-1": "t1" });

    const mismatching = await store.load("fingerprint-b");
    expect(mismatching.fingerprintMatches).toBe(false);

    const files = await readdir(store.dir);
    expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("caps retained actions at the configured bound", async () => {
    const store = new StateStore({ dir: await tempDir(), maxActions: 3, clock });
    await store.init();
    const actions = Array.from({ length: 8 }, (_, index) => ({
      at: "2026-02-03T04:00:00.000Z",
      type: "event",
      message: `action ${index}`,
    }));
    await store.save(state(), { actions });
    const loaded = await store.load();
    expect(loaded.actions.map((action) => action.message)).toEqual([
      "action 5",
      "action 6",
      "action 7",
    ]);
  });

  it("appends per-task JSONL logs in order", async () => {
    const store = new StateStore({ dir: await tempDir(), clock });
    await store.init();
    await store.appendTaskLog("task/with spaces", {
      at: "2026-02-03T04:00:00.000Z",
      type: "status",
      text: "first",
    });
    await store.appendTaskLog("task/with spaces", {
      at: "2026-02-03T04:00:01.000Z",
      type: "text",
      text: "second",
    });
    expect(await store.readTaskLog("task/with spaces")).toEqual([
      { at: "2026-02-03T04:00:00.000Z", type: "status", text: "first" },
      { at: "2026-02-03T04:00:01.000Z", type: "text", text: "second" },
    ]);
    expect(await store.readTaskLog("missing")).toEqual([]);
  });

  it("rejects unsupported schema versions", async () => {
    const dir = await tempDir();
    const store = new StateStore({ dir, clock });
    await store.init();
    await writeFile(
      store.stateFile,
      JSON.stringify({ schemaVersion: 99, state: state() }),
      "utf8",
    );
    await expect(store.load()).rejects.toBeInstanceOf(StateStoreError);
    await expect(store.load()).rejects.toThrow(/schema version 99/);
  });

  it("rejects corrupt state JSON", async () => {
    const dir = await tempDir();
    const store = new StateStore({ dir, clock });
    await store.init();
    await writeFile(store.stateFile, "{ not json", "utf8");
    await expect(store.load()).rejects.toThrow(/not valid JSON/);
  });
});
