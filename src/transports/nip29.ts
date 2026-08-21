/**
 * NIP-29 relay groups.
 *
 * A group lives on ONE relay, which enforces its membership and moderation, so
 * every read and every write here is addressed to that relay and no other. A
 * group id is only unique within its relay: the pair travels together, and the
 * id is never lowercased, because `#h` is case-sensitive and `Bitcoin` and
 * `bitcoin` on one relay are two rooms.
 */

import { merge, Observable } from "rxjs";
import { map as rxMap, filter as rxFilter } from "rxjs/operators";
import type { NostrEvent } from "nostr-tools";
import { nip10Root } from "./nip10.js";
import { roomKey } from "./types.js";
import {
  GroupMessageFactory,
  ReactionFactory,
} from "applesauce-common/factories";
import type { Nip29GroupConfig } from "../config.js";
import type { ISigner } from "../signer.js";
import {
  publishTo,
  requestEvents,
  subscribe,
  type HexRelays,
} from "../relays.js";
import { addressesSelfInGroup } from "../policy.js";
import type { Inbound, Room, Transport } from "./types.js";

/** A group chat message. */
export const KIND_GROUP_MESSAGE = 9;
/** What the relay says the group IS: name, topic, whether it is public. */
export const KIND_GROUP_METADATA = 39000;

/**
 * Which message an event replies to.
 *
 * `q` FIRST, because that is what a kind-9 reply actually carries: NIP-C7 quotes
 * the parent with `["q", id, relay, pubkey]`, and grimoire both writes and reads
 * that tag for group chat. Reading only `e` meant a reply typed in grimoire —
 * including a reply to Hex — arrived looking like an unrelated message.
 *
 * `e` is still honoured for clients that thread that way: an explicit
 * `["e", id, relay, "reply"]` wins over an unmarked one, and a lone `root` is
 * taken only because nothing better exists — threading to the root would flatten
 * a long exchange into a single turn.
 */
export function replyTarget(event: NostrEvent): string | undefined {
  const quoted = event.tags.find((tag) => tag[0] === "q" && tag[1]);
  if (quoted) return quoted[1];

  const tags = event.tags.filter((tag) => tag[0] === "e" && tag[1]);
  const marked = tags.find((tag) => tag[3] === "reply");
  if (marked) return marked[1];
  const unmarked = tags.find(
    (tag) => tag[3] !== "root" && tag[3] !== "mention",
  );
  return (unmarked ?? tags[0])?.[1];
}

/**
 * The thread a kind 9 hangs under, when it says — and usually it does not.
 *
 * NIP-C7 quotes the parent with `q` and names no root, so a group thread is a
 * chain of parents and nothing more: grimoire, which is what writes most of
 * these, sends the `q` alone. A client that threads with NIP-10 `e` tags
 * instead does name one, and that is worth reading when it is there.
 *
 * Where it is not there, one hop is all this protocol offers — which is why
 * every message Hex handles is bound to its session as well as its root. The
 * hop then lands on something the store knows, and the thread resolves anyway.
 */
export function threadRoot(event: NostrEvent): string | undefined {
  const root = nip10Root(event);
  // A lone unmarked `e` is reported as both root and parent by the positional
  // rules; here that would make every reply its own thread root.
  return root === replyTarget(event) ? undefined : root;
}

export interface Nip29TransportOptions {
  relays: HexRelays;
  signer: ISigner;
  pubkey: string;
  groups: Nip29GroupConfig[];
  /** Names Hex answers to, beyond a p-tag. */
  mentions: string[];
  /** Unix seconds. The live subscription asks for nothing older. */
  since: number;
  publishTimeoutMs?: number;
  /**
   * "Did Hex publish this?", asked of something that outlives the process.
   *
   * The in-memory set below only knows this run. With a persistent answer, a
   * reply to something Hex said last week still reads as addressed to it, which
   * is the difference between an agent with a memory and one that meets everyone
   * again on every restart.
   */
  isOwnMessage?: (id: string) => boolean;
  /**
   * Whether a thread already belongs to a run of Hex's.
   *
   * The half `isOwnMessage` cannot answer. In a group, a reply threads onto the
   * message it answers — which is usually the PERSON'S own opening mention, not
   * anything Hex wrote — so a thread Hex is already running looked like room
   * chatter and demanded the mention be typed again on every message.
   */
  threadIsOurs?: (id: string, room: string) => boolean;
}

/**
 * How many of Hex's own message ids to remember.
 *
 * Only needed to recognise a reply to one of them, and a conversation is answered
 * within minutes or not at all.
 */
const MAX_OWN_IDS = 500;

export class Nip29Transport implements Transport {
  readonly name = "nip-29" as const;

  private stopped = false;
  /**
   * What Hex has said in these rooms, this run.
   *
   * A reply to one of these addresses Hex whether or not it repeats the name —
   * which is what makes a conversation a conversation. Nobody says "hex" again in
   * their second sentence, and requiring it means every exchange dies after one
   * turn.
   *
   * Session-scoped: after a restart Hex no longer recognises its own older
   * messages, so a follow-up then has to name it or p-tag it again.
   */
  private readonly ownMessageIds = new Set<string>();

