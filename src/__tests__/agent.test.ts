import { describe, it, expect, vi } from "vitest";
import { Subject } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { runAgent, ACK_EMOJI } from "../agent.js";
import { ReplyGate } from "../policy.js";
import { RoomContext } from "../context.js";
import { createRelays } from "../relays.js";
import type { Brain, BrainRequest, TurnOutcome } from "../brain/types.js";
import { RESPOND_TOOL } from "../tools/types.js";
import type { Inbound, Room, Transport } from "../transports/types.js";

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);
const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};

/** A transport whose stream the test drives by hand. */
class FakeTransport implements Transport {
  readonly name = "nip-29" as const;
  readonly inbox = new Subject<Inbound>();
  readonly replies: { to: string; text: string }[] = [];
  readonly reactions: { to: string; emoji: string }[] = [];
  /** Recorded in call order, so the ack's position is observable. */
  readonly calls: string[] = [];
  stopped = false;
  historyMessages: Inbound[] = [];
  replyFails = false;
  reactFails = false;

  start() {
    return this.inbox.asObservable();
  }

  async history(): Promise<Inbound[]> {
    return this.historyMessages;
  }

  async reply(to: Inbound, text: string): Promise<string> {
    this.calls.push("reply");
    if (this.replyFails) throw new Error("relay refused");
    this.replies.push({ to: to.id, text });
    return `reply-${this.replies.length}`;
  }

  async react(to: Inbound, emoji: string): Promise<string> {
    this.calls.push("react");
    if (this.reactFails) throw new Error("relay refused the reaction");
    this.reactions.push({ to: to.id, emoji });
    return `reaction-${this.reactions.length}`;
  }

  stop(): void {
    this.stopped = true;
  }
}

/** Answers by calling the respond tool, like a real brain does. */
class FixedBrain implements Brain {
  readonly name = "fixed";
  readonly seen: BrainRequest[] = [];
  constructor(
    private readonly answer: string | null,
    private readonly fail = false,
  ) {}
  async turn(request: BrainRequest): Promise<TurnOutcome> {
    this.seen.push(request);
    if (this.fail) throw new Error("provider exploded");
    if (this.answer === null) return { delivered: false, note: "stayed quiet" };
    const result = await request.tools.call({
      name: RESPOND_TOOL,
      arguments: { text: this.answer },
    });
    return { delivered: request.tools.delivered, note: result.output };
  }
}

let counter = 0;

function inbound(overrides: Partial<Inbound> = {}): Inbound {
  counter += 1;
  const text = overrides.text ?? "hex, hello";
  const event: NostrEvent = {
    id: overrides.id ?? `event-${counter}`,
    pubkey: overrides.author ?? OTHER,
    created_at: overrides.createdAt ?? 1000,
    kind: 9,
    content: text,
    tags: [],
    sig: "",
  };
  return {
    id: event.id,
    author: event.pubkey,
    text,
    createdAt: event.created_at,
    room: ROOM,
    addressesSelf: true,
    event,
    ...overrides,
  };
}

function harness(
  brain: Brain,
  options: { dryRun?: boolean; ackEmoji?: string } = {},
) {
  const transport = new FakeTransport();
  const relays = createRelays();
  const lines: string[] = [];
  const agent = runAgent({
    transports: [transport],
    gate: new ReplyGate({
      selfPubkey: SELF,
      mentions: ["hex"],
      startedAt: 900,
      repliesPerRoomPerHour: 2,
      now: () => 1000,
    }),
    brain,
    context: new RoomContext({
      relays,
      lookupRelays: [],
      messages: 10,
      lookupTimeoutMs: 50,
    }),
    instructions: "You are Hex.",
    log: (line) => lines.push(line),
    ...options,
  });
  return { transport, agent, lines, relays };
}

