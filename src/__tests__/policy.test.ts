import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { mentionsName, addressesSelfInGroup } from "../policy.js";
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

describe("mentionsName", () => {
  it("refuses a bare name, because nobody types @ by accident", () => {
    /**
     * The rule: a mention is EXPLICIT or it is not a mention.
     *
     * Saying the bare name used to count, and in a room named after the agent
     * that means ordinary conversation about it starts a paid turn. This is not
     * hypothetical — "hex is just a bot you run on your computer or what?" was
     * answered, at cost, by somebody talking ABOUT Hex rather than to it.
     */
    expect(mentionsName("Hex, help", ["hex"])).toBe(false);
    expect(mentionsName("ask HEX about it", ["hex"])).toBe(false);
    expect(
      mentionsName("hex is just a bot you run on your computer or what?", [
        "hex",
      ]),
    ).toBe(false);
  });

  it("matches the @ form, case-insensitively", () => {
    expect(mentionsName("@Hex, help", ["hex"])).toBe(true);
    expect(mentionsName("ask @HEX about it", ["hex"])).toBe(true);
  });

  it("does not match inside a longer word", () => {
    // "@hexadecimal" is not a summons either.
    expect(mentionsName("print it in @hexadecimal", ["hex"])).toBe(false);
    expect(mentionsName("ping @vertex please", ["hex"])).toBe(false);
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

  it("reads a token the same whether or not it spells the @", () => {
    // Both configure the NAME; the text is what has to carry the `@`. An
    // operator cannot accidentally configure the loose form, because there
    // isn't one.
    expect(mentionsName("hex", ["@hex"])).toBe(false);
    expect(mentionsName("hex", ["hex"])).toBe(false);
    expect(mentionsName("@hex", ["@hex"])).toBe(true);
    expect(mentionsName("@hex", ["hex"])).toBe(true);
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
