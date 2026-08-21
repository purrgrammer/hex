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

/**
 * Does this text address Hex by name?
 *
 * A mention has to be EXPLICIT: the text carries `@name`, or it is not a
 * summons. Saying the bare name used to count, and in a room named after the
 * agent that means ordinary conversation about it starts a paid turn — "hex is
 * just a bot you run on your computer or what?" was answered, at cost, by a
 * person who was talking about Hex rather than to it. Nobody types `@` by
 * accident.
 *
 * A configured token is the NAME, with or without the `@` spelled out; either
 * way the text needs one. So `["hex"]` and `["@hex"]` mean the same thing, and
 * an operator cannot accidentally configure the loose form.
 *
 * Word-boundary and case-insensitive, because `@hexagon` is not a summons
 * either. The boundary is asserted with lookarounds rather than `\b`, since
 * `\b@hex` never matches — `@` is already a non-word character.
 *
 * This is one of three ways to reach Hex, and the narrowest. A `p` tag naming
 * it counts (`tagsSelf`), which is what every client's mention picker writes;
 * and a reply in a thread Hex is already running counts, which is what makes a
 * conversation a conversation.
 */
export function mentionsName(text: string, mentions: string[]): boolean {
  return mentions.some((token) => {
    const name = token.trim().replace(/^@+/, "");
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\w@])@${escaped}(?![\\w])`, "iu").test(text);
  });
}

/** Is Hex p-tagged on this event? */
export function tagsSelf(inbound: Inbound, selfPubkey: string): boolean {
  return inbound.event.tags.some(
    (tag) => tag[0] === "p" && tag[1] === selfPubkey,
  );
}

/**
 * Decide `addressesSelf` for a plaintext room. Transports own this call — a DM
 * addresses Hex by existing, a group message has to say so.
 */
export function addressesSelfInGroup(
  inbound: Inbound,
  selfPubkey: string,
  mentions: string[],
): boolean {
  return tagsSelf(inbound, selfPubkey) || mentionsName(inbound.text, mentions);
}
