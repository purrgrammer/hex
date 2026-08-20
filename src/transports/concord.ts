/**
 * Concord communities — CORD-01 through CORD-08, the half an agent needs.
 *
 * A Concord channel is not a room on a relay. It is a STREAM: kind-1059 wraps
 * published by a key derived from a community secret, to one-time recipients,
 * encrypted under a key only members hold. The relay stores ciphertext by an
 * author it cannot associate with anybody, and hands it to whoever can prove
 * ownership of that address over NIP-42 — which the client can, because it
 * derived the address in the first place.
 *
 * Three consequences shape everything here, and none of them apply to the two
 * transports next door:
 *
 * - **Hex authenticates as the STREAM, not as Hex.** A relay gating kind 1059
 *   requires every `authors` entry in a REQ to be authenticated on the
 *   connection, and Hex's own key cannot satisfy that. So this transport holds
 *   its own pool, and answers a challenge once per stream address it reads.
 *   That pool must never be the one Hex's identity signs on: a socket
 *   authenticated as Hex AND as a community's channel address tells the relay
 *   exactly which member is behind that pseudonym.
 * - **An address is a key AND an epoch.** A rotation re-addresses the channel,
 *   so a transport that ignores CORD-06 does not break — it goes quietly deaf
 *   in a room that still looks configured. The rekey watch below is what stops
 *   that, and adoption is additive so following one can never lose the room.
 * - **A reply is a NIP-22 comment (1111), never a kind-9 with a `q` tag.** The
 *   NIP-29 transport threads the other way round, and getting this backwards
 *   renders wrong in every Concord client.
 *
 * What this transport does not have is the Control fold: the community's own
 * statement of which channels exist and what they are called. Private channels
 * arrive with the invite that granted them; a public channel has to be named by
 * id in the config. Said out loud rather than hidden, because a missing feature
 * that looks like a working one is the worst shape one can take.
 */

import { Observable, Subject, type Subscription } from "rxjs";
import { finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";

import type { ISigner } from "../signer.js";
import {
  createRelays,
  publishTo,
  requestEvents,
  subscribe,
  type HexRelays,
} from "../relays.js";
import { addressesSelfInGroup } from "../policy.js";
import type { Inbound, Room, Transport } from "./types.js";
import { bytesToHex, hex32, type GroupKey } from "../concord/derive.js";
import {
  KIND_COMMENT,
  KIND_MESSAGE,
  KIND_REACTION,
  KIND_SEAL_ENCRYPTED,
  KIND_WRAP,
  KIND_WRAP_EPHEMERAL,
  PLANE_KINDS,
  TIMELINE_KINDS,
} from "../concord/kinds.js";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  sealRumor,
  wrapSeal,
  type OpenedEvent,
} from "../concord/stream.js";
import {
  adoptChannelKey,
  adoptRoot,
  channelStreams,
  currentChannelKey,
  currentRoot,
  currentStream,
  type HeldChannel,
  type Membership,
} from "../concord/membership.js";
import {
  base64ToBytes,
  checkContinuity,
  decodeWrappedBaseKey,
  decodeWrappedKey,
  findBlob,
  groupRotations,
  myLocator,
  parseRekey,
  rekeyScopeId,
  rotationPublishedAtMs,
  REKEY_LOOKAHEAD,
  ROOT_SCOPE_HEX,
  type ParsedRekey,
  type RekeyRotationSet,
} from "../concord/rekey.js";
import { channelRekeyGroupKey, baseRekeyGroupKey } from "../concord/derive.js";

/** NIP-42's authentication event. */
const KIND_CLIENT_AUTH = 22242;

/**
 * How far back a stream with no cursor resumes.
 *
 * Short on purpose: this is a LIVE subscription and the gate refuses a backlog
 * anyway, so asking a relay for a week of ciphertext buys nothing but work.
 */
const FRESH_LOOKBACK_SECONDS = 5 * 60;
/** Ceiling on a resumed cursor: a daemon down for a month resumes at a week. */
const MAX_CURSOR_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Overlap subtracted from a resumed cursor, for clock skew and borderline events. */
const CURSOR_OVERLAP_SECONDS = 60;

