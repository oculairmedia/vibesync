/**
 * EventBus — append-only pub/sub log for cross-layer observability.
 *
 * Layering invariant #3 (event bus is the universal observation
 * substrate): all cross-layer visibility flows through this. If layer A
 * needs to know what layer B did, B emits an event and A subscribes.
 * No direct status polling between layers. No reading another layer's
 * internal state.
 *
 * Two-tier design (mirrors Gas City):
 *   - **Persistent tier** — every emitted event is written to a
 *     newline-delimited JSON log at `.beads/events.jsonl`. Survives
 *     process restart, can be tailed with `cat`/`tail -f`, replayable.
 *   - **Live tier** — in-process subscribers receive events
 *     synchronously via callback registration. Used by the daemon, TUI,
 *     dashboards.
 *
 * Volume notes: a busy molecule emits ~10-50 events per turn (step
 * starts, message-delta samples, tool calls, step completions). The
 * file-backed log is fine at that rate; future scale-out moves the
 * persistent tier to a postgres/sqlite table or a real message queue.
 *
 * See vibesync-ds4.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * One observation event. All cross-layer signals use this shape.
 *
 * `layer` identifies who emitted (matches the src/orchestration/ subdir
 * names). `kind` is layer-specific; e.g. `runtime/session.started`,
 * `molecule/step.dispatched`, `formula/dispatch.requested`. Convention:
 * dot-separated, scoped under the layer name.
 *
 * `task_id` / `molecule_id` reference bead ids. Either may be present;
 * both may be present. `payload` is layer-specific structured data.
 */
export interface Event {
  readonly id: string;
  readonly ts: string;
  readonly layer:
    | 'runtime'
    | 'daemon'
    | 'formula'
    | 'dispatcher'
    | 'molecule'
    | 'health-patrol'
    | 'pm-agent';
  readonly kind: string;
  readonly task_id?: string;
  readonly molecule_id?: string;
  readonly teammate?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type EventInput = Omit<Event, 'id' | 'ts'>;

export type Subscriber = (event: Event) => void;

export interface EventBusConfig {
  /** Repo root that contains .beads/. Defaults to process.cwd(). */
  readonly beadsRoot?: string;
  /** Override the log file path (otherwise .beads/events.jsonl). */
  readonly logPath?: string;
  /** Disable file-backed persistence (e.g. for tests). */
  readonly noPersist?: boolean;
}

export class EventBus {
  private readonly logPath: string | null;
  private readonly subscribers = new Set<Subscriber>();

  constructor(cfg: EventBusConfig = {}) {
    if (cfg.noPersist) {
      this.logPath = null;
    } else {
      const root = cfg.beadsRoot ?? process.cwd();
      this.logPath = cfg.logPath ?? join(root, '.beads', 'events.jsonl');
      mkdirSync(dirname(this.logPath), { recursive: true });
    }
  }

  /**
   * Subscribe to events. Returns an unsubscribe function. Subscribers
   * are called synchronously in registration order — they MUST be fast
   * (or schedule async work themselves). A throwing subscriber is
   * caught and logged; it does not block other subscribers or stop
   * emission.
   */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Emit one event. Persists to the log (if configured) and notifies
   * all subscribers synchronously. Returns the fully-decorated Event
   * (with id + ts) for the caller's records.
   */
  emit(input: EventInput): Event {
    const event: Event = {
      ...input,
      id: randomUUID(),
      ts: new Date().toISOString(),
    };
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, JSON.stringify(event) + '\n');
      } catch (err) {
        // Persistence failure is non-fatal — emit-and-forget tier.
        // eslint-disable-next-line no-console
        console.warn(`[EventBus] persist failed: ${(err as Error).message}`);
      }
    }
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[EventBus] subscriber error: ${(err as Error).message}`);
      }
    }
    return event;
  }

  /** Number of active subscribers. Diagnostic only. */
  subscriberCount(): number {
    return this.subscribers.size;
  }
}
