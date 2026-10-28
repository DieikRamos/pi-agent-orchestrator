import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  BrokerHttpError,
  BrokerTimeoutError,
  BrokerUnavailableError,
  brokerLogPath,
} from "../client/broker-client.js";
import type { AgentView, HealthView, OrchestratorConfig, TaskView } from "../types.js";
import type { ToolBrokerClient } from "./tools.js";
import type { EnsureBrokerResult } from "./autostart.js";

export const COMMAND_NAME = "agents";

export interface CommandBrokerClient extends ToolBrokerClient {
  readonly baseUrl: string;
  reload(): Promise<unknown>;
  shutdown(): Promise<{ ok: boolean }>;
}

export interface CommandContext {
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface CommandDependencies {
  getClient(cwd: string): CommandBrokerClient;
  ensureBroker(cwd: string): Promise<EnsureBrokerResult>;
  readLog(cwd: string, lines?: number): Promise<string>;
  openUrl(url: string): void;
}

function formatError(error: unknown): string {
  if (error instanceof BrokerUnavailableError) return error.message;
  if (error instanceof BrokerTimeoutError) return error.message;
  if (error instanceof BrokerHttpError) {
    return `Broker ${error.code} (HTTP ${error.status}): ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatStatus(
  health: HealthView,
  agents: AgentView[],
  tasks: TaskView[],
): string {
  const lines = [
    `Broker ${health.ok ? "healthy" : "unhealthy"} · pid ${health.pid} · uptime ${Math.round(health.uptimeMs / 1000)}s`,
    `Agents ${health.agents.total}: ${health.agents.idle} idle, ${health.agents.busy} busy, ${health.agents.awaitingReview} awaiting review, ${health.agents.error} error`,
    `Tasks: ${health.tasks.queued} queued, ${health.tasks.running} running, ${health.tasks.awaitingReview} awaiting review, ${health.tasks.closed} closed, ${health.tasks.failed} failed, ${health.tasks.cancelled} cancelled`,
  ];
  if (agents.length === 0) {
    lines.push("No replicas.");
  } else {
    lines.push("Replicas:");
    for (const agent of agents) {
      const locked = agent.currentTaskId ? ` task ${agent.currentTaskId}` : "";
      const action = agent.lastAction ? ` · ${agent.lastAction}` : "";
      const error = agent.error ? ` · error: ${agent.error}` : "";
      lines.push(`  ${agent.id} [${agent.status}]${locked}${action}${error}`);
    }
  }
  const open = tasks.filter(
    (task) => task.status !== "closed" && task.status !== "failed" && task.status !== "cancelled",
  );
  if (open.length > 0) {
    lines.push("Open tasks:");
    for (const task of open.slice(-12)) {
      const agent = task.agentId ? ` · ${task.agentId}` : "";
      lines.push(`  ${task.id} [${task.status}] ${task.role}${agent} · ${task.title}`);
    }
  }
  return lines.join("\n");
}

export async function readBrokerLog(cwd: string, lines = 40): Promise<string> {
  const logPath = brokerLogPath(cwd);
  let source: string;
  try {
    source = await readFile(logPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `No broker log at ${logPath} (the broker has not started yet).`;
    throw error;
  }
  const all = source.split(/\r?\n/);
  const tail = all.slice(Math.max(0, all.length - Math.max(1, lines)));
  return `Log: ${logPath}\n${tail.join("\n")}`;
}

/** Best-effort browser launch. Never fails the command. */
export function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on?.("error", () => {
      // The URL is also printed by the command, so opening is optional.
    });
    child.unref();
  } catch {
    // Ignore: the dashboard URL is printed either way.
  }
}

function extractConfig(value: unknown): OrchestratorConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.agents && typeof record.agents === "object") {
    return record as unknown as OrchestratorConfig;
  }
  if (record.config && typeof record.config === "object") {
    const nested = record.config as Record<string, unknown>;
    if (nested.agents && typeof nested.agents === "object") {
      return nested as unknown as OrchestratorConfig;
    }
  }
  return undefined;
}

const USAGE =
  "Usage: /agents [status|schedules|run <id>|enable <id>|disable <id>|dashboard|start|stop|reload|logs] — status is the default.";

export async function handleAgentsCommand(
  args: string,
  ctx: CommandContext,
  deps: CommandDependencies,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = (tokens[0] ?? "status").toLowerCase();

  try {
    switch (subcommand) {
      case "schedules": {
        const client = deps.getClient(ctx.cwd);
        const schedules = await client.listSchedules();
        const lines = [
          `Schedules: ${schedules.length}`,
          ...(schedules.length > 0
            ? schedules.map((schedule) => {
                const state = schedule.enabled ? `next ${schedule.nextRunAt}` : "disabled";
                const last = schedule.lastRunAt ? ` · last ${schedule.lastRunAt}` : "";
                const task = schedule.lastTaskId
                  ? ` · task ${schedule.lastTaskId}${schedule.lastTaskStatus ? ` [${schedule.lastTaskStatus}]` : ""}`
                  : "";
                return `  ${schedule.id} · ${schedule.role} · every ${schedule.every} · overlap ${schedule.overlap} · ${state}${last}${task} · ${schedule.title}`;
              })
            : ["  none"]),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      case "run": {
        const scheduleId = tokens[1];
        if (!scheduleId) {
          ctx.ui.notify("Usage: /agents run <schedule-id>", "warning");
          return;
        }
        const client = deps.getClient(ctx.cwd);
        const task = await client.runSchedule(scheduleId);
        ctx.ui.notify(
          `Triggered schedule ${scheduleId}: task ${task.id} [${task.status}] role=${task.role}.`,
          "info",
        );
        return;
      }
      case "enable":
      case "disable": {
        const scheduleId = tokens[1];
        if (!scheduleId) {
          ctx.ui.notify(`Usage: /agents ${subcommand} <schedule-id>`, "warning");
          return;
        }
        const client = deps.getClient(ctx.cwd);
        const schedule = await client.setScheduleEnabled(scheduleId, subcommand === "enable");
        ctx.ui.notify(
          `Schedule ${schedule.id} is now ${schedule.enabled ? "enabled" : "disabled"}; next=${schedule.nextRunAt}.`,
          "info",
        );
        return;
      }
      case "status": {
        const client = deps.getClient(ctx.cwd);
        const [health, agents, tasks] = await Promise.all([
          client.health(),
          client.listAgents(),
          client.listTasks(),
        ]);
        ctx.ui.notify(formatStatus(health, agents, tasks), "info");
        return;
      }
      case "dashboard": {
        const result = await deps.ensureBroker(ctx.cwd);
        if (!result.url) {
          ctx.ui.notify("The broker did not report a dashboard URL.", "warning");
          return;
        }
        deps.openUrl(result.url);
        ctx.ui.notify(`Dashboard: ${result.url}`, "info");
        return;
      }
      case "start": {
        const result = await deps.ensureBroker(ctx.cwd);
        if (result.skipped) {
          ctx.ui.notify(result.reason ?? "Broker autostart skipped.", "warning");
          return;
        }
        const verb = result.reused ? "already running" : "started";
        ctx.ui.notify(`Agent orchestrator broker ${verb} at ${result.url ?? "an unknown URL"}.`, "info");
        return;
      }
      case "stop": {
        const client = deps.getClient(ctx.cwd);
        try {
          await client.shutdown();
          ctx.ui.notify("Agent orchestrator broker is shutting down.", "info");
        } catch (error) {
          if (error instanceof BrokerUnavailableError) {
            ctx.ui.notify(`Broker is not running. ${error.message}`, "warning");
          } else {
            throw error;
          }
        }
        return;
      }
      case "reload": {
        const client = deps.getClient(ctx.cwd);
        const response = await client.reload();
        const config = extractConfig(response);
        const roles = config ? Object.keys(config.agents) : [];
        ctx.ui.notify(
          roles.length > 0
            ? `Reloaded config: ${roles.length} role(s): ${roles.join(", ")}.`
            : "Reloaded config.",
          "info",
        );
        return;
      }
      case "logs": {
        const requested = Number.parseInt(tokens[1] ?? "40", 10);
        const lines = Number.isFinite(requested)
          ? Math.min(Math.max(requested, 1), 500)
          : 40;
        ctx.ui.notify(await deps.readLog(ctx.cwd, lines), "info");
        return;
      }
      default:
        ctx.ui.notify(`Unknown /agents subcommand "${subcommand}". ${USAGE}`, "warning");
    }
  } catch (error) {
    ctx.ui.notify(`/agents ${subcommand} failed: ${formatError(error)}`, "error");
  }
}

/** Register the /agents command with the Pi extension API. */
export function registerCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  deps: CommandDependencies,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Manage the local agent orchestrator (status, schedules, run, enable, disable, dashboard, start, stop, reload, logs)",
    getArgumentCompletions: (prefix: string) => {
      const options = [
        "status",
        "schedules",
        "run",
        "enable",
        "disable",
        "dashboard",
        "start",
        "stop",
        "reload",
        "logs",
      ];
      return options
        .filter((option) => option.startsWith(prefix.trim()))
        .map((option) => ({ label: option, value: option }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleAgentsCommand(args, ctx, deps);
    },
  });
}
