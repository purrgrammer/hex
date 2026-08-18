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
}

export class Nip29Transport implements Transport {
  readonly name = "nip-29" as const;

  private stopped = false;

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
      event,
    };
    // The transport decides this: it is the layer that knows the tag shape.
    return {
      ...inbound,
      addressesSelf: addressesSelfInGroup(
        inbound,
        this.options.pubkey,
        this.options.mentions,
      ),
    };
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

  /**
   * Reply in the room, threaded under what was said.
   *
   * Published to the group's relay ALONE: a kind 9 anywhere else is a public
   * event no relay enforces and no member of the group will ever see.
   *
   * Returns the published event's id so the caller can remember it — Hex's own
   * message comes straight back through the same subscription.
   */
  async reply(to: Inbound, text: string): Promise<string> {
    if (!to.room.relay) throw new Error("a NIP-29 room needs its relay");
    const event = await GroupMessageFactory.reply(
      { id: to.room.id, relay: to.room.relay },
      to.event,
      text,
    ).sign(this.options.signer);

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
