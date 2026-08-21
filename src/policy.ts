/**
 * Whether Hex answers a message, and nothing else.
 *
 * This is the one gate: everything that costs money, publishes an event, or
 * (later) runs code passes through here first. It is pure apart from the small
 * amount of state a rate limit needs, and the clock is injected so the tests
 * are not timing tests.
 */

import type { LaneState } from "./policy-table.js";
import type { Inbound } from "./transports/types.js";
import { roomKey } from "./transports/types.js";

export type SkipReason =
  | "not-addressed"
  | "own-message"
  | "before-start"
  | "duplicate"
  | "in-flight"
  | "rate-limited"
  /**
   * Not a refusal — an instruction to abandon what is running and do this
   * instead. The only reason that asks the caller to ACT rather than to stop.
   */
  | "interrupt";

export type Verdict = { reply: true } | { reply: false; reason: SkipReason };

/** Who is holding a room, and with which message. */
export interface TurnHolder {
  id: string;
  author: string;
}

export interface ReplyGateOptions {
  selfPubkey: string;
  /** Names Hex answers to, beyond a p-tag. Matched on word boundaries. */
  mentions: string[];
  /** Unix seconds. Messages older than this minus `graceSecs` are ignored. */
  startedAt: number;
  repliesPerRoomPerHour: number;
  /** Unix seconds. Injected so tests do not depend on the wall clock. */
  now: () => number;
  /** How far before startup a message may be dated and still get an answer. */
  graceSecs?: number;
  /** Upper bound on the dedupe set, so a long run cannot grow without limit. */
  maxSeen?: number;
}

/**
 * A message dated just before startup is almost certainly one Hex already saw
 * in a previous run, or backfill. Small and deliberate: a genuine mention that
 * arrives in the second before the sockets open should still get an answer.
 */
const DEFAULT_GRACE_SECS = 30;
const DEFAULT_MAX_SEEN = 20_000;
const HOUR_SECS = 3600;

/**
 * Does this text address Hex by name?
 *
 * Word-boundary and case-insensitive, because "hexadecimal" is not a summons.
 * The boundary is asserted with lookarounds rather than `\b`, since a token may
 * start with `@` and `\b@hex` never matches — `@` is already a non-word
 * character.
 *
 * A BARE token matches with or without an `@`: someone who configures
 * `["hex"]` and then gets `@hex` in the room must not be met with silence,
 * which is the least debuggable failure this agent has. A token that spells the
 * `@` out is taken at its word and matches only the @-form.
 */
export function mentionsName(text: string, mentions: string[]): boolean {
  return mentions.some((token) => {
    const trimmed = token.trim();
    if (!trimmed) return false;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = trimmed.startsWith("@")
      ? new RegExp(`(?<![\\w@])${escaped}(?![\\w])`, "iu")
      : new RegExp(`(?<![\\w@])@?${escaped}(?![\\w])`, "iu");
    return pattern.test(text);
  });
}

/** Is Hex p-tagged on this event? */
export function tagsSelf(inbound: Inbound, selfPubkey: string): boolean {
  return inbound.event.tags.some(
    (tag) => tag[0] === "p" && tag[1] === selfPubkey,
  );
}

/**
 * Decide `addressesSelf` for a plaintext room. Transports own this call — a DM
 * addresses Hex by existing, a group message has to say so.
 */
export function addressesSelfInGroup(
  inbound: Inbound,
  selfPubkey: string,
  mentions: string[],
): boolean {
  return tagsSelf(inbound, selfPubkey) || mentionsName(inbound.text, mentions);
}

export class ReplyGate {
  private readonly options: Required<
    Pick<ReplyGateOptions, "graceSecs" | "maxSeen">
  > &
    ReplyGateOptions;
  /** Insertion-ordered, so trimming drops the oldest ids first. */
  private readonly seen = new Set<string>();
  /** Room key -> who is holding it. The holder's identity decides interrupts. */
  private readonly inFlight = new Map<string, TurnHolder>();
  /** Room key -> reply timestamps (unix seconds) inside the current hour. */
  private readonly replies = new Map<string, number[]>();

