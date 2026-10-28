import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ConfigError,
  computeConfigFingerprint,
  loadConfig,
  parseConfig,
  parseDuration,
  parseModelSpec,
} from "../src/config.js";

const minimal = {
  agents: {
    worker: {
      description: "Do the work",
      model: "anthropic/claude-sonnet-4-5",
    },
  },
};

describe("parseConfig", () => {
  it("applies all defaults for a minimal config", () => {
    const { config, configFingerprint } = parseConfig(minimal);
    expect(config.version).toBe(1);
    expect(config.server).toEqual({ host: "127.0.0.1", port: 0, dashboard: true });
    expect(config.defaults).toBeUndefined();
    expect(config.agents.worker).toEqual({
      role: "worker",
      description: "Do the work",
      model: "anthropic/claude-sonnet-4-5",
      replicas: 1,
    });
    expect(configFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(configFingerprint).toBe(computeConfigFingerprint(config));
  });

  it("normalizes server, role defaults and effort case", () => {
    const { config } = parseConfig({
      version: 1,
      server: { host: "localhost", port: 4321, dashboard: false, "x-note": true },
      defaults: { effort: "HIGH", replicas: 2, tools: ["read", "read", "bash"] },
      agents: {
        reviewer: {
          role: "reviewer",
          description: "Review work",
          model: "openai/gpt-5",
          effort: "Low",
          replicas: 3,
          cwd: "packages/app",
        },
      },
    });
    expect(config.server).toEqual({ host: "127.0.0.1", port: 4321, dashboard: false });
    expect(config.defaults).toEqual({
      effort: "high",
      replicas: 2,
      tools: ["read", "bash"],
    });
    expect(config.agents.reviewer).toMatchObject({
      role: "reviewer",
      effort: "low",
      replicas: 3,
      cwd: "packages/app",
      tools: ["read", "bash"],
    });
  });

  it("uses defaults.tools when an agent does not override them", () => {
    const { config } = parseConfig({
      defaults: { tools: ["read", "grep"] },
      agents: {
        a: { description: "A", model: "m" },
        b: { description: "B", model: "m", tools: ["bash"] },
      },
    });
    expect(config.agents.a?.tools).toEqual(["read", "grep"]);
    expect(config.agents.b?.tools).toEqual(["bash"]);
  });

  it("allows x-* annotation keys but rejects other unknown keys", () => {
    expect(() =>
      parseConfig({
        "x-owner": "team",
        agents: { a: { description: "A", model: "m", "x-note": "ok" } },
      }),
    ).not.toThrow();

    expect(() =>
      parseConfig({
        agents: { a: { description: "A", model: "m", temperature: 1 } },
      }),
    ).toThrow(/unknown key "temperature"/);
  });

  it("accepts only loopback server hosts", () => {
    expect(() =>
      parseConfig({ server: { host: "0.0.0.0" }, agents: minimal.agents }),
    ).toThrow(/only loopback is supported/);
  });

  it.each([
    [{ agents: {} }, /at least one agent role/],
    [{ agents: { a: { model: "m" } } }, /description: required/],
    [{ agents: { a: { description: "A" } } }, /model: required/],
    [
      { agents: { a: { description: "A", model: "m", replicas: 0 } } },
      /replicas must be between 1 and 16/,
    ],
    [
      { agents: { a: { description: "A", model: "m", replicas: 17 } } },
      /replicas must be between 1 and 16/,
    ],
    [
      { agents: { a: { description: "A", model: "m", effort: "turbo" } } },
      /invalid effort "turbo"/,
    ],
    [
      {
        agents: {
          a: { description: "A", model: "m" },
          b: { description: "B", model: "m", role: "a" },
        },
      },
      /duplicate role "a"/,
    ],
    [
      { agents: { a: { description: "A", model: "m", tools: ["read", ""] } } },
      /tools\[1\]: expected a non-empty string/,
    ],
    [
      { version: 2, agents: { a: { description: "A", model: "m" } } },
      /unsupported config version 2/,
    ],
  ])("rejects invalid config %#", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(message as RegExp);
  });

  it("reports multiple issues at once", () => {
    try {
      parseConfig({ agents: { a: { replicas: 0 } } });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
      expect(issues.join("\n")).toContain("agents.a.description");
      expect(issues.join("\n")).toContain("agents.a.model");
    }
  });


  it("normalizes recurring schedules and defaults", () => {
    const { config } = parseConfig({
      agents: {
        reviewer: { description: "Review changes", model: "m", replicas: 2 },
      },
      schedules: [
        {
          id: "regression-review",
          role: "reviewer",
          every: "15m",
          prompt: "Review changes added since the last check.\nReport regressions.",
          acceptance: "A concise report with file references.",
        },
        {
          id: "nightly-audit",
          role: "reviewer",
          title: "Nightly audit",
          every: "1d",
          prompt: "Audit the repository.",
          enabled: false,
          runOnStart: true,
          overlap: "queue",
        },
      ],
    });

    expect(config.schedules).toHaveLength(2);
    expect(config.schedules?.[0]).toMatchObject({
      id: "regression-review",
      role: "reviewer",
      title: "Review changes added since the last check.",
      every: "15m",
      everyMs: 900_000,
      enabled: true,
      runOnStart: false,
      overlap: "skip",
    });
    expect(config.schedules?.[1]).toMatchObject({
      id: "nightly-audit",
      title: "Nightly audit",
      everyMs: 86_400_000,
      enabled: false,
      runOnStart: true,
      overlap: "queue",
    });
  });

  it.each([
    [
      {
        agents: { a: { description: "A", model: "m" } },
        schedules: [{ id: "s", role: "missing", every: "10m", prompt: "p" }],
      },
      /unknown role "missing"/,
    ],
    [
      { agents: { a: { description: "A", model: "m" } }, schedules: [{ id: "s", role: "a", every: "10x", prompt: "p" }] },
      /invalid duration/,
    ],
    [
      { agents: { a: { description: "A", model: "m" } }, schedules: [{ id: "s", role: "a", every: "500ms", prompt: "p" }] },
      /at least 1000ms/,
    ],
    [
      {
        agents: { a: { description: "A", model: "m" } },
        schedules: [
          { id: "s", role: "a", every: "10m", prompt: "p" },
          { id: "s", role: "a", every: "10m", prompt: "q" },
        ],
      },
      /duplicate schedule id/,
    ],
    [
      { agents: { a: { description: "A", model: "m" } }, schedules: [{ id: "s", role: "a", every: "10m" }] },
      /prompt: required/,
    ],
    [
      { agents: { a: { description: "A", model: "m" } }, schedules: [{ id: "s", role: "a", every: "10m", prompt: "p", overlap: "replace" }] },
      /overlap: expected/,
    ],
  ])("rejects invalid schedule config %#", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(message as RegExp);
  });

  it("parses compact durations", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1.5m")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(() => parseDuration("5 minutes")).toThrow(/invalid duration/);
  });

  it("fingerprints are independent of YAML key order", () => {
    const a = parseConfig({
      agents: { a: { description: "A", model: "m", role: "a", replicas: 1 } },
    });
    const b = parseConfig({
      agents: { a: { replicas: 1, role: "a", model: "m", description: "A" } },
    });
    expect(a.configFingerprint).toBe(b.configFingerprint);
  });
});

