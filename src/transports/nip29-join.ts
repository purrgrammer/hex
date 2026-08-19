/**
 * Joining a NIP-29 group.
 *
 * Split out from the transport because it is the one part of NIP-29 that writes
 * before Hex has read anything: `hex join --auto` does it for every group
 * configured with `autoJoin`, and `hex join` calls it on its own.
 *
 * Everything here is addressed to ONE relay — the group's own. A kind 9021 sent
 * anywhere else is not a join request, it is a public event nobody enforces.
 */

import type { NostrEvent } from "nostr-tools";
import type { Nip29GroupConfig } from "../config.js";
import type { ISigner } from "../signer.js";
import { publishTo, requestEvents, type HexRelays } from "../relays.js";

/** Relay-maintained membership lists (NIP-29). */
const KIND_GROUP_ADMINS = 39001;
const KIND_GROUP_MEMBERS = 39002;
/** A join request. */
export const KIND_JOIN_REQUEST = 9021;

export type JoinOutcome =
  /** Already listed as a member or admin — no request sent. */
  | { group: string; action: "already-member" }
  /** The request was accepted by the relay. What happens next is the relay's. */
  | { group: string; action: "requested" }
  | { group: string; action: "failed"; detail: string };

/**
 * Is `pubkey` in the group's member or admin list?
 *
 * Admins count: a relay lists an admin in 39001 and need not repeat them in
 * 39002, so checking members alone would have Hex ask to join a group it
 * moderates.
 *
 * A relay that answers with nothing is treated as "not a member", which is the
 * safe direction — the cost of being wrong is one redundant join request, and
 * the cost of the opposite is a group Hex never joins and so never reads.
 */
export async function isGroupMember(
  relays: HexRelays,
  group: Nip29GroupConfig,
  pubkey: string,
  timeoutMs?: number,
): Promise<boolean> {
  const events = await requestEvents(
    relays,
    [group.relay],
    [
      {
        kinds: [KIND_GROUP_MEMBERS, KIND_GROUP_ADMINS],
        // `d` is the group id, verbatim: `#h` and `#d` are case-sensitive, and
        // two casings on one relay are two rooms.
        "#d": [group.id],
      },
    ],
    { timeoutMs },
  );

  return events.some((event) =>
    event.tags.some((tag) => tag[0] === "p" && tag[1] === pubkey),
  );
}

export interface JoinOptions {
  now?: () => number;
  lookupTimeoutMs?: number;
  publishTimeoutMs?: number;
  /** Log the request instead of sending it. */
  dryRun?: boolean;
}

/** Ask to join one group, unless Hex is already in it. */
export async function joinGroup(
  relays: HexRelays,
  signer: ISigner,
  pubkey: string,
  group: Nip29GroupConfig,
  options: JoinOptions = {},
): Promise<JoinOutcome> {
  const label = `${group.relay}'${group.id}`;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  if (await isGroupMember(relays, group, pubkey, options.lookupTimeoutMs))
    return { group: label, action: "already-member" };

  if (options.dryRun) return { group: label, action: "requested" };

  try {
    const event = await signer.signEvent({
      kind: KIND_JOIN_REQUEST,
      content: "",
      tags: [["h", group.id]],
      created_at: now(),
    });
    // The group's relay, and nothing else.
    const outcomes = await publishTo(
      relays,
      [group.relay],
      event as NostrEvent,
      options.publishTimeoutMs,
    );
    const accepted = outcomes.filter((outcome) => outcome.ok);
    if (accepted.length === 0)
      return {
        group: label,
        action: "failed",
        detail: outcomes
          .map((outcome) => outcome.message ?? "rejected")
          .join("; "),
      };
    return { group: label, action: "requested" };
  } catch (error) {
    return {
      group: label,
      action: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Join every group a transport config marks `autoJoin`.
 *
 * Groups are joined concurrently but each on its own relay, and one relay
 * refusing never stops the others: a bot that cannot enter one room should still
 * be in the rest.
 */
export async function joinConfiguredGroups(
  relays: HexRelays,
  signer: ISigner,
  pubkey: string,
  groups: Nip29GroupConfig[],
  options: JoinOptions = {},
): Promise<JoinOutcome[]> {
  return Promise.all(
    groups.map((group) => joinGroup(relays, signer, pubkey, group, options)),
  );
}