/** How many of Hex's own rumor ids to keep in memory, for recognising a reply. */
const MAX_OWN_IDS = 500;

/**
 * What this transport needs to remember across restarts.
 *
 * Narrow on purpose: the transport should not know it is talking to SQLite, and
 * the tests should not need a database to prove a rotation is followed.
 */
export interface ConcordDurability {
  /** Newest `created_at` ingested from a stream at a relay, unix seconds. */
  cursorFor(relay: string, streamPk: string): number | undefined;
  rememberCursor(relay: string, streamPk: string, at: number): void;
  /** Has this rumor already been ingested — in this run or a previous one? */
  sawRumor(rumorId: string): boolean;
  rememberRumor(rumorId: string, own: boolean, at: number): void;
  /** Did Hex write this rumor? Answered across restarts, unlike the memory set. */
  isOwnRumor(rumorId: string): boolean;
  /** A membership changed — a rotation was adopted. Persist it. */
  saveMembership(membership: Membership): void;
}

export interface ConcordTransportOptions {
  signer: ISigner;
  pubkey: string;
  /** The communities Hex holds keys for, already resolved from invites. */
  memberships: Membership[];
  /** Names Hex answers to, beyond a `p` tag on the rumor. */
  mentions: string[];
  /** Unix seconds. A stream with no stored cursor starts here. */
  since: number;
  durability?: ConcordDurability;
  publishTimeoutMs?: number;
  log?: (line: string) => void;
  /** Its own pool by default; injectable so a test can drive one. */
  relays?: HexRelays;
}

/** A chat stream Hex reads: one channel at one epoch. */
interface ChatStreamBinding {
  membership: Membership;
  channel: HeldChannel;
  epoch: bigint;
  group: GroupKey;
}

/** A rekey address Hex watches: one scope at one candidate epoch. */
interface RekeyStreamBinding {
  membership: Membership;
  /** The channel this rotation would re-key, or undefined for the root. */
  channel?: HeldChannel;
  scopeIdHex: string;
  newEpoch: bigint;
  group: GroupKey;
}

/** `community:channel` — a channel id is only meaningful inside its community. */
export function concordRoomId(
  communityIdHex: string,
  channelIdHex: string,
): string {
  return `${communityIdHex}:${channelIdHex}`;
}

/** Split a room id back into its two halves, or nothing if it is not one. */
export function parseConcordRoomId(
  id: string,
): { communityIdHex: string; channelIdHex: string } | undefined {
  const [communityIdHex, channelIdHex, ...rest] = id.split(":");
  if (!communityIdHex || !channelIdHex || rest.length > 0) return undefined;
  return { communityIdHex, channelIdHex };
}

/**
 * Which message a chat rumor replies to.
 *
 * A NIP-22 comment (1111) names its immediate parent with a lowercase `e`; the
 * uppercase `E` is the thread ROOT and threading to it would flatten a long
 * exchange into one turn. A kind 9 has no thread at all — its `q` is an inline
 * quote (NIP-C7), which is still the best available answer to "what is this
 * about", and is what the NIP-29 transport reads too.
 */
export function replyTargetOf(opened: OpenedEvent): string | undefined {
  if (opened.kind === KIND_COMMENT)
    return opened.tags.find((tag) => tag[0] === "e" && tag[1])?.[1];
  return opened.tags.find((tag) => tag[0] === "q" && tag[1])?.[1];
}

export class ConcordTransport implements Transport {
  readonly name = "concord" as const;

  private readonly relays: HexRelays;
  /** True when the pool is this transport's own and must be closed with it. */
  private readonly ownsRelays: boolean;
  private readonly log: (line: string) => void;

  private readonly inbound$ = new Subject<Inbound>();
  private subscriptions: Subscription[] = [];
  private started = false;
  private stopped = false;

  /** Stream address → what reading it means. Rebuilt on every rotation. */
  private chat = new Map<string, ChatStreamBinding>();
  private rekeys = new Map<string, RekeyStreamBinding>();
  /** Rekey chunks seen per scope, until a rotation is complete enough to adopt. */
  private readonly rekeyChunks = new Map<string, ParsedRekey[]>();

