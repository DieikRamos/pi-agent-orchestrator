import type {
  SSEEvent,
  SSEEventMap,
  SSEEventType,
  SSEListener,
} from "../types.js";

export const DEFAULT_REPLAY_LIMIT = 500;

export interface EventBusOptions {
  /** Persisted sequence number to continue from. */
  initialSeq?: number;
  clock?: () => Date;
  /** Maximum events retained for Last-Event-ID replay. */
  replayLimit?: number;
  /** Optional diagnostics hook; by default listener errors are swallowed. */
  onListenerError?: (error: unknown, event: SSEEvent) => void;
}

/**
 * Typed broker event bus.
 *
 * Sequence numbers are assigned here and are strictly increasing for the
 * lifetime of the bus. A bounded ring buffer lets SSE clients reconnect with
 * `Last-Event-ID` and catch up without forcing a full snapshot on every
 * transient disconnect.
 */
export class EventBus {
  private currentSeq: number;
  private readonly clock: () => Date;
  private readonly replayLimit: number;
  private readonly onListenerError?: (error: unknown, event: SSEEvent) => void;
  private readonly listeners = new Set<SSEListener>();
  private readonly buffer: SSEEvent[] = [];

  constructor(options: EventBusOptions = {}) {
    this.currentSeq = Math.max(0, Math.trunc(options.initialSeq ?? 0));
    this.clock = options.clock ?? (() => new Date());
    this.replayLimit = Math.max(1, Math.trunc(options.replayLimit ?? DEFAULT_REPLAY_LIMIT));
    if (options.onListenerError) this.onListenerError = options.onListenerError;
  }

  get seq(): number {
    return this.currentSeq;
  }

  /** Continue numbering from an externally loaded sequence (startup recovery). */
  setSeq(seq: number): void {
    this.currentSeq = Math.max(this.currentSeq, Math.max(0, Math.trunc(seq)));
  }

  /**
   * Publish one event. Every subscriber is isolated: a throwing listener does
   * not prevent other listeners from receiving the event or the sequence from
   * advancing.
   */
  emit<K extends SSEEventType>(
    type: K,
    data: SSEEventMap[K],
    at: string = this.clock().toISOString(),
  ): SSEEvent {
    this.currentSeq += 1;
    const event = {
      seq: this.currentSeq,
      at,
      type,
      data,
    } as SSEEvent;

    this.buffer.push(event);
    if (this.buffer.length > this.replayLimit) {
      this.buffer.splice(0, this.buffer.length - this.replayLimit);
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        if (this.onListenerError) {
          try {
            this.onListenerError(error, event);
          } catch {
            // Diagnostics must never break event delivery.
          }
        }
      }
    }
    return event;
  }

  subscribe(listener: SSEListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Events after `lastSeq` still retained in the ring. When no sequence is
   * provided the whole retained ring is returned.
   */
  replay(lastSeq?: number): SSEEvent[] {
    if (lastSeq === undefined) return [...this.buffer];
    return this.buffer.filter((event) => event.seq > lastSeq);
  }

  clearReplayBuffer(): void {
    this.buffer.length = 0;
  }
}
