import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";

import {
  RpcWorkerFactory,
  createWorkerFactory,
  isFakeWorkerMode,
} from "../../src/worker/factory.js";
import { RpcWorker } from "../../src/worker/rpc-worker.js";
import { FakeWorkerFactory } from "../../src/testing/fake-worker.js";
import {
  ModelRuntimeResolver,
  type CatalogModel,
  type ModelCatalog,
} from "../../src/models/resolve.js";
import type { AgentRuntime, OrchestratorConfig } from "../../src/types.js";

function model(provider: string, id: string): CatalogModel {
  return { provider, id, name: id, reasoning: true };
}

class FakeCatalog implements ModelCatalog {
  constructor(private readonly models: CatalogModel[]) {}
  getModels(provider?: string): readonly CatalogModel[] {
    return provider ? this.models.filter((item) => item.provider === provider) : this.models;
  }
  getAvailable(provider?: string): Promise<readonly CatalogModel[]> {
    return Promise.resolve(this.getModels(provider));
  }
}

function config(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 0, dashboard: true },
    agents: {
      developer: {
        role: "developer",
        description: "Implement assigned work.",
        model: "anthropic/claude-sonnet-4-5",
        effort: "high",
        replicas: 1,
      },
    },
    ...overrides,
  };
}

function runtime(role = "developer", overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  const agentConfig = config().agents[role]!;
  return {
    id: `${role}#1`,
    role,
    replica: 1,
    config: agentConfig,
    status: "idle",
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-factory-test-"));
});

afterEach(async () => {
  delete process.env.PI_ORCHESTRATOR_FAKE_WORKER;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("worker factory selection", () => {
  it("selects fake workers from PI_ORCHESTRATOR_FAKE_WORKER=1", async () => {
    process.env.PI_ORCHESTRATOR_FAKE_WORKER = "1";
    const factory = await createWorkerFactory({ projectRoot: tmpRoot, config: config() });
    expect(factory).toBeInstanceOf(FakeWorkerFactory);
    expect(isFakeWorkerMode()).toBe(true);
    expect(isFakeWorkerMode("true")).toBe(true);
    expect(isFakeWorkerMode("0")).toBe(false);
  });

  it("selects fake workers from an explicit option and skips model validation", async () => {
    const factory = await createWorkerFactory({
      projectRoot: tmpRoot,
      config: config({
        agents: {
          fake: {
            role: "fake",
            description: "Fake role.",
            model: "does-not-exist",
            replicas: 1,
          },
        },
      }),
      fake: { response: () => "fake result" },
    });
    expect(factory).toBeInstanceOf(FakeWorkerFactory);
    const worker = factory.create(runtime("fake"));
    await worker.start();
    await expect(worker.run({ ...task(), role: "fake" }, () => {})).resolves.toMatchObject({
      finalText: "fake result",
    });
  });

  it("uses fake workers when explicitly requested even if env is not set", async () => {
    const factory = await createWorkerFactory({
      projectRoot: tmpRoot,
      config: config(),
      fake: true,
    });
    expect(factory).toBeInstanceOf(FakeWorkerFactory);
  });
});

describe("RpcWorkerFactory validation and creation", () => {
  it("validates every role before creating a worker", async () => {
    const factory = new RpcWorkerFactory(
      { projectRoot: tmpRoot },
      new ModelRuntimeResolver(new FakeCatalog([model("anthropic", "claude-sonnet-4-5")])),
    );
    await expect(factory.prepare(config())).resolves.toBeDefined();
    expect(factory.resolvedModel("developer")).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
    });
    const worker = factory.create(runtime());
    expect(worker).toBeInstanceOf(RpcWorker);
  });

  it("fails fast for an unknown model", async () => {
    const factory = new RpcWorkerFactory(
      { projectRoot: tmpRoot },
      new ModelRuntimeResolver(new FakeCatalog([model("anthropic", "other-model")])),
    );
    await expect(factory.prepare(config())).rejects.toThrow(/was not found/);
  });

  it("fails fast when the effort is unsupported", async () => {
    const catalog = new FakeCatalog([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude", reasoning: false },
    ]);
    const factory = new RpcWorkerFactory(
      { projectRoot: tmpRoot },
      new ModelRuntimeResolver(catalog),
    );
    await expect(factory.prepare(config())).rejects.toThrow(/not supported by model/);
  });

  it("refuses create before prepare with an actionable error", () => {
    const factory = new RpcWorkerFactory({ projectRoot: tmpRoot });
    expect(() => factory.create(runtime())).toThrow(/prepare\(config\)/);
  });

  it("spawns through RpcClient options with required worker args and recursion guard", async () => {
    const captured: RpcClientOptions[] = [];
    class StubClient {
      state = {
        sessionId: "s1",
        sessionFile: path.join(tmpRoot, "s1.jsonl"),
        messageCount: 0,
      };
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      onEvent(): () => void {
        return () => {};
      }
      async prompt(): Promise<unknown> {
        return "started";
      }
      async abort(): Promise<void> {}
      async newSession(): Promise<{ cancelled: boolean }> {
        return { cancelled: false };
      }
      async getState() {
        return { ...this.state };
      }
      async getLastAssistantText(): Promise<string> {
        return "done";
      }
      async setThinkingLevel(_level: ThinkingLevel): Promise<void> {}
      async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
        return ["off", "medium", "high"];
      }
      getStderr(): string {
        return "";
      }
    }
    const factory = new RpcWorkerFactory(
      {
        projectRoot: tmpRoot,
        clientFactory: (options) => {
          captured.push(options);
          return new StubClient();
        },
      },
      new ModelRuntimeResolver(new FakeCatalog([model("anthropic", "claude-sonnet-4-5")])),
    );
    await factory.prepare(config());
    const worker = factory.create(runtime());
    await worker.start();
    await worker.stop();

    expect(captured).toHaveLength(1);
    const options = captured[0]!;
    expect(options.provider).toBe("anthropic");
    expect(options.model).toBe("claude-sonnet-4-5");
    expect(options.cwd).toBe(tmpRoot);
    expect(options.args).toEqual(
      expect.arrayContaining(["--mode", "rpc", "--session-dir", path.join(tmpRoot, ".pi/agent-orchestrator", "sessions")]),
    );
    expect(options.args).not.toContain("--no-extensions");
    expect(options.args).toContain("--offline");
    expect(options.env).toMatchObject({
      PI_AGENT_ORCHESTRATOR_WORKER: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
  });
});

	function task() {
	  return {
	    id: "task-fake",
	    title: "Fake task",
	    role: "developer",
	    prompt: "Do the fake thing.",
	    status: "running" as const,
	    createdAt: new Date(0).toISOString(),
	    attempts: 1,
	    logs: [],
	  };
	}