  /** Stream secrets by address, for answering a relay's NIP-42 challenge. */
  private readonly streamKeys = new Map<string, Uint8Array>();
  /** One in-flight AUTH per (relay, stream), because a challenge can fire twice. */
  private readonly authing = new Set<string>();

  /**
   * What Hex said in these rooms, this run.
   *
   * A reply to one of these addresses Hex whether or not it repeats the name,
   * which is what makes a conversation a conversation. Backed by the durable
   * answer when one is configured, so a follow-up to yesterday's message still
   * lands.
   */
  private readonly ownRumorIds = new Set<string>();
  /** Rumors already emitted, so four relays serving one wrap is one message. */
  private readonly seen = new Set<string>();

  constructor(private readonly options: ConcordTransportOptions) {
    this.relays = options.relays ?? createRelays();
    this.ownsRelays = options.relays === undefined;
    this.log = options.log ?? (() => {});
  }

  /** Every community relay, deduplicated. */
  private allRelays(): string[] {
    return [
      ...new Set(
        this.options.memberships.flatMap((membership) => membership.relays),
      ),
    ];
  }

  private membershipFor(communityIdHex: string): Membership | undefined {
    return this.options.memberships.find(
      (candidate) => candidate.communityIdHex === communityIdHex,
    );
  }

  // ── Addressing ────────────────────────────────────────────────────────────

  /**
   * Derive every address to read, from what is currently held.
   *
   * Recomputed after each adopted rotation rather than kept: the address set IS
   * a function of the keys, and two places holding it would disagree the moment
   * one rotated.
   */
  private index(): void {
    this.chat = new Map();
    this.rekeys = new Map();
    this.streamKeys.clear();

    for (const membership of this.options.memberships) {
      for (const channel of membership.channels) {
        for (const stream of channelStreams(membership, channel)) {
          this.chat.set(stream.group.pk, {
            membership,
            channel,
            epoch: stream.epoch,
            group: stream.group,
          });
          this.streamKeys.set(stream.group.pk, stream.group.sk);
        }
      }

      // The rotations that would move this community on. Watched a window
      // ahead, because a daemon that was down through a rotation must be able
      // to catch up — or to learn that it was removed — rather than polling an
      // address nobody will ever publish to again.
      const root = currentRoot(membership);
      if (root) {
        for (let ahead = 1n; ahead <= BigInt(REKEY_LOOKAHEAD); ahead++) {
          const newEpoch = root.epoch + ahead;
          const group = baseRekeyGroupKey(
            root.key,
            hex32(membership.communityIdHex),
            newEpoch,
          );
          this.rekeys.set(group.pk, {
            membership,
            scopeIdHex: ROOT_SCOPE_HEX,
            newEpoch,
            group,
          });
          this.streamKeys.set(group.pk, group.sk);
        }
      }

      for (const channel of membership.channels) {
        if (!channel.isPrivate) continue;
        const held = currentChannelKey(channel);
        if (!held || !root) continue;
        for (let ahead = 1n; ahead <= BigInt(REKEY_LOOKAHEAD); ahead++) {
          const newEpoch = held.epoch + ahead;
          // Addressed from the PRIOR COMMUNITY ROOT, not from the channel key:
          // a rotation has to be findable by everyone the community still
          // trusts, and only the root is held by all of them.
          const group = channelRekeyGroupKey(root.key, channel.id, newEpoch);
          this.rekeys.set(group.pk, {
            membership,
            channel,
            scopeIdHex: channel.idHex,
            newEpoch,
            group,
          });
          this.streamKeys.set(group.pk, group.sk);
        }
      }
    }
  }

  // ── NIP-42, as every stream ───────────────────────────────────────────────

