/**
 * What Hex holds in a Concord community, and what that lets it read.
 *
 * A Concord membership is not a row on a relay — it IS a set of keys. There is
 * no server to ask whether Hex is a member, no address to knock at, and nothing
 * to revoke: an invite hands over the community_root and whatever private
 * channel keys were granted, and holding them is the whole of belonging. Which
 * is why this file, not a relay, is the authority on what Hex can read.
 *
 * Two things it deliberately keeps, both learned from grimoire:
 *
 * - **History is not one key.** A channel accumulates streams — one per held
 *   root epoch (what it wrote while public) and one per held channel key,
 *   current and retired. Reading only the current one is why rotating a key
 *   appears to erase a conversation.
 * - **Adoption is additive.** A rotation ADDS an epoch and never drops one, so
 *   following a rotation can never cost Hex the room it is already in.
 *
 * What it does NOT do is fold the Control Plane. That fold is where a community
 * says which channels exist and what they are called, and it is a thousand lines
 * of edition ordering and delegation authority that this package does not have.
 * The consequence is stated rather than hidden: PRIVATE channels arrive with the
 * invite that granted them, and a PUBLIC channel has to be named in the config
 * by its id, because nothing here can discover one.
 */

import {
  bytesToHex,
  channelGroupKey,
  hex32,
  type GroupKey,
} from "./derive.js";
import type { InviteBundle } from "./invite.js";

/** One key at one epoch. Held forever: it is what keeps old messages readable. */
export interface HeldEpochKey {
  epoch: bigint;
  key: Uint8Array;
}

/** A channel Hex can read, and the keys that let it. */
export interface HeldChannel {
  id: Uint8Array;
  idHex: string;
  name: string;
  /**
   * Private channels only: the independent channel key, current first, priors
   * after. Empty for a public channel, whose streams come from the roots.
   */
  keys: HeldEpochKey[];
  isPrivate: boolean;
}

/** One community, as this process holds it. */
export interface Membership {
  communityIdHex: string;
  /** The owner whose key the community_id commits to (A.4). */
  owner: string;
  name: string;
  /** Where the community's planes live. Every read and write goes here. */
  relays: string[];
  /** The community_root per epoch, newest first. */
  roots: HeldEpochKey[];
  /** The Control Plane address, carried for a reader that folds it. Hex does not. */
  controlPk?: string;
  channels: HeldChannel[];
  /**
   * When this membership began, epoch ms.
   *
   * Not decoration: a rotation that carries no blob for Hex means removal only
   * if it published AFTER the join. A member who joined on a stale invite lands
   * on a historical rotation they were never part of, and reading that as a
   * removal would evict them from a community they had just entered.
   */
  joinedAtMs: number;
}

/** A channel stream: one address, at one epoch. */
export interface ChannelStream {
  epoch: bigint;
  group: GroupKey;
}

function byEpochDesc(a: HeldEpochKey, b: HeldEpochKey): number {
  return a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0;
}

/**
 * Build a membership from an accepted invite bundle plus the public channels the
 * operator named.
 *
 * A public channel is taken on the operator's word, because there is nobody else
 * to ask: without the Control fold, an id in the config is the only way one is
 * known. It costs nothing if it is wrong — a channel nobody writes to is an
 * address that stays quiet — which is the right failure for a guess.
 */
