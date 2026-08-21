/**
 * Asking relays to forget something this agent published.
 *
 * NIP-09's kind 5 is a REQUEST. A relay that already served the note is under no
 * obligation to drop it, and a reader that cached it never hears the ask. So
 * this undoes a mistake as far as anything can, which is not all the way — the
 * honest framing everywhere in this module.
 *
 * Kind 5 stays in `GUARDED_KINDS` for `nostr.publish` and `nostr.sign`, and this
 * is the sanctioned path instead. The difference is the check below: a raw kind
 * 5 can name any id at all, and aimed at the wrong one it asks the network to
 * destroy someone else's work. This one fetches every target first and refuses
 * anything the agent did not sign. `publish.ts` already says why that is enough
 * — "the agent's own key is authority enough for its own notes" — and the
 * fetch is what turns that sentence into something checked rather than assumed.
 *
 * An id that cannot be found is refused too, and deliberately: not-found means
 * authorship could not be established, which is the one thing this must never
 * guess at.
 */

import type { EventTemplate, NostrEvent } from "nostr-tools";

import {
  publishTo,
  requestEvents,
  type HexRelays,
  type PublishOutcome,
} from "./relays.js";

/** What this needs of a signer: the one method, however the key is held. */
export interface RetractSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

export interface RetractOptions {
  relays: HexRelays;
  signer: RetractSigner;
  /** The agent's own pubkey. Nothing signed by anyone else may be named. */
  pubkey: string;
  /** Where to look the targets up. */
  readRelays: string[];
  /** Where the request goes. */
  publishRelays: string[];
  /** Goes in the deletion request's content, for whoever reads it. */
  reason?: string;
  /** Resolve the targets and build the request, but publish nothing. */
  dryRun?: boolean;
}

/** One id, and what became of it. */
export interface RetractTarget {
  id: string;
  /** The kind it turned out to be, once found. */
  kind?: number;
  /** Absent when it was retracted; a sentence when it was not. */
  refused?: string;
}

export interface Retraction {
  targets: RetractTarget[];
  /** The signed kind 5, when at least one target survived the checks. */
  request?: NostrEvent;
  outcomes: PublishOutcome[];
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Retract what this agent published, and report per id what happened.
 *
 * One request for the whole batch rather than one per id: NIP-09 takes many `e`
 * tags, and a single event is one thing for a relay to accept or refuse.
 */
export async function retract(
  ids: string[],
  options: RetractOptions,
): Promise<Retraction> {
  const wanted = [...new Set(ids.map((id) => id.trim().toLowerCase()))];
  const targets: RetractTarget[] = [];

  const malformed = wanted.filter((id) => !HEX_64.test(id));
  const lookups = wanted.filter((id) => HEX_64.test(id));

  for (const id of malformed)
    targets.push({ id, refused: "not a 64-character hex event id" });

  const found = new Map<string, NostrEvent>();
  if (lookups.length > 0) {
    const events = await requestEvents(options.relays, options.readRelays, [
      { ids: lookups },
    ]);
    for (const event of events) found.set(event.id, event);
  }

  const retractable: NostrEvent[] = [];
  for (const id of lookups) {
    const event = found.get(id);
    if (!event) {
      targets.push({
        id,
        refused:
          "not found on the relays this agent reads, so who signed it could " +
          "not be established",
      });
      continue;
    }
    if (event.pubkey !== options.pubkey) {
      targets.push({
        id,
        kind: event.kind,
        refused: `signed by ${event.pubkey.slice(0, 8)}…, not by this agent`,
      });
      continue;
    }
    targets.push({ id, kind: event.kind });
    retractable.push(event);
  }

  if (retractable.length === 0) return { targets, outcomes: [] };

  const kinds = [...new Set(retractable.map((event) => event.kind))];
  const request = await options.signer.signEvent({
    kind: 5,
    content: options.reason ?? "",
    tags: [
      ...retractable.map((event) => ["e", event.id]),
      // NIP-09: naming the kinds lets a relay apply its own per-kind rules
      // without fetching what is being deleted.
      ...kinds.map((kind) => ["k", String(kind)]),
    ],
    created_at: Math.floor(Date.now() / 1000),
  });

  if (options.dryRun) return { targets, request, outcomes: [] };

  const outcomes = await publishTo(
    options.relays,
    options.publishRelays,
    request,
  );
  return { targets, request, outcomes };
}