  /**
   * Answer one relay's challenge for every address this transport reads there.
   *
   * A relay's challenge stays valid for the socket's lifetime and a connection
   * may hold many authenticated pubkeys, so this is extra AUTH frames on one
   * challenge rather than a socket per stream. Signed locally with the derived
   * key: the whole point is that Hex's own signer is not involved and the relay
   * never learns which member is behind the address.
   */
  private async authenticateStreams(url: string): Promise<void> {
    let relay;
    try {
      relay = this.relays.pool.relay(url);
    } catch (error) {
      this.log(
        `[hex] ${url} could not be dialled for Concord: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const challenge = relay.challenge;
    if (!challenge) return;

    for (const [pk, sk] of this.streamKeys) {
      const key = `${url}|${pk}`;
      if (this.authing.has(key)) continue;
      this.authing.add(key);
      try {
        const auth = finalizeEvent(
          {
            kind: KIND_CLIENT_AUTH,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", url],
              ["challenge", challenge],
            ],
            content: "",
          },
          sk,
        );
        const response = await relay.auth(auth);
        if (!response.ok)
          this.log(
            `[hex] ${url} refused a Concord stream's authentication: ${
              response.message ?? "no reason given"
            }`,
          );
      } catch (error) {
        this.log(
          `[hex] ${url} would not authenticate a Concord stream: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        this.authing.delete(key);
      }
    }
  }

  private watchAuth(): void {
    for (const url of this.allRelays()) {
      let relay;
      try {
        relay = this.relays.pool.relay(url);
      } catch {
        continue;
      }
      const sign = (required: boolean) => {
        if (!required) return;
        void this.authenticateStreams(url);
      };
      this.subscriptions.push(
        relay.authRequiredForRead$.subscribe(sign),
        relay.authRequiredForPublish$.subscribe(sign),
      );
    }
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** Where a stream resumes at a relay: its cursor, bounded, or the fresh floor. */
  private sinceFor(relay: string, streamPk: string): number {
    const now = Math.floor(Date.now() / 1000);
    const stored = this.options.durability?.cursorFor(relay, streamPk);
    if (stored === undefined)
      return Math.max(0, this.options.since - FRESH_LOOKBACK_SECONDS);
    return Math.max(stored - CURSOR_OVERLAP_SECONDS, now - MAX_CURSOR_AGE_SECONDS);
  }

  private roomFor(binding: ChatStreamBinding): Room {
    return {
      transport: "concord",
      id: concordRoomId(binding.membership.communityIdHex, binding.channel.idHex),
      label: `${binding.channel.name} (${binding.membership.name})`,
    };
  }

  /**
   * Open one wrap into a message, or refuse it.
   *
   * Both fences of the plane boundary are here, and neither is optional. The
   * channel BINDING stops a keyholder splicing someone's rumor into a channel
   * they never wrote in; the kind fence stops the reverse — a chat keyholder
   * wrapping a control-plane kind and having a later reader serve it as
   * community state. Hex folds no control state today, which is exactly when a
   * fence is cheap to install.
   */
  private ingestChat(
    event: NostrEvent,
    binding: ChatStreamBinding,
  ): Inbound | null {
    let opened: OpenedEvent;
    try {
      opened = openWrap(event, binding.group);
      checkChannelBinding(opened, binding.channel.idHex, binding.epoch);
    } catch (error) {
      // A wrap that will not open is ordinary: relays serve every stream this
      // pool asks for, and one channel's key opens none of another's.
      this.log(
        `[hex] concord: a wrap at ${binding.group.pk.slice(0, 8)}… was refused: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    if (PLANE_KINDS.has(opened.kind)) {
      this.log(
        `[hex] concord: refused a plane kind (${opened.kind}) inside a channel`,
      );
      return null;
    }
    if (!TIMELINE_KINDS.has(opened.kind)) return null;
    if (opened.author === this.options.pubkey) {
      this.remember(opened.rumorId, true);
      return null;
    }
    if (this.alreadySeen(opened.rumorId)) return null;
    this.remember(opened.rumorId, false);

    const replyToId = replyTargetOf(opened);
    const inbound: Inbound = {
      id: opened.rumorId,
      author: opened.author,
      text: opened.content,
      createdAt: opened.createdAt,
      room: this.roomFor(binding),
      addressesSelf: false,
      ...(replyToId ? { replyToId } : {}),
      /**
       * The rumor, in event's clothing.
       *
       * A rumor carries no signature — its authorship was proven by the seal,
       * which has already been verified and discarded — so `sig` is empty
       * rather than fabricated. Everything downstream reads tags and content;
       * nothing re-verifies, and nothing may, because there is nothing here to
       * verify against.
       */
      event: {
        id: opened.rumorId,
        pubkey: opened.author,
        kind: opened.kind,
        tags: opened.tags,
        content: opened.content,
        created_at: opened.createdAt,
        sig: "",
      },
    };

    const continuesConversation =
      inbound.replyToId !== undefined &&
      (this.ownRumorIds.has(inbound.replyToId) ||
        (this.options.durability?.isOwnRumor(inbound.replyToId) ?? false));

    return {
      ...inbound,
      addressesSelf:
        continuesConversation ||
        addressesSelfInGroup(inbound, this.options.pubkey, this.options.mentions),
    };
  }

  private alreadySeen(rumorId: string): boolean {
    return (
      this.seen.has(rumorId) ||
      (this.options.durability?.sawRumor(rumorId) ?? false)
    );
  }

  private remember(rumorId: string, own: boolean): void {
    this.seen.add(rumorId);
    if (own) {
      this.ownRumorIds.add(rumorId);
      if (this.ownRumorIds.size > MAX_OWN_IDS) {
        const oldest = this.ownRumorIds.values().next();
        if (!oldest.done) this.ownRumorIds.delete(oldest.value);
      }
    }
    this.options.durability?.rememberRumor(
      rumorId,
      own,
      Math.floor(Date.now() / 1000),
    );
  }

  // ── Rotations ─────────────────────────────────────────────────────────────

  /**
   * A rekey wrap arrived: park its chunk, and adopt the rotation once every
   * chunk of it is in hand.
   *
   * A rotation may be chunked across several events, and a missing chunk is a
   * gap rather than a removal — so nothing is decided on a partial set.
   */
  private async ingestRekey(
    event: NostrEvent,
    binding: RekeyStreamBinding,
  ): Promise<void> {
    let parsed: ParsedRekey;
    try {
      const opened = openWrap(event, binding.group);
      parsed = parseRekey(opened);
    } catch {
      return;
    }
    if (
      parsed.scopeIdHex !== binding.scopeIdHex ||
      parsed.newEpoch !== binding.newEpoch
    )
      return;

    const key = `${binding.membership.communityIdHex}|${binding.scopeIdHex}|${binding.newEpoch}`;
    const parked = this.rekeyChunks.get(key) ?? [];
    if (parked.some((chunk) => chunk.rumorId === parsed.rumorId)) return;
    parked.push(parsed);
    this.rekeyChunks.set(key, parked);

    for (const rotation of groupRotations(parked)) {
      if (!rotation.complete) continue;
      const adopted = await this.adopt(binding, rotation);
      if (adopted) {
        this.rekeyChunks.delete(key);
        return;
      }
    }
  }

  private async adopt(
    binding: RekeyStreamBinding,
    rotation: RekeyRotationSet,
  ): Promise<boolean> {
    const membership = binding.membership;
    const held = binding.channel
      ? currentChannelKey(binding.channel)
      : currentRoot(membership);
    if (!held) return false;

    const continuity = checkContinuity(rotation, held.epoch, held.key);
    if (!continuity.ok) {
      // A gap says an earlier rotation was missed and this one cannot be
      // chained onto what is held; a fork says the rotator was working from a
      // key this member never had. Neither is adopted, and neither costs the
      // channel it is about — the epochs already held stay subscribed.
      this.log(
        `[hex] concord: a rotation of ${binding.scopeIdHex.slice(0, 8)}… was not adopted (${continuity.reason})`,
      );
      return false;
    }

    const locator = myLocator(
      rotation.rotator,
      this.options.pubkey,
      rotation.scopeIdHex,
      rotation.newEpoch,
    );
    const blob = findBlob(rotation, locator);
    if (!blob) {
      // A complete rotation with no blob at our locator is what a removal looks
      // like from the inside — but only if it published AFTER Hex joined. An
      // agent invited on a slightly stale bundle lands on a rotation it was
      // never part of, and reading that as a removal would evict it from a
      // community it had just been let into.
      if (rotationPublishedAtMs(rotation) >= membership.joinedAtMs)
        this.log(
          `[hex] concord: ${membership.name} rotated ${binding.scopeIdHex.slice(0, 8)}… with no key for Hex — it is out of that scope`,
        );
      return false;
    }

    // A blob is NIP-44'd to Hex's own identity, so opening one is the signer's
    // job and not this process's — which is what lets a bunker-held key follow
    // a rotation at all. A signer without NIP-44 cannot, and says so once
    // rather than looking like a community that never rotates.
    const nip44 = this.options.signer.nip44;
    if (!nip44) {
      this.log(
        "[hex] concord: this signer cannot decrypt NIP-44, so rotations cannot be followed",
      );
      return false;
    }

    let plain: Uint8Array;
    try {
      const decrypted = await nip44.decrypt(rotation.rotator, blob.wrapped);
      plain = base64ToBytes(decrypted);
    } catch (error) {
      this.log(
        `[hex] concord: a rotation blob would not decrypt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }

    try {
      if (binding.channel) {
        const newKey = decodeWrappedKey(
          plain,
          rekeyScopeId({ kind: "channel", channelId: binding.channel.id }),
          rotation.newEpoch,
        );
        if (
          !adoptChannelKey(membership, binding.channel.idHex, {
            epoch: rotation.newEpoch,
            key: newKey,
          })
        )
          return false;
        this.log(
          `[hex] concord: ${membership.name}/${binding.channel.name} rotated to epoch ${rotation.newEpoch}`,
        );
      } else {
        const base = decodeWrappedBaseKey(plain, rotation.newEpoch);
        if (
          !adoptRoot(
            membership,
            { epoch: rotation.newEpoch, key: base.newRoot },
            base.controlPk,
          )
        )
          return false;
        this.log(
          `[hex] concord: ${membership.name} refounded at epoch ${rotation.newEpoch}`,
        );
      }
    } catch (error) {
      this.log(
        `[hex] concord: a rotation blob was malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }

    this.options.durability?.saveMembership(membership);
    // The addresses just changed. Re-derive and re-subscribe, or Hex holds the
    // new key and goes on listening at the old address — deaf, with the key in
    // its hand.
    this.resubscribe();
    return true;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  private resubscribe(): void {
    if (this.stopped) return;
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];

    this.index();
    this.watchAuth();

    for (const membership of this.options.memberships) {
      const chatAuthors = [...this.chat]
        .filter(([, binding]) => binding.membership === membership)
        .map(([pk]) => pk);
      const rekeyAuthors = [...this.rekeys]
        .filter(([, binding]) => binding.membership === membership)
        .map(([pk]) => pk);

      for (const relay of membership.relays) {
        if (chatAuthors.length > 0) {
          const since = Math.min(
            ...chatAuthors.map((pk) => this.sinceFor(relay, pk)),
          );
          this.subscriptions.push(
            subscribe(
              this.relays,
              [relay],
              [
                {
                  kinds: [KIND_WRAP, KIND_WRAP_EPHEMERAL],
                  authors: chatAuthors,
                  since,
                },
              ],
            ).subscribe((event) => {
              const binding = this.chat.get(event.pubkey);
              if (!binding) return;
              this.options.durability?.rememberCursor(
                relay,
                event.pubkey,
                event.created_at,
              );
              const inbound = this.ingestChat(event, binding);
              if (inbound) this.inbound$.next(inbound);
            }),
          );
        }

        if (rekeyAuthors.length > 0) {
          this.subscriptions.push(
            subscribe(
              this.relays,
              [relay],
              [{ kinds: [KIND_WRAP], authors: rekeyAuthors }],
            ).subscribe((event) => {
              const binding = this.rekeys.get(event.pubkey);
              if (!binding) return;
              void this.ingestRekey(event, binding);
            }),
          );
        }
      }
    }
  }

  /**
   * Every channel of every community, as one stream.
   *
   * A Subject rather than a merge of the relay observables, because the address
   * set is not fixed for the life of the process: adopting a rotation replaces
   * every subscription underneath, and a caller holding one merged observable
   * must not have to resubscribe to keep hearing the same room.
   */
  start(): Observable<Inbound> {
    if (!this.started) {
      this.started = true;
      this.resubscribe();
    }
    return this.inbound$.asObservable();
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  private bindingFor(room: Room): {
    membership: Membership;
    channel: HeldChannel;
    stream: { epoch: bigint; group: GroupKey };
  } {
    const parsed = parseConcordRoomId(room.id);
    if (!parsed)
      throw new Error(`${room.id} is not a Concord room id (community:channel)`);
    const membership = this.membershipFor(parsed.communityIdHex);
    if (!membership)
      throw new Error(
        `Hex holds no keys for community ${parsed.communityIdHex.slice(0, 8)}…`,
      );
    const channel = membership.channels.find(
      (candidate) => candidate.idHex === parsed.channelIdHex,
    );
    if (!channel)
      throw new Error(
        `Hex holds no key for channel ${parsed.channelIdHex.slice(0, 8)}…`,
      );
    const stream = currentStream(membership, channel);
    if (!stream)
      throw new Error(`${channel.name} has no readable epoch — nothing to send under`);
    return { membership, channel, stream };
  }

  /**
   * Build, seal, wrap and publish one chat rumor.
   *
   * Exactly one signer round-trip, on the seal: the wrap is signed locally by
   * the stream key, which this process holds. Publishing goes to the community's
   * OWN relays and nowhere else — a wrap on a foreign relay is ciphertext no
   * member is subscribed to, which is indistinguishable from never having sent
   * it.
   */
  private async send(
    room: Room,
    kind: number,
    content: string,
    tags: string[][],
  ): Promise<string> {
    const { membership, channel, stream } = this.bindingFor(room);
    const ms = Date.now();
    const rumor = buildRumor({
      kind,
      content,
      tags: [...channelBindingTags(channel.idHex, stream.epoch), ...tags],
      pubkey: this.options.pubkey,
      ms,
    });
    const seal = await sealRumor(
      rumor,
      KIND_SEAL_ENCRYPTED,
      stream.group,
      this.options.signer,
    );
    const wrap = wrapSeal(seal, stream.group);

    const outcomes = await publishTo(
      this.relays,
      membership.relays,
      wrap,
      this.options.publishTimeoutMs,
    );
    if (!outcomes.some((outcome) => outcome.ok))
      throw new Error(
        `no relay of ${membership.name} took the message: ${outcomes
          .map((outcome) => outcome.message ?? "rejected")
          .join("; ")}`,
      );

    this.remember(rumor.id, true);
    return rumor.id;
  }

  /**
   * Say something nobody asked for: a kind 9 with no thread.
   *
   * Threading it under an arbitrary message would put an unprompted remark in
   * somebody else's conversation.
   */
  async post(room: Room, text: string, extraTags: string[][] = []): Promise<string> {
    return this.send(room, KIND_MESSAGE, text, extraTags);
  }

  /**
   * Reply, threaded under what was said — a NIP-22 comment (1111).
   *
   * Uppercase `K`/`E`/`P` pin the immutable thread ROOT and lowercase `k`/`e`/`p`
   * the immediate parent, so a reply to a reply keeps the root it inherited
   * instead of drifting one level deeper per turn. Every id here is a RUMOR id:
   * it names the decrypted message and means nothing outside the channel.
   */
  async reply(
    to: Inbound,
    text: string,
    extraTags: string[][] = [],
  ): Promise<string> {
    const tags: string[][] = [];
    const inherited = to.event.tags.filter(
      ([name]) => name === "K" || name === "E" || name === "P",
    );
    if (inherited.length > 0) {
      for (const tag of inherited) tags.push([...tag]);
    } else {
      tags.push(["K", String(to.event.kind)]);
      tags.push(["E", to.id, "", to.author]);
      tags.push(["P", to.author]);
    }
    tags.push(["k", String(to.event.kind)]);
    tags.push(["e", to.id, "", to.author]);
    tags.push(["p", to.author]);

    return this.send(to.room, KIND_COMMENT, text, [...tags, ...extraTags]);
  }

  /**
   * React to a message — the "I'm on it" ack.
   *
   * NIP-25 asks a reaction to name the author it reacts to, which is safe here
   * because the tag rides the encrypted rumor: it is recoverable to members and
   * invisible to the relay.
   */
  async react(to: Inbound, emoji: string): Promise<string> {
    return this.send(to.room, KIND_REACTION, emoji, [
      ["e", to.id],
      ["p", to.author],
    ]);
  }

  // ── Context ───────────────────────────────────────────────────────────────

  /**
   * The newest `limit` messages in a channel, oldest last.
   *
   * Every held epoch is asked, not just the current one: a channel that rotated
   * this morning has most of its conversation under yesterday's address, and a
   * thread missing its own beginning is worse than no history at all.
   */
  async history(
    room: Room,
    limit: number,
    options?: { includeOwn?: boolean },
  ): Promise<Inbound[]> {
    const parsed = parseConcordRoomId(room.id);
    if (!parsed) return [];
    const membership = this.membershipFor(parsed.communityIdHex);
    if (!membership) return [];
    const channel = membership.channels.find(
      (candidate) => candidate.idHex === parsed.channelIdHex,
    );
    if (!channel) return [];

    const streams = channelStreams(membership, channel);
    if (streams.length === 0) return [];

    const events = await requestEvents(
      this.relays,
      membership.relays,
      [
        {
          kinds: [KIND_WRAP],
          authors: streams.map((stream) => stream.group.pk),
          limit,
        },
      ],
    );

    const byPk = new Map(streams.map((stream) => [stream.group.pk, stream]));
    const out: Inbound[] = [];
    for (const event of events) {
      const stream = byPk.get(event.pubkey);
      if (!stream) continue;
      let opened: OpenedEvent;
      try {
        opened = openWrap(event, stream.group);
        checkChannelBinding(opened, channel.idHex, stream.epoch);
      } catch {
        continue;
      }
      if (!TIMELINE_KINDS.has(opened.kind)) continue;
      const own = opened.author === this.options.pubkey;
      if (own && !options?.includeOwn) continue;
      const replyToId = replyTargetOf(opened);
      out.push({
        id: opened.rumorId,
        author: opened.author,
        text: opened.content,
        createdAt: opened.createdAt,
        room,
        addressesSelf: false,
        ...(replyToId ? { replyToId } : {}),
        event: {
          id: opened.rumorId,
          pubkey: opened.author,
          kind: opened.kind,
          tags: opened.tags,
          content: opened.content,
          created_at: opened.createdAt,
          sig: "",
        },
      });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt).slice(-limit);
  }

  /**
   * What this room IS.
   *
   * Answered from what Hex holds rather than fetched, because there is nothing
   * to fetch: a Concord channel's metadata lives inside the Control Plane, which
   * this transport does not fold. What it CAN say is the part that changes how
   * an agent should answer — the community, the channel, and whether the room is
   * private — and `private` here means encrypted to a granted key, which is a
   * stronger statement than a NIP-29 group's flag of the same name.
   */
  async describeRoom(room: Room): Promise<Record<string, unknown> | undefined> {
    const parsed = parseConcordRoomId(room.id);
    if (!parsed) return undefined;
    const membership = this.membershipFor(parsed.communityIdHex);
    if (!membership) return undefined;
    const channel = membership.channels.find(
      (candidate) => candidate.idHex === parsed.channelIdHex,
    );
    if (!channel) return { community: membership.name };
    return {
      community: membership.name,
      communityId: membership.communityIdHex,
      owner: membership.owner,
      channel: channel.name,
      channelId: channel.idHex,
      private: channel.isPrivate,
      /**
       * Nothing here is world-readable, which is worth saying: a model deciding
       * how frank to be reads this, and "public" in Concord means public TO THE
       * MEMBERSHIP, never to a passer-by with a relay connection.
       */
      encrypted: true,
      epochs: channelStreams(membership, channel).map((stream) =>
        stream.epoch.toString(),
      ),
    };
  }

  stop(): void {
    this.stopped = true;
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];
    this.inbound$.complete();
    if (this.ownsRelays) this.relays.close();
  }

  /** The stream addresses currently read — for `hex check` and for tests. */
  get addresses(): string[] {
    if (this.chat.size === 0) this.index();
    return [...this.chat.keys()];
  }
}

/** Exposed for the tests that assert the wire shape without a relay. */
export const _internals = { bytesToHex };
