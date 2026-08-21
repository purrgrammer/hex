/**
 * Getting Hex into a community, once, at startup.
 *
 * A Concord membership is key material rather than a row on a relay, so joining
 * is not a request anybody answers — it is coming into possession of an invite
 * and keeping what it carried. Three ways in, and this resolves all of them
 * into the same {@link Membership}:
 *
 * - what Hex already holds, from the store (the ordinary case after the first run);
 * - an invite LINK in the config, whose bundle is fetched from the relays the
 *   link names;
 * - a DIRECT invite sitting in Hex's mailbox, which is how an operator invites
 *   an agent the same way they would invite a person.
 *
 * Auto-accepting the third one is gated by an explicit list of who may invite
 * Hex. An open door here is not a nicety: joining a community means holding a
 * standing subscription and answering mentions in it, so anyone who could push
 * an invite could put Hex in a room of their choosing and spend the operator's
 * tokens there.
 */

import type { NostrEvent } from "nostr-tools";

import { requestEvents, type HexRelays } from "../relays.js";
import type { ISigner } from "../signer.js";
import {
  KIND_DIRECT_INVITE,
  parseDirectInviteRumor,
  unwrapDirectInvite,
} from "./direct-invite.js";
import {
  InviteError,
  inviteExpired,
  parseBundleEvent,
  parseInviteLink,
  type InviteBundle,
} from "./invite.js";
import { KIND_INVITE_BUNDLE, KIND_WRAP } from "./kinds.js";
import {
  declarePublicChannel,
  membershipFromBundle,
  membershipFromStored,
  mergeBundle,
  type Membership,
  type StoredMembership,
} from "./membership.js";

/** What the config says about one community Hex should be in. */
export interface ConcordCommunityConfig {
  /**
   * The community this entry is about, hex.
   *
   * Named even when an invite link is given, so the config states which
   * community it expects and a link that turns out to name another is a
   * mismatch rather than a silent join.
   */
  id: string;
  /** An invite link, if the operator has one. */
  invite?: string;
  /**
   * Public channels to listen in, by id.
   *
   * Required for a public channel because nothing here folds the Control Plane,
   * which is where a community says which channels exist. A private channel
   * needs no entry: its key arrives with the invite that granted it.
   */
  channels?: Array<{ id: string; name?: string }>;
}

export interface ConcordConfig {
  communities: ConcordCommunityConfig[];
  /**
   * Whose direct invites Hex accepts unprompted. Absent means none.
   */
  acceptInvitesFrom?: string[];
}

/** What resolving needs to read and write. */
export interface MembershipStore {
  storedMemberships(): StoredMembership[];
  saveMembership(membership: Membership): void;
}

export interface ResolveOptions {
  relays: HexRelays;
  signer: ISigner;
  pubkey: string;
  config: ConcordConfig;
  store?: MembershipStore;
  /** Where to look for direct invites: Hex's own inbox. */
  inboxRelays: string[];
  log?: (line: string) => void;
}

/** Fetch and open the bundle an invite link names. */
export async function fetchInviteBundle(
  relays: HexRelays,
  link: string,
): Promise<InviteBundle> {
  const parsed = parseInviteLink(link);
  if (!parsed)
    throw new InviteError("bad-link", "that is not a Concord invite link");
  const events = await requestEvents(
    relays,
    parsed.bootstrapRelays,
    [
      {
        kinds: [KIND_INVITE_BUNDLE],
        authors: [parsed.linkSigner],
        "#d": [""],
      },
    ],
  );
  // Newest first: a link is refreshed in place, and an old copy still on some
  // relay would hand back keys the community has already rotated past.
  const newest = events
    .filter((event) => event.pubkey === parsed.linkSigner)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!newest)
    throw new InviteError(
      "bad-link",
      "no invite bundle was found at that link's coordinate",
    );
  return parseBundleEvent(newest, parsed.linkSigner, parsed.token);
}

/**
 * Direct invites in Hex's mailbox, from people allowed to send them.
 *
 * Indexed by the outer `k` tag where the sender set one, and by `#p` alone
 * otherwise — the tag is a hint, so both filters are asked and the answer is
 * whatever actually unwraps to a kind-3313 rumor.
 */
