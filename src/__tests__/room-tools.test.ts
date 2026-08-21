import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { RoomTools } from "../tools/room-tools.js";

import {
  HISTORY_TOOL,
  REACT_TOOL,
  RESPOND_TOOL,
  WHO_TOOL,
} from "../tools/types.js";
import type { Inbound, Room, Transport } from "../transports/types.js";

const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};
const AUTHOR = "b".repeat(64);
const SELF = "c".repeat(64);

const INBOUND: Inbound = {
  id: "event-1",
  author: AUTHOR,
  text: "hex?",
  createdAt: 1000,
  room: ROOM,
  addressesSelf: true,
  event: {
    id: "event-1",
    pubkey: AUTHOR,
    created_at: 1000,
    kind: 9,
    content: "hex?",
    tags: [],
    sig: "",
  } as NostrEvent,
};

function transport(
  overrides: Partial<Transport> & { canReact?: boolean } = {},
): Transport {
  const base: Transport = {
    name: "nip-29",
    start: () => {
      throw new Error("not used");
    },
    history: async () => [],
    reply: async () => "reply-id",
    react: async () => "reaction-id",
    stop: () => {},
  };
  const merged = { ...base, ...overrides } as Transport;
  if (overrides.canReact === false)
    delete (merged as { react?: unknown }).react;
  return merged;
}

