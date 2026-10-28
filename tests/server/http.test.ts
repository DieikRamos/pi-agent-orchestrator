import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createServer,
  normalizeLoopbackHost,
  resolveWebRoot,
  resolveWebRootFrom,
  webRootCandidates,
  type BrokerHttpServer,
  type BrokerServerOptions,
} from "../../src/server/http.js";
import type { OrchestratorConfig } from "../../src/types.js";
import { makeConfig, StubCore, readSseEvents } from "./stub-core.js";

const webSource = fileURLToPath(new URL("../../web/", import.meta.url));

interface Harness {
  core: StubCore;
  server: BrokerHttpServer;
  base: string;
  config: OrchestratorConfig;
}

async function startHarness(
  options: BrokerServerOptions = {},
  core = new StubCore(),
): Promise<Harness> {
  const config = options.getConfig
    ? makeConfig()
    : (makeConfig() as OrchestratorConfig);
  const server = createServer(core, {
    port: 0,
    logger: () => {},
    getConfig: () => config,
    ...options,
  });
  const address = await server.listen();
  return { core, server, base: address.url, config };
}

describe("broker HTTP API", () => {
  let harness: Harness | undefined;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness?.server.close();
    harness = undefined;
  });

  it("binds loopback on an ephemeral port and reports health", async () => {
    const { base, server, core } = harness!;
    expect(server.address()?.address).toBe("127.0.0.1");
    expect(server.address()?.port).toBeGreaterThan(0);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const health = await response.json();
    expect(health).toMatchObject({
      ok: true,
      name: "pi-agent-orchestrator",
      version: "0.1.0",
      configFingerprint: core.configFingerprint,
    });
    expect(health.agents).toMatchObject({ total: 1, idle: 1 });
    expect(health.tasks).toMatchObject({ total: 0, queued: 0 });
    expect(typeof health.uptimeMs).toBe("number");
  });

  it("serves normalized config and redacts credential-like keys", async () => {
    const config = makeConfig() as OrchestratorConfig & { token?: string };
    config.token = "super-secret-token";
    const local = await startHarness({ getConfig: () => config });
    try {
      const response = await fetch(`${local.base}/api/config`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents.developer.model).toBe("test/fake-model");
      expect(body.token).toBe("[redacted]");
      expect(body.configFingerprint).toBe(local.core.configFingerprint);
      expect(JSON.stringify(body)).not.toContain("super-secret-token");
    } finally {
      await local.server.close();
    }
  });

  it("lists agents and tasks and returns 404 for unknown tasks/routes", async () => {
    const { base } = harness!;
    const agents = await (await fetch(`${base}/api/agents`)).json();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "developer#1", status: "idle" });

    const missingTask = await fetch(`${base}/api/tasks/nope`);
    expect(missingTask.status).toBe(404);
    expect(await missingTask.json()).toMatchObject({
      error: { code: "not_found" },
    });

    const missingRoute = await fetch(`${base}/api/does-not-exist`);
    expect(missingRoute.status).toBe(404);
    expect(await missingRoute.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("lists recurring schedules and supports manual run and enable/disable", async () => {
    const { base, core } = harness!;
    core.schedules.push({
      id: "regression",
      role: "developer",
      title: "Regression review",
      prompt: "Review recent changes.",
      every: "15m",
      everyMs: 900_000,
      enabled: true,
      runOnStart: false,
      overlap: "skip",
      nextRunAt: "2026-01-01T00:15:00.000Z",
      skippedRuns: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const listed = await fetch(`${base}/api/schedules`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject([
      { id: "regression", role: "developer", every: "15m" },
    ]);
    const one = await fetch(`${base}/api/schedules/regression`);
    expect(one.status).toBe(200);
    expect((await one.json()).id).toBe("regression");

    const run = await fetch(`${base}/api/schedules/regression/run`, { method: "POST" });
    expect(run.status).toBe(201);
    const task = await run.json();
    expect(task).toMatchObject({ role: "developer", title: "Regression review" });
    expect(core.schedules[0]?.lastTaskId).toBe(task.id);

    const disabled = await fetch(`${base}/api/schedules/regression/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).enabled).toBe(false);

    const invalid = await fetch(`${base}/api/schedules/regression/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "no" }),
    });
    expect(invalid.status).toBe(400);

    const missing = await fetch(`${base}/api/schedules/nope/run`, { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("validates and creates tasks", async () => {
    const { base, core } = harness!;

    const invalid = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Missing prompt", role: "developer" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const unknownRole = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", role: "nobody", prompt: "p" }),
    });
    expect(unknownRole.status).toBe(400);
    const unknownBody = await unknownRole.json();
    expect(unknownBody.error.message).toContain("nobody");

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Implement feature",
        role: "developer",
        prompt: "Do the work.",
        acceptance: "Tests pass.",
      }),
    });
    expect(created.status).toBe(201);
    const task = await created.json();
    expect(task).toMatchObject({
      id: "task-1",
      title: "Implement feature",
      role: "developer",
      status: "queued",
      acceptance: "Tests pass.",
    });
    expect(core.tasks).toHaveLength(1);

    const fetched = await fetch(`${base}/api/tasks/${task.id}`);
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).id).toBe(task.id);

    const filtered = await (await fetch(`${base}/api/tasks?status=queued&role=developer`)).json();
    expect(filtered).toHaveLength(1);
    const noMatch = await (await fetch(`${base}/api/tasks?status=closed`)).json();
    expect(noMatch).toHaveLength(0);
  });

  it("rejects malformed JSON with a consistent error body", async () => {
    const { base } = harness!;
    const response = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(typeof body.error.message).toBe("string");
  });

  it("closes and reworks tasks through the review endpoint", async () => {
    const { base, core } = harness!;
    const created = await core.submit({
      title: "Review me",
      role: "developer",
      prompt: "work",
    });
    core.markAwaitingReview(created.id);

    const invalidDecision = await fetch(`${base}/api/tasks/${created.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(invalidDecision.status).toBe(400);

    const missingFeedback = await fetch(`${base}/api/tasks/${created.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rework" }),
    });
    expect(missingFeedback.status).toBe(400);

    const rework = await fetch(`${base}/api/tasks/${created.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rework", feedback: "Try harder." }),
    });
    expect(rework.status).toBe(200);
    const reworked = await rework.json();
    expect(reworked).toMatchObject({ status: "running", review: { decision: "rework" } });
    expect(reworked.review.feedback).toBe("Try harder.");
    expect(core.agents[0]!.currentTaskId).toBe(created.id);

    core.markAwaitingReview(created.id);
    const close = await fetch(`${base}/api/tasks/${created.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "close", feedback: "ignored" }),
    });
    expect(close.status).toBe(200);
    expect(await close.json()).toMatchObject({ status: "closed" });
    expect(core.agents[0]!.currentTaskId).toBeUndefined();

    const again = await fetch(`${base}/api/tasks/${created.id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "close" }),
    });
    expect(again.status).toBe(409);
  });

  it("cancels non-terminal tasks and reports conflicts for terminal ones", async () => {
    const { base, core } = harness!;
    const task = await core.submit({ title: "Cancel me", role: "developer", prompt: "work" });
    core.markAwaitingReview(task.id);

    const cancelled = await fetch(`${base}/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    expect(core.agents[0]!.currentTaskId).toBeUndefined();

    const again = await fetch(`${base}/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("streams an SSE snapshot then live events", async () => {
    const { base, core } = harness!;
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);

    await core.submit({ title: "Live task", role: "developer", prompt: "work" });
    try {
      const events = await readSseEvents(response, 2);
      expect(events[0]).toMatchObject({ type: "snapshot", seq: 0 });
      expect(events[0]!.data).toMatchObject({
        version: 1,
        configFingerprint: core.configFingerprint,
      });
      expect(events[1]).toMatchObject({ type: "task.updated" });
      expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
      expect((events[1]!.data as { task: { title: string } }).task.title).toBe("Live task");
    } finally {
      controller.abort();
    }
  });

  it("enforces the JSON body limit", async () => {
    const local = await startHarness({ bodyLimitBytes: 80 });
    try {
      const response = await fetch(`${local.base}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "big", role: "developer", prompt: "x".repeat(200) }),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error: { code: "payload_too_large" },
      });
    } finally {
      await local.server.close();
    }
  });

  it("reloads and shuts down over loopback", async () => {
    let shutdowns = 0;
    const local = await startHarness({ onShutdown: () => { shutdowns += 1; } });
    try {
      const reload = await fetch(`${local.base}/api/reload`, { method: "POST" });
      expect(reload.status).toBe(200);
      expect(await reload.json()).toMatchObject({ ok: true, configFingerprint: "stub-fingerprint" });
      expect(local.core.reloadCalls).toBe(1);

      const shutdown = await fetch(`${local.base}/api/shutdown`, { method: "POST" });
      expect(shutdown.status).toBe(200);
      expect(await shutdown.json()).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shutdowns).toBe(1);
    } finally {
      await local.server.close();
    }
  });

  it("serves the dashboard from the source layout", async () => {
    const { base } = harness!;
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    const html = await index.text();
    expect(html).toContain("/app.js");
    expect(html).toContain("/styles.css");

    const app = await fetch(`${base}/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toMatch(/javascript/);
    expect(await app.text()).toContain("EventSource");

    const css = await fetch(`${base}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    expect((await css.text()).length).toBeGreaterThan(100);

    expect(resolveWebRoot()).toBe(path.resolve(webSource));
  });

  it("resolves dashboard assets from a real dist-like module layout", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-dist-"));
    try {
      const distServer = path.join(tempRoot, "dist", "server");
      const tempWeb = path.join(tempRoot, "web");
      await mkdir(distServer, { recursive: true });
      await mkdir(tempWeb, { recursive: true });
      for (const file of ["index.html", "app.js", "styles.css"]) {
        await copyFile(path.join(webSource, file), path.join(tempWeb, file));
      }
      const distModule = pathToFileURL(path.join(distServer, "http.js"));
      const expectedWeb = path.join(tempRoot, "web");
      const candidates = webRootCandidates(distModule);
      expect(candidates[0]).toBe(expectedWeb);
      expect(candidates[1]).toBe(path.join(tempRoot, "dist", "web"));
      expect(resolveWebRootFrom(distModule)).toBe(expectedWeb);

      // Bundled entry points resolve `<root>/web` through their own directory.
      const entry = pathToFileURL(path.join(tempRoot, "dist", "extension.js"));
      expect(resolveWebRootFrom(entry)).toBe(expectedWeb);
      const brokerEntry = pathToFileURL(path.join(tempRoot, "dist", "broker", "main.js"));
      expect(resolveWebRootFrom(brokerEntry)).toBe(expectedWeb);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves the dashboard from an explicit built layout", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-web-"));
    try {
      for (const file of ["index.html", "app.js", "styles.css"]) {
        await copyFile(path.join(webSource, file), path.join(tempRoot, file));
      }
      const local = await startHarness({ webRoot: tempRoot });
      try {
        const index = await fetch(`${local.base}/`);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain("/app.js");
        const app = await fetch(`${local.base}/app.js`);
        expect(await app.text()).toContain("connectSSE");
        const css = await fetch(`${local.base}/styles.css`);
        expect((await css.text()).length).toBeGreaterThan(100);
      } finally {
        await local.server.close();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns a JSON 404 when the dashboard is disabled", async () => {
    const local = await startHarness({ dashboard: false });
    try {
      const response = await fetch(`${local.base}/`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    } finally {
      await local.server.close();
    }
  });
});

describe("loopback binding", () => {
  it("accepts loopback spellings", () => {
    expect(normalizeLoopbackHost(undefined)).toBe("127.0.0.1");
    expect(normalizeLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeLoopbackHost("localhost")).toBe("127.0.0.1");
    expect(normalizeLoopbackHost("::1")).toBe("127.0.0.1");
  });

  it("rejects non-loopback explicit hosts", async () => {
    expect(() => normalizeLoopbackHost("0.0.0.0")).toThrow(/non-loopback/);
    expect(() => normalizeLoopbackHost("192.168.1.10")).toThrow(/non-loopback/);
    const server = createServer(new StubCore(), {
      host: "0.0.0.0",
      port: 0,
      logger: () => {},
      getConfig: () => makeConfig(),
    });
    await expect(server.listen()).rejects.toThrow(/non-loopback/);
    await server.close();
  });

  it("rejects a non-loopback host supplied by config", async () => {
    const config = makeConfig({
      server: { host: "0.0.0.0", port: 0, dashboard: true } as never,
    });
    const server = createServer(new StubCore(), {
      port: 0,
      logger: () => {},
      getConfig: () => config,
    });
    await expect(server.listen()).rejects.toThrow(/non-loopback/);
    await server.close();
  });
});
