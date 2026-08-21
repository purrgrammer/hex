/**
 * The one thing about addressing a transport can answer on its own.
 *
 * This file used to hold the whole decision, and does not any more: whether a
 * message is FOR Hex depends on what Hex has been doing, which is durable
 * state, and the layer that owns tag shapes has no business reading a database
 * to finish that sentence. `addressing.ts` decides; this reports the fact it
 * decides with.
 *
 * What is left is a predicate over tags — exactly what a transport can see, and
 * exactly what it should be asked for.
 */

/** Is Hex named by a `p` tag on this event? */
export function tagsSelf(tags: string[][], selfPubkey: string): boolean {
  return tags.some((tag) => tag[0] === "p" && tag[1] === selfPubkey);
}