export async function readDirectInvites(
  options: Pick<ResolveOptions, "relays" | "signer" | "pubkey" | "log"> & {
    inboxRelays: string[];
    from: string[];
  },
): Promise<Array<{ bundle: InviteBundle; sender: string }>> {
  if (options.from.length === 0) return [];
  const events = await requestEvents(options.relays, options.inboxRelays, [
    {
      kinds: [KIND_WRAP],
      "#p": [options.pubkey],
      "#k": [String(KIND_DIRECT_INVITE)],
    },
  ]);

  const out: Array<{ bundle: InviteBundle; sender: string }> = [];
  const seen = new Set<string>();
  for (const wrap of events as NostrEvent[]) {
    const unwrapped = await unwrapDirectInvite(wrap, options.signer);
    if (!unwrapped) continue;
    // The seal proved who wrote it; this decides whether Hex takes anything
    // from that person. Checked here rather than at the call site so no later
    // call site can forget.
    if (!options.from.includes(unwrapped.sender)) {
      // The whole key, not a prefix: an operator who decides this invite was
      // fine has to be able to copy the pubkey into `acceptInvitesFrom`, and a
      // truncated one is a fact they cannot act on.
      options.log?.(
        `[hex] concord: an invite from ${unwrapped.sender} was ignored — not in acceptInvitesFrom`,
      );
      continue;
    }
    const bundle = parseDirectInviteRumor(
      unwrapped.rumor.kind,
      unwrapped.rumor.content,
    );
    if (!bundle) continue;
    if (inviteExpired(bundle)) {
      options.log?.(
        `[hex] concord: the invite to ${bundle.name} has expired`,
      );
      continue;
    }
    // One invite may be delivered by several relays; the community it names is
    // what makes two copies the same invite.
    const key = `${unwrapped.sender}|${bundle.community_id}|${bundle.root_epoch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bundle, sender: unwrapped.sender });
  }
  return out;
}

/**
 * Every community Hex is in, from the store, the config and the mailbox.
 *
 * A bundle that arrives for a community already held is a CATCH-UP rather than
 * a second membership — an admin healing a stranded member, or granting a
 * channel since — so it is merged, never allowed to replace what is held.
 */
export async function resolveMemberships(
  options: ResolveOptions,
): Promise<Membership[]> {
  const log = options.log ?? (() => {});
  const byCommunity = new Map<string, Membership>();

  for (const stored of options.store?.storedMemberships() ?? []) {
    try {
      const membership = membershipFromStored(stored);
      byCommunity.set(membership.communityIdHex, membership);
    } catch (error) {
      log(
        `[hex] concord: a stored membership would not load: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const declaredChannels = new Map<string, Array<{ id: string; name?: string }>>();
  for (const community of options.config.communities) {
    declaredChannels.set(
      community.id.toLowerCase(),
      (community.channels ?? []).map((channel) => ({
        id: channel.id.toLowerCase(),
        ...(channel.name ? { name: channel.name } : {}),
      })),
    );
  }

  const take = (bundle: InviteBundle, how: string): void => {
    const id = bundle.community_id.toLowerCase();
    const declared = declaredChannels.get(id);
    if (declared === undefined) {
      // An invite to a community the config never named is not joined. The
      // config is the operator's statement of where Hex belongs, and an agent
      // that joins whatever it is handed is one nobody can predict.
      log(
        `[hex] concord: an invite to ${bundle.name} was not accepted — that community is not in the config`,
      );
      return;
    }
    const held = byCommunity.get(id);
    if (!held) {
      byCommunity.set(id, membershipFromBundle(bundle, declared));
      log(`[hex] concord: joined ${bundle.name} (${how})`);
      return;
    }
    if (mergeBundle(held, bundle))
      log(`[hex] concord: ${bundle.name} caught up (${how})`);
  };

  for (const community of options.config.communities) {
    if (!community.invite) continue;
    try {
      const bundle = await fetchInviteBundle(options.relays, community.invite);
      if (bundle.community_id.toLowerCase() !== community.id.toLowerCase()) {
        log(
          `[hex] concord: the invite configured for ${community.id.slice(0, 8)}… names ${bundle.community_id.slice(0, 8)}… instead`,
        );
        continue;
      }
      take(bundle, "invite link");
    } catch (error) {
      log(
        `[hex] concord: the invite link for ${community.id.slice(0, 8)}… did not resolve: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (options.config.acceptInvitesFrom?.length) {
    try {
      const invites = await readDirectInvites({
        relays: options.relays,
        signer: options.signer,
        pubkey: options.pubkey,
        inboxRelays: options.inboxRelays,
        from: options.config.acceptInvitesFrom,
        log,
      });
      for (const invite of invites)
        take(invite.bundle, `invited by ${invite.sender.slice(0, 8)}…`);
    } catch (error) {
      log(
        `[hex] concord: the invite mailbox could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Channels named in the config after a membership was already stored — the
  // ordinary way a second channel is added — belong to it now.
  for (const [id, membership] of byCommunity) {
    for (const declared of declaredChannels.get(id) ?? [])
      declarePublicChannel(membership, declared);
    options.store?.saveMembership(membership);
  }

  return [...byCommunity.values()];
}
