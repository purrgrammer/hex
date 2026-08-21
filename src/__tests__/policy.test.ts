import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { addressesSelfInGroup } from "../policy.js";
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

const tagged = (tag: string[]) =>
  inbound({ event: { tags: [tag] } as unknown as Inbound["event"] });
const saying = (text: string) => inbound({ text });

/**
 * Two doors, and the text is not one of them.
 *
 * Matching Hex's NAME in the message text was the only way in that could open
 * when nobody had addressed anything: quote a message that said `@hex` and the
 * text carries the mention while the tags name the original author. It is gone,
 * config key and all.
 */
describe("what reaches Hex in a room", () => {
  it("is a p-tag, whatever the text says", () => {
    expect(addressesSelfInGroup(tagged(["p", SELF]), SELF)).toBe(true);
  });

  it("is not the name in the text, however it is written", () => {
    for (const text of [
      "hex, help",
      "@hex, help",
      "cc @Hex",
      "hex is just a bot you run on your computer or what?",
      'someone said "@hex research NIP 5D" earlier',
    ])
      expect(addressesSelfInGroup(saying(text), SELF)).toBe(false);
  });

  it("is not somebody else's p-tag", () => {
    expect(addressesSelfInGroup(tagged(["p", OTHER]), SELF)).toBe(false);
  });
});
