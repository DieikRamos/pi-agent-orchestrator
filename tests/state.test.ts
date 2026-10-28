import { describe, expect, it } from "vitest";

import {
  AgentLockError,
  TASK_TRANSITIONS,
  TaskTransitionError,
  assertAgentTaskLock,
  assertTaskTransition,
  canTransitionTask,
  isTerminalTaskStatus,
  taskHoldsAgentLock,
} from "../src/state.js";
import type { AgentRuntime, Task, TaskStatus } from "../src/types.js";

describe("task state machine", () => {
  it("supports the happy path and rework", () => {
    const path: TaskStatus[] = [
      "queued",
      "assigned",
      "running",
      "awaiting_review",
      "running",
      "awaiting_review",
      "closed",
    ];
    for (let index = 1; index < path.length; index += 1) {
      expect(canTransitionTask(path[index - 1]!, path[index]!)).toBe(true);
      expect(() => assertTaskTransition(path[index - 1]!, path[index]!)).not.toThrow();
    }
  });

  it("rejects rework after close and skipping assigned", () => {
    expect(canTransitionTask("closed", "running")).toBe(false);
    expect(canTransitionTask("awaiting_review", "closed")).toBe(true);
    expect(canTransitionTask("queued", "running")).toBe(false);
    expect(() => assertTaskTransition("queued", "running")).toThrow(TaskTransitionError);
  });

  it("allows failure/cancel release from non-terminal states", () => {
    for (const status of ["queued", "assigned", "running", "awaiting_review"] as const) {
      expect(TASK_TRANSITIONS[status]).toContain("cancelled");
      expect(TASK_TRANSITIONS[status]).toContain("failed");
    }
  });

  it("marks closed/failed/cancelled terminal", () => {
    expect(isTerminalTaskStatus("closed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
    expect(isTerminalTaskStatus("awaiting_review")).toBe(false);
    expect(TASK_TRANSITIONS.closed).toEqual([]);
    expect(TASK_TRANSITIONS.failed).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe("agent lock invariant", () => {
  it("holds the replica from assignment through review", () => {
    expect(taskHoldsAgentLock("assigned")).toBe(true);
    expect(taskHoldsAgentLock("running")).toBe(true);
    expect(taskHoldsAgentLock("awaiting_review")).toBe(true);
    expect(taskHoldsAgentLock("queued")).toBe(false);
    expect(taskHoldsAgentLock("closed")).toBe(false);
    expect(taskHoldsAgentLock("failed")).toBe(false);
    expect(taskHoldsAgentLock("cancelled")).toBe(false);
  });

  it("accepts the owning task and rejects a second task", () => {
    const agent = { id: "dev#1", currentTaskId: "t1" } as AgentRuntime;
    expect(() => assertAgentTaskLock(agent, { id: "t1", status: "running" })).not.toThrow();
    expect(() =>
      assertAgentTaskLock(agent, { id: "t2", status: "queued" }),
    ).toThrow(AgentLockError);
    expect(() =>
      assertAgentTaskLock(agent, { id: "t2", status: "assigned" }),
    ).toThrow(/locked to task t1/);
  });

  it("requires a matching lock for a locking task", () => {
    const agent = { id: "dev#1" } as AgentRuntime;
    expect(() => assertAgentTaskLock(agent, { id: "t1", status: "queued" })).not.toThrow();
    expect(() => assertAgentTaskLock(agent, { id: "t1", status: "assigned" })).toThrow(
      /cannot be attached/,
    );
  });

  it("allows an idle replica to take a task", () => {
    const agent = { id: "dev#2", status: "idle" } as AgentRuntime;
    const task = { id: "t3", status: "queued" } as Task;
    expect(() => assertAgentTaskLock(agent, task)).not.toThrow();
  });
});
