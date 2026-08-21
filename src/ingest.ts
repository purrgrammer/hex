/**
 * Hearing, separated from acting.
 *
 * Everything a transport hears becomes ONE shape — a `CanonicalEvent` — and
 * lands in a sqlite row before any downstream code sees it. That row is the
 * handover: what arrived is durable whether or not the turn that answers it
 * survives, and each (transport, event id) enqueues at most once no matter how
 * many relays serve it or how often a restart re-reads its inbox.
 *
 * The taxonomy is CLOSED and versioned. A row naming a type this build does not
 * know is ignored with one log line rather than guessed at — a queue is read by
 * versions that did not write it, and the alternative to ignoring is a newer
 * hex's events being mishandled by an older one.
 */

import type { SessionControl } from "./nostr/decode-control.js";
import type { HexStore, QueuedInbound } from "./store.js";
import type { Inbound, TransportName } from "./transports/types.js";

/**
 * What can arrive.
 *
 * `timer` has no producer yet. It exists because proactivity — an agent that
 * speaks first — has to arrive as another ingestor source feeding this same
 * queue and the same policy, not as a parallel path beside it. Reserving the
 * name now is what makes that a producer rather than a refactor.
 */
export type HexEventType =
  "message" | "reaction" | "room-joined" | "room-left" | "control" | "timer";

const HEX_EVENT_TYPES: readonly string[] = [
  "message",
  "reaction",
  "room-joined",
  "room-left",
  "control",
  "timer",
];

/** The taxonomy's version, written on every row. */
export const HEX_EVENT_VERSION = 1;

/**
 * Where an event came from, in fields every transport can answer.
 *
 * The whole route, and nothing protocol-specific: this is the vocabulary the
 * policy layer matches on, so anything that only one transport can fill in
 * would make a rule that only works for one transport.
 */
export interface EventRoute {
  transport: TransportName;
  relay?: string;
  /** The room, or the peer's pubkey for a private conversation. */
  room: string;
  /** Who spoke, or whose instruction this is. */
  peer: string;
  /** The exchange this belongs to, when the protocol threads. */
  thread?: string;
}

/** A message's canonical fields. No transport payloads, ever. */
export interface MessagePayload {
  text: string;
  /** Set by the TRANSPORT, which is the only layer that knows the tag shape. */
  addressesSelf: boolean;
  replyToId?: string;
}

/** A control event's canonical fields: the instruction, already authorised. */
export interface ControlPayload {
  instruction: SessionControl;
}

export interface CanonicalEvent {
  v: typeof HEX_EVENT_VERSION;
  type: HexEventType;
  /**
   * The RUMOR id for nip-17 and Concord, the event id for nip-29.
   *
   * A wrap is a different envelope on every relay and one rumor gets several,
   * so a wrap id counts one message as many. This is the identity the dedupe
   * is keyed on.
   */
  id: string;
  route: EventRoute;
  /** Author-claimed, in unix seconds. Never trusted as a clock. */
  createdAt: number;
  /** When this process heard it. */
  observedAt: number;
  payload: unknown;
}

