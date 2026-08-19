/**
 * Agent-session event kinds (NIP-xx: Agent Sessions).
 *
 * The transcript of an autonomous agent, as events. Numbered as a family with
 * grimoire's kind-777 "Spells" draft.
 *
 * DO NOT RENUMBER. Once a session has been published, its `a` tags name
 * `31777:<pubkey>:<session>` forever; changing a number orphans every
 * transcript already on a relay.
 *
 * The envelope is never reinvented: a copy is a rumor inside the ordinary NIP-59
 * stack (`1059` wrap, `13` seal), and an ephemeral one swaps the wrap for
 * `21059` so the relay drops it with its payload. Only `1777`/`21777`/`31777`/
 * `31779` are this NIP's.
 */

/** Agent Definition — addressable, `d` = agent slug. What the agent *is*. */
export const KIND_AGENT_DEFINITION = 31779;

/** Session Head — addressable, `d` = session id. What one run currently is. */
export const KIND_SESSION_HEAD = 31777;

/** Session Turn — regular, append-only. A correction is a new turn. */
export const KIND_TURN = 1777;

/**
 * Delta — ephemeral. Token-level output; relays MUST NOT store it. Everything a
 * delta carries is repeated in the `1777` that closes the turn, so a client that
 * missed one has lost nothing but liveness.
 */
export const KIND_DELTA = 21777;

/**
 * 1778 is deliberately unused. It held a "milestone" — a coarse stored progress
 * line — until it turned out to restate what the turn beside it already said.
 * What it alone could carry moved onto the head's `status`. Burned rather than
 * recycled, so a reader that once saw one never mistakes a later kind for it.
 */

/** Every kind this NIP defines. */
export const AGENT_SESSION_KINDS = [
  KIND_AGENT_DEFINITION,
  KIND_SESSION_HEAD,
  KIND_TURN,
  KIND_DELTA,
] as const;

/**
 * The kind that carries stream sequence: the turn, and only the turn.
 *
 * A delta evaporates at the relay and a head is replaced on it, so neither may
 * burn a sequence number — a number whose event the protocol itself removes is a
 * hole no reader can ever fill, on a stream that tells them to try.
 */
export const SEQUENCED_KINDS = [KIND_TURN] as const;

/** Kinds a private stream stores (and therefore hands to the DM pipeline). */
export const STORED_AGENT_KINDS = [
  KIND_AGENT_DEFINITION,
  KIND_SESSION_HEAD,
  KIND_TURN,
] as const;

export function isAgentSessionKind(kind: number): boolean {
  return (AGENT_SESSION_KINDS as readonly number[]).includes(kind);
}
