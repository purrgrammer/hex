/**
 * What a transport can answer about addressing on its own.
 *
 * Whether a message is FOR Hex depends on what Hex has been doing, which is
 * durable state — that decision lives in `addressing.ts`. What lives here is
 * the fact it is built on, and the fact is not as simple as "is Hex p-tagged".
 *
 * A `p` tag means two different things depending on why it is there. NIP-27
 * says a client SHOULD add one for every `nostr:` reference in the content, so
 * a mention is a `p` tag. But NIP-10 and NIP-22 also put the parent's author —
 * and NIP-22's uppercase `P`, the ROOT's author — on every reply in a thread.
 * So once Hex has said one thing anywhere, every later message between two
 * humans under it carries Hex's pubkey, written by their client, meaning
 * nothing but "this is who is upstream".
 *
 * Reading that as an address is worse than the text-matching rule this replaced,
 * because a human had to type `@hex` for that one to misfire and here nobody
 * has to do anything at all. It is also expensive in exactly the place it is
 * most likely: a busy thread on something Hex posted.
 */

import { nip19 } from "nostr-tools";

/** Anything carrying the two things this reads. */
export interface Addressable {
  content: string;
  tags: string[][];
}

/** Is Hex named by a `p` tag — for any reason, deliberate or derived? */
export function tagsSelf(tags: string[][], selfPubkey: string): boolean {
  return tags.some(
    (tag) => (tag[0] === "p" || tag[0] === "P") && tag[1] === selfPubkey,
  );
}

/** Does this event point at anything — a parent, a root, a quote? */
function threads(tags: string[][]): boolean {
  return tags.some((tag) =>
    ["e", "E", "a", "A", "i", "I", "q"].includes(tag[0] ?? ""),
  );
}

const NOSTR_REF = /nostr:((?:npub|nprofile)1[02-9ac-hj-np-z]+)/gi;

/**
 * Does the CONTENT name Hex — the `nostr:` reference a person actually typed?
 *
 * Decoded rather than matched, because a reference is only an address if it
 * resolves to Hex: a message can name three people and the tags cannot say
 * which of them the writer meant. Both forms, because a picker may write either
 * and `nprofile` carries relay hints the bare key does not.
 *
 * A reference that will not decode is somebody's typo, not an address.
 */
export function mentionsSelf(content: string, selfPubkey: string): boolean {
  for (const [, ref] of content.matchAll(NOSTR_REF)) {
    try {
      const decoded = nip19.decode(ref as string);
      if (decoded.type === "npub" && decoded.data === selfPubkey) return true;
      if (decoded.type === "nprofile" && decoded.data.pubkey === selfPubkey)
        return true;
    } catch {
      // Not a reference, just text that looked like one.
    }
  }
  return false;
}

/**
 * Does this event name Hex deliberately?
 *
 * Two ways, and the second exists only to keep faith with clients that write a
 * mention without a `nostr:` reference in the content:
 *
 * - the content names Hex — unambiguous, whatever else the event carries;
 * - Hex is p-tagged on an event that points at NOTHING. A tag on a message with
 *   no parent, no root and no quote has no threading to explain it, so somebody
 *   put it there on purpose.
 *
 * A p-tag on a threaded event is not read as an address. It is what a client
 * writes for the author upstream, and treating it as a summons means two people
 * replying to each other under something Hex once said each pay for a turn.
 * Those conversations still reach Hex when they should — through the thread it
 * is answering in, which is a fact about Hex's own history rather than a guess
 * about somebody's tags.
 */
export function namesSelf(event: Addressable, selfPubkey: string): boolean {
  if (mentionsSelf(event.content, selfPubkey)) return true;
  return tagsSelf(event.tags, selfPubkey) && !threads(event.tags);
}