describe("runAgent", () => {
  it("acks with eyes BEFORE asking the model, then replies", async () => {
    // The ack's whole job is to cover the seconds the model takes, so its
    // position in the sequence is the feature.
    const brain = new FixedBrain("kind 9 is a group message");
    const { transport, agent, relays } = harness(brain);

    transport.inbox.next(inbound());
    await agent.idle();

    expect(transport.reactions).toEqual([{ to: "event-1", emoji: ACK_EMOJI }]);
    expect(transport.calls).toEqual(["react", "reply"]);
    expect(transport.replies).toEqual([
      { to: "event-1", text: "kind 9 is a group message" },
    ]);
    agent.stop();
    relays.close();
  });

  it("still answers when the ack could not be published", async () => {
    // A failed reaction is not a failed answer.
    const { transport, agent, relays } = harness(new FixedBrain("here"));
    transport.reactFails = true;

    transport.inbox.next(inbound());
    await agent.idle();

    expect(transport.replies).toHaveLength(1);
    agent.stop();
    relays.close();
  });

  it("does not ack a message it will not answer", async () => {
    const { transport, agent, relays } = harness(new FixedBrain("here"));

    transport.inbox.next(inbound({ addressesSelf: false }));
    await agent.idle();

    expect(transport.reactions).toEqual([]);
    expect(transport.replies).toEqual([]);
    agent.stop();
    relays.close();
  });

  it("never answers its own message", async () => {
    const { transport, agent, relays } = harness(new FixedBrain("here"));

    transport.inbox.next(inbound({ author: SELF }));
    await agent.idle();

    expect(transport.replies).toEqual([]);
    agent.stop();
    relays.close();
  });

  it("does not answer the same message twice", async () => {
    const { transport, agent, relays } = harness(new FixedBrain("here"));
    const message = inbound();

    transport.inbox.next(message);
    await agent.idle();
    // Several relays deliver one message; Hex's own reply arrives the same way.
    transport.inbox.next(message);
    await agent.idle();

    expect(transport.replies).toHaveLength(1);
    agent.stop();
    relays.close();
  });

  it("publishes nothing when the brain stays quiet", async () => {
    // `null` is a real answer.
    const { transport, agent, relays } = harness(new FixedBrain(null));

    transport.inbox.next(inbound());
    await agent.idle();

    expect(transport.replies).toEqual([]);
    agent.stop();
    relays.close();
  });

  it("logs a brain failure instead of passing it off as silence", async () => {
    const { transport, agent, lines, relays } = harness(
      new FixedBrain(null, true),
    );

    transport.inbox.next(inbound());
    await agent.idle();

    expect(lines.some((line) => line.includes("FAILED"))).toBe(true);
    expect(transport.replies).toEqual([]);
    agent.stop();
    relays.close();
  });

  it("does not spend the room's budget on a turn that published nothing", async () => {
    const brain = new FixedBrain("here");
    const { transport, agent, relays } = harness(brain);
    transport.replyFails = true;

    // Two failures, against a limit of two per hour.
    transport.inbox.next(inbound());
    await agent.idle();
    transport.inbox.next(inbound());
    await agent.idle();

    transport.replyFails = false;
    transport.inbox.next(inbound());
    await agent.idle();

    // Still allowed, because nothing was ever published.
    expect(transport.replies).toHaveLength(1);
    agent.stop();
    relays.close();
  });

  it("passes the room's prior messages to the brain, excluding the mention", async () => {
    const brain = new FixedBrain("here");
    const { transport, agent, relays } = harness(brain);

    const earlier = inbound({
      text: "unrelated chatter",
      addressesSelf: false,
    });
    transport.inbox.next(earlier);
    await agent.idle();

    const mention = inbound({ text: "hex, what was that?" });
    transport.inbox.next(mention);
    await agent.idle();

    const request = brain.seen[0]!;
    expect(request.history.map((entry) => entry.text)).toEqual([
      "unrelated chatter",
    ]);
    expect(request.incoming.id).toBe(mention.id);
    expect(request.instructions).toBe("You are Hex.");
    agent.stop();
    relays.close();
  });

  it("publishes nothing on a dry run, ack included", async () => {
    const { transport, agent, lines, relays } = harness(
      new FixedBrain("here"),
      {
        dryRun: true,
      },
    );

    transport.inbox.next(inbound());
    await agent.idle();

    expect(transport.replies).toEqual([]);
    expect(transport.reactions).toEqual([]);
    expect(lines.some((line) => line.includes("would say"))).toBe(true);
    agent.stop();
    relays.close();
  });

  it("can have the ack turned off", async () => {
    const { transport, agent, relays } = harness(new FixedBrain("here"), {
      ackEmoji: "",
    });

    transport.inbox.next(inbound());
    await agent.idle();

    expect(transport.reactions).toEqual([]);
    expect(transport.replies).toHaveLength(1);
    agent.stop();
    relays.close();
  });

  it("stops the transports when it stops", async () => {
    const { transport, agent, relays } = harness(new FixedBrain("here"));
    agent.stop();
    expect(transport.stopped).toBe(true);

    // And answers nothing after that.
    transport.inbox.next(inbound());
    await agent.idle();
    expect(transport.replies).toEqual([]);
    relays.close();
  });

  it("does not let one slow room block another", async () => {
    // A model takes seconds; two rooms must not queue behind each other.
    const order: string[] = [];
    const brain: Brain = {
      name: "slow-then-fast",
      turn: async (request) => {
        if (request.incoming.room.id === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push("slow");
        } else order.push("fast");
        await request.tools.call({
          name: RESPOND_TOOL,
          arguments: { text: "answer" },
        });
        return { delivered: request.tools.delivered };
      },
    };
    const { transport, agent, relays } = harness(brain);

    transport.inbox.next(
      inbound({ room: { transport: "nip-29", id: "slow", relay: "wss://g/" } }),
    );
    transport.inbox.next(
      inbound({ room: { transport: "nip-29", id: "fast", relay: "wss://g/" } }),
    );
    await agent.idle();

    expect(order).toEqual(["fast", "slow"]);
    agent.stop();
    relays.close();
  });

  it("holds one room to a single reply in flight", async () => {
    const brain: Brain = {
      name: "slow",
      turn: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await request.tools.call({
          name: RESPOND_TOOL,
          arguments: { text: "answer" },
        });
        return { delivered: request.tools.delivered };
      },
    };
    const { transport, agent, relays } = harness(brain);

    transport.inbox.next(inbound());
    transport.inbox.next(inbound());
    await agent.idle();

    // The second arrived while the first was still being answered.
    expect(transport.replies).toHaveLength(1);
    agent.stop();
    relays.close();
  });

  it("survives a stream error rather than dying with it", async () => {
    const { transport, agent, lines, relays } = harness(new FixedBrain("here"));
    transport.inbox.error(new Error("socket died"));
    await agent.idle();
    expect(lines.some((line) => line.includes("stream error"))).toBe(true);
    agent.stop();
    relays.close();
  });
});

