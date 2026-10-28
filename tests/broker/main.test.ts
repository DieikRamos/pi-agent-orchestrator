import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrokerCliError,
  descriptorIsHealthy,
  parseArgs,
  readDescriptor,
  runBroker,
  type RunningBroker,
} from "../../src/broker/main.js";
import { BrokerClient } from "../../src/client/broker-client.js";

const CONFIG = `version: 1
server:
  host: 127.0.0.1
  port: 0
  dashboard: true
agents:
  worker:
    description: Test worker.
    model: test/fake-model
    effort: low
    replicas: 1
`;

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-main-"));
  await writeFile(path.join(dir, "agents.yml"), CONFIG, "utf8");
  return dir;
}

describe("broker CLI entrypoint", () => {
  const dirs: string[] = [];
  const brokers: RunningBroker[] = [];

  afterEach(async () => {
    delete process.env.PI_ORCHESTRATOR_FAKE_WORKER;
    while (brokers.length > 0) await brokers.pop()!.shutdown();
    while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("parses flags and rejects invalid ports", () => {
    expect(parseArgs(["--config", "a.yml", "--port=0", "--fake-worker", "--daemon"])).toEqual({
      configPath: "a.yml",
      stateDir: ".pi/agent-orchestrator",
      port: 0,
      daemon: true,
      fakeWorker: true,
      help: false,
    });
    expect(() => parseArgs(["--port", "nope"])).toThrow(BrokerCliError);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
  });

  it("fails with an actionable message when the config is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-empty-"));
    dirs.push(dir);
    await expect(
      runBroker({
        configPath: "missing.yml",
        stateDir: "state",
        port: 0,
        daemon: false,
        fakeWorker: true,
        help: false,
        cwd: dir,
      }),
    ).rejects.toThrow(/config file not found|Create \.pi\/agents\.yml/);
  });

  it("starts, guards a single instance, serves tasks, and cleans up its descriptor", async () => {
    const dir = await tempProject();
    dirs.push(dir);
    const options = {
      configPath: "agents.yml",
      stateDir: "state",
      port: 0,
      daemon: false,
      fakeWorker: true,
      help: false,
      cwd: dir,
    };
    const running = await runBroker(options);
    expect(running).toBeDefined();
    brokers.push(running!);

    const descriptorPath = path.join(dir, "state", "broker.json");
    const descriptor = await readDescriptor(descriptorPath);
    expect(descriptor?.pid).toBe(process.pid);
    expect(descriptor?.configPath).toBe(path.join(dir, "agents.yml"));
    expect(await descriptorIsHealthy(descriptor!)).toBe(true);

    const duplicate = await runBroker(options);
    expect(duplicate).toBeUndefined();

    const client = BrokerClient.forDescriptor(descriptor!);
    const task = await client.submit({
      title: "Integration task",
      role: "worker",
      prompt: "Prove the composed broker works end to end.",
    });
    const reviewed = await client.waitForReview(task.id, 5_000);
    expect(reviewed.status).toBe("awaiting_review");
    expect(reviewed.agentId).toBe("worker#1");

    const closed = await client.review(task.id, "close");
    expect(closed.status).toBe("closed");

    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.tasks.closed).toBe(1);

    const log = await readFile(path.join(dir, "state", "broker.log"), "utf8");
    expect(log).toContain("broker listening at");
    expect(log).toContain("already running");

    await running!.shutdown();
    brokers.pop();
    expect(await readDescriptor(descriptorPath)).toBeUndefined();
  }, 20_000);
});
