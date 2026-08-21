/**
 * Speaking, made survivable.
 *
 * An answer is composed once. Handed straight to a transport, everything
 * between the composing and the delivery loses it for good: a relay that
 * refuses the event, a socket that drops, a kill between the end of the turn
 * and the reply going out. The model already ran and the money is already
 * spent, and the person is left looking at silence.
 *
 * So the row is written first and sent second. A send that fails leaves the row
 * owed, the loop below tries again with a widening gap, and a restart picks up
 * whatever the last process never managed. Bounded on purpose: a row that can
 * never go — a relay that will not take this kind, a peer with no inbox — parks
 * with its error rather than retrying forever, because a spool one row can
 * block is a spool that stops.
 *
 * What is NOT here: the transcript. Eve's indexed stream is already a durable
 * outbound queue — its cursor advances only when a publish lands and a restart
 * replays what it did not — so spooling it would be a second source of truth
 * for the same events. Only the PARTIAL wrap case comes here, because that one
 * advances the cursor and is therefore never replayed.
 */

import type { Rumor } from "./nostr/types.js";
import { FencedWriteError } from "./store.js";
import type { HexStore, OutboundRow } from "./store.js";
import type { Inbound } from "./transports/types.js";

/** What the spool needs of a transport: answer a message, acknowledge one. */
export interface SpoolTransport {
  reply(to: Inbound, text: string, tags?: string[][]): Promise<string>;
  react?(to: Inbound, emoji: string): Promise<string>;
}

/** What it needs to deliver a gift wrap: the one door a rumor goes out of. */
export interface SpoolSink {
  publishRumor(
    rumor: Rumor,
    recipients: string[],
    options?: { ephemeral?: boolean; selfCopy?: boolean },
  ): Promise<{ delivered: string[]; undeliverable: string[] }>;
}

/** A reply's row, and what to do once it lands. */
interface ReplyPayload {
  to: Inbound;
  text: string;
  tags?: string[][];
  /**
   * The request this message put to the room, remembered when it goes out.
   *
   * In the payload rather than at the call site because a reply that lands on
   * the third attempt still has to be answerable: without the mapping, the
   * obvious thing to do — reply in the room — steers the run instead of
   * resolving its question.
   */
  remember?: { sessionId: string; requestId: string };
}

interface ReactionPayload {
  to: Inbound;
  emoji: string;
}

interface WrapPayload {
  rumor: Rumor;
  /** For the log line only: "turn 3", "head". */
  what?: string;
}

export interface SpoolOptions {
  store: HexStore;
  /** The writer lease's generation. Every send is fenced on it. */
  generation: number;
  transport: SpoolTransport;
  /** Absent means a wrap cannot be retried, only a reply. */
  sink?: SpoolSink;
  /** How many tries a row gets before it parks. */
  maxAttempts?: number;
  /** How often the loop looks for owed rows while any are owed. */
  pollMs?: number;
  /** The first gap after a failure; it doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  log?: (line: string) => void;
  /** Milliseconds. Injected so the backoff's tests are not timing tests. */
  clock?: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The narrow half the transcript publisher needs.
 *
 * It owes wraps and never sends them itself, and handing it the whole spool
 * would let a per-session object drive the loop.
 */
export interface WrapSpool {
  owe(rumor: Rumor, recipients: string[], room: string, what?: string): void;
}

export class Spool {
  /**
   * When each owed row may next be tried, by id. In memory on purpose.
   *
   * A restart forgets the schedule, which costs one immediate attempt per owed
   * row and buys no schema column for a value that is only ever a hint.
   */
  private readonly nextAt = new Map<number, number>();
  /**
   * Rows being delivered right now.
   *
   * The row's own state cannot answer this: an attempt in flight has neither
   * `sent_at` nor a spent attempt that a retry could be told apart from, and
   * the same generation is allowed to try again — that is what a retry IS. So
   * two callers into `send` for one row — a live turn's reply and the retry
   * loop that woke while a relay was down — would both deliver it, and the
   * person would read the answer twice.
   */
  private readonly sending = new Set<number>();
  private timer?: ReturnType<typeof setInterval>;
  /** The lease moved on. Nothing here may send again, in this process. */
  private fenced = false;
  private draining?: Promise<void>;

