import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { RoomTools } from "../tools/room-tools.js";
import { REACT_TOOL, RESPOND_TOOL } from "../tools/types.js";
import type { Inbound, Room, Transport } from "../transports/types.js";

const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};
const AUTHOR = "b".repeat(64);

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
    ]);

    // A protocol without reactions simply does not advertise one.
    const withoutReact = new RoomTools({
      transport: transport({ canReact: false }),
      incoming: INBOUND,
    });
    expect(withoutReact.list().map((spec) => spec.name)).toEqual([
      RESPOND_TOOL,
    ]);
  });
});

describe("RoomTools.call", () => {
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
  /** A repo host that would happily run something if it were ever reached. */
  const reachable = {
    list: () => [
      { name: "repo.exec", description: "run", parameters: {}, prompt: "" },
    ],
    handles: (name: string) => name === "repo.exec",
    call: async () => ({ ok: true, output: "RAN" }),
  };

  it("refuses a tool the channel's grants exclude", async () => {
    const tools = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      repo: reachable as never,
      grants: ["grimoire.*"],
    });

    expect(tools.list().map((spec) => spec.name)).not.toContain("repo.exec");
    const result = await tools.call({ name: "repo.exec", arguments: {} });
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("RAN");
    expect(result.output).toMatch(/no tool called/);
  });

  it("refuses it by wire name too", async () => {
    // `repo_exec` is what a provider actually sends; resolving the dot back
    // must not be a way around the grant.
    const tools = new RoomTools({
      transport: transport(),
      incoming: INBOUND,
      repo: reachable as never,
      grants: [],
    });
    const result = await tools.call({ name: "repo_exec", arguments: {} });
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
      repo: reachable as never,
      grants: ["repo.*"],
    });
    const result = await tools.call({ name: "repo.exec", arguments: {} });
    expect(result.output).toBe("RAN");
  });
});
