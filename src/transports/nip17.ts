/**
 * NIP-17 private direct messages.
 *
 * Two rules here are load-bearing and neither is obvious:
 *
 * 1. **A wrap authenticates as itself, never as Hex.** A gift wrap is signed by a
 *    throwaway key precisely so a relay cannot attribute it — and a socket that
 *    has NIP-42 AUTHed as Hex hands over exactly that. But plenty of inbox relays
 *    require NIP-42, and refusing them outright means mail that silently never
 *    arrives. So the peer's copy goes out on its own fresh socket, and if that
 *    relay asks for authentication it gets the throwaway key that signed the
 *    wrap: a pubkey it can already read off the event. Reading Hex's OWN mailbox
 *    authenticated as Hex costs nothing, because it is Hex's mailbox.
 *
 * 2. **A DM is addressed by existing.** Nobody writes "hex," in a private message
 *    to a bot. Every wrap that opens is addressed to Hex, so the mention rules do
 *    not apply — which makes the allow-list the only gate, and it is not
 *    optional: without one, anyone who can reach the inbox can spend the
 *    operator's tokens.
 *
 * The message ids in here are RUMOR ids: unsigned, on no relay, and not
 * addressable by anyone. They are still stable and unique, which is all the
 * session store needs.
 */

import { Observable, Subject } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { getEventHash } from "nostr-tools/pure";
import { RelayPool } from "applesauce-relay";
import { unlockGiftWrap, type Rumor } from "applesauce-common/helpers";
import { sealRumor } from "applesauce-common/operations/gift-wrap";
import { WrappedMessageFactory } from "applesauce-common/factories";
import { EventFactory } from "applesauce-core/factories";
import { PrivateKeySigner } from "applesauce-signers";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import type { ISigner } from "../signer.js";
import {
  publishTo,
  requestEvents,
  subscribe,
  type HexRelays,
} from "../relays.js";
import type { Inbound, Room, Transport } from "./types.js";

/** NIP-17 kinds. */
export const KIND_GIFT_WRAP = 1059;
export const KIND_PRIVATE_MESSAGE = 14;
/** NIP-25, as a rumor inside a wrap. */
export const KIND_REACTION = 7;
/** Where a peer says their wraps should be delivered. */
export const KIND_DM_RELAYS = 10050;

/** How many of a conversation's wraps to read at startup. */
const BACKFILL_LIMIT = 200;

export interface Nip17TransportOptions {
  relays: HexRelays;
  signer: ISigner;
  pubkey: string;
  /** Hex's own inbox — the same relays its kind 10050 announces. */
  inboxRelays: string[];
  /** Where to look up a peer's kind 10050. */
  readRelays: string[];
  /**
   * Who may talk to Hex here, as hex pubkeys.
   *
   * Not optional and not defaultable: a DM needs no mention to be addressed, so
   * an empty list means an open inbox that anyone can spend tokens through.
   */
  allow: string[];
  /** Unix seconds; wraps older than this are not fetched at startup. */
  since: number;
  publishTimeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * A wrap, and the throwaway key that signed it.
 *
 * Built here rather than by the factory because the key has to be KEPT: a relay
 * that demands NIP-42 gets authenticated with this key and no other. It is the
 * pubkey already on the wrap, so the relay learns nothing it was not about to
 * be told — whereas authenticating as Hex would hand it the sender.
 */
interface SealedWrap {
  event: NostrEvent;
  signer: PrivateKeySigner;
}

/** NIP-59 randomises timestamps up to two days back, to blur when mail moves. */
function randomPast(): number {
  return (
    Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 2 * 24 * 60 * 60)
  );
}

/** Does this rejection mean "authenticate first"? */
function needsAuth(message: string | undefined): boolean {
  return (message ?? "").toLowerCase().includes("auth-required");
}

/** A conversation is with one pubkey. */
function roomFor(pubkey: string): Room {
  return { transport: "nip-17", id: pubkey, label: `dm:${pubkey.slice(0, 8)}` };
}

export class Nip17Transport implements Transport {
  readonly name = "nip-17" as const;

  private readonly inbox = new Subject<Inbound>();
  private subscription?: { unsubscribe(): void };
  /** Wraps already opened. Decrypting costs a signer round trip. */
  private readonly seen = new Set<string>();
  private readonly ownRumorIds = new Set<string>();

