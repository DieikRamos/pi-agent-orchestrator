import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../../src/broker/event-bus.js";
import type { SSEEvent } from "../../src/types.js";

const clock = () => new Date("2026-03-04T05:06:07.000Z");

const agent = {
  id: "dev#1",
  role: "dev",
  replica: 1,
  model: "m",
  status: "idle" as const,
};

describe("EventBus", () => {
  it("assigns monotonically increasing sequence numbers from the initial seq", () => {
    const bus = new EventBus({ initialSeq: 4, clock });
    const first = bus.emit("agent.updated", { agent });
    const second = bus.emit("task.log", {
      taskId: "t1",
      entry: { at: "2026-03-04T05:06:07.000Z", type: "text", text: "hello" },
    });
    expect(first.seq).toBe(5);
    expect(second.seq).toBe(6);
    expect(bus.seq).toBe(6);
    expect(first.at).toBe("2026-03-04T05:06:07.000Z");
  });

  it("never moves the sequence backwards when recovering a lower value", () => {
    const bus = new EventBus({ initialSeq: 10, clock });
    bus.setSeq(3);
    expect(bus.seq).toBe(10);
    expect(bus.emit("agent.updated", { agent }).seq).toBe(11);
  });

  it("isolates throwing listeners and continues delivery", () => {
    const errors: unknown[] = [];
    const bus = new EventBus({
      clock,
      onListenerError: (error) => errors.push(error),
    });
    const received: SSEEvent[] = [];
    bus.subscribe(() => {
      throw new Error("listener boom");
    });
    const unsubscribe = bus.subscribe((event) => received.push(event));

    expect(() => bus.emit("agent.updated", { agent })).not.toThrow();
    expect(received).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("listener boom");

    unsubscribe();
    bus.emit("agent.updated", { agent });
    expect(received).toHaveLength(1);
  });

  it("replays events after Last-Event-ID from a bounded ring", () => {
    const bus = new EventBus({ initialSeq: 100, replayLimit: 3, clock });
    for (let index = 0; index < 5; index += 1) {
      bus.emit("agent.updated", { agent });
    }
    expect(bus.replay().map((event) => event.seq)).toEqual([103, 104, 105]);
    expect(bus.replay(103).map((event) => event.seq)).toEqual([104, 105]);
    expect(bus.replay(104).map((event) => event.seq)).toEqual([105]);
    expect(bus.replay(105)).toEqual([]);
  });
});