export function membershipFromBundle(
  bundle: InviteBundle,
  publicChannels: Array<{ id: string; name?: string }> = [],
  joinedAtMs = Date.now(),
): Membership {
  const channels: HeldChannel[] = [];

  for (const granted of bundle.channels) {
    if (!/^[0-9a-f]{64}$/i.test(granted.id) || !/^[0-9a-f]{64}$/i.test(granted.key))
      continue;
    const idHex = granted.id.toLowerCase();
    channels.push({
      id: hex32(idHex),
      idHex,
      name: granted.name || idHex.slice(0, 8),
      keys: [{ epoch: BigInt(granted.epoch), key: hex32(granted.key) }],
      isPrivate: true,
    });
  }

  for (const declared of publicChannels) {
    const idHex = declared.id.toLowerCase();
    // A channel granted privately and ALSO named as public is a contradiction,
    // and the grant is the one with evidence behind it.
    if (channels.some((channel) => channel.idHex === idHex)) continue;
    channels.push({
      id: hex32(idHex),
      idHex,
      name: declared.name || idHex.slice(0, 8),
      keys: [],
      isPrivate: false,
    });
  }

  return {
    communityIdHex: bundle.community_id.toLowerCase(),
    owner: bundle.owner.toLowerCase(),
    name: bundle.name,
    relays: bundle.relays,
    roots: [
      { epoch: BigInt(bundle.root_epoch), key: hex32(bundle.community_root) },
    ],
    ...(bundle.control_pk ? { controlPk: bundle.control_pk } : {}),
    channels,
    joinedAtMs,
  };
}

/**
 * Every stream a channel's history lives in, newest epoch first.
 *
 * A public channel reads the root-derived stream at every held root epoch. A
 * private one reads ONLY its own channel keys — never the root stream every
 * public channel shares, because those messages are readable by the whole
 * membership and surfacing them inside a private room would present public
 * words as private ones.
 */
export function channelStreams(
  membership: Membership,
  channel: HeldChannel,
): ChannelStream[] {
  const sources = channel.isPrivate ? channel.keys : membership.roots;
  return [...sources]
    .sort(byEpochDesc)
    .map((held) => ({
      epoch: held.epoch,
      group: channelGroupKey(held.key, channel.id, held.epoch),
    }));
}

/** Where a message Hex sends goes: the newest epoch it holds for that channel. */
export function currentStream(
  membership: Membership,
  channel: HeldChannel,
): ChannelStream | undefined {
  return channelStreams(membership, channel)[0];
}

/** The newest root epoch held — what a rotation extends. */
export function currentRoot(membership: Membership): HeldEpochKey | undefined {
  return [...membership.roots].sort(byEpochDesc)[0];
}

/** The newest key held for a private channel. */
export function currentChannelKey(
  channel: HeldChannel,
): HeldEpochKey | undefined {
  return [...channel.keys].sort(byEpochDesc)[0];
}

function addEpochKey(into: HeldEpochKey[], adopted: HeldEpochKey): boolean {
  const existing = into.find((held) => held.epoch === adopted.epoch);
  if (existing) {
    // Same epoch, different key: a race between two rotators (CORD-06 §3). Both
    // stay readable in practice because the loser's messages were sent under a
    // key somebody holds; what must converge is which one Hex writes under.
    if (bytesToHex(existing.key) === bytesToHex(adopted.key)) return false;
    if (bytesToHex(adopted.key) < bytesToHex(existing.key)) {
      into.push({ epoch: adopted.epoch, key: existing.key });
      existing.key = adopted.key;
      return true;
    }
    into.push(adopted);
    return true;
  }
  into.push(adopted);
  return true;
}

/**
 * Adopt a rotated community_root. Additive: the prior epoch stays held, so
 * every public channel keeps its history and its old address stays subscribed.
 */
export function adoptRoot(
  membership: Membership,
  adopted: HeldEpochKey,
  controlPk?: string,
): boolean {
  const changed = addEpochKey(membership.roots, adopted);
  if (changed && controlPk) membership.controlPk = controlPk;
  return changed;
}

/** Adopt a rotated private channel key. Additive, for the same reason. */
export function adoptChannelKey(
  membership: Membership,
  channelIdHex: string,
  adopted: HeldEpochKey,
): boolean {
  const channel = membership.channels.find(
    (candidate) => candidate.idHex === channelIdHex.toLowerCase(),
  );
  if (!channel || !channel.isPrivate) return false;
  return addEpochKey(channel.keys, adopted);
}

/**
 * Add a public channel the operator named.
 *
 * Separate from the invite path because a public channel is not GRANTED — it
 * derives from the community_root every member already holds, so declaring one
 * hands over no key and costs nothing if the id is wrong: an address nobody
 * writes to simply stays quiet.
 */