describe("loadConfig", () => {
  it("loads .pi/agents.yml by default and resolves the path", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-orch-config-"));
    await writeFile(
      path.join(cwd, "agents.yml"),
      [
        "agents:",
        "  worker:",
        "    description: Work",
        "    model: test/model",
      ].join("\n"),
    );
    const loaded = await loadConfig({ cwd, path: "agents.yml" });
    expect(loaded.path).toBe(path.join(cwd, "agents.yml"));
    expect(loaded.config.agents.worker?.model).toBe("test/model");

  });

  it("gives an actionable error for a missing file", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-orch-config-"));
    await expect(loadConfig({ cwd })).rejects.toThrow(/config file not found.*\.pi\/agents\.yml/);
  });

  it("wraps YAML parse errors with the file path", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-orch-config-"));
    await writeFile(path.join(cwd, "agents.yml"), "agents: [unclosed");
    await expect(loadConfig({ cwd, path: "agents.yml" })).rejects.toThrow(
      /failed to parse YAML/,
    );
  });

  it("prefixes validation issues with the config path", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-orch-config-"));
    await writeFile(path.join(cwd, "agents.yml"), "agents:\n  a:\n    model: m\n");
    try {
      await loadConfig({ cwd, path: "agents.yml" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues[0]).toContain(path.join(cwd, "agents.yml"));
      expect(issues.join("\n")).toContain("description");
    }
  });
});

describe("parseModelSpec", () => {
  it("splits the first provider slash only", () => {
    expect(parseModelSpec("anthropic/claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(parseModelSpec("openrouter/anthropic/claude")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude",
    });
    expect(parseModelSpec("claude-sonnet-4-5")).toEqual({ model: "claude-sonnet-4-5" });
  });

  it("rejects empty and malformed specs", () => {
    expect(() => parseModelSpec("  ")).toThrow(/non-empty/);
    expect(() => parseModelSpec("/model")).toThrow(/invalid model spec/);
    expect(() => parseModelSpec("provider/")).toThrow(/invalid model spec/);
  });
});
