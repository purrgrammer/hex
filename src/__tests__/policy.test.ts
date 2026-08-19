import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { ReplyGate, mentionsName, addressesSelfInGroup } from "../policy.js";
import type { Inbound, Room } from "../transports/types.js";

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);
const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://groups.example/",
};

let counter = 0;

function inbound(overrides: Partial<Inbound> = {}): Inbound {
  counter += 1;
  const text = overrides.text ?? "hex, are you there?";
  const author = overrides.author ?? OTHER;
  const event: NostrEvent = {
    id: overrides.id ?? `id${counter}`,
    pubkey: author,
    created_at: overrides.createdAt ?? 1000,
    kind: 9,
    content: text,
    tags: overrides.event?.tags ?? [],
    sig: "",
  };
  return {
    id: event.id,
    author,
    text,
    createdAt: event.created_at,
    room: overrides.room ?? ROOM,
    addressesSelf: overrides.addressesSelf ?? true,
    event,
    ...overrides,
  };
}

function gate(
  overrides: Partial<ConstructorParameters<typeof ReplyGate>[0]> = {},
) {
  return new ReplyGate({
    selfPubkey: SELF,
    mentions: ["hex"],
    startedAt: 900,
    repliesPerRoomPerHour: 2,
    now: () => 1000,
    ...overrides,
  });
}

describe("mentionsName", () => {
  it("matches on a word boundary, case-insensitively", () => {
    expect(mentionsName("Hex, help", ["hex"])).toBe(true);
    expect(mentionsName("ask HEX about it", ["hex"])).toBe(true);
  });

  it("does not match inside a longer word", () => {
    // "hexadecimal" is not a summons.
    expect(mentionsName("print it in hexadecimal", ["hex"])).toBe(false);
    expect(mentionsName("vertex please", ["hex"])).toBe(false);
  });

  it("matches an @-prefixed token, which \\b cannot", () => {
    expect(mentionsName("cc @hex", ["@hex"])).toBe(true);
  });

  it("matches an @ mention from a BARE token", () => {
    // Configuring ["hex"] and then being ignored because the room types "@hex"
    // is the least debuggable failure this agent has.
    expect(mentionsName("@hex what is this", ["hex"])).toBe(true);
    expect(mentionsName("cc @Hex", ["hex"])).toBe(true);
  });

  it("still refuses a longer word after the @", () => {
    expect(mentionsName("@hexagon ping", ["hex"])).toBe(false);
  });

  it("does not treat a bare name as an @ mention when the token spells the @", () => {
    expect(mentionsName("hex", ["@hex"])).toBe(false);
  });

  it("is false with no configured names", () => {
    expect(mentionsName("hex", [])).toBe(false);
  });
});

describe("addressesSelfInGroup", () => {
  it("is true for a p-tag even with no name in the text", () => {
    const message = inbound({
      text: "any thoughts?",
      event: { tags: [["p", SELF]] } as NostrEvent,
    });
    expect(addressesSelfInGroup(message, SELF, ["hex"])).toBe(true);
  });

  it("is false for someone else's p-tag and no name", () => {
    const message = inbound({
      text: "any thoughts?",
      event: { tags: [["p", OTHER]] } as NostrEvent,
    });
    expect(addressesSelfInGroup(message, SELF, ["hex"])).toBe(false);
  });
});

