import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BrokerClient,
  BrokerHttpError,
  BrokerTimeoutError,
  BrokerUnavailableError,
  brokerDescriptorPath,
  normalizeDescriptor,
  readBrokerDescriptor,
} from "../../src/client/broker-client.js";
import type { AgentView, HealthView, Task } from "../../src/types.js";

const health: HealthView = {
  ok: true,
  name: "pi-agent-orchestrator",
  version: "0.1.0",
  pid: 123,
  startedAt: "2026-01-01T00:00:00.000Z",
  uptimeMs: 1000,
  configFingerprint: "fingerprint",
  agents: { total: 1, idle: 1, busy: 0, awaitingReview: 0, error: 0 },
  tasks: { total: 0, queued: 0, running: 0, awaitingReview: 0, closed: 0, failed: 0, cancelled: 0 },
};

const schedule = {
  id: "regression",
  role: "developer",
  title: "Regression review",
  prompt: "Review changes",
  every: "15m",
  everyMs: 900_000,
  enabled: true,
  runOnStart: false,
  overlap: "skip" as const,
  nextRunAt: "2026-01-01T00:15:00.000Z",
  skippedRuns: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const agent: AgentView = {
  id: "developer#1",
  role: "developer",
  replica: 1,
  model: "anthropic/claude-sonnet-4-5",
  effort: "medium",
  status: "idle",
};

function task(status: Task["status"] = "queued"): Task {
  return {
    id: "t1",
    title: "Do work",
    role: "developer",
    prompt: "Do work",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    logs: [],
  };
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface StubServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startServer(
  handler: (req: RecordedRequest, res: ServerResponse) => void,
): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const record = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(record);
      handler(record, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const servers: StubServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("BrokerClient", () => {
  it("rejects remote URLs", () => {
    expect(() => new BrokerClient({ baseUrl: "http://example.com:8787" })).toThrow(
      BrokerUnavailableError,
    );
    expect(() => new BrokerClient({ baseUrl: "https://127.0.0.1:8787" })).toThrow(
      BrokerUnavailableError,
    );
  });

  it("health requires the broker identity", async () => {
    const server = await startServer((_req, res) => json(res, 200, health));
    servers.push(server);
    const client = new BrokerClient({ baseUrl: server.url });
    await expect(client.health()).resolves.toMatchObject({ ok: true, pid: 123 });

    server.close();
    const wrong = await startServer((_req, res) => json(res, 200, { ok: true, name: "other" }));
    servers.push(wrong);
    const bad = new BrokerClient({ baseUrl: wrong.url });
    await expect(bad.health()).rejects.toThrow(/not a pi-agent-orchestrator broker/);
  });

  it("submits, lists, reviews, cancels and reloads with documented routes", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/api/tasks" && req.method === "POST") return json(res, 201, task());
      if (req.url === "/api/agents") return json(res, 200, [agent]);
      if (req.url === "/api/schedules") return json(res, 200, [schedule]);
      if (req.url === "/api/schedules/regression/run") return json(res, 201, task("queued"));
      if (req.url === "/api/schedules/regression/enable") return json(res, 200, { ...schedule, enabled: false });
      if (req.url?.startsWith("/api/tasks?")) return json(res, 200, [task("awaiting_review")]);
      if (req.url === "/api/tasks/t1/review") return json(res, 200, task("closed"));
      if (req.url === "/api/tasks/t1/cancel") return json(res, 200, task("cancelled"));
      if (req.url === "/api/reload") return json(res, 200, { config: { version: 1, server: {}, agents: {} }, configFingerprint: "f" });
      return json(res, 404, { error: { code: "not_found", message: "missing" } });
    });
    servers.push(server);
    const client = new BrokerClient({ baseUrl: server.url, token: "secret" });

    await expect(
      client.submit({ title: "Do work", role: "developer", prompt: "Do it", acceptance: "tests" }),
    ).resolves.toMatchObject({ id: "t1" });
    await expect(client.listAgents()).resolves.toHaveLength(1);
    await expect(client.listSchedules()).resolves.toHaveLength(1);
    await expect(client.runSchedule("regression")).resolves.toMatchObject({ status: "queued" });
    await expect(client.setScheduleEnabled("regression", false)).resolves.toMatchObject({
      id: "regression",
      enabled: false,
    });
    await expect(client.listTasks({ role: "developer", status: ["running", "queued"] })).resolves.toHaveLength(1);
    await expect(client.review("t1", "close")).resolves.toMatchObject({ status: "closed" });
    await expect(client.cancel("t1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(client.reload()).resolves.toMatchObject({ configFingerprint: "f", config: { version: 1 } });

    const submit = server.requests.find((request) => request.method === "POST" && request.url === "/api/tasks");
    expect(JSON.parse(submit!.body)).toMatchObject({
      title: "Do work",
      role: "developer",
      prompt: "Do it",
      acceptance: "tests",
    });
    expect(submit!.headers.authorization).toBe("Bearer secret");
    const list = server.requests.find((request) => request.url?.startsWith("/api/tasks?"));
    expect(list?.url).toContain("status=running");
    expect(list?.url).toContain("status=queued");
    expect(list?.url).toContain("role=developer");
  });

  it("maps broker error bodies and network failures to clear errors", async () => {
    const server = await startServer((_req, res) =>
      json(res, 409, {
        error: { code: "conflict", message: "agent is locked", details: { agentId: "developer#1" } },
      }),
    );
    servers.push(server);
    const client = new BrokerClient({ baseUrl: server.url });
    await expect(client.cancel("t1")).rejects.toMatchObject({
      name: "BrokerHttpError",
      status: 409,
      code: "conflict",
      message: "agent is locked",
      details: { agentId: "developer#1" },
    });

    const dead = await startServer((_req, res) => json(res, 200, health));
    const deadUrl = dead.url;
    await dead.close();
    const offline = new BrokerClient({ baseUrl: deadUrl, timeoutMs: 250 });
    await expect(offline.health()).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it("polls until awaiting_review and reports terminal failures and timeouts", async () => {
    let calls = 0;
    const server = await startServer((req, res) => {
      if (req.url === "/api/tasks/running") {
        calls += 1;
        return json(res, 200, task(calls >= 3 ? "awaiting_review" : "running"));
      }
      if (req.url === "/api/tasks/failed") return json(res, 200, { ...task("failed"), error: "boom" });
      return json(res, 200, task("running"));
    });
    servers.push(server);
    const client = new BrokerClient({ baseUrl: server.url });

    await expect(
      client.waitForReview("running", 2000, { pollIntervalMs: 10 }),
    ).resolves.toMatchObject({ status: "awaiting_review" });
    expect(calls).toBeGreaterThanOrEqual(3);

    await expect(client.waitForReview("failed", 1000, { pollIntervalMs: 10 })).rejects.toBeInstanceOf(
      BrokerHttpError,
    );
    await expect(client.waitForReview("never", 60, { pollIntervalMs: 20 })).rejects.toBeInstanceOf(
      BrokerTimeoutError,
    );
  });

  it("reads and validates broker.json", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pao-client-"));
    const descriptor = {
      pid: 42,
      port: 9999,
      token: "secret",
      startedAt: "2026-01-01T00:00:00.000Z",
      configPath: path.join(cwd, ".pi/agents.yml"),
    };
    await mkdir(path.dirname(brokerDescriptorPath(cwd)), { recursive: true });
    await writeFile(brokerDescriptorPath(cwd), JSON.stringify(descriptor), "utf8");
    await expect(readBrokerDescriptor(cwd)).resolves.toEqual(descriptor);
    const client = new BrokerClient({ cwd });
    expect(client.baseUrl).toBe("");
    expect(normalizeDescriptor(descriptor, "test")).toEqual(descriptor);
    expect(() => normalizeDescriptor({ ...descriptor, port: 0 }, "test")).toThrow(
      BrokerUnavailableError,
    );
    expect(() => normalizeDescriptor({ ...descriptor, pid: 0 }, "test")).toThrow(
      BrokerUnavailableError,
    );
  });
});
