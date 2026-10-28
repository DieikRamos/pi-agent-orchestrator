import { access } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CONFIG_PATH } from "./config.js";
import { BrokerClient } from "./client/broker-client.js";
import { WORKER_ENV, ensureBroker, type EnsureBrokerResult } from "./extension/autostart.js";
import {
  handleAgentsCommand,
  openInBrowser,
  readBrokerLog,
  registerCommands,
} from "./extension/commands.js";
import { registerTools } from "./extension/tools.js";

const STATUS_KEY = "agent-orchestrator";

function configPathFor(cwd: string): string {
  return path.resolve(cwd, DEFAULT_CONFIG_PATH);
}

async function configExists(cwd: string): Promise<boolean> {
  try {
    await access(configPathFor(cwd));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pi extension entry point.
 *
 * The worker processes spawned by the broker load Pi as well. They must never
 * register orchestrator tools or start another broker, so the worker guard
 * returns before doing any registration. Sessions share one detached broker;
 * session shutdown only drops local resources and never kills that daemon.
 */
export default function piAgentOrchestrator(pi: ExtensionAPI): void {
  if (process.env[WORKER_ENV] === "1") return;

  const clients = new Map<string, BrokerClient>();
  const getClient = (cwd: string): BrokerClient => {
    const key = path.resolve(cwd);
    let client = clients.get(key);
    if (!client) {
      client = new BrokerClient({ cwd: key });
      clients.set(key, client);
    }
    return client;
  };

  const ensureForProject = (cwd: string): Promise<EnsureBrokerResult> =>
    ensureBroker({ cwd, configPath: configPathFor(cwd) });

  registerTools(pi, { getClient });
  registerCommands(pi, {
    getClient,
    ensureBroker: ensureForProject,
    readLog: readBrokerLog,
    openUrl: openInBrowser,
  });

  pi.on("session_start", (_event, ctx) => {
    // Never start a broker recursively from a worker process.
    if (process.env[WORKER_ENV] === "1") return;
    void (async () => {
      try {
        if (!(await configExists(ctx.cwd))) {
          ctx.ui.setStatus(STATUS_KEY, "no .pi/agents.yml");
          return;
        }
        ctx.ui.setStatus(STATUS_KEY, "starting broker...");
        const result = await ensureForProject(ctx.cwd);
        if (result.skipped) {
          ctx.ui.setStatus(STATUS_KEY, undefined);
          return;
        }
        ctx.ui.setStatus(
          STATUS_KEY,
          result.reused ? "broker ready" : "broker started",
        );
      } catch (error) {
        // Autostart is best-effort: tools still return actionable errors.
        ctx.ui.setStatus(STATUS_KEY, "broker unavailable");
        if (ctx.mode === "tui") {
          ctx.ui.notify(
            `Agent orchestrator broker did not start: ${(error as Error).message}`,
            "warning",
          );
        }
      }
    })();
  });

  pi.on("session_shutdown", () => {
    // Timers/listeners would be cleared here. The broker is shared by every
    // Pi session in the project, so shutdown must never stop it.
    clients.clear();
  });
}

// Re-exported for programmatic users and tests.
export { handleAgentsCommand };
