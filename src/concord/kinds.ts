/**
 * Concord's event kinds — CORD-02 Appendix B (frozen).
 *
 * Ported from grimoire's `src/lib/concord/kinds.ts`, narrowed to what a server
 * that reads a channel and answers in it actually touches. The numbers are wire
 * format: they are copied rather than imported because this package must not
 * reach into the app, and a number invented here is a message no other client
 * can read.
 *
 * Every durable plane event is a kind-1059 wrap around a seal (CORD-01); the
 * INNER rumor carries the functional kind. Kinds Hex neither writes nor renders
 * are still listed where the plane fence below has to recognise them.
 */

// ── Envelope kinds (CORD-01) ────────────────────────────────────────────────

/** Durable stream wrap — the outer envelope of every stored plane event. */
export const KIND_WRAP = 1059;
/** Ephemeral wrap: identical structure, relays MUST NOT store it. */
export const KIND_WRAP_EPHEMERAL = 21059;
/** Encrypted seal: the rumor is NIP-44-encrypted again inside the wrap. */
export const KIND_SEAL_ENCRYPTED = 20013;
/** Plaintext seal: the content is the rumor's JSON string, byte-verbatim. */
export const KIND_SEAL_PLAINTEXT = 20014;

// ── Chat Plane rumor kinds (CORD-03) ────────────────────────────────────────

/** A chat message (NIP-C7 shape; `q` is an inline quote, NOT a thread). */
export const KIND_MESSAGE = 9;
/**
 * A threaded reply — a NIP-22 comment pointing at its thread root (`K`/`E`/`P`)
 * and its immediate parent (`k`/`e`/`p`).
 *
 * A reply is NEVER a kind 9 with a `q` tag: NIP-C7 reserves `q` for inline
 * quote-replies, and conflating the two renders wrong in every other client.
 * This is the one place Concord's threading differs from the NIP-29 transport
 * next door, where a kind-9 `q` IS the reply.
 */
export const KIND_COMMENT = 1111;
/** A reaction (NIP-25 shape) — Hex's "I'm on it" ack. */
export const KIND_REACTION = 7;
/** A delete (NIP-09 shape, naming the author's own rumor ids). */
export const KIND_DELETE = 5;

/** Rumor kinds that are a message rather than a decoration on one. */
export const TIMELINE_KINDS: ReadonlySet<number> = new Set([
  KIND_MESSAGE,
  KIND_COMMENT,
]);

// ── Control / rekey rumor kinds ─────────────────────────────────────────────

/** A control edition (sub-kinded by its `vsk` tag). Hex reads none of them. */
export const KIND_CONTROL = 3308;
/** Rekey blobs (CORD-06), delivered at the rekey addresses. */
export const KIND_REKEY = 3303;
/** Guestbook join/leave, kick, snapshot — the membership plane. */
export const KIND_JOIN_LEAVE = 3306;
export const KIND_KICK = 3309;
export const KIND_SNAPSHOT = 3312;

// ── Bare kinds (outside the wrap) ───────────────────────────────────────────

/** A public invite bundle: addressable, signed by the per-link keypair, `d` empty. */
export const KIND_INVITE_BUNDLE = 33301;

/**
 * Every kind claimed by a NON-chat plane — the set the chat ingress refuses.
 *
 * A community's planes share one relay and a plane is read back BY KIND, so the
 * two ingresses have to fence each other. Without this fence a holder of any one
 * channel's stream key could wrap a kind-3308 rumor carrying a valid channel
 * binding and have a plane read serve it as a control edition. Hex folds no
 * control state today, but it refuses these at the chat boundary anyway: the
 * fence has to exist before the reader that would trust it does, not after.
 */
export const PLANE_KINDS: ReadonlySet<number> = new Set([
  KIND_CONTROL,
  KIND_REKEY,
  KIND_JOIN_LEAVE,
  KIND_KICK,
  KIND_SNAPSHOT,
]);
