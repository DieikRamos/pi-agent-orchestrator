import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import {
  BrokerHttpError,
  BrokerTimeoutError,
  BrokerUnavailableError,
} from "../client/broker-client.js";
import type {
  AgentView,
  HealthView,
  ReviewDecision,
  ScheduleView,
  SubmitTaskInput,
  Task,
  TaskFilter,
  TaskView,
} from "../types.js";

export const TOOL_NAMES = [
  "agent_dispatch",
  "agent_wait",
  "agent_status",
  "agent_schedule",
  "agent_review",
  "agent_cancel",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Minimal broker surface used by the extension tools. */
export interface ToolBrokerClient {
  health(): Promise<HealthView>;
  submit(input: SubmitTaskInput & { clientRequestId?: string }): Promise<Task>;
  waitForReview(
    taskId: string,
    timeoutMs?: number,
    options?: { signal?: AbortSignal; pollIntervalMs?: number },
  ): Promise<Task>;
  review(taskId: string, decision: ReviewDecision, feedback?: string): Promise<Task>;
  cancel(taskId: string): Promise<Task>;
  listAgents(): Promise<AgentView[]>;
  listTasks(filter?: TaskFilter): Promise<TaskView[]>;
  getTask(taskId: string): Promise<TaskView>;
  listSchedules(): Promise<ScheduleView[]>;
  runSchedule(scheduleId: string): Promise<Task>;
  setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<ScheduleView>;
}

export interface ToolDependencies {
  getClient(cwd: string): ToolBrokerClient;
}

type ToolResult = AgentToolResult<unknown>;

function textResult(text: string, details: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function errorResult(text: string, details?: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: details ?? { error: text },
    isError: true,
  };
}

export function formatBrokerError(error: unknown): string {
  if (error instanceof BrokerUnavailableError) return error.message;
  if (error instanceof BrokerTimeoutError) return error.message;
  if (error instanceof BrokerHttpError) {
    return `Broker ${error.code} (HTTP ${error.status}): ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function taskSummary(task: TaskView, includeResult = true): string {
  const lines = [
    `Task ${task.id} [${task.status}] role=${task.role}${task.agentId ? ` agent=${task.agentId}` : ""}`,
    `Title: ${task.title}`,
    `Attempts: ${task.attempts}`,
  ];
  if (task.error) lines.push(`Error: ${task.error}`);
  if (task.review) {
    const feedback = task.review.feedback ? ` — ${task.review.feedback}` : "";
    lines.push(`Review: ${task.review.decision} at ${task.review.at}${feedback}`);
  }
  if (includeResult && task.result) {
    lines.push("Result:", truncate(task.result, 12_000));
  }
  const recent = task.logs.slice(-5);
  if (recent.length > 0) {
    lines.push("Latest activity:");
    for (const entry of recent) {
      lines.push(`- ${entry.at} ${entry.type}: ${truncate(entry.text, 300)}`);
    }
  }
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n... (${value.length - max} chars truncated)`;
}

function agentLine(agent: AgentView): string {
  const task = agent.currentTaskId ? ` task=${agent.currentTaskId}` : "";
  const action = agent.lastAction ? ` — ${agent.lastAction}` : "";
  const error = agent.error ? ` error=${agent.error}` : "";
  return `${agent.id} [${agent.status}] ${agent.model}${agent.effort ? ` effort=${agent.effort}` : ""}${task}${action}${error}`;
}

function scheduleLine(schedule: ScheduleView): string {
  const next = schedule.enabled ? `next=${schedule.nextRunAt}` : "disabled";
  const last = schedule.lastRunAt ? ` last=${schedule.lastRunAt}` : "";
  const task = schedule.lastTaskId
    ? ` task=${schedule.lastTaskId}${schedule.lastTaskStatus ? `[${schedule.lastTaskStatus}]` : ""}`
    : "";
  return `${schedule.id} role=${schedule.role} every=${schedule.every} overlap=${schedule.overlap} ${next}${last}${task} — ${schedule.title}`;
}

function defaultTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] ?? "Task";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function createToolDefinitions(deps: ToolDependencies) {
  const dispatch = {
    name: "agent_dispatch" as const,
    label: "Dispatch agent task",
    description:
      "Dispatch a task to one fixed agent role from .pi/agents.yml. The broker queues it until a replica of that role is idle. The replica is locked to this task from assignment through review: it will not accept another task until you call agent_review with decision=\"close\" (after which its context is reset) or decision=\"rework\" (which continues the same context with your feedback). Use agent_wait to wait for review, agent_status to inspect progress, and agent_cancel to abort. Returns the task id and assigned agent.",
    parameters: Type.Object({
      role: Type.String({
        minLength: 1,
        description: "Role name exactly as defined under agents in .pi/agents.yml.",
      }),
      prompt: Type.String({
        minLength: 1,
        description:
          "Complete work instructions for this task. The worker does not see your conversation; include all necessary context, files, and expected checks.",
      }),
      title: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Short task title shown in status and the dashboard. Defaults to the first prompt line.",
        }),
      ),
      acceptance: Type.Optional(
        Type.String({
          description: "Concrete acceptance criteria the worker should satisfy before reporting completion.",
        }),
      ),
      clientRequestId: Type.Optional(
        Type.String({
          description:
            "Optional idempotency/correlation id for your own bookkeeping, echoed to brokers that support it.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        role: string;
        prompt: string;
        title?: string;
        acceptance?: string;
        clientRequestId?: string;
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<ToolResult> {
      try {
        const client = deps.getClient(ctx.cwd);
        const input: SubmitTaskInput & { clientRequestId?: string } = {
          title: params.title?.trim() || defaultTitle(params.prompt),
          role: params.role,
          prompt: params.prompt,
        };
        if (params.acceptance !== undefined) input.acceptance = params.acceptance;
        if (params.clientRequestId !== undefined) input.clientRequestId = params.clientRequestId;
        const task = await client.submit(input);
        return textResult(
          `Dispatched task ${task.id} to role "${task.role}"${task.agentId ? ` (agent ${task.agentId})` : ""}; status=${task.status}. Use agent_wait ${task.id} or agent_status.`,
          { taskId: task.id, agentId: task.agentId, status: task.status, task },
        );
      } catch (error) {
        return errorResult(
          `agent_dispatch failed: ${formatBrokerError(error)} The broker was not started by this call. Run /agents start, then retry.`,
        );
      }
    },
  };

  const wait = {
    name: "agent_wait" as const,
    label: "Wait for agent review",
    description:
      "Wait (long-poll) until a dispatched task reaches awaiting_review and return its result, or until it fails/is cancelled/times out. Default timeout is 120000 ms (2 minutes); maximum is 600000 ms (10 minutes). This does not close the task: the replica stays locked until agent_review. Prefer waiting on a task id returned by agent_dispatch rather than dispatching duplicate work.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1, description: "Task id returned by agent_dispatch." }),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 600_000,
          description: "Maximum wait in milliseconds. Default 120000, maximum 600000.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { taskId: string; timeoutMs?: number },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<ToolResult> {
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 120_000, 0), 600_000);
      try {
        const client = deps.getClient(ctx.cwd);
        const task = await client.waitForReview(params.taskId, timeoutMs, {
          ...(signal ? { signal } : {}),
        });
        return textResult(taskSummary(task), { taskId: task.id, task });
      } catch (error) {
        const details: Record<string, unknown> = { taskId: params.taskId };
        if (error instanceof BrokerTimeoutError && error.task) details.task = error.task;
        if (error instanceof BrokerHttpError && error.details) details.brokerDetails = error.details;
        const suffix =
          error instanceof BrokerTimeoutError
            ? " The task is still running and remains locked to its agent. Check agent_status or the dashboard; do not dispatch duplicate work."
            : "";
        return errorResult(`agent_wait failed: ${formatBrokerError(error)}${suffix}`, details);
      }
    },
  };

  const status = {
    name: "agent_status" as const,
    label: "Agent orchestrator status",
    description:
      "Show the broker health, agent replicas (status, current locked task, last action), and tasks. Filter to one task with taskId or to one role with role. Use this before dispatching more work to see idle capacity and inspect tasks awaiting review.",
    parameters: Type.Object({
      taskId: Type.Optional(
        Type.String({ minLength: 1, description: "Return this task and its assigned agent." }),
      ),
      role: Type.Optional(
        Type.String({ minLength: 1, description: "Only show replicas and tasks for this role." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { taskId?: string; role?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<ToolResult> {
      try {
        const client = deps.getClient(ctx.cwd);
        const [health, allAgents] = await Promise.all([client.health(), client.listAgents()]);
        let agents = allAgents;
        let tasks: TaskView[];
        if (params.taskId) {
          const task = await client.getTask(params.taskId);
          tasks = [task];
          if (task.agentId) {
            agents = allAgents.filter(
              (agent) => agent.id === task.agentId || (!params.role || agent.role === params.role),
            );
            if (!agents.some((agent) => agent.id === task.agentId)) agents = allAgents;
          }
        } else if (params.role) {
          agents = allAgents.filter((agent) => agent.role === params.role);
          tasks = await client.listTasks({ role: params.role });
        } else {
          tasks = await client.listTasks();
        }
        if (params.role && params.taskId) {
          agents = agents.filter((agent) => agent.role === params.role || agent.id === tasks[0]?.agentId);
        }

        const lines = [
          `Broker: ${health.ok ? "healthy" : "unhealthy"} pid=${health.pid} uptime=${Math.round(health.uptimeMs / 1000)}s`,
          `Agents: total=${health.agents.total} idle=${health.agents.idle} busy=${health.agents.busy} awaitingReview=${health.agents.awaitingReview} error=${health.agents.error}`,
          `Tasks: queued=${health.tasks.queued} running=${health.tasks.running} awaitingReview=${health.tasks.awaitingReview} closed=${health.tasks.closed} failed=${health.tasks.failed} cancelled=${health.tasks.cancelled}`,
          "Replicas:",
          ...(agents.length > 0 ? agents.map((agent) => `- ${agentLine(agent)}`) : ["- none"]),
          "Tasks:",
          ...(tasks.length > 0
            ? tasks.slice(-20).map((task) => `- ${task.id} [${task.status}] role=${task.role}${task.agentId ? ` agent=${task.agentId}` : ""} ${task.title}`)
            : ["- none"]),
        ];
        return textResult(lines.join("\n"), { health, agents, tasks });
      } catch (error) {
        return errorResult(
          `agent_status failed: ${formatBrokerError(error)} Run /agents start if the broker is not running.`,
        );
      }
    },
  };

  const schedule = {
    name: "agent_schedule" as const,
    label: "List or run recurring agent schedules",
    description:
      "Inspect or control recurring schedules defined under `schedules` in .pi/agents.yml. Use action=\"list\" to see next/last run and the latest task. Use action=\"run\" with a scheduleId to trigger one occurrence immediately (the task still goes through the normal queue and review lock). Use enable/disable to toggle future occurrences without reloading the config. Disabling a schedule does not cancel its existing task.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("run"),
          Type.Literal("enable"),
          Type.Literal("disable"),
        ],
        { description: "Operation to perform. Defaults to list." },
      ),
      scheduleId: Type.Optional(
        Type.String({ minLength: 1, description: "Schedule id for run/enable/disable." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { action?: "list" | "run" | "enable" | "disable"; scheduleId?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<ToolResult> {
      const action = params.action ?? "list";
      try {
        const client = deps.getClient(ctx.cwd);
        if (action === "list") {
          const schedules = await client.listSchedules();
          const lines = [
            `Schedules: ${schedules.length}`,
            ...(schedules.length > 0 ? schedules.map((entry) => `- ${scheduleLine(entry)}`) : ["- none"]),
          ];
          return textResult(lines.join("\n"), { schedules });
        }
        const scheduleId = params.scheduleId?.trim();
        if (!scheduleId) return errorResult(`agent_schedule ${action} requires scheduleId.`);
        if (action === "run") {
          const task = await client.runSchedule(scheduleId);
          return textResult(
            `Triggered schedule ${scheduleId}; task ${task.id} [${task.status}] role=${task.role}. Use agent_wait ${task.id} to wait for review.`,
            { scheduleId, taskId: task.id, task },
          );
        }
        const updated = await client.setScheduleEnabled(scheduleId, action === "enable");
        return textResult(
          `Schedule ${updated.id} is now ${updated.enabled ? "enabled" : "disabled"}; next=${updated.nextRunAt}.`,
          { schedule: updated },
        );
      } catch (error) {
        return errorResult(`agent_schedule failed: ${formatBrokerError(error)}`);
      }
    },
  };

  const review = {
    name: "agent_review" as const,
    label: "Review agent result",
    description:
      "Review a task that is awaiting_review. decision=\"close\" accepts the result, releases the agent lock, and resets the worker context before it takes another task. decision=\"rework\" requires feedback and continues the SAME worker context for another attempt; the replica stays locked. Closing or reworking is mandatory before that replica can run other work.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1, description: "Task id awaiting review." }),
      decision: Type.Union([Type.Literal("close"), Type.Literal("rework")], {
        description: "close accepts and releases; rework continues the same context with feedback.",
      }),
      feedback: Type.Optional(
        Type.String({
          description: "Required for rework; ignored for close. Be specific about what to change.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { taskId: string; decision: ReviewDecision; feedback?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<ToolResult> {
      if (params.decision === "rework" && !params.feedback?.trim()) {
        return errorResult("agent_review failed: rework requires non-empty feedback.");
      }
      try {
        const client = deps.getClient(ctx.cwd);
        const task = await client.review(
          params.taskId,
          params.decision,
          params.decision === "rework" ? params.feedback : undefined,
        );
        const next =
          task.status === "closed"
            ? "The agent lock was released and its context will be reset before the next task."
            : task.status === "running"
              ? "The worker continues in the same context with your feedback and still holds the lock."
              : `Task status is now ${task.status}.`;
        return textResult(`${taskSummary(task)}\n${next}`, { taskId: task.id, task });
      } catch (error) {
        return errorResult(`agent_review failed: ${formatBrokerError(error)}`);
      }
    },
  };

  const cancel = {
    name: "agent_cancel" as const,
    label: "Cancel agent task",
    description:
      "Cancel a non-terminal task. The broker aborts/stops the worker as needed, releases the agent lock, and resets or replaces the worker before reuse. Cancelling a task awaiting review rejects its result; terminal tasks cannot be cancelled.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1, description: "Task id to cancel." }),
    }),
    async execute(
      _toolCallId: string,
      params: { taskId: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ): Promise<ToolResult> {
      try {
        const client = deps.getClient(ctx.cwd);
        const task = await client.cancel(params.taskId);
        return textResult(taskSummary(task, false), { taskId: task.id, task });
      } catch (error) {
        return errorResult(`agent_cancel failed: ${formatBrokerError(error)}`);
      }
    },
  };

  return [dispatch, wait, status, schedule, review, cancel];
}

/** Register all orchestrator tools with the Pi extension API. */
export function registerTools(pi: Pick<ExtensionAPI, "registerTool">, deps: ToolDependencies): void {
  for (const tool of createToolDefinitions(deps)) {
    pi.registerTool(tool as Parameters<ExtensionAPI["registerTool"]>[0]);
  }
}
