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

import type { ControlOutcome } from "./eve/serve.js";
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
  /**
   * The event as it arrived.
   *
   * Kept beside the canonical fields, never inside them: policy decides on
   * canonical fields only, but ANSWERING needs the original — a Concord reply
   * inherits `K`/`E`/`P` from the parent's tags. Storing it is what makes a
   * queued row answerable by a process that never saw it arrive, which is what
   * lets a restart be ordinary rather than a special case.
   */
  raw?: unknown;
}

/** `type` from a stored row, if this build knows it. */
export function knownEventType(type: string): HexEventType | undefined {
  return HEX_EVENT_TYPES.includes(type) ? (type as HexEventType) : undefined;
}

/**
 * A stored row, read back as the event it was written from.
 *
 * Takes the type rather than reading it off the row, because the row's is a
 * string on purpose: a row a newer hex wrote must be recognised
 * (`knownEventType`) before anything casts it into this build's taxonomy.
 */
export function canonicalEvent(
  row: QueuedInbound,
  type: HexEventType,
): CanonicalEvent {
  return {
    v: HEX_EVENT_VERSION,
    type,
    id: row.id,
    route: { ...row.route, transport: row.route.transport as TransportName },
    createdAt: row.createdAt,
    observedAt: row.observedAt,
    payload: row.payload,
  };
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
    raw: inbound.event,
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

/**
 * The row, as the thing a transport can reply to.
 *
 * Everything here comes off the row: the route the ingestor recorded, the
 * canonical fields it decided on, and the event exactly as it arrived. A row
 * written before `raw` existed has none, and cannot be answered — it is the
 * only case left that has to be given up on.
 */
export function carrierFor(row: QueuedInbound): Inbound | undefined {
  if (row.raw === undefined || row.raw === null) return undefined;
  const payload = (row.payload ?? {}) as Partial<MessagePayload>;
  return {
    id: row.id,
    author: row.route.peer,
    text: payload.text ?? "",
    createdAt: row.createdAt,
    room: {
      transport: row.route.transport,
      id: row.route.room,
      ...(row.route.relay !== undefined ? { relay: row.route.relay } : {}),
    },
    addressesSelf: payload.addressesSelf ?? false,
    ...(payload.replyToId !== undefined ? { replyToId: payload.replyToId } : {}),
    event: row.raw,
  } as unknown as Inbound;
}

/** One queue row, ready to act on, with the type this build recognises. */
export interface QueuedEvent {
  seq: number;
  type: HexEventType;
  event: QueuedInbound;
  /**
   * What a transport needs to answer this row, rebuilt from the row itself.
   *
   * It used to be the live `Inbound` held in a map for the life of the process,
   * which meant a row outlived the only thing that could answer it: after a
   * restart the message was dropped, and the person who sent it got a log line.
   * The row stores the raw event now, so this is derived rather than remembered
   * — a restart is ordinary, not a special case.
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

/**
 * Whatever can settle a row — the ingestor, or the runner holding it.
 *
 * Narrow on purpose: `settleControl` is the one rule about when an instruction
 * stops being owed, and taking the whole ingestor would keep the runner from
 * using the same copy of it.
 */
export interface Settleable {
  finish(seq: number, outcome: string): void;
}

/**
 * How long a control stays owed before it is given up on.
 *
 * NIP-17's two-day timestamp window, because that window IS the redelivery this
 * replaces: an unobeyed instruction used to be retried for exactly as long as a
 * restart's inbox read still reached it, and no longer. Without a bound, one
 * that can never land — a stop for a run that already ended, a session this
 * agent never published — is re-dispatched at every start forever.
 */
const CONTROL_OWED_SECONDS = 2 * 24 * 60 * 60;

/**
 * Settle a control's row from what the server made of it, or leave it owed.
 *
 * The one rule the queue and the obeyed ledger have to agree on, in one place
 * because both callers of it — the daemon and its tests — get it wrong the same
 * way otherwise: settling on "the call returned" marks an instruction handled
 * that the runtime refused, and `inbound_seen` then means no relay ever offers
 * it again. Returns whether the row was settled.
 */
export function settleControl(
  ingest: Settleable,
  seq: number,
  outcome: ControlOutcome,
): boolean {
  if (outcome === "unavailable") return false;
  ingest.finish(seq, outcome);
  return true;
}

export class Ingestor {
  /** Rows handed to `dispatch` and not yet settled. Never dispatched twice. */
  private readonly inFlight = new Set<number>();
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
   * A pending message from a dead process is dropped rather than re-run —
   * settled instead when the spool already owes its answer:
   * nobody is waiting for that answer, it costs money, and redelivering into a
   * writer that has not been fenced is the duplicate-publish bug. A pending
   * CONTROL is redelivered, because a relay used to redeliver it and the
   * `obeyed` ledger makes a second delivery a no-op — dropping it would lose a
   * stop button pressed while the runtime was down. Past `CONTROL_OWED_SECONDS`
   * it is given up on, or one that can never land is retried at every start for
   * the life of the home.
   */
  start(): void {
    const owedSince = now() - CONTROL_OWED_SECONDS;
    for (const row of this.options.store.pendingInbound()) {
      if (row.type === "control") {
        if (row.observedAt >= owedSince) continue;
        this.log(
          `[hex] control ${row.seq} was never carried out and is too old to try — dropped`,
        );
        this.options.store.finishInbound(row.seq, "dropped:expired");
        continue;
      }
      /**
       * Unless it was already answered, and it is the ANSWER that is owed.
       *
       * The spool's row is the durable record that this message's turn ran, so
       * calling this one "dropped" would say in the log that a question went
       * unanswered while its answer is on its way out of the spool.
       */
      if (this.options.store.outboundRepliedTo(row.seq)) {
        this.log(
          `[hex] queued message ${row.seq} was answered by an earlier run — its reply is owed, not another turn`,
        );
        this.options.store.finishInbound(row.seq, "handled");
        continue;
      }
      /**
       * Left pending on purpose: `drain()` below hands it on, and
       * `claimInbound` admits a row whose claim belongs to a dead generation.
       * The row answers for itself now, so there is nothing a previous process
       * knew that this one does not.
       */
      this.log(
        `[hex] queued ${row.type} ${row.seq} was left behind by an earlier run — retrying it`,
      );
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
        carrier: carrierFor(row),
      });
    }
  }

  /** Settle a row. Not calling this leaves the event owed until a restart. */
  finish(seq: number, outcome: string): void {
    this.options.store.finishInbound(seq, outcome);
    this.inFlight.delete(seq);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
