/**
 * One place decides whether a message is for Hex, and this is the test of it.
 *
 * These assertions used to be spread across three transport suites, each with a
 * relay and a key and a wrap, because the decision lived in the transports and
 * could not be reached without one. It is a pure function now: an event, a room,
 * and a lookup. That is the point of the move — not tidiness, but that the rule
 * became something you can state and test on its own.
 */

import { describe, it, expect } from "vitest";

import { addresses, NOTHING_REMEMBERED } from "../addressing.js";
import type { AddressingBindings } from "../addressing.js";
import type { Inbound } from "../transports/types.js";

const ROOM = "concord|community:channel";
const ELSEWHERE = "nip-29|wss://groups.example/|other";
const ROOT = "11".repeat(32);
const PARENT = "22".repeat(32);

const message = (over: Partial<Inbound> = {}): Inbound =>
  ({
    id: "aa".repeat(32),
    author: "bb".repeat(32),
    text: "any thoughts?",
    createdAt: 1,
    room: { transport: "concord", id: "community:channel" },
    tagsSelf: false,
    addressesSelf: false,
    event: { tags: [] },
    ...over,
  }) as Inbound;

/** A store that remembers exactly one thread, in exactly one room. */
const remembers = (rootId: string, room = ROOM): AddressingBindings => ({
  threadIsOurs: (id, where) => id === rootId && where === room,
  isOwnMessage: () => false,
});

describe("whether a message is for Hex", () => {
  it("is yes when the tags say so", () => {
    expect(
      addresses(message({ tagsSelf: true }), ROOM, NOTHING_REMEMBERED),
    ).toBe(true);
  });

  it("is no when nothing names it and nothing is remembered", () => {
    expect(addresses(message(), ROOM, NOTHING_REMEMBERED)).toBe(false);
  });

  it("is yes for a reply in a thread Hex is answering in", () => {
    // The case that makes a conversation a conversation: the reply threads onto
    // the PERSON'S own opening message, so nothing about it names Hex.
    const reply = message({ threadRoot: ROOT, replyToId: PARENT });
    expect(addresses(reply, ROOM, remembers(ROOT))).toBe(true);
  });

  it("is yes for a reply whose parent is the handle, which is all a kind 9 has", () => {
    // NIP-C7 quotes the parent and names no root. One hop is the whole story.
    const reply = message({ replyToId: PARENT });
    expect(addresses(reply, ROOM, remembers(PARENT))).toBe(true);
  });

  it("is yes for a reply to something Hex wrote", () => {
    const reply = message({ replyToId: PARENT });
    const bindings: AddressingBindings = {
      threadIsOurs: () => false,
      isOwnMessage: (id) => id === PARENT,
    };
    expect(addresses(reply, ROOM, bindings)).toBe(true);
  });

  it("is no for a thread that belongs to a run in a different room", () => {
    /**
     * The reason the room is a parameter at all. Ids are public: quote
     * something Hex said in a group, from anywhere, and without this you resume
     * that room's session — with its history — wherever you asked.
     */
    const reply = message({ threadRoot: ROOT, replyToId: ROOT });
    expect(addresses(reply, ELSEWHERE, remembers(ROOT, ROOM))).toBe(false);
  });

  it("is no for a reply into somebody else's conversation", () => {
    const reply = message({ threadRoot: "cc".repeat(32) });
    expect(addresses(reply, ROOM, remembers(ROOT))).toBe(false);
  });

  it("never reads the text, however the text is written", () => {
    for (const text of [
      "hex, help",
      "@hex, help",
      'someone said "@hex research NIP 5D" earlier',
    ])
      expect(addresses(message({ text }), ROOM, NOTHING_REMEMBERED)).toBe(
        false,
      );
  });
});