describe("RoomTools.list", () => {
  it("offers respond, and react only when the transport has one", () => {
    const withReact = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
    });
    expect(withReact.list().map((spec) => spec.name)).toEqual([
      RESPOND_TOOL,
      REACT_TOOL,
      HISTORY_TOOL,
    ]);

    // A protocol without reactions simply does not advertise one.
    const withoutReact = new RoomTools({
      transport: transport({ canReact: false }),
      incoming: INBOUND,
    });
    expect(withoutReact.list().map((spec) => spec.name)).toEqual([
      RESPOND_TOOL,
      HISTORY_TOOL,
    ]);
  });

  it("offers no chat tools at all when there is no room", async () => {
    /**
     * A run started over the control plane happens in no room.
     *
     * Offering it `chat.respond` anyway would hand a speaking tool to a model
     * that has nobody to speak to: the call comes back "no room bound", the
     * answer goes nowhere, and the run reads as one that had nothing to say.
     * The catalogue depends on the channel, so with no channel there is no
     * `chat.*` — and everything that acts on the network is unaffected, because
     * reading relays never needed a room.
     */
    const roomless = new RoomTools({
      transport: transport(),
      requestedBy: AUTHOR,
    });
    expect(roomless.list()).toEqual([]);
    expect(roomless.room).toBeUndefined();
    expect(roomless.requestedBy).toBe(AUTHOR);

    /**
     * And a call for one is refused with the REASON, not with "no such tool".
     *
     * That distinction cost a real run. "There is no tool called chat_respond"
     * reads to a model like a typo, so one that had just finished a long piece
     * of work and could not report it did the work again looking for another
     * way out — the same patch published twice, ninety-nine seconds apart.
     */
    const refused = await roomless.call({
      name: RESPOND_TOOL,
      arguments: { text: "hello?" },
    });
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("no room");
    expect(refused.output).toContain("Do not repeat work");
    expect(refused.output).not.toContain("no tool called");
  });

  it("reads the thread with both halves in it", async () => {
    /**
     * A runtime is handed one message, so anything that refers to earlier is
     * either repeated or invented. And a thread without the agent's own replies
     * is half a conversation — the half that is missing being the half it wrote.
     */
    const past = [
      { ...INBOUND, id: "m1", text: "what is kind 30023" },
      { ...INBOUND, id: "m2", author: SELF, text: "a long-form article" },
      { ...INBOUND, id: "m3", text: "and its d tag?" },
    ];
    const tools = new RoomTools({
      transport: { ...transport(), history: async () => past },
      incoming: INBOUND,
      selfPubkey: SELF,
    });

    expect(tools.list().map((spec) => spec.name)).toContain(HISTORY_TOOL);

    const result = await tools.call({ name: "chat_history", arguments: {} });
    const read = JSON.parse(result.output) as {
      count: number;
      messages: { id: string; mine: boolean; text: string }[];
    };

    expect(read.count).toBe(3);
    // Which half it wrote, said plainly rather than left to a pubkey comparison.
    expect(read.messages.map((m) => m.mine)).toEqual([false, true, false]);
    expect(read.messages[0]!.text).toBe("what is kind 30023");
  });

  it("reads history off a transport that uses `this`", async () => {
    /**
     * The bug this exists for shipped and refused every single call.
     *
     * `const read = transport.history` then `read(…)` detaches the method from
     * its object, so `this` inside a real transport is undefined and its first
     * line dies on `this.options`. Every other test here passes an object
     * literal of ARROW functions, which close over nothing and never notice —
     * which is exactly why this one is a class.
     */
    class Recording {
      readonly name = "nip-29" as const;
      private readonly stored: Inbound[];
      constructor(stored: Inbound[]) {
        this.stored = stored;
      }
      start() {
        throw new Error("not used");
      }
      async history(): Promise<Inbound[]> {
        // The line that broke: reaching for instance state.
        return this.stored;
      }
      async reply() {
        return "reply-id";
      }
      stop() {}
    }

    const tools = new RoomTools({
      transport: new Recording([
        { ...INBOUND, id: "m1", text: "earlier" },
      ]) as unknown as Transport,
      incoming: INBOUND,
    });

    const result = await tools.call({ name: "chat_history", arguments: {} });
    expect(result.ok).toBe(true);
    const read = JSON.parse(result.output) as { count: number };
    expect(read.count).toBe(1);
  });

  it("does not offer history a transport cannot provide", () => {
    // An empty list would read as "nothing was said", which is a different and
    // much worse answer than "this room cannot be read back".
    const tools = new RoomTools({
      transport: { reply: async () => "reply-id" },
      incoming: INBOUND,
    });
    expect(tools.list().map((spec) => spec.name)).not.toContain(HISTORY_TOOL);
  });

  it("no longer offers chat.who, because the answer is in the prompt", async () => {
    /**
     * A runtime handed a bare message has no idea whose it is, and a tool was
     * the wrong shape of fix: it cost a round trip, the model had to know to
     * reach for it, and it did not. Who is asking is true before the first
     * token, so it is context now.
     */
    const tools = new RoomTools({ transport: transport(), incoming: INBOUND });
    expect(tools.list().map((spec) => spec.name)).not.toContain(WHO_TOOL);

    // Offered and callable are the same set, so it is refused rather than
    // quietly answered by a code path nothing lists.
    const result = await tools.call({ name: "chat_who", arguments: {} });
    expect(result.ok).toBe(false);
  });

  it("delivers through the transport and reports the id back", async () => {
    const sent: string[] = [];
    const tools = new RoomTools({
      transport: transport({
        reply: async (_to, text) => {
          sent.push(text);
          return "abc123";
        },
      }),
      incoming: INBOUND,
    });

    const result = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "  an answer  " },
    });

    expect(sent).toEqual(["an answer"]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("abc123");
    expect(tools.delivered).toBe(true);
    // The caller needs these to recognise Hex's own events coming back.
    expect(tools.deliveredIds).toEqual(["abc123"]);
  });

  it("carries an attachment's imeta so the picture is readable", async () => {
    /**
     * An encrypted blob's URL on its own is a link to bytes nobody can open.
     * The `imeta` beside it holds the key, so a respond that dropped it would
     * deliver a broken image every single time — and the model, told
     * `delivered as …`, would have no way to know.
     */
    const sent: { text: string; tags?: string[][] }[] = [];
    const tools = new RoomTools({
      transport: transport({
        reply: async (_to, text, tags) => {
          sent.push({ text, tags });
          return "abc123";
        },
      }),
      incoming: INBOUND,
    });

    const imeta = [
      "imeta",
      "url https://blossom.example/abc",
      "m image/png",
      "decryption-key aa",
    ];
    const result = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "here it is", imeta },
    });

    expect(result.ok).toBe(true);
    expect(sent[0]!.tags).toEqual([imeta]);
  });

  it("drops something that is not an imeta rather than publishing it", async () => {
    // It is the tool's own output coming back, so the risk is a model mangling
    // it — and a malformed tag published as-is renders as nothing, with no
    // explanation anywhere.
    const sent: { tags?: string[][] }[] = [];
    const tools = new RoomTools({
      transport: transport({
        reply: async (_to, _text, tags) => {
          sent.push({ tags });
          return "abc123";
        },
      }),
      incoming: INBOUND,
    });

    await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "hi", imeta: ["p", "not an imeta"] },
    });
    expect(sent[0]!.tags).toEqual([]);
  });

  it("refuses a second answer in one turn, and says why", async () => {
    // A model that answers three times has misunderstood; the room is worse off
    // for hearing all three, and the refusal is what lets it stop.
    const tools = new RoomTools({ transport: transport(), incoming: INBOUND });
    await tools.call({ name: RESPOND_TOOL, arguments: { text: "first" } });
    const second = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "second" },
    });
    expect(second.ok).toBe(false);
    expect(second.output).toContain("already answered");
  });

  it("honours a higher cap when one is configured", async () => {
    const tools = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      maxResponses: 2,
    });
    await tools.call({ name: RESPOND_TOOL, arguments: { text: "one" } });
    const second = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "two" },
    });
    expect(second.ok).toBe(true);
  });

  it("tells the brain the truth when the relay refused", async () => {
    const tools = new RoomTools({
      transport: transport({
        reply: async () => {
          throw new Error("group relay refused");
        },
      }),
      incoming: INBOUND,
    });

    const result = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "hello" },
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("group relay refused");
    // Nothing was heard, so nothing was delivered — and the rate limit, which
    // reads this, stays unspent.
    expect(tools.delivered).toBe(false);
  });

  it("rejects an empty answer rather than posting whitespace", async () => {
    const tools = new RoomTools({ transport: transport(), incoming: INBOUND });
    const result = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "   " },
    });
    expect(result.ok).toBe(false);
    expect(tools.delivered).toBe(false);
  });

  it("names the available tools when asked for one that does not exist", async () => {
    // A model that guessed can correct itself from the answer.
    const tools = new RoomTools({ transport: transport(), incoming: INBOUND });
    const result = await tools.call({ name: "sendMessage", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.output).toContain(RESPOND_TOOL);
  });

  it("does not count a reaction as having spoken", async () => {
    const tools = new RoomTools({ transport: transport(), incoming: INBOUND });
    const result = await tools.call({
      name: REACT_TOOL,
      arguments: { emoji: "👍" },
    });
    expect(result.ok).toBe(true);
    expect(tools.delivered).toBe(false);
  });

  it("publishes nothing on a dry run, but still reports delivery", async () => {
    // The brain must experience the same path, or a dry run tests nothing.
    const lines: string[] = [];
    let published = false;
    const tools = new RoomTools({
      transport: transport({
        reply: async () => {
          published = true;
          return "id";
        },
      }),
      incoming: INBOUND,
      dryRun: true,
      log: (line) => lines.push(line),
    });

    const result = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "an answer" },
    });

    expect(published).toBe(false);
    expect(result.ok).toBe(true);
    expect(tools.delivered).toBe(true);
    expect(lines.some((line) => line.includes("would say: an answer"))).toBe(
      true,
    );
  });

  it("is bound to the message it was built for", async () => {
    // A brain holding a host cannot reach a different room or a different message.
    const targets: string[] = [];
    const tools = new RoomTools({
      transport: transport({
        reply: async (to) => {
          targets.push(to.id);
          return "id";
        },
      }),
      incoming: INBOUND,
    });
    await tools.call({ name: RESPOND_TOOL, arguments: { text: "hi" } });
    expect(targets).toEqual(["event-1"]);
    expect(tools.room).toEqual(ROOM);
    expect(tools.requestedBy).toBe(AUTHOR);
  });
});

