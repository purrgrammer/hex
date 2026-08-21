/**
 * Whether a message is for Hex — decided once, in one place.
 *
 * This used to live in the transports, and it was the wrong home for it. A
 * transport's job is tag shapes: it can see that a `p` tag names Hex, and that
 * is a fact about the event in front of it. But "is this for me" also depends
 * on what Hex has been DOING — which threads it is answering in, which messages
 * it wrote — and that is durable state. So each of the three transports reached
 * into the store to finish the sentence, and the layer that owns tag shapes
 * ended up owning a policy decision it could not test without a database.
 *
 * Here instead, as a pure function over a fact and a lookup. The transports
 * report `namesSelf` and stop; the ingestor resolves this before the message
 * becomes a queue row; the policy table reads the answer.
 *
 * It is also the seam the next thing needs. Capability has to follow the
 * channel — a DM from the operator, a group message, and a stranger's DM must
 * not resolve to the same toolset — and that is a question about exactly the
 * triple this function already has in hand: the room, the requester, and what
 * Hex is already doing with them. "Is this for me" and "what may they ask for"
 * are the same lookup asked twice, and they belong in the same place.
 */

import type { Inbound } from "./transports/types.js";

/**
 * What the answer needs from durable state.
 *
 * Two questions, both about Hex's own history rather than about the event: is
 * this thread one Hex is answering in, and is this message a reply to something
 * Hex said. An implementation that answers `false` to both is valid and means
 * "nothing remembered" — a fresh home addresses nobody by continuation.
 */
export interface AddressingBindings {
  /** Is this root (or parent) bound to a run of Hex's, in this room? */
  threadIsOurs(rootId: string, room: string): boolean;
  /** Did Hex publish this message? Kept for rooms whose threads predate binding. */
  isOwnMessage(id: string): boolean;
}

/** Nothing is remembered: only the tags can address Hex. */
export const NOTHING_REMEMBERED: AddressingBindings = {
  threadIsOurs: () => false,
  isOwnMessage: () => false,
};

/**
 * Is this message addressed to Hex?
 *
 * Three ways in, and every one of them is a deliberate act by the sender:
 *
 * - the room is a private conversation with Hex, so the message was sent to it
 *   and to nobody else — `namesSelf` carries this for a DM;
 * - a `p` tag names Hex, which is what a client's mention picker writes;
 * - it continues something of Hex's: a reply to a message Hex wrote, or a reply
 *   in a thread Hex is already answering in.
 *
 * Matching Hex's NAME in the message text was a fourth, and it is gone. It was
 * the only one that could fire when nobody had addressed anything: quote a
 * message that said `@hex` and the text carries the mention while the tags name
 * the original author.
 *
 * The thread check is what makes a conversation a conversation. Without it the
 * mention has to be retyped on every message, because a reply threads onto
 * whatever it answers — which in a live thread is usually the PERSON'S own
 * opening message, not anything Hex wrote.
 */
export function addresses(
  inbound: Inbound,
  room: string,
  bindings: AddressingBindings,
): boolean {
  if (inbound.namesSelf) return true;

  const parent = inbound.replyToId;
  if (parent !== undefined) {
    if (bindings.isOwnMessage(parent)) return true;
    if (bindings.threadIsOurs(parent, room)) return true;
  }

  const root = inbound.threadRoot;
  return root !== undefined && bindings.threadIsOurs(root, room);
}
