/**
 * Acting, separated from hearing and from deciding.
 *
 * The ingestor makes an event durable, the policy table says what to do about
 * it, and this drains the queue and does it. Its whole job is that no two
 * dispatches of one conversation ever overlap — across a message and a control
 * event, and across a restart.
 *
 * That last part is why this exists rather than the two maps it replaces. A
 * turn was serialised per (author, room) and an instruction per session, in
 * different maps, so a `cancel` and a question about the same session ran at
 * once: two readers of one stream, publishing its turns twice under one `seq`.
 * One LANE per conversation is one serialisation domain, and the claim on the
 * row makes it survive the process.
 */

import {
  canonicalEvent,
  settleControl,
  type ControlPayload,
  type QueuedEvent,
} from "./ingest.js";
import {
  DEFAULT_POLICY,
  decide,
  whyIgnored,
  type Disposition,
  type LaneState,
  type PolicyRule,
} from "./policy-table.js";
import type { ControlOutcome } from "./eve/serve.js";
import type { SessionControl } from "./nostr/decode-control.js";
import type { HexStore } from "./store.js";
import { roomKey } from "./transports/types.js";
import type { Inbound } from "./transports/types.js";

/** What the runner needs of the thing that does the work. */
export interface RunnerTarget {
  /** Answer a message. One call at a time per conversation — that is our job. */
  runTurn(inbound: Inbound): Promise<void>;
  /** Carry out an instruction. `unavailable` leaves it owed. */
  applyControl(control: SessionControl): Promise<ControlOutcome>;
  /**
   * Ask what is running in this conversation to stop. Reads no stream.
   *
   * Only asks. Whatever replaces the abandoned work is a separate dispatch this
   * class starts once the abandoned one has actually returned — an overlap here
   * is two readers of one stream, which is what this class exists to prevent.
   */
  abandon(inbound: Inbound): Promise<void>;
  /** The same, for the run an instruction names. */
  abandonSession(control: SessionControl): Promise<void>;
}

/** What the runner needs of the queue: the settle half of it. */
export interface RunnerQueue {
  finish(seq: number, outcome: string): void;
}

