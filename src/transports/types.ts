import type { Observable } from "rxjs";
import type { NostrEvent } from "nostr-tools";

/** Every transport there is. A runtime list, so config validation cannot drift. */
export const TRANSPORT_NAMES = ["nip-29", "nip-17", "concord"] as const;

export type TransportName = (typeof TRANSPORT_NAMES)[number];

/**
 * A place Hex can be spoken to.
 *
 * `relay` is part of a NIP-29 room's IDENTITY, not a hint: a group id is only
 * unique within the relay hosting it, so `bitcoin` on two relays is two rooms.
 */
export interface Room {
  transport: TransportName;
  id: string;
  relay?: string;
  label?: string;
}

/** One inbound message, flattened to what the agent reasons over. */
export interface Inbound {
  id: string;
  author: string;
  text: string;
  /** Unix SECONDS, author-chosen — never trusted as a clock. */
  createdAt: number;
  room: Room;
  /**
   * Whether this message addresses Hex. Set by the TRANSPORT, which is the only
   * layer that knows the protocol's tag shape; `policy` reads it and never
   * recomputes it, so the two cannot disagree.
   */
  addressesSelf: boolean;
  /**
   * The message this one replies to, if any.
   *
   * This is what makes a conversation a conversation: a mention opens one, Hex's
   * answer continues it, and a reply to that answer is the next turn of the SAME
   * exchange rather than unrelated room chatter. Set by the transport, which knows
   * how its protocol threads.
   */
  replyToId?: string;
  /** The raw event, for verification and for whatever context a runtime wants. */
  event: NostrEvent;
}

export interface Transport {
  readonly name: TransportName;
  /** One stream for every room this transport serves. */
  start(): Observable<Inbound>;
  /**
   * Bounded history, oldest last, for context.
   *
   * `includeOwn` keeps the transport's own past messages, which the live stream
   * always drops. A thread without the agent's own replies in it is half a
   * conversation, and the half that is missing is the half it wrote.
   */
  history(
    room: Room,
    limit: number,
    options?: { includeOwn?: boolean },
  ): Promise<Inbound[]>;
  /**
   * One message by id, for walking a thread back past what is in memory.
   *
   * Optional: a protocol with no way to fetch a single message just yields a
   * shorter conversation.
   */
  fetchById?(room: Room, id: string): Promise<Inbound | null>;
  /**
   * What this room IS, for the context a runtime is given before it reads.
   *
   * Only the transport can answer. A NIP-29 group's name and rules are a kind
   * 39000 on the group's own relay; a private conversation's "room" is the
   * person on the other end; a Concord channel's metadata is inside an
   * encrypted community list that no relay will hand over. So the question is
   * asked of whoever owns the protocol rather than answered by a switch
   * somewhere else that has to be extended every time a transport is added.
   *
   * Optional, and its absence costs the model a fact rather than a run.
   */
  describeRoom?(room: Room): Promise<Record<string, unknown> | undefined>;
  /** Publish a reply and return its event id. */
  /**
   * `tags` rides on the message itself.
   *
   * What it is for: an `imeta` describing an attachment. An encrypted blob's
   * URL on its own is a link to bytes nobody can open, and the tag beside it is
   * what makes them readable — so a transport that dropped it would deliver a
   * broken image every time.
   */
  reply(to: Inbound, text: string, tags?: string[][]): Promise<string>;
  /**
   * Acknowledge that a message is being worked on.
   *
   * A model takes seconds; a room has no other way to know the difference
   * between "thinking" and "ignored you". Optional, because not every transport
   * has a reaction — a protocol without one simply has no ack.
   */
  react?(to: Inbound, emoji: string): Promise<string>;
  stop(): void;
}

/** Stable key for a room, for maps and rate limits. */
export function roomKey(room: Room): string {
  return room.relay
    ? `${room.transport}|${room.relay}|${room.id}`
    : `${room.transport}|${room.id}`;
}