  constructor(private readonly options: Nip17TransportOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  /**
   * Seal a rumor for one recipient and wrap it under a fresh throwaway key.
   *
   * The seal is signed by Hex — that is what proves who wrote the message, to
   * the recipient and to nobody else. The wrap is signed by the throwaway.
   */
  private async wrapFor(recipient: string, rumor: Rumor): Promise<SealedWrap> {
    const seal = await sealRumor(recipient, this.options.signer)(rumor);
    const key = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        created_at: randomPast(),
        content: nip44Encrypt(
          JSON.stringify(seal),
          getConversationKey(key, recipient),
        ),
        tags: [["p", recipient]],
      },
      key,
    );
    return { event, signer: new PrivateKeySigner(key) };
  }

  /** May this pubkey talk to Hex? */
  allows(pubkey: string): boolean {
    return this.options.allow.includes(pubkey);
  }

  /**
   * Open a wrap into the message it carries.
   *
   * Returns null for anything that is not a NIP-17 message from someone allowed
   * — including a wrap that will not open, which is normal: an inbox holds wraps
   * for keys Hex does not have.
   */
  private async toInbound(wrap: NostrEvent): Promise<Inbound | null> {
    if (this.seen.has(wrap.id)) return null;
    this.seen.add(wrap.id);

    let rumor: Rumor;
    try {
      rumor = await unlockGiftWrap(wrap, this.options.signer);
    } catch {
      return null;
    }

    if (rumor.kind !== KIND_PRIVATE_MESSAGE) return null;
    // Hex's own copy of what it sent, delivered back by its own inbox.
    if (rumor.pubkey === this.options.pubkey) return null;

    if (!this.allows(rumor.pubkey)) {
      this.log(
        `[hex] dm from ${rumor.pubkey.slice(0, 8)}… ignored — not on the allow list`,
      );
      return null;
    }

    const replyToId = rumor.tags.find((tag) => tag[0] === "e" && tag[1])?.[1];

    return {
      id: rumor.id,
      author: rumor.pubkey,
      text: rumor.content,
      createdAt: rumor.created_at,
      room: roomFor(rumor.pubkey),
      // A private message needs no mention: it was sent to Hex and nobody else.
      addressesSelf: true,
      replyToId,
      // The rumor, which is unsigned by construction. Nothing re-verifies it —
      // the wrap it came out of is the proof.
      event: { ...rumor, sig: "" } as NostrEvent,
    };
  }

  start(): Observable<Inbound> {
    const filter = {
      kinds: [KIND_GIFT_WRAP],
      "#p": [this.options.pubkey],
      // A wrap's `created_at` is randomised up to two days into the past, so the
      // floor is deliberately loose: a strict `since` drops messages sent now.
      since: this.options.since - 2 * 24 * 60 * 60,
    };

    this.subscription = subscribe(
      this.options.relays,
      this.options.inboxRelays,
      [filter],
    ).subscribe({
      next: (wrap) => {
        void this.toInbound(wrap).then((inbound) => {
          if (inbound) this.inbox.next(inbound);
        });
      },
      error: (error: unknown) => this.inbox.error(error),
    });

    return this.inbox.asObservable();
  }

  /**
   * A conversation's earlier messages.
   *
   * Read from Hex's own inbox and filtered to this peer after opening, because a
   * wrap says nothing about who is inside it — the sender is only known once it
   * is decrypted.
   */
  async history(room: Room, limit: number): Promise<Inbound[]> {
    const wraps = await requestEvents(
      this.options.relays,
      this.options.inboxRelays,
      [
        {
          kinds: [KIND_GIFT_WRAP],
          "#p": [this.options.pubkey],
          limit: Math.min(BACKFILL_LIMIT, limit * 10),
        },
      ],
    );

    const opened = await Promise.all(wraps.map((wrap) => this.toInbound(wrap)));
    return opened
      .filter((inbound): inbound is Inbound => inbound !== null)
      .filter((inbound) => inbound.room.id === room.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit);
  }

  async fetchById(): Promise<Inbound | null> {
    // A rumor id exists on no relay: there is nothing to fetch it from. The
    // session store is what remembers a conversation here.
    return null;
  }

  /**
   * Where a peer wants their mail.
   *
   * Their kind 10050, and nothing else — not their NIP-65 relays, not Hex's.
   * A wrap delivered where they do not read is a message that was never sent.
   */
  private async inboxOf(pubkey: string): Promise<string[]> {
    const events = await requestEvents(
      this.options.relays,
      this.options.readRelays,
      [{ kinds: [KIND_DM_RELAYS], authors: [pubkey], limit: 1 }],
    );
    const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
    return (newest?.tags ?? [])
      .filter((tag) => tag[0] === "relay" && tag[1])
      .map((tag) => tag[1]!);
  }

  /**
   * Send a private message.
   *
   * Two wraps: one for the peer, one for Hex, each sealed under its own
   * conversation key. Without the self-copy Hex cannot read back what it said —
   * its own inbox is the only record it has.
   */
  async reply(to: Inbound, text: string): Promise<string> {
    const peer = to.room.id;

    // Stamped, not signed: a rumor carries a pubkey and an id and no signature.
    // The id is computed here because the session store keys on it, and because
    // both wraps must carry the SAME rumor — one message, two envelopes.
    const unsigned = await WrappedMessageFactory.create(peer, text)
      .replyTo(to.id)
      .stamp(this.options.signer);
    const rumor = { ...unsigned, id: getEventHash(unsigned) } as Rumor;

    const theirInbox = await this.inboxOf(peer);
    if (theirInbox.length === 0)
      throw new Error(
        `${peer.slice(0, 8)}… publishes no kind 10050, so there is nowhere to deliver a private message`,
      );

    // THEIRS: wrapped under a throwaway key we keep, so a relay demanding
    // NIP-42 can be answered as that key rather than as Hex.
    const theirs = await this.wrapFor(peer, rumor);
    const delivered = await this.publishUnattributed(theirs, theirInbox);

    // OURS: Hex's own copy, on its own inbox, where authenticating as Hex is
    // fine — it is Hex's mailbox.
    const ours = await this.wrapFor(this.options.pubkey, rumor);
    await publishTo(
      this.options.relays,
      this.options.inboxRelays,
      ours.event,
      this.options.publishTimeoutMs,
    );

    if (!delivered)
      throw new Error(
        `no relay in ${peer.slice(0, 8)}…'s inbox accepted the message`,
      );

    const id = rumor.id;
    this.ownRumorIds.add(id);
    return id;
  }

  /**
   * React to a message — the "I'm on it" ack, privately.
   *
   * A reaction in a DM is a kind-7 RUMOR, wrapped like everything else: the same
   * two envelopes, the same inbox rules. A plain kind 7 published in the open
   * would announce, to anyone watching, that Hex is in a conversation with this
   * person about an event id nobody else can see — which is the one thing the
   * gift wrap exists to prevent.
   *
   * The `e` tag points at a rumor id, which exists on no relay. That is fine and
   * deliberate: the recipient has the rumor, and nobody else can resolve the
   * pointer.
   */
  async react(to: Inbound, emoji: string): Promise<string> {
    const peer = to.room.id;

    const unsigned = await EventFactory.fromKind(KIND_REACTION)
      .content(emoji)
      .modifyPublicTags((tags) => [
        ...tags,
        ["e", to.id],
        ["p", peer],
        ["k", String(KIND_PRIVATE_MESSAGE)],
      ])
      .stamp(this.options.signer);
    const rumor = { ...unsigned, id: getEventHash(unsigned) } as Rumor;

    const theirInbox = await this.inboxOf(peer);
    if (theirInbox.length === 0)
      throw new Error(
        `${peer.slice(0, 8)}… publishes no kind 10050, so there is nowhere to deliver a reaction`,
      );

    const theirs = await this.wrapFor(peer, rumor);
    const delivered = await this.publishUnattributed(theirs, theirInbox);

    // The self-copy, so Hex's own inbox shows the same conversation the peer
    // sees — a reaction missing from it is a hole in the record.
    const ours = await this.wrapFor(this.options.pubkey, rumor);
    await publishTo(
      this.options.relays,
      this.options.inboxRelays,
      ours.event,
      this.options.publishTimeoutMs,
    );

    if (!delivered)
      throw new Error(
        `no relay in ${peer.slice(0, 8)}…'s inbox accepted the reaction`,
      );

    return rumor.id;
  }

  /**
   * Publish a wrap, authenticating AS THE WRAP if a relay insists.
   *
   * Plenty of inbox relays require NIP-42, and refusing outright meant a message
   * that silently never arrived. So when one answers `auth-required`, Hex
   * authenticates with the throwaway key that signed this very wrap: the relay
   * already sees that pubkey as the event's author, so it learns nothing new —
   * and it still never learns that Hex is the sender, which is what
   * authenticating as Hex would have told it.
   *
   * A fresh socket per send, closed after. Reusing one connection across wraps
   * would let a relay tie their throwaway keys together by session, which is
   * precisely the linkage a throwaway exists to prevent.
   */
  private async publishUnattributed(
    wrap: SealedWrap,
    relays: string[],
  ): Promise<boolean> {
    const pool = new RelayPool();
    const timeout = this.options.publishTimeoutMs ?? 10_000;

    try {
      const outcomes = await Promise.all(
        relays.map(async (url) => {
          const relay = pool.relay(url);

          /**
           * One attempt.
           *
           * applesauce turns an `auth-required` rejection into a THROWN
           * AuthRequiredError rather than a falsy response — with retries off it
           * reaches us as an exception, so both shapes have to be read or the
           * retry below never fires and the message is silently lost.
           */
          const attempt = async (): Promise<{
            ok: boolean;
            reason?: string;
          }> => {
            try {
              const response = await relay.publish(wrap.event, {
                retries: 0,
                timeout,
              });
              return { ok: response.ok, reason: response.message };
            } catch (error) {
              return {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              };
            }
          };

          let result = await attempt();

          if (!result.ok && needsAuth(result.reason)) {
            try {
              const auth = await relay.authenticate(wrap.signer);
              if (!auth.ok) {
                this.log(
                  `[hex] ${url} refused the wrap's own authentication: ${auth.message ?? "no reason given"}`,
                );
                return false;
              }
            } catch (error) {
              this.log(
                `[hex] ${url} would not authenticate the wrap: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              return false;
            }
            this.log(`[hex] ${url} wanted NIP-42; authenticated as the wrap`);
            result = await attempt();
          }

          if (!result.ok)
            this.log(
              `[hex] ${url} did not take the wrap: ${result.reason ?? "no reason given"}`,
            );
          return result.ok;
        }),
      );
      return outcomes.some(Boolean);
    } finally {
      pool.close();
    }
  }

  /** Did Hex write this rumor? Used the same way the group transport does. */
  isOwnMessage(id: string): boolean {
    return this.ownRumorIds.has(id);
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.inbox.complete();
  }
}