describe("ReplyGate", () => {
  it("replies to a fresh addressed message", () => {
    expect(gate().consider(inbound())).toEqual({ reply: true });
  });

  it("stays silent when not addressed", () => {
    expect(gate().consider(inbound({ addressesSelf: false }))).toEqual({
      reply: false,
      reason: "not-addressed",
    });
  });

  it("never answers itself", () => {
    // Hex's own reply comes back through the same subscription.
    expect(gate().consider(inbound({ author: SELF }))).toEqual({
      reply: false,
      reason: "own-message",
    });
  });

  it("ignores backfill from before startup", () => {
    expect(gate().consider(inbound({ createdAt: 500 }))).toEqual({
      reply: false,
      reason: "before-start",
    });
  });

  it("answers a message inside the startup grace window", () => {
    // startedAt 900, grace 30 -> 880 is still fair game.
    expect(gate().consider(inbound({ createdAt: 880 }))).toEqual({
      reply: true,
    });
  });

  it("treats a second copy of the same event as a duplicate", () => {
    const g = gate();
    const message = inbound();
    expect(g.consider(message)).toEqual({ reply: true });
    // Four inbox relays deliver four copies of one message.
    expect(g.consider(message)).toEqual({ reply: false, reason: "duplicate" });
  });

  it("remembers a message it refused, so a later copy is still a duplicate", () => {
    const g = gate();
    const message = inbound({ addressesSelf: false });
    expect(g.consider(message).reply).toBe(false);
    expect(g.consider(message)).toEqual({ reply: false, reason: "duplicate" });
  });

  it("allows only one reply in flight per room", () => {
    const g = gate();
    const first = inbound();
    expect(g.consider(first)).toEqual({ reply: true });
    g.begin(first);
    expect(g.consider(inbound())).toEqual({
      reply: false,
      reason: "in-flight",
    });
    g.end(first, true);
    expect(g.consider(inbound())).toEqual({ reply: true });
  });

  it("does not block a different room while one is in flight", () => {
    const g = gate();
    const first = inbound();
    g.begin(first);
    const elsewhere = inbound({
      room: {
        transport: "nip-29",
        id: "other",
        relay: "wss://groups.example/",
      },
    });
    expect(g.consider(elsewhere)).toEqual({ reply: true });
  });

  it("rate limits per room, and only counts replies that landed", () => {
    const g = gate();
    for (let i = 0; i < 2; i += 1) {
      const message = inbound();
      expect(g.consider(message)).toEqual({ reply: true });
      g.begin(message);
      g.end(message, true);
    }
    expect(g.consider(inbound())).toEqual({
      reply: false,
      reason: "rate-limited",
    });
  });

  it("does not spend the rate limit on a silent turn", () => {
    const g = gate({ repliesPerRoomPerHour: 1 });
    const first = inbound();
    g.consider(first);
    g.begin(first);
    // The brain returned null, or the send failed: nothing was published.
    g.end(first, false);
    expect(g.consider(inbound())).toEqual({ reply: true });
  });

  it("forgets replies older than the hour", () => {
    let now = 1000;
    const g = gate({ repliesPerRoomPerHour: 1, now: () => now });
    const first = inbound();
    g.consider(first);
    g.begin(first);
    g.end(first, true);
    expect(g.consider(inbound()).reply).toBe(false);
    now += 3601;
    expect(g.consider(inbound({ createdAt: now }))).toEqual({ reply: true });
  });

  it("never reconsiders an id it was told to remember", () => {
    const g = gate();
    const own = inbound();
    // What the agent loop does with the id of a reply it just published.
    g.remember(own.id);
    expect(g.consider(own)).toEqual({ reply: false, reason: "duplicate" });
  });

  it("bounds the dedupe set", () => {
    const g = gate({ maxSeen: 2 });
    const a = inbound({ id: "a" });
    g.consider(a);
    g.consider(inbound({ id: "b" }));
    g.consider(inbound({ id: "c" }));
    // "a" was evicted, so it is considerable again rather than growing forever.
    expect(g.consider(inbound({ id: "a", createdAt: a.createdAt })).reply).toBe(
      true,
    );
  });
});

/**
 * A DM room. Interrupting is deliberately a private-message behaviour: an
 * allow-listed 1:1 conversation has no other reason for someone to type while
 * Hex works, and a relay group does.
 */
const DM: Room = { transport: "nip-17", id: OTHER };

describe("interrupting", () => {
  const gate = () =>
    new ReplyGate({
      selfPubkey: SELF,
      mentions: ["hex"],
      startedAt: 900,
      repliesPerRoomPerHour: 20,
      now: () => 1000,
    });

  it("calls a same-author message in a DM an interrupt, not a refusal", () => {
    const g = gate();
    const first = inbound({ id: "a", room: DM });
    expect(g.consider(first).reply).toBe(true);
    g.begin(first);

    const verdict = g.consider(inbound({ id: "b", room: DM }));
    expect(verdict.reply === false && verdict.reason).toBe("interrupt");
  });

  it("still refuses a group mention while busy", () => {
    const g = gate();
    const first = inbound({ id: "a" });
    expect(g.consider(first).reply).toBe(true);
    g.begin(first);

    const verdict = g.consider(inbound({ id: "b" }));
    expect(verdict.reply === false && verdict.reason).toBe("in-flight");
  });

  it("does not let a second person cancel the first one's turn", () => {
    // roomKey covers groups too, and one member must never be able to kill
    // another member's work.
    const g = gate();
    const first = inbound({ id: "a", room: DM, author: OTHER });
    g.consider(first);
    g.begin(first);

    const verdict = g.consider(
      inbound({ id: "b", room: DM, author: "c".repeat(64) }),
    );
    expect(verdict.reply === false && verdict.reason).toBe("in-flight");
  });

  it("treats a redelivered interrupt as a duplicate, not a second stop", () => {
    // The id is entered into `seen` before the in-flight check, deliberately:
    // several relays deliver the same event, and cancelling twice would abandon
    // the steering turn the first cancel started.
    const g = gate();
    const first = inbound({ id: "a", room: DM });
    g.consider(first);
    g.begin(first);

    const copy = inbound({ id: "b", room: DM });
    expect(g.consider(copy).reply === false && g.consider(copy).reason).toBe(
      "duplicate",
    );
  });

  it("names who is holding the room", () => {
    const g = gate();
    const first = inbound({ id: "a", room: DM });
    expect(g.holderFor(first)).toBeUndefined();
    g.begin(first);
    expect(g.holderFor(first)).toEqual({ id: "a", author: OTHER });
    g.end(first, false);
    expect(g.holderFor(first)).toBeUndefined();
  });
});
