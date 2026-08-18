import { describe, it, expect, vi } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { RoomContext } from "../context.js";
import { createRelays } from "../relays.js";
import { replyTarget } from "../transports/nip29.js";
import type { Inbound, Room, Transport } from "../transports/types.js";

const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};
const HUMAN = "b".repeat(64);
const HEX = "a".repeat(64);

function message(
  id: string,
  author: string,
  text: string,
  at: number,
  replyToId?: string,
): Inbound {
  return {
    id,
    author,
    text,
    createdAt: at,
    room: ROOM,
    addressesSelf: true,
    replyToId,
    event: {
      id,
      pubkey: author,
      created_at: at,
      kind: 9,
      content: text,
      tags: replyToId ? [["e", replyToId]] : [],
      sig: "",
    } as NostrEvent,
  };
}

/** A transport that can be asked for a message by id. */
function transport(known: Inbound[] = []): Transport {
  return {
    name: "nip-29",
    start: () => {
      throw new Error("not used");
    },
    history: async () => [],
    fetchById: async (_room, id) => known.find((m) => m.id === id) ?? null,
    reply: async () => "id",
    stop: () => {},
  };
}

function context(messages = 20) {
  const relays = createRelays();
  const ctx = new RoomContext({
    relays,
    lookupRelays: [],
    messages,
    lookupTimeoutMs: 50,
  });
  return { ctx, relays };
}

describe("replyTarget", () => {
  it("prefers the q tag, which is what a kind-9 reply carries", () => {
    // NIP-C7 quotes the parent, and grimoire writes and reads `q` for group
    // chat. Reading only `e` made a reply typed in grimoire look unrelated.
    const event = {
      tags: [
        ["e", "some-thread-root"],
        ["q", "the-parent", "wss://g.example/", "b".repeat(64)],
      ],
    } as NostrEvent;
    expect(replyTarget(event)).toBe("the-parent");
  });

  it("takes the e tag as the parent", () => {
    expect(replyTarget(message("c", HUMAN, "x", 3, "b").event)).toBe("b");
  });

  it("prefers an explicit reply marker over a root", () => {
    // A client may carry both; threading to the root flattens a long exchange.
    const event = {
      tags: [
        ["e", "root-id", "", "root"],
        ["e", "parent-id", "", "reply"],
      ],
    } as NostrEvent;
    expect(replyTarget(event)).toBe("parent-id");
  });

  it("skips a lone root marker rather than treating it as the parent", () => {
    const event = { tags: [["e", "root-id", "", "root"]] } as NostrEvent;
    // Nothing better exists, so the root is all there is.
    expect(replyTarget(event)).toBe("root-id");
  });

  it("is undefined for a message that starts a conversation", () => {
    expect(replyTarget(message("a", HUMAN, "hex?", 1).event)).toBeUndefined();
  });
});