describe("runAgent logging", () => {
  it("says which rule refused, for the ones that mean misconfiguration", async () => {
    const brain: Brain = {
      name: "slow",
      turn: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await request.tools.call({
          name: RESPOND_TOOL,
          arguments: { text: "answer" },
        });
        return { delivered: request.tools.delivered };
      },
    };
    const { transport, agent, lines, relays } = harness(brain);

    transport.inbox.next(inbound());
    transport.inbox.next(inbound());
    await agent.idle();

    expect(lines.some((line) => line.includes("in-flight"))).toBe(true);
    agent.stop();
    relays.close();
  });

  it("does not log a line for every message it was never meant to answer", async () => {
    // A busy room would otherwise produce a log entry per message.
    const { transport, agent, lines, relays } = harness(new FixedBrain("here"));
    for (let i = 0; i < 5; i += 1)
      transport.inbox.next(inbound({ addressesSelf: false }));
    await agent.idle();
    expect(lines).toEqual([]);
    agent.stop();
    relays.close();
  });
});

describe("RoomContext", () => {
  it("bounds the window it keeps", async () => {
    const relays = createRelays();
    const context = new RoomContext({
      relays,
      lookupRelays: [],
      messages: 3,
      lookupTimeoutMs: 50,
    });
    for (let i = 0; i < 10; i += 1)
      context.record(inbound({ createdAt: 1000 + i }));
    expect(context.size(ROOM)).toBe(3);
    relays.close();
  });

  it("ignores a message it already holds", async () => {
    const relays = createRelays();
    const context = new RoomContext({
      relays,
      lookupRelays: [],
      messages: 10,
      lookupTimeoutMs: 50,
    });
    const message = inbound();
    context.record(message);
    context.record(message);
    // A duplicate would reach the model as a repeated turn.
    expect(context.size(ROOM)).toBe(1);
    relays.close();
  });

  it("keeps the window in time order however it arrives", async () => {
    const relays = createRelays();
    const context = new RoomContext({
      relays,
      lookupRelays: [],
      messages: 10,
      lookupTimeoutMs: 50,
    });
    const transport = new FakeTransport();
    const later = inbound({ text: "second", createdAt: 2000 });
    const earlier = inbound({ text: "first", createdAt: 1000 });
    context.record(later);
    context.record(earlier);

    const history = await context.history(
      transport,
      inbound({ text: "hex?", createdAt: 3000 }),
    );
    expect(history.map((entry) => entry.text)).toEqual(["first", "second"]);
    relays.close();
  });

  it("seeds from the relay once, not on every message", async () => {
    const relays = createRelays();
    const context = new RoomContext({
      relays,
      lookupRelays: [],
      messages: 10,
      lookupTimeoutMs: 50,
    });
    const transport = new FakeTransport();
    transport.historyMessages = [inbound({ text: "from the relay" })];
    const spy = vi.spyOn(transport, "history");

    await context.history(transport, inbound({ text: "hex?" }));
    await context.history(transport, inbound({ text: "hex again?" }));

    expect(spy).toHaveBeenCalledTimes(1);
    relays.close();
  });
});
