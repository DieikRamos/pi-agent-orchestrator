import { afterEach, describe, expect, it } from "vitest";

import extension from "../../src/extension.js";
import { TOOL_NAMES } from "../../src/extension/tools.js";
import { COMMAND_NAME } from "../../src/extension/commands.js";
import { WORKER_ENV } from "../../src/extension/autostart.js";

interface MockPi {
  tools: string[];
  commands: string[];
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  registerTool(tool: { name: string }): void;
  registerCommand(name: string): void;
  on(event: string, handler: (...args: unknown[]) => unknown): () => void;
}

function mockPi(): MockPi {
  return {
    tools: [],
    commands: [],
    handlers: new Map(),
    registerTool(tool) {
      this.tools.push(tool.name);
    },
    registerCommand(name) {
      this.commands.push(name);
    },
    on(event, handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return () => {};
    },
  };
}

afterEach(() => {
  delete process.env[WORKER_ENV];
});

describe("extension factory", () => {
  it("registers tools, commands, and session lifecycle handlers", () => {
    const pi = mockPi();
    extension(pi as never);
    expect(pi.tools).toEqual([...TOOL_NAMES]);
    expect(pi.commands).toEqual([COMMAND_NAME]);
    expect(pi.handlers.get("session_start")).toHaveLength(1);
    expect(pi.handlers.get("session_shutdown")).toHaveLength(1);
  });

  it("registers nothing inside a broker worker process", () => {
    process.env[WORKER_ENV] = "1";
    const pi = mockPi();
    extension(pi as never);
    expect(pi.tools).toEqual([]);
    expect(pi.commands).toEqual([]);
    expect(pi.handlers.size).toBe(0);
  });
});