  constructor(private readonly options: SpoolOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Owe an answer, then try to deliver it now.
   *
   * Returns the published id, or nothing when it did not go — the caller's
   * log line and the row's fate are different questions, and the row is
   * already durable either way.
   */
  async reply(
    to: Inbound,
    text: string,
    options: {
      tags?: string[][];
      remember?: { sessionId: string; requestId: string };
    } = {},
  ): Promise<string | undefined> {
    const payload: ReplyPayload = {
      to,
      text,
      tags: options.tags,
      remember: options.remember,
    };
    const id = this.options.store.enqueueOutbound({
      inboundSeq: this.seqFor(to),
      kind: "reply",
      transport: to.room.transport,
      relay: to.room.relay,
      room: to.room.id,
      payload,
    });
    return this.attempt(id);
  }

  /** The same for an ack. Nothing waits on it, and it is still owed if it fails. */
  async react(to: Inbound, emoji: string): Promise<string | undefined> {
    const payload: ReactionPayload = { to, emoji };
    const id = this.options.store.enqueueOutbound({
      inboundSeq: this.seqFor(to),
      kind: "reaction",
      transport: to.room.transport,
      relay: to.room.relay,
      room: to.room.id,
      payload,
    });
    return this.attempt(id);
  }

  /**
   * Owe one wrap per recipient a publish did not reach.
   *
   * One row each, so the retry re-wraps for the recipient who is missing it and
   * not for the ones who already have it.
   */
  owe(rumor: Rumor, recipients: string[], room: string, what?: string): void {
    const payload: WrapPayload = { rumor, what };
    for (const recipient of recipients) {
      this.options.store.enqueueOutbound({
        kind: "wrap",
        transport: "nip-17",
        room,
        recipient,
        payload,
      });
    }
    if (recipients.length > 0) this.arm();
  }

  /**
   * Drain once, then keep an eye on the spool while anything is owed.
   *
   * Called at startup, before any new traffic: a process that only drained on
   * its next send would leave the last run's owed replies sitting there for as
   * long as nobody wrote to it, which is exactly the case this exists for.
   */
  async start(): Promise<void> {
    await this.drain();
    this.arm();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Try every owed row whose gap has passed, oldest first. */
  async drain(): Promise<void> {
    // One pass at a time: a signer is one at a time, and two passes would both
    // claim the same rows in the window between reading and attempting them.
    if (this.draining) return this.draining;
    this.draining = this.pass().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async pass(): Promise<void> {
    const rows = this.options.store.pendingOutbound(this.maxAttempts);
    for (const row of rows) {
      if (this.fenced) return;
      const due = this.nextAt.get(row.id);
      if (due !== undefined && due > this.clock()) continue;
      await this.send(row);
    }
    // Nothing owed, nothing to wake up for.
    if (this.options.store.pendingOutbound(this.maxAttempts).length === 0)
      this.stop();
  }

  /** Deliver one row that is already durable. Never throws. */
  private async attempt(id: number): Promise<string | undefined> {
    const row = this.options.store.owedOutbound(id);
    if (!row) return undefined;
    return this.send(row);
  }

  private async send(row: OutboundRow): Promise<string | undefined> {
    // Somebody is already delivering this one; two callers is one duplicate.
    if (this.sending.has(row.id)) return undefined;
    this.sending.add(row.id);
    try {
      return await this.deliverOnce(row);
    } finally {
      this.sending.delete(row.id);
    }
  }

  private async deliverOnce(row: OutboundRow): Promise<string | undefined> {
    try {
      if (!this.options.store.beginOutbound(row.id, this.options.generation))
        return undefined;
    } catch (error) {
      // A lease taken over. Sending anyway is the double-send this whole
      // discipline exists to prevent, so stop the loop and say so.
      if (error instanceof FencedWriteError) {
        // Said once: the rest of this pass would repeat it per owed row.
        if (!this.fenced) this.log(`[hex] the spool stopped: ${error.message}`);
        this.fenced = true;
        this.stop();
        return undefined;
      }
      throw error;
    }
    try {
      const sentId = await this.deliver(row);
      this.options.store.outboundSent(row.id, sentId);
      this.nextAt.delete(row.id);
      this.remember(row, sentId);
      return sentId;
    } catch (error) {
      const attempts = row.attempts + 1;
      this.options.store.outboundFailed(row.id, message(error));
      if (attempts >= this.maxAttempts) {
        this.nextAt.delete(row.id);
        this.log(
          `[hex] a ${row.kind} for ${row.room.slice(0, 12)}… was given up on after ` +
            `${attempts} tries: ${message(error)}`,
        );
        return undefined;
      }
      const backoff = Math.min(
        (this.options.backoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** (attempts - 1),
        this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      );
      this.nextAt.set(row.id, this.clock() + backoff);
      this.log(
        `[hex] a ${row.kind} for ${row.room.slice(0, 12)}… is still owed after ` +
          `${attempts} tries: ${message(error)}`,
      );
      this.arm();
      return undefined;
    }
  }

  /** Hand one row to whoever can deliver it. Throws when it did not go. */
  private async deliver(row: OutboundRow): Promise<string> {
    switch (row.kind) {
      case "reply": {
        const payload = row.payload as ReplyPayload;
        return this.options.transport.reply(
          payload.to,
          payload.text,
          payload.tags,
        );
      }
      case "reaction": {
        const payload = row.payload as ReactionPayload;
        if (!this.options.transport.react)
          throw new Error("nothing here can react");
        return this.options.transport.react(payload.to, payload.emoji);
      }
      case "wrap": {
        const payload = row.payload as WrapPayload;
        if (!this.options.sink)
          throw new Error("no rumor sink, so a wrap cannot be delivered");
        if (!row.recipient) throw new Error("a wrap row with no recipient");
        /**
         * No self-copy on a retry: this agent's own copy went out with the
         * first publish, and a second one is a duplicate event in its own
         * inbox for a turn it already has.
         */
        const { delivered } = await this.options.sink.publishRumor(
          payload.rumor,
          [row.recipient],
          { selfCopy: false },
        );
        if (delivered.length === 0)
          throw new Error(
            `${row.recipient.slice(0, 8)}… still has nowhere to receive it`,
          );
        return payload.rumor.id;
      }
      default:
        // A row a newer hex spooled. Parked rather than guessed at.
        throw new Error(
          `a "${row.kind}" is not something this version can send`,
        );
    }
  }

  /** Bookkeeping that belongs to the delivery rather than to the composing. */
  private remember(row: OutboundRow, sentId: string): void {
    if (row.kind !== "reply") return;
    const { remember } = row.payload as ReplyPayload;
    if (!remember) return;
    this.options.store.rememberQuestion(
      sentId,
      remember.sessionId,
      remember.requestId,
      Math.floor(this.clock() / 1000),
    );
  }

  /** Which queue row this message was, so a redelivery of it can be settled. */
  private seqFor(to: Inbound): number | undefined {
    return this.options.store.inboundSeqFor(to.room.transport, to.id);
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain();
    }, this.options.pollMs ?? DEFAULT_POLL_MS);
    // A backstop must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }
}