  constructor(private readonly options: Nip29TransportOptions) {}

  /** The configured groups, keyed by relay — one subscription per relay. */
  private byRelay(): Map<string, Nip29GroupConfig[]> {
    const map = new Map<string, Nip29GroupConfig[]>();
    for (const group of this.options.groups) {
      const existing = map.get(group.relay);
      if (existing) existing.push(group);
      else map.set(group.relay, [group]);
    }
    return map;
  }

  private roomFor(relay: string, event: NostrEvent): Room | null {
    const h = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!h) return null;
    // Exact match against what was configured FOR THIS RELAY. A relay hosts many
    // rooms and the store cannot tell them apart on its own.
    const group = this.options.groups.find(
      (candidate) => candidate.relay === relay && candidate.id === h,
    );
    if (!group) return null;
    return { transport: "nip-29", id: group.id, relay: group.relay };
  }

  private toInbound(relay: string, event: NostrEvent): Inbound | null {
    const room = this.roomFor(relay, event);
    if (!room) return null;
    const inbound: Inbound = {
      id: event.id,
      author: event.pubkey,
      text: event.content,
      createdAt: event.created_at,
      room,
      addressesSelf: false,
      // A kind-9 reply quotes its parent with `q` (NIP-C7), which is what
      // grimoire writes and reads; `e` is the fallback.
      replyToId: replyTarget(event),
      ...(threadRoot(event) !== undefined
        ? { threadRoot: threadRoot(event) }
        : {}),
      event,
    };
    // The transport decides this: it is the layer that knows the tag shape, and
    // the only one that knows which messages are Hex's own.
    /*
     * Three ways a kind 9 continues something rather than starting it: it
     * quotes a message Hex wrote, in this run or an earlier one, or it hangs
     * under a thread Hex already has a session for.
     *
     * The third is what makes a group thread usable. Without a root tag the
     * only handle is the parent, so this asks the store about the parent — and
     * the store knows it, because every message Hex handles is bound to its
     * session too.
     */
    const root = inbound.threadRoot ?? inbound.replyToId;
    const continuesConversation =
      (inbound.replyToId !== undefined &&
        (this.ownMessageIds.has(inbound.replyToId) ||
          (this.options.isOwnMessage?.(inbound.replyToId) ?? false))) ||
      (root !== undefined &&
        (this.options.threadIsOurs?.(root, roomKey(inbound.room)) ?? false)) ||
      (inbound.replyToId !== undefined &&
        (this.options.threadIsOurs?.(
          inbound.replyToId,
          roomKey(inbound.room),
        ) ??
          false));

    return {
      ...inbound,
      addressesSelf:
        continuesConversation ||
        addressesSelfInGroup(
          inbound,
          this.options.pubkey,
          this.options.mentions,
        ),
    };
  }

  /** Remember something Hex said, so a reply to it counts as addressed. */
  private rememberOwn(id: string): void {
    this.ownMessageIds.add(id);
    if (this.ownMessageIds.size > MAX_OWN_IDS) {
      const oldest = this.ownMessageIds.values().next();
      if (!oldest.done) this.ownMessageIds.delete(oldest.value);
    }
  }

  /**
   * Every configured group's messages, as one stream.
   *
   * `since` keeps the subscription from replaying a room's whole history at
   * startup — the gate would refuse all of it anyway, and asking for it costs
   * the relay real work.
   */
  start(): Observable<Inbound> {
    const streams = [...this.byRelay()].map(([relay, groups]) =>
      subscribe(
        this.options.relays,
        [relay],
        [
          {
            kinds: [KIND_GROUP_MESSAGE],
            "#h": groups.map((group) => group.id),
            since: this.options.since,
          },
        ],
      ).pipe(
        rxMap((event) => this.toInbound(relay, event)),
        rxFilter((inbound): inbound is Inbound => inbound !== null),
      ),
    );
    return merge(...streams);
  }

  /**
   * What the group says it is: its kind 39000, from its own relay.
   *
   * A model told only "you are in group NkeVhXuWHGKKJCpn" knows nothing it can
   * use. The name, the topic and whether the room is public are what decide how
   * to answer — and whether the room is public decides what it is safe to say
   * at all, which is not a judgement to leave to a guess.
   *
   * Never throws: a relay that will not answer costs the model a fact.
   */
  async describeRoom(room: Room): Promise<Record<string, unknown> | undefined> {
    if (!room.relay) return undefined;
    try {
      const events = await requestEvents(
        this.options.relays,
        [room.relay],
        [{ kinds: [KIND_GROUP_METADATA], "#d": [room.id], limit: 1 }],
      );
      const meta = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!meta) return { id: room.id, relay: room.relay };

      const tag = (name: string) =>
        meta.tags.find((t) => t[0] === name && t[1])?.[1];
      const flag = (name: string) =>
        meta.tags.some((t) => t[0] === name) || undefined;

      return {
        id: room.id,
        relay: room.relay,
        name: tag("name"),
        about: tag("about"),
        picture: tag("picture"),
        // NIP-29 states these as bare tags rather than values, and both
        // matter to an agent deciding what to say: a public group is
        // readable by anyone, forever.
        public: flag("public"),
        private: flag("private"),
        open: flag("open"),
        closed: flag("closed"),
      };
    } catch {
      return { id: room.id, relay: room.relay };
    }
  }

  /** The newest `limit` messages in a room, oldest first. */
  async history(room: Room, limit: number): Promise<Inbound[]> {
    if (!room.relay) throw new Error("a NIP-29 room needs its relay");
    const events = await requestEvents(
      this.options.relays,
      [room.relay],
      [{ kinds: [KIND_GROUP_MESSAGE], "#h": [room.id], limit }],
    );
    return events
      .map((event) => this.toInbound(room.relay!, event))
      .filter((inbound): inbound is Inbound => inbound !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** One message by id, for walking a thread back past what is in memory. */
  async fetchById(room: Room, id: string): Promise<Inbound | null> {
    if (!room.relay) throw new Error("a NIP-29 room needs its relay");
    const events = await requestEvents(
      this.options.relays,
      [room.relay],
      [{ ids: [id] }],
    );
    const event = events.find((candidate) => candidate.id === id);
    return event ? this.toInbound(room.relay, event) : null;
  }

  /**
   * Say something in a group nobody asked in.
   *
   * A kind 9 with no `q`, because there is nothing to quote — an unprompted
   * message is not a reply to anything, and threading it under some arbitrary
   * event would put it in the wrong conversation.
   *
   * To the group's relay ALONE, for the same reason a reply goes nowhere else:
   * a kind 9 on a foreign relay is a public event no relay enforces and no
   * member of the group will ever see.
   */
  async post(
    room: Room,
    text: string,
    extraTags: string[][] = [],
  ): Promise<string> {
    const relay = room.relay;
    if (!relay) throw new Error("a NIP-29 room needs its relay");

    const event = await GroupMessageFactory.create({ id: room.id, relay }, text)
      .modifyPublicTags((tags) => [...tags, ...extraTags])
      .sign(this.options.signer);

    const outcomes = await publishTo(
      this.options.relays,
      [relay],
      event as NostrEvent,
      this.options.publishTimeoutMs,
    );
    if (!outcomes.some((outcome) => outcome.ok))
      throw new Error(
        `the group relay did not accept the message: ${outcomes
          .map((outcome) => outcome.message ?? "rejected")
          .join("; ")}`,
      );
    this.rememberOwn(event.id);
    return event.id;
  }

  /**
   * Reply in the room, threaded under what was said.
   *
   * Published to the group's relay ALONE: a kind 9 anywhere else is a public
   * event no relay enforces and no member of the group will ever see.
   *
   * Returns the published event's id so the caller can remember it — Hex's own
   * message comes straight back through the same subscription.
   */
  async reply(
    to: Inbound,
    text: string,
    extraTags: string[][] = [],
  ): Promise<string> {
    if (!to.room.relay) throw new Error("a NIP-29 room needs its relay");
    const relay = to.room.relay;
    const event = await GroupMessageFactory.reply(
      { id: to.room.id, relay },
      to.event,
      text,
    )
      // The `q` tag is what makes this a REPLY in a kind-9 room: NIP-C7 quotes
      // the parent, and grimoire reads `q` and ignores the factory's `e`. With
      // the relay hint and the author, so a client can fetch what is quoted.
      // The `e` stays for clients that thread on it instead.
      .modifyPublicTags((tags) => [
        ...tags,
        ["q", to.id, relay, to.author],
        ...extraTags,
      ])
      .sign(this.options.signer);

    const outcomes = await publishTo(
      this.options.relays,
      [to.room.relay],
      event as NostrEvent,
      this.options.publishTimeoutMs,
    );
    if (!outcomes.some((outcome) => outcome.ok))
      throw new Error(
        `the group relay did not accept the reply: ${outcomes
          .map((outcome) => outcome.message ?? "rejected")
          .join("; ")}`,
      );
    this.rememberOwn(event.id);
    return event.id;
  }

  /**
   * React to a message — the "I'm on it" ack.
   *
   * A kind 7 in a NIP-29 group needs the `h` tag like everything else, or the
   * relay will not accept it as part of the group. Published to the group's relay
   * alone, same as the reply.
   */
  async react(to: Inbound, emoji: string): Promise<string> {
    if (!to.room.relay) throw new Error("a NIP-29 room needs its relay");
    const roomId = to.room.id;
    const event = await ReactionFactory.create(to.event, emoji)
      .modifyPublicTags((tags) => [...tags, ["h", roomId]])
      .sign(this.options.signer);

    const outcomes = await publishTo(
      this.options.relays,
      [to.room.relay],
      event as NostrEvent,
      this.options.publishTimeoutMs,
    );
    if (!outcomes.some((outcome) => outcome.ok))
      throw new Error(
        `the group relay did not accept the reaction: ${outcomes
          .map((outcome) => outcome.message ?? "rejected")
          .join("; ")}`,
      );
    return event.id;
  }

  stop(): void {
    // The subscriptions belong to whoever subscribed to `start()`; tearing the
    // stream down is their unsubscribe. Nothing else is held here.
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