  constructor(options: ReplyGateOptions) {
    this.options = {
      graceSecs: DEFAULT_GRACE_SECS,
      maxSeen: DEFAULT_MAX_SEEN,
      ...options,
    };
  }

  /**
   * Should Hex answer this? Records the message as seen either way — a second
   * copy from another relay is a duplicate whatever the first verdict was.
   */
  consider(inbound: Inbound): Verdict {
    if (this.seen.has(inbound.id)) return { reply: false, reason: "duplicate" };
    this.remember(inbound.id);

    // Hex's own reply comes straight back through the same subscription.
    if (inbound.author === this.options.selfPubkey)
      return { reply: false, reason: "own-message" };

    if (!inbound.addressesSelf)
      return { reply: false, reason: "not-addressed" };

    if (inbound.createdAt < this.options.startedAt - this.options.graceSecs)
      return { reply: false, reason: "before-start" };

    const key = roomKey(inbound.room);
    const holder = this.inFlight.get(key);
    if (holder) return this.whileBusy(inbound, holder);

    if (this.recentReplies(key).length >= this.options.repliesPerRoomPerHour)
      return { reply: false, reason: "rate-limited" };

    return { reply: true };
  }

  /**
   * Someone wrote while a turn was already running.
   *
   * In a private message that means "not that — this": there is nobody else in
   * the conversation and no other reason to type, so the running turn is
   * abandoned and this message takes over. A relay group is different — it has
   * other conversations in it, and every mention during a turn is not an
   * instruction to drop what you are doing — so a group keeps waiting.
   *
   * Same author only. `roomKey` covers groups too, and Bob saying hello must
   * never kill the build Alice asked for.
   */
  private whileBusy(inbound: Inbound, holder: TurnHolder): Verdict {
    const isDm = inbound.room.transport === "nip-17";
    return isDm && holder.author === inbound.author
      ? { reply: false, reason: "interrupt" }
      : { reply: false, reason: "in-flight" };
  }

  /** Who is working in this room, if anyone. */
  holderFor(inbound: Inbound): TurnHolder | undefined {
    return this.inFlight.get(roomKey(inbound.room));
  }

  /**
   * The same room state, in the shape the policy table matches on.
   *
   * The gate still owns who is working where, so the table is asked about a
   * lane reported from here rather than a second copy that could disagree.
   */
  laneFor(inbound: Inbound): LaneState {
    const holder = this.holderFor(inbound);
    return holder
      ? { inTurn: true, turnHolder: holder.author }
      : { inTurn: false };
  }

  /** Claim the room. One reply in flight per room, so a stall cannot fan out. */
  begin(inbound: Inbound): void {
    this.inFlight.set(roomKey(inbound.room), {
      id: inbound.id,
      author: inbound.author,
    });
  }

  /**
   * Release the room. `published` is false when the runtime stayed silent or the
   * send failed — a reply that never landed does not spend the rate limit.
   */
  end(inbound: Inbound, published: boolean): void {
    const key = roomKey(inbound.room);
    // Only the holder releases the room. A turn that was taken over mid-flight
    // still runs its own cleanup, and deleting by room alone let it free its
    // successor's claim — which left the room open for the duration of the
    // handover, exactly long enough for a third message to start a turn that the
    // pending interrupt then killed.
    if (this.inFlight.get(key)?.id === inbound.id) this.inFlight.delete(key);
    if (!published) return;
    const timestamps = this.recentReplies(key);
    timestamps.push(this.options.now());
    this.replies.set(key, timestamps);
  }

  /** Ids of Hex's own published replies, so they are never reconsidered. */
  remember(eventId: string): void {
    this.seen.add(eventId);
    if (this.seen.size > this.options.maxSeen) {
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
  }

  private recentReplies(key: string): number[] {
    const cutoff = this.options.now() - HOUR_SECS;
    const kept = (this.replies.get(key) ?? []).filter(
      (stamp) => stamp > cutoff,
    );
    this.replies.set(key, kept);
    return kept;
  }
}
