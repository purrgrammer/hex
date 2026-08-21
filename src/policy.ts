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
 * Word-boundary and case-insensitive, because "hexadecimal" is not a summons.
 * The boundary is asserted with lookarounds rather than `\b`, since a token may
 * start with `@` and `\b@hex` never matches — `@` is already a non-word
 * character.
 *
 * A BARE token matches with or without an `@`: someone who configures
 * `["hex"]` and then gets `@hex` in the room must not be met with silence,
 * which is the least debuggable failure this agent has. A token that spells the
 * `@` out is taken at its word and matches only the @-form.
 */
export function mentionsName(text: string, mentions: string[]): boolean {
  return mentions.some((token) => {
    const trimmed = token.trim();
    if (!trimmed) return false;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = trimmed.startsWith("@")
      ? new RegExp(`(?<![\\w@])${escaped}(?![\\w])`, "iu")
      : new RegExp(`(?<![\\w@])@?${escaped}(?![\\w])`, "iu");
    return pattern.test(text);
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
