import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BrokerStartError,
  NO_AUTOSTART_ENV,
  WORKER_ENV,
  ensureBroker,
  resetEnsureBrokerState,
  resolveBrokerEntry,
  type EnsureBrokerOptions,
} from "../../src/extension/autostart.js";
import {
  brokerDescriptorPath,
  brokerLogPath,
  type BrokerDescriptor,
} from "../../src/client/broker-client.js";

async function project(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pao-autostart-"));
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi/agents.yml"), "agents: {}\n", "utf8");
  return cwd;
}

function descriptor(cwd: string, port = 8787, pid = 100): BrokerDescriptor {
  return {
    pid,
    port,
    startedAt: "2026-01-01T00:00:00.000Z",
    configPath: path.join(cwd, ".pi/agents.yml"),
  };
}

const exists = async (): Promise<boolean> => true;

beforeEach(() => {
  resetEnsureBrokerState();
});

describe("ensureBroker", () => {
  it("never starts a broker in a worker process", async () => {
    const cwd = await project();
    let spawned = 0;
    const result = await ensureBroker({
      cwd,
      env: { [WORKER_ENV]: "1" },
      spawn: () => {
        spawned += 1;
        return {};
      },
      fileExists: exists,
    });
    expect(result.skipped).toBe(true);
    expect(spawned).toBe(0);
    expect(result.reason).toContain(WORKER_ENV);
  });

  it("skips autostart when the broker is managed externally", async () => {
    const cwd = await project();
    let spawned = 0;
    const result = await ensureBroker({
      cwd,
      env: { [NO_AUTOSTART_ENV]: "1" },
      spawn: () => {
        spawned += 1;
        return {};
      },
      fileExists: exists,
    });
    expect(result.skipped).toBe(true);
    expect(spawned).toBe(0);
    expect(result.reason).toContain(NO_AUTOSTART_ENV);
  });

  it("reuses a healthy running broker", async () => {
    const cwd = await project();
    const live = descriptor(cwd);
    let spawned = 0;
    const result = await ensureBroker({
      cwd,
      env: {},
      fileExists: exists,
      readDescriptor: async () => live,
      health: async (candidate) => candidate.pid === live.pid,
      spawn: () => {
        spawned += 1;
        return {};
      },
    });
    expect(result.reused).toBe(true);
    expect(result.started).toBe(false);
    expect(result.url).toBe("http://127.0.0.1:8787");
    expect(spawned).toBe(0);
  });

  it("spawns a detached broker and waits for health", async () => {
    const cwd = await project();
    const live = descriptor(cwd, 9123);
    let spawned = 0;
    let spawnOptions: unknown;
    let spawnArgs: string[] = [];
    const result = await ensureBroker({
      cwd,
      env: {},
      timeoutMs: 1000,
      sleep: async () => {},
      now: () => 0,
      fileExists: exists,
      readDescriptor: async () => (spawned > 0 ? live : undefined),
      health: async () => spawned > 0,
      spawn: (_command, args, options) => {
        spawned += 1;
        spawnArgs = args;
        spawnOptions = options;
        return { pid: live.pid, unref: () => {} };
      },
    });
    expect(result.started).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.url).toBe("http://127.0.0.1:9123");
    expect(spawned).toBe(1);
    expect(spawnArgs).toContain("--daemon");
    expect(spawnArgs).toContain("--config");
    expect(spawnArgs).toContain("--workdir");
    expect(spawnArgs[spawnArgs.indexOf("--workdir") + 1]).toBe(cwd);
    expect(spawnOptions).toMatchObject({ detached: true, stdio: "ignore", cwd });
  });

  it("shares one spawn across concurrent calls and retries health", async () => {
    const cwd = await project();
    const live = descriptor(cwd, 9001);
    let spawned = 0;
    let healthChecks = 0;
    const options: EnsureBrokerOptions = {
      cwd,
      env: {},
      timeoutMs: 1000,
      fileExists: exists,
      readDescriptor: async () => (spawned > 0 ? live : undefined),
      health: async () => {
        healthChecks += 1;
        return spawned > 0;
      },
      sleep: async () => {},
      now: () => 0,
      spawn: () => {
        spawned += 1;
        return { pid: 100, unref: () => {} };
      },
    };
    const [a, b] = await Promise.all([ensureBroker(options), ensureBroker(options)]);
    expect(spawned).toBe(1);
    expect(healthChecks).toBeGreaterThan(0);
    expect(a.started).toBe(true);
    expect(b.started).toBe(true);
  });

  it("reports the log and descriptor path when the broker never becomes healthy", async () => {
    const cwd = await project();
    let clock = 0;
    let spawned = 0;
    await expect(
      ensureBroker({
        cwd,
        env: {},
        timeoutMs: 300,
        fileExists: exists,
        readDescriptor: async () => undefined,
        health: async () => false,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        spawn: () => {
          spawned += 1;
          return { pid: 55, unref: () => {} };
        },
      }),
    ).rejects.toMatchObject({
      name: "BrokerStartError",
      logPath: brokerLogPath(cwd),
      descriptorPath: brokerDescriptorPath(cwd),
    });
    expect(spawned).toBe(1);
  });

  it("fails actionably when config or broker build is missing", async () => {
    const cwd = await project();
    await expect(
      ensureBroker({
        cwd,
        env: {},
        fileExists: async (file) => file !== path.join(cwd, ".pi/agents.yml"),
      }),
    ).rejects.toThrow(/No agent config found/);

    await expect(
      ensureBroker({
        cwd,
        env: {},
        fileExists: async (file) => !file.endsWith(path.join("dist", "broker", "main.js")),
        readDescriptor: async () => undefined,
        health: async () => false,
      }),
    ).rejects.toBeInstanceOf(BrokerStartError);
  });

  it("supports an explicit broker entry and default resolution", () => {
    expect(resolveBrokerEntry({ brokerEntry: "/tmp/broker.js", env: {} })).toBe(
      path.resolve("/tmp/broker.js"),
    );
    expect(
      resolveBrokerEntry({ env: { PI_AGENT_ORCHESTRATOR_BROKER_ENTRY: "/tmp/env-broker.js" } }),
    ).toBe(path.resolve("/tmp/env-broker.js"));
    expect(resolveBrokerEntry({ env: {} })).toMatch(/dist[\\/]broker[\\/]main\.js$/);
  });
});