/**
 * Offered and callable are the same set.
 *
 * `list()` is what a well-behaved model reads, but `call()` is what actually
 * happens. A model that names a tool it was never shown — because it saw one in
 * another conversation, or invented it — must not reach the thing behind it.
 */
describe("grants at the call, not just the listing", () => {
  /** A read host that would happily answer if it were ever reached. */
  const reachable = {
    list: () => [
      { name: "nostr.req", description: "query", parameters: {}, prompt: "" },
    ],
    handles: (name: string) => name === "nostr.req",
    call: async () => ({ ok: true, output: "RAN" }),
  };

  it("refuses a tool the channel's grants exclude", async () => {
    const tools = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      knowledge: reachable as never,
      grants: ["grimoire.*"],
    });

    expect(tools.list().map((spec) => spec.name)).not.toContain("nostr.req");
    const result = await tools.call({ name: "nostr.req", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("RAN");
    expect(result.output).toMatch(/no tool called/);
  });

  it("refuses it by wire name too", async () => {
    // `nostr_req` is what a provider actually sends; resolving the dot back must
    // not be a way around the grant.
    const tools = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      knowledge: reachable as never,
      grants: [],
    });
    const result = await tools.call({ name: "nostr_req", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("RAN");
  });

  it("still speaks when granted nothing at all", async () => {
    // A channel Hex listens to must be one it can answer in, whatever else it
    // is denied.
    const tools = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      grants: [],
    });
    expect(tools.list().map((spec) => spec.name)).toContain(RESPOND_TOOL);
    const result = await tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "here" },
    });
    expect(result.ok).toBe(true);
  });

  it("runs it when the grant covers it", async () => {
    const tools = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      knowledge: reachable as never,
      grants: ["nostr.*"],
    });
    const result = await tools.call({ name: "nostr.req", arguments: {} });
    expect(result.output).toBe("RAN");
  });
});