export interface RunnerOptions {
  store: HexStore;
  queue: RunnerQueue;
  target: RunnerTarget;
  /**
   * The writer lease's generation. Claims are fenced on it, which is what makes
   * a row a dead process left claimed safe to hand out again.
   */
  generation: number;
  /** Hex's own pubkey: it hears its own replies come back. */
  selfPubkey: string;
  /** Unix seconds. Messages dated before this minus `graceSecs` are backfill. */
  startedAt: number;
  repliesPerRoomPerHour: number;
  /** Absent means no cap, which is what Hex did before this file existed. */
  maxConcurrentTurns?: number;
  /** Absent means the compiled-in default, which is today's behaviour. */
  policy?: readonly PolicyRule[];
  graceSecs?: number;
  /** Unix seconds. Injected so the rate limit's tests are not timing tests. */
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * A message dated just before startup is almost certainly one Hex already saw
 * in a previous run, or backfill. Small and deliberate: a genuine mention that
 * arrives in the second before the sockets open should still get an answer.
 */
const DEFAULT_GRACE_SECS = 30;
const HOUR_SECS = 3600;

/**
 * How much one lane may hold while a turn runs.
 *
 * A bound, not a policy: a conversation that is written to faster than it can
 * be answered would otherwise queue a turn — and a turn's worth of tokens —
 * for every message forever. The OLDEST goes, because the newest is the one
 * still worth answering.
 */
const PENDING_CAP = 20;

/** One conversation's serialisation domain. */
interface Lane {
  /**
   * The event being acted on, or nothing. `seq` is which one.
   *
   * `done` settles when that dispatch has RETURNED — bookkeeping included. It
   * is what a steer waits for: until then the abandoned turn is still reading
   * the session's stream, and a second reader publishes its turns twice.
   */
  running?: {
    seq: number;
    peer: string;
    room?: string;
    done: Promise<void>;
  };
  /** Waiting their turn, oldest first: followups and collected events. */
  pending: QueuedEvent[];
}

/**
 * The instructions that must reach the runtime before their turn in the lane.
 *
 * A stop held behind the turn it names does nothing until that turn ends by
 * itself, at which point there is nothing left to stop. Every other verb reads
 * the session's stream — waiting IS the fix for those.
 */
const ABORTS_THE_TURN = new Set(["cancel", "reset"]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Runner {
  private readonly lanes = new Map<string, Lane>();
  /** Room key -> the seconds at which a reply landed inside this hour. */
  private readonly replies = new Map<string, number[]>();
  private turns = 0;

  constructor(private readonly options: RunnerOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  private now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /**
   * Take one queued event: claim it, decide it, and act or record why not.
   *
   * Shaped as the ingestor's `dispatch`, so the queue stays the only path in.
   */
  offer(queued: QueuedEvent): void {
    if (queued.type !== "message" && queued.type !== "control") {
      // Reactions, joins and timers have no handler yet. The row says so.
      this.log(`[hex] queued ${queued.type} ${queued.seq} has no handler yet`);
      this.options.queue.finish(queued.seq, "ignored");
      return;
    }
    /**
     * The claim is the durable half of the lane.
     *
     * A row this generation already holds is never acted on twice; a row the
     * LAST generation held is offered again, because the process that held it
     * is gone. Redelivery is only safe with the fence and the obeyed ledger
     * underneath it — see the phase notes on why this cannot ship before them.
     */
    if (!this.options.store.claimInbound(queued.seq, this.options.generation)) {
      this.log(`[hex] queued event ${queued.seq} is already claimed — skipped`);
      return;
    }
    if (queued.type === "control") this.offerControl(queued);
    else this.offerMessage(queued);
  }

  /** Whether another turn may start. */
  private hasCapacity(): boolean {
    const cap = this.options.maxConcurrentTurns;
    return cap === undefined || this.turns < cap;
  }

  private lane(key: string): Lane {
    const existing = this.lanes.get(key);
    if (existing) return existing;
    const lane: Lane = { pending: [] };
    this.lanes.set(key, lane);
    return lane;
  }

  /**
   * How the lane looks to the policy table.
   *
   * `activeThreads` is deliberately not filled in: the default table's thread
   * rule would start matching un-addressed replies the moment it is, which is
   * a second behaviour change and not this one.
   */
  private state(lane: Lane): LaneState {
    return lane.running
      ? { inTurn: true, turnHolder: lane.running.peer }
      : { inTurn: false };
  }

  /**
   * Which lane a message belongs to: the conversation, as the store keys it.
   *
   * Not the session, even though a lane IS a session's serialisation domain —
   * the first message of a conversation has no session yet, and keying on one
   * would put it in a different lane from the control events that arrive about
   * it moments later. `conversationForSession` is the other half: a control
   * lands on the same key.
   */
  private laneForMessage(inbound: Inbound): string {
    return `${inbound.author}\u0000${roomKey(inbound.room)}`;
  }

  /** Which lane an instruction belongs to. */
  private laneForControl(control: SessionControl): string {
    const store = this.options.store;
    const record = store.transcriptForNostrId(control.session);
    const conversation = record
      ? store.conversationForSession(record.sessionId)
      : undefined;
    if (conversation) return `${conversation.peer}\u0000${conversation.room}`;
    /**
     * A `start` has published nothing yet, so name the lane it WILL resolve to.
     *
     * `start` remembers its conversation as (operator, no room), which is what
     * every later control for that session reads back. Derived from the row
     * alone, a start ran in `session\0<id>` while the steer that followed it
     * landed in an idle `<operator>\0` lane and forked the stream. No message
     * lane can collide with this key: `roomKey` is never empty.
     */
    if (control.command === "start") return `${control.operator}\u0000`;
    // A session this process never published: refused without reading anything,
    // so a lane of its own costs nothing.
    return `session\u0000${control.session}`;
  }

  private offerMessage(queued: QueuedEvent): void {
    /**
     * An answer to this row was already composed, so it is not asked again.
     *
     * The idempotency marker a gateway usually gets from a client-supplied key
     * and hex cannot: the spool's row IS the record that the turn happened.
     * Without it, a row redelivered after a crash — claimed under a generation
     * that is gone, settled by nothing — buys a second run of a turn whose
     * answer is already owed or already sent. Replies only; the ack reaction is
     * spooled before the turn starts and says nothing about it.
     */
    if (this.options.store.outboundRepliedTo(queued.seq)) {
      this.log(
        `[hex] queued message ${queued.seq} already has an answer owed — not run again`,
      );
      this.options.queue.finish(queued.seq, "handled");
      return;
    }
    const inbound = queued.carrier;
    if (!inbound) {
      // A row from a previous run: the canonical fields cannot be replied to,
      // only the transport's own object can. An answer that WAS composed is
      // owed by the spool above, not by this row.
      this.log(`[hex] queued message ${queued.seq} has no carrier — dropped`);
      this.options.queue.finish(queued.seq, "dropped:restart");
      return;
    }
    if (inbound.author === this.options.selfPubkey) {
      // Hex's own reply, back through its own subscription.
      this.options.queue.finish(queued.seq, "ignored");
      return;
    }
    const grace = this.options.graceSecs ?? DEFAULT_GRACE_SECS;
    if (inbound.createdAt < this.options.startedAt - grace) {
      this.log(`[hex] ${short(inbound.author)} not answered: before-start`);
      this.options.queue.finish(queued.seq, "dropped:before-start");
      return;
    }

    const key = this.laneForMessage(inbound);
    const lane = this.lane(key);
    const event = canonicalEvent(queued.event, "message");
    const laneState = this.state(lane);
    const disposition = decide(
      event,
      laneState,
      this.options.policy ?? DEFAULT_POLICY,
    );

    switch (disposition) {
      case "ignore":
        this.log(
          `[hex] ${short(inbound.author)} not answered: ${whyIgnored(event, laneState)}`,
        );
        this.options.queue.finish(queued.seq, "ignored");
        return;
      case "steer":
        if (lane.running) {
          this.log(
            `[hex] ${short(inbound.author)} interrupted: ${inbound.text.slice(0, 80)}`,
          );
          this.begin(key, lane, queued, true);
          return;
        }
        this.begin(key, lane, queued, false);
        return;
      case "collect":
        // Held even when nothing is running, and then started by the pump
        // below: a row nobody ever replays is a message silently owed forever.
        this.hold(lane, queued);
        this.pump();
        return;
      default:
        // `respond` and `wake`. Mid-turn it becomes a followup — the one
        // behaviour this phase changes.
        if (!lane.running && this.hasCapacity())
          this.begin(key, lane, queued, false);
        else this.hold(lane, queued);
        return;
    }
  }

  private offerControl(queued: QueuedEvent): void {
    const { instruction } = queued.event.payload as ControlPayload;
    const key = this.laneForControl(instruction);
    const lane = this.lane(key);
    const disposition: Disposition = decide(
      canonicalEvent(queued.event, "control"),
      this.state(lane),
      this.options.policy ?? DEFAULT_POLICY,
    );
    if (disposition === "ignore") {
      this.log(`[hex] a ${instruction.command} matched no rule — ignored`);
      this.options.queue.finish(queued.seq, "ignored");
      return;
    }
    if (lane.running) {
      /**
       * An instruction waits for the turn it is about, rather than reading that
       * session's stream alongside it. That wait IS the fix this phase is for.
       *
       * But a stop that only waits is not a stop: the turn it names would run
       * to its own end, and the instruction would land on a settled target. So
       * the runtime is asked to abort NOW — that reads no stream — while the
       * instruction itself still takes its turn in the lane.
       */
      if (ABORTS_THE_TURN.has(instruction.command))
        void this.options.target
          .abandonSession(instruction)
          .catch((error: unknown) =>
            this.log(
              `[hex] could not stop the running turn: ${message(error)}`,
            ),
          );
      this.hold(lane, queued);
    } else this.beginControl(key, lane, queued);
  }

  /**
   * Wait in line, and drop the oldest MESSAGE if the line is already long
   * enough.
   *
   * Never a control. A dropped row is gone for good — the queue's dedupe means
   * no relay offers the wrap again and a settled row is not redelivered — so a
   * stop button held behind a turn must not be evictable by twenty messages
   * arriving after it. A line of nothing but controls is allowed to grow: the
   * operator pressed all of them.
   */
  private hold(lane: Lane, queued: QueuedEvent): void {
    lane.pending.push(queued);
    while (lane.pending.length > PENDING_CAP) {
      const at = lane.pending.findIndex((held) => held.type !== "control");
      if (at === -1) return;
      const [dropped] = lane.pending.splice(at, 1);
      if (!dropped) return;
      this.log(
        `[hex] queued event ${dropped.seq} fell out of a full lane — dropped`,
      );
      this.options.queue.finish(dropped.seq, "dropped:overflow");
    }
  }

  /**
   * Start whatever can start, oldest lane first.
   *
   * Called at every ending, because the thing that frees capacity for one lane
   * is a turn ending in another.
   */
  private pump(): void {
    for (const [key, lane] of this.lanes) {
      while (!lane.running && lane.pending.length > 0) {
        if (!this.hasCapacity()) return;
        const next = lane.pending.shift();
        if (!next) break;
        if (next.type === "control") this.beginControl(key, lane, next);
        else this.begin(key, lane, next, false);
      }
      // An idle lane with nothing waiting is not state, it is a leak.
      if (!lane.running && lane.pending.length === 0) this.lanes.delete(key);
    }
  }

  /** Run a turn about this message. Fire and forget: a failure is reported. */
  private begin(
    key: string,
    lane: Lane,
    queued: QueuedEvent,
    steer: boolean,
  ): void {
    const inbound = queued.carrier;
    if (!inbound) {
      this.options.queue.finish(queued.seq, "dropped:restart");
      return;
    }
    const room = roomKey(inbound.room);
    if (this.landed(room).length >= this.options.repliesPerRoomPerHour) {
      this.log(`[hex] ${short(inbound.author)} not answered: rate-limited`);
      this.options.queue.finish(queued.seq, "dropped:rate-limited");
      return;
    }

    const abandoned = lane.running;
    this.turns += 1;
    // Settled at the start, not at the end: a turn is fire-and-forget and the
    // row records that the event was acted on, not what the answer said.
    this.options.queue.finish(queued.seq, "handled");
    this.log(
      `[hex] ${short(inbound.author)} asked: ${inbound.text.slice(0, 80)}`,
    );

    const run = steer
      ? this.handover(abandoned, inbound)
      : this.options.target.runTurn(inbound);
    const done = run.then(
      () => this.ending(key, queued.seq, room, true),
      (error: unknown) => {
        this.log(`[hex] the turn failed: ${message(error)}`);
        this.ending(key, queued.seq, room, false);
      },
    );
    /**
     * The lane's holder changes BEFORE the handover is awaited.
     *
     * The turn being abandoned still runs its own ending, and that ending must
     * not free its successor's claim — which is exactly what left a room open
     * for the length of a handover, long enough for a third message to start a
     * turn the pending interrupt then killed. `ending` is guarded on `seq`, and
     * it cannot have run yet: the `then` above is a microtask.
     */
    lane.running = { seq: queued.seq, peer: inbound.author, room, done };
  }

  /**
   * Take a lane over from the turn that holds it.
   *
   * Ask it to stop, then WAIT for it. Only asking is what the map this class
   * replaced already did better: the abandoned turn keeps following the
   * session's stream until its call returns, and a second reader publishes
   * every turn between them twice under one `seq`. A cancel is best effort —
   * Eve answers `no_active_turn` for a turn that already ended — so the wait is
   * what makes the handover safe, not the cancel.
   */
  private async handover(
    abandoned: Lane["running"],
    inbound: Inbound,
  ): Promise<void> {
    await this.options.target
      .abandon(inbound)
      .catch((error: unknown) =>
        this.log(`[hex] could not stop the running turn: ${message(error)}`),
      );
    // Its failure is its own business; this turn runs either way.
    await abandoned?.done.catch(() => {});
    await this.options.target.runTurn(inbound);
  }

  /** Carry out one instruction. Does not count against the turn cap: an
   * operator's stop button has to work while everything is busy. */
  private beginControl(key: string, lane: Lane, queued: QueuedEvent): void {
    const { instruction } = queued.event.payload as ControlPayload;
    const done = this.options.target.applyControl(instruction).then(
      (outcome) => {
        // An instruction that did not land stays PENDING on purpose: the row is
        // the only thing that can bring it back, now that the queue's dedupe
        // stops a relay ever redelivering the wrap. The next start is its retry.
        if (!settleControl(this.options.queue, queued.seq, outcome))
          this.log(
            `[hex] the ${instruction.command} did not land — still owed`,
          );
        this.ending(key, queued.seq);
      },
      (error: unknown) => {
        this.log(`[hex] the control failed: ${message(error)}`);
        this.ending(key, queued.seq);
      },
    );
    lane.running = { seq: queued.seq, peer: instruction.operator, done };
  }

  /**
   * One dispatch ended. Free the lane if it still holds it, then pump.
   *
   * `room` and `published` are a turn's; a control spends no rate limit. Only
   * the holder frees the lane — see `begin`.
   */
  private ending(
    key: string,
    seq: number,
    room?: string,
    published?: boolean,
  ): void {
    if (room !== undefined) {
      this.turns = Math.max(0, this.turns - 1);
      // A reply that never landed does not spend the rate limit.
      if (published) this.landed(room).push(this.now());
    }
    const lane = this.lanes.get(key);
    if (lane?.running?.seq !== seq) {
      this.pump();
      return;
    }
    lane.running = undefined;
    this.pump();
  }

  private landed(room: string): number[] {
    const cutoff = this.now() - HOUR_SECS;
    const kept = (this.replies.get(room) ?? []).filter(
      (stamp) => stamp > cutoff,
    );
    this.replies.set(room, kept);
    return kept;
  }
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…`;
}
