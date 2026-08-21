/**
 * Generators for the store's inputs, valid BY CONSTRUCTION.
 *
 * No post-hoc `.filter()` anywhere: a filtered arbitrary shrinks into invalid
 * values and then reports the shrink rather than the bug. Ids are derived from
 * bounded indices, so a shrunk counterexample still names the same row it named
 * before, and a history stays readable when it is three commands long.
 */

import fc from "fast-check";

import type { CanonicalEvent } from "../../ingest.js";
import type { OutboundSpec } from "../../store.js";

/** Sixty-four hex characters, from a small pool so collisions are reachable. */
export function idFrom(prefix: string, index: number): string {
  return `${prefix}${index}`.padEnd(64, "0").slice(0, 64);
}

export const TRANSPORTS = ["concord", "nip-29", "nip-17"] as const;

/** A handful of rooms and peers: a property about routing needs repeats. */
const ROOMS = ["community:general", "community:hex", "npub-dm"] as const;

export const peerArb = fc.nat({ max: 3 }).map((i) => idFrom("aa", i));
export const sessionArb = fc.nat({ max: 1 }).map((i) => `wrun_${i}`);

/**
 * One inbound message as the ingestor writes it.
 *
 * `id` comes from a bounded index so the same event can be offered twice —
 * which is the whole point of the dedupe this exercises — and `threadRoot` is
 * sometimes the id of another generated message, so a thread can actually be
 * threaded rather than always dangling.
 */
export const messageEventArb: fc.Arbitrary<CanonicalEvent> = fc
  .record({
    idIndex: fc.nat({ max: 5 }),
    transport: fc.constantFrom(...TRANSPORTS),
    room: fc.constantFrom(...ROOMS),
    peerIndex: fc.nat({ max: 3 }),
    text: fc.string({ maxLength: 24 }),
    tagsSelf: fc.boolean(),
    replyIndex: fc.option(fc.nat({ max: 5 }), { nil: undefined }),
    rootIndex: fc.option(fc.nat({ max: 5 }), { nil: undefined }),
    createdAt: fc.nat({ max: 1_000 }),
    observedAt: fc.nat({ max: 1_000 }),
  })
  .map((raw) => {
    const id = idFrom("ee", raw.idIndex);
    const peer = idFrom("aa", raw.peerIndex);
    const replyToId =
      raw.replyIndex === undefined ? undefined : idFrom("ee", raw.replyIndex);
    const threadRoot =
      raw.rootIndex === undefined ? undefined : idFrom("ee", raw.rootIndex);
    return {
      v: 1,
      type: "message",
      id,
      route: {
        transport: raw.transport,
        room: raw.room,
        peer,
        thread: threadRoot ?? replyToId,
      },
      createdAt: raw.createdAt,
      observedAt: raw.observedAt,
      payload: {
        text: raw.text,
        // Addressing is resolved from the fact, so a generated event carries
        // the fact and the answer that follows from it with nothing remembered.
        tagsSelf: raw.tagsSelf,
        addressesSelf: raw.tagsSelf,
        ...(replyToId !== undefined ? { replyToId } : {}),
        ...(threadRoot !== undefined ? { threadRoot } : {}),
      },
      raw: {
        id,
        pubkey: peer,
        kind: 1111,
        tags: [
          ...(threadRoot ? [["E", threadRoot]] : []),
          ...(replyToId ? [["e", replyToId]] : []),
        ],
        content: raw.text,
        created_at: raw.createdAt,
        sig: "",
      },
    } as unknown as CanonicalEvent;
  });

export const outboundSpecArb: fc.Arbitrary<OutboundSpec> = fc
  .record({
    kind: fc.constantFrom(
      "reply" as const,
      "reaction" as const,
      "wrap" as const,
    ),
    transport: fc.constantFrom(...TRANSPORTS),
    room: fc.constantFrom(...ROOMS),
    recipientIndex: fc.option(fc.nat({ max: 3 }), { nil: undefined }),
    text: fc.string({ maxLength: 24 }),
  })
  .map((raw) => ({
    kind: raw.kind,
    transport: raw.transport,
    room: raw.room,
    ...(raw.recipientIndex !== undefined
      ? { recipient: idFrom("aa", raw.recipientIndex) }
      : {}),
    payload: { text: raw.text },
  }));

/** A reservation key, from a pool small enough that two commands collide. */
export const reservationArb = fc.record({
  kind: fc.constantFrom(1621, 1617, 30617),
  scope: fc.constantFrom("", "repo-a", "repo-b"),
  subject: fc.constantFrom("one", "two"),
});

/**
 * How far a clock jump goes.
 *
 * Chosen rather than uniform: the interesting values are the horizons
 * themselves — ten minutes past a reservation, a week past a settled queue row,
 * a month past the replay guard — and a uniform integer would essentially never
 * land on one.
 */
export const clockJumpArb = fc.constantFrom(
  1,
  60,
  11 * 60,
  8 * 24 * 60 * 60,
  31 * 24 * 60 * 60,
);