export function declarePublicChannel(
  membership: Membership,
  declared: { id: string; name?: string },
): boolean {
  const idHex = declared.id.toLowerCase();
  if (membership.channels.some((channel) => channel.idHex === idHex))
    return false;
  membership.channels.push({
    id: hex32(idHex),
    idHex,
    name: declared.name || idHex.slice(0, 8),
    keys: [],
    isPrivate: false,
  });
  return true;
}

// ── Persistence ─────────────────────────────────────────────────────────────
//
// A membership is key material, and the process that holds it restarts. Kept as
// JSON in the agent's own SQLite home, at the same trust level as the rest of it:
// anyone who can read that file can read the community, which is exactly as true
// of the Eve transcripts already stored beside it.

export interface StoredMembership {
  communityId: string;
  owner: string;
  name: string;
  relays: string[];
  controlPk?: string;
  roots: Array<{ epoch: string; key: string }>;
  channels: Array<{
    id: string;
    name: string;
    isPrivate: boolean;
    keys: Array<{ epoch: string; key: string }>;
  }>;
  joinedAtMs: number;
}

export function membershipToStored(membership: Membership): StoredMembership {
  const epochKeys = (keys: HeldEpochKey[]) =>
    keys.map((held) => ({
      epoch: held.epoch.toString(),
      key: bytesToHex(held.key),
    }));
  return {
    communityId: membership.communityIdHex,
    owner: membership.owner,
    name: membership.name,
    relays: membership.relays,
    ...(membership.controlPk ? { controlPk: membership.controlPk } : {}),
    roots: epochKeys(membership.roots),
    channels: membership.channels.map((channel) => ({
      id: channel.idHex,
      name: channel.name,
      isPrivate: channel.isPrivate,
      keys: epochKeys(channel.keys),
    })),
    joinedAtMs: membership.joinedAtMs,
  };
}

export function membershipFromStored(stored: StoredMembership): Membership {
  const epochKeys = (keys: StoredMembership["roots"]): HeldEpochKey[] =>
    keys.map((held) => ({ epoch: BigInt(held.epoch), key: hex32(held.key) }));
  return {
    communityIdHex: stored.communityId,
    owner: stored.owner,
    name: stored.name,
    relays: stored.relays,
    ...(stored.controlPk ? { controlPk: stored.controlPk } : {}),
    roots: epochKeys(stored.roots),
    channels: stored.channels.map((channel) => ({
      id: hex32(channel.id),
      idHex: channel.id,
      name: channel.name,
      isPrivate: channel.isPrivate,
      keys: epochKeys(channel.keys),
    })),
    joinedAtMs: stored.joinedAtMs,
  };
}

/**
 * Fold a freshly-read invite into a membership already held.
 *
 * An invite arriving for a community Hex is already in is a CATCH-UP: an admin
 * healing a stranded member, or granting a channel since. It may only ever add —
 * a bundle at a lower epoch is stale, and letting it win would walk the
 * membership backwards into keys the community has already rotated away from.
 */
export function mergeBundle(
  membership: Membership,
  bundle: InviteBundle,
): boolean {
  let changed = adoptRoot(
    membership,
    { epoch: BigInt(bundle.root_epoch), key: hex32(bundle.community_root) },
    bundle.control_pk,
  );
  for (const granted of bundle.channels) {
    if (!/^[0-9a-f]{64}$/i.test(granted.id) || !/^[0-9a-f]{64}$/i.test(granted.key))
      continue;
    const idHex = granted.id.toLowerCase();
    const held = membership.channels.find(
      (candidate) => candidate.idHex === idHex,
    );
    const adopted = { epoch: BigInt(granted.epoch), key: hex32(granted.key) };
    if (!held) {
      membership.channels.push({
        id: hex32(idHex),
        idHex,
        name: granted.name || idHex.slice(0, 8),
        keys: [adopted],
        isPrivate: true,
      });
      changed = true;
      continue;
    }
    if (!held.isPrivate) continue;
    if (addEpochKey(held.keys, adopted)) changed = true;
  }
  return changed;
}
