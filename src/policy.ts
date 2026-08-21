/**
 * Whether a message is addressed to Hex at all.
 *
 * All that is left here of the old reply gate. What it decided — answer, steer,
 * ignore — is now a table (`policy-table.ts`) read by the runner, and what it
 * remembered — who is busy, what has been seen, how many replies this hour —
 * is the runner's lane and the durable queue. These three functions stayed
 * because only a transport can answer them, and it asks before an event is even
 * a canonical one.
 */

import type { Inbound } from "./transports/types.js";

/** Is Hex p-tagged on this event? */
export function tagsSelf(inbound: Inbound, selfPubkey: string): boolean {
  return inbound.event.tags.some(
    (tag) => tag[0] === "p" && tag[1] === selfPubkey,
  );
}

/**
 * Decide `addressesSelf` for a plaintext room. Transports own this call — a DM
 * addresses Hex by existing, a group message has to say so.
 *
 * Saying so means a `p` tag, and nothing else. Matching a name in the TEXT used
 * to count too, and it was the only one of Hex's doors that could open when
 * nobody had addressed anything: quote a message that said `@hex` and the text
 * carries the mention while the tags do not, because the quoter tags the
 * original author. No pattern fixes that — the text is genuinely ambiguous
 * about who is being spoken to, and a tag is not.
 *
 * The other two doors are unchanged and both are deliberate acts: a client's
 * mention picker writes the tag, and a reply in a thread Hex is answering in is
 * addressed by the thread.
 */
export function addressesSelfInGroup(
  inbound: Inbound,
  selfPubkey: string,
): boolean {
  return tagsSelf(inbound, selfPubkey);
}