describe("RoomContext threading", () => {
  it("builds the conversation from the reply chain, oldest first", async () => {
    // The shape the user cares about: a mention opens it, Hex answers, and the
    // human's follow-up is the next turn of the SAME exchange.
    const { ctx, relays } = context();
    const opener = message("m1", HUMAN, "hex, what is kind 9?", 1);
    const answer = message("m2", HEX, "a group chat message", 2, "m1");
    const followUp = message("m3", HUMAN, "and kind 11?", 3, "m2");

    ctx.record(opener);
    ctx.record(answer);

    const history = await ctx.history(transport(), followUp);

    expect(history.map((entry) => entry.text)).toEqual([
      "hex, what is kind 9?",
      "a group chat message",
    ]);
    expect(history.map((entry) => entry.author)).toEqual([HUMAN, HEX]);
    relays.close();
  });

  it("leaves out room chatter that is not part of the thread", async () => {
    // Unrelated lines between a question and its answer are noise the model has
    // to reason around.
    const { ctx, relays } = context();
    ctx.record(message("m1", HUMAN, "hex, what is kind 9?", 1));
    ctx.record(message("m2", HEX, "a group chat message", 2, "m1"));
    ctx.record(message("x1", "c".repeat(64), "unrelated chatter", 2));

    const history = await ctx.history(
      transport(),
      message("m3", HUMAN, "and kind 11?", 3, "m2"),
    );

    expect(history.map((entry) => entry.text)).not.toContain(
      "unrelated chatter",
    );
    relays.close();
  });

  it("fetches a parent it never saw, once", async () => {
    // A restart, or a thread older than the window: the exchange is still real.
    const { ctx, relays } = context();
    const opener = message("m1", HUMAN, "the original question", 1);
    const answer = message("m2", HEX, "the original answer", 2, "m1");
    const bus = transport([opener, answer]);
    const spy = vi.spyOn(bus, "fetchById");

    const followUp = message("m3", HUMAN, "wait, why?", 3, "m2");
    const first = await ctx.history(bus, followUp);
    expect(first.map((entry) => entry.text)).toEqual([
      "the original question",
      "the original answer",
    ]);

    // Fetched parents are remembered, so the next turn costs no lookups.
    spy.mockClear();
    await ctx.history(bus, message("m4", HUMAN, "and?", 4, "m2"));
    expect(spy).not.toHaveBeenCalled();
    relays.close();
  });

  it("falls back to the room window for a message that starts a conversation", async () => {
    const { ctx, relays } = context();
    ctx.record(message("x1", "c".repeat(64), "earlier chatter", 1));

    const history = await ctx.history(
      transport(),
      message("m1", HUMAN, "hex?", 2),
    );

    expect(history.map((entry) => entry.text)).toEqual(["earlier chatter"]);
    relays.close();
  });

  it("falls back to the room window when the parent cannot be found", async () => {
    // A reply to something deleted, or on a relay that no longer serves it.
    const { ctx, relays } = context();
    ctx.record(message("x1", "c".repeat(64), "earlier chatter", 1));

    const history = await ctx.history(
      transport(),
      message("m9", HUMAN, "hex?", 5, "missing"),
    );

    expect(history.map((entry) => entry.text)).toEqual(["earlier chatter"]);
    relays.close();
  });

  it("survives a chain that points at itself", async () => {
    const { ctx, relays } = context();
    const loop = message("m1", HUMAN, "hex?", 1, "m1");
    ctx.record(loop);
    // Would otherwise walk forever.
    const history = await ctx.history(transport(), loop);
    expect(history).toEqual([]);
    relays.close();
  });

  it("survives a cycle between two messages", async () => {
    const { ctx, relays } = context();
    const a = message("m1", HUMAN, "one", 1, "m2");
    const b = message("m2", HEX, "two", 2, "m1");
    ctx.record(a);
    ctx.record(b);
    const history = await ctx.history(
      transport(),
      message("m3", HUMAN, "three", 3, "m2"),
    );
    // Bounded, and each message appears once.
    expect(history.map((entry) => entry.text)).toHaveLength(2);
    relays.close();
  });

  it("bounds the thread by the configured message count", async () => {
    const { ctx, relays } = context(3);
    for (let i = 1; i <= 10; i += 1)
      ctx.record(
        message(
          `m${i}`,
          i % 2 ? HUMAN : HEX,
          `turn ${i}`,
          i,
          i > 1 ? `m${i - 1}` : undefined,
        ),
      );

    const history = await ctx.history(
      transport(),
      message("m11", HUMAN, "latest", 11, "m10"),
    );

    expect(history).toHaveLength(3);
    // The nearest turns, not the oldest.
    expect(history.map((entry) => entry.text)).toEqual([
      "turn 8",
      "turn 9",
      "turn 10",
    ]);
    relays.close();
  });

  it("does not follow a thread out of its room", async () => {
    // An `e` tag can point anywhere, including another room's message.
    const { ctx, relays } = context();
    const elsewhere: Inbound = {
      ...message("other", HUMAN, "different room", 1),
      room: { transport: "nip-29", id: "other", relay: "wss://g.example/" },
    };
    ctx.record(elsewhere);

    const history = await ctx.history(
      transport(),
      message("m1", HUMAN, "hex?", 2, "other"),
    );

    expect(history.map((entry) => entry.text)).not.toContain("different room");
    relays.close();
  });
});