/** `type` from a stored row, if this build knows it. */
export function knownEventType(type: string): HexEventType | undefined {
  return HEX_EVENT_TYPES.includes(type) ? (type as HexEventType) : undefined;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** A room message, flattened to what any policy can reason about. */
export function messageEvent(
  inbound: Inbound,
  observedAt = now(),
): CanonicalEvent {
  const payload: MessagePayload = {
    text: inbound.text,
    addressesSelf: inbound.addressesSelf,
    replyToId: inbound.replyToId,
  };
  return {
    v: HEX_EVENT_VERSION,
    type: "message",
    id: inbound.id,
    route: {
      transport: inbound.room.transport,
      relay: inbound.room.relay,
      room: inbound.room.id,
      peer: inbound.author,
      thread: inbound.replyToId,
    },
    createdAt: inbound.createdAt,
    observedAt,
    payload,
  };
}

/**
 * An operator's instruction.
 *
 * Its route names the session rather than a room: a control arrives over the
 * private channel and is about a run, and the session is what serialises it
 * against the messages of the same conversation later.
 */
export function controlEvent(
  control: SessionControl,
  observedAt = now(),
): CanonicalEvent {
  const payload: ControlPayload = { instruction: control };
  return {
    v: HEX_EVENT_VERSION,
    type: "control",
    id: control.id,
    route: {
      transport: "nip-17",
      room: control.session,
      peer: control.operator,
    },
    createdAt: observedAt,
    observedAt,
    payload,
  };
}

/** One queue row, ready to act on, with the type this build recognises. */
export interface QueuedEvent {
  seq: number;
  type: HexEventType;
  event: QueuedInbound;
  /**
   * The transport's own object, when this row was enqueued by this process.
   *
   * A `CanonicalEvent` is deliberately not enough to answer with — replying
   * needs the raw event and the room the transport built. So the live path
   * carries it alongside, and a row with no carrier (one a previous run left
   * behind) is not dispatchable as a message. That is what makes crash
   * redelivery the runner's problem rather than a surprise here.
   */
  carrier?: Inbound;
}

export interface IngestorOptions {
  store: HexStore;
  /**
   * Act on one event. Settles the row itself, via `finish` — a dispatch that
   * starts a turn cannot know its outcome yet.
   */
  dispatch: (queued: QueuedEvent) => void;
  log?: (line: string) => void;
  /**
   * How often to look for rows nothing nudged about. A backstop only: the live
   * path drains synchronously on accept.
   */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 5_000;

export class Ingestor {
  /** Rows handed to `dispatch` and not yet settled. Never dispatched twice. */
  private readonly inFlight = new Set<number>();
  private readonly carriers = new Map<number, Inbound>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: IngestorOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  /**
   * Enqueue a message and drain.
   *
   * Returns the seq, or undefined when it was a duplicate — which is silent on
   * purpose: four relays serving one wrap is the normal case, not an event.
   */
  accept(inbound: Inbound, observedAt?: number): number | undefined {
    const event = messageEvent(inbound, observedAt);
    const seq = this.options.store.enqueueInbound(event);
    if (seq === undefined) return undefined;
    this.carriers.set(seq, inbound);
    this.drain();
    return seq;
  }

  /** Enqueue an already-authorised control event and drain. */
  acceptControl(
    control: SessionControl,
    observedAt?: number,
  ): number | undefined {
    const seq = this.options.store.enqueueInbound(
      controlEvent(control, observedAt),
    );
    if (seq === undefined) return undefined;
    this.drain();
    return seq;
  }

  /**
   * Start draining, and retire what the last run left behind.
   *
   * A pending message from a dead process is dropped rather than re-run:
   * nobody is waiting for that answer, it costs money, and redelivering into a
   * writer that has not been fenced is the duplicate-publish bug. A pending
   * CONTROL is redelivered, because a relay used to redeliver it and the
   * `obeyed` ledger makes a second delivery a no-op — dropping it would lose a
   * stop button pressed while the runtime was down.
   */
  start(): void {
    for (const row of this.options.store.pendingInbound()) {
      if (row.type === "control") continue;
      this.log(
        `[hex] queued ${row.type} ${row.seq} was left behind by an earlier run — dropped`,
      );
      this.options.store.finishInbound(row.seq, "dropped:restart");
    }
    this.drain();
    this.timer = setInterval(
      () => this.drain(),
      this.options.pollMs ?? DEFAULT_POLL_MS,
    );
    // A backstop must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  /** Hand every pending row to `dispatch`, in arrival order. */
  drain(): void {
    for (const row of this.options.store.pendingInbound()) {
      if (this.inFlight.has(row.seq)) continue;
      const type = knownEventType(row.type);
      if (!type) {
        this.log(
          `[hex] queued event ${row.seq} is a "${row.type}", which this version does not know — ignored`,
        );
        this.options.store.finishInbound(row.seq, "ignored");
        continue;
      }
      this.inFlight.add(row.seq);
      this.options.dispatch({
        seq: row.seq,
        type,
        event: row,
        carrier: this.carriers.get(row.seq),
      });
    }
  }

  /** Settle a row. Not calling this leaves the event owed until a restart. */
  finish(seq: number, outcome: string): void {
    this.options.store.finishInbound(seq, outcome);
    this.inFlight.delete(seq);
    this.carriers.delete(seq);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