describe("publishing from inside a room", () => {
  /** A publish surface that records what actually reached it. */
  function publisher(took: Record<string, unknown>[]) {
    return {
      list: () => [
        { name: "nostr.publish", description: "publish", parameters: {} },
        { name: "nostr.sign", description: "sign", parameters: {} },
      ],
      handles: (name: string) =>
        name === "nostr.publish" || name === "nostr.sign",
      call: async (_name: string, args: Record<string, unknown>) => {
        took.push(args);
        return { ok: true, output: "PUBLISHED" };
      },
    };
  }

  function inRoom(took: Record<string, unknown>[]) {
    return new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      publish: publisher(took) as never,
    });
  }

  it("refuses to answer the room on the open network", async () => {
    // Measured, not imagined: asked a question in a private channel and told
    // to "post it here", a run signed the answer as a bare kind 9 and
    // published it to three public relays.
    const took: Record<string, unknown>[] = [];
    const result = await inRoom(took).call({
      name: "nostr.publish",
      arguments: { kind: 9, content: "the answer" },
    });
    expect(result.ok).toBe(false);
    // The refusal is the teaching moment: it names the door that was there.
    expect(result.output).toContain(RESPOND_TOOL);
    expect(took).toEqual([]);
  });

  it("refuses a kind the model invented", async () => {
    // One of the three real leaks was kind 9411, which is not a kind. No
    // denylist can enumerate what a model might make up, which is the whole
    // reason this is an allowlist.
    const took: Record<string, unknown>[] = [];
    const result = await inRoom(took).call({
      name: "nostr.publish",
      arguments: { kind: 9411, content: "found it: the fix is …" },
    });
    expect(result.ok).toBe(false);
    expect(took).toEqual([]);
  });

  it("bounds signing exactly as it bounds publishing", async () => {
    // A signed event is one relay call from being published by whoever holds
    // it, so a tool that signs what it will not publish is a loophole.
    const took: Record<string, unknown>[] = [];
    const result = await inRoom(took).call({
      name: "nostr.sign",
      arguments: { kind: 9, content: "the answer" },
    });
    expect(result.ok).toBe(false);
    expect(took).toEqual([]);
  });

  it("still files the work the room asked for", async () => {
    // The point is not to stop an agent publishing. A patch, an issue and the
    // statuses that close them are addressed to a repository, are public
    // whoever files them, and are how the work gets handed in at all.
    const took: Record<string, unknown>[] = [];
    const tools = inRoom(took);
    for (const kind of [1617, 1621, 1631]) {
      const result = await tools.call({
        name: "nostr.publish",
        arguments: { kind, content: "work" },
      });
      expect(result.output).toBe("PUBLISHED");
    }
    expect(took).toHaveLength(3);
  });

  it("leaves a run with no room alone", async () => {
    // A control-plane run has nowhere to speak and no chat tool to be
    // redirected to. None of this is about it.
    const took: Record<string, unknown>[] = [];
    const tools = new RoomTools({
      transport: transport(),
      publish: publisher(took) as never,
    });
    const result = await tools.call({
      name: "nostr.publish",
      arguments: { kind: 1, content: "a note" },
    });
    expect(result.output).toBe("PUBLISHED");
  });
});
