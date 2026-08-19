/**
 * Stopping Hex mid-task, and telling it to do something else instead.
 *
 * The bug this exists to prevent is subtle and was live: a message that arrived
 * during a turn was refused as `in-flight` AND entered into the dedupe set, so it
 * could never be reconsidered by any path. It was permanently unanswered while
 * still appearing in the history handed to the next turn — the agent looked like
 * it was ignoring you, on purpose.
 *
 * So the assertions here are mostly about a message NOT vanishing.
 */

import { describe, it, expect } from "vitest";
import { Subject } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { runAgent, STOP_EMOJI, ACK_EMOJI } from "../agent.js";
import { ReplyGate } from "../policy.js";
import { RoomContext } from "../context.js";
import { createRelays } from "../relays.js";
import type { Brain, BrainRequest, TurnOutcome } from "../brain/types.js";
import { RESPOND_TOOL } from "../tools/types.js";
import type { Inbound, Room, Transport } from "../transports/types.js";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);

/** A DM. Interrupting is a private-message behaviour, deliberately. */
const DM: Room = { transport: "nip-17", id: PEER };
const GROUP: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};

class FakeTransport implements Transport {
  readonly name = "nip-17" as const;
  readonly inbox = new Subject<Inbound>();
  readonly replies: { to: string; text: string }[] = [];
  readonly reactions: { to: string; emoji: string }[] = [];
  start() {
    return this.inbox.asObservable();
  }
  async history(): Promise<Inbound[]> {
    return [];
  }
  async reply(to: Inbound, text: string): Promise<string> {
    this.replies.push({ to: to.id, text });
    return `reply-${this.replies.length}`;
  }
  async react(to: Inbound, emoji: string): Promise<string> {
    this.reactions.push({ to: to.id, emoji });
    return `reaction-${this.reactions.length}`;
  }
  stop(): void {}
}

/**
 * A brain that blocks until the test lets it finish, so timing is controlled
 * rather than slept. It reports whether its signal fired and whether a reply
 * attempted after the abort was refused.
 */
class SlowBrain implements Brain {
  readonly name = "slow";
  readonly seen: BrainRequest[] = [];
  readonly aborted: boolean[] = [];
  readonly postAbortReply: string[] = [];
  private release?: () => void;
  /** Resolves once the brain has actually been entered. */
  readonly entered: Promise<void>;
  private announceEntered!: () => void;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.announceEntered = resolve;
    });
  }

  finish(): void {
    this.release?.();
  }

  async turn(request: BrainRequest): Promise<TurnOutcome> {
    this.seen.push(request);
    // The first turn blocks; the steering turn answers immediately.
    if (this.seen.length > 1) {
      const result = await request.tools.call({
        name: RESPOND_TOOL,
        arguments: { text: "doing that instead" },
      });
      return { delivered: request.tools.delivered, note: result.output };
    }

    this.announceEntered();
    await new Promise<void>((resolve) => {
      this.release = resolve;
      request.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    this.aborted.push(request.signal?.aborted ?? false);

    // Try to speak anyway — the host must refuse it.
    const late = await request.tools.call({
      name: RESPOND_TOOL,
      arguments: { text: "too late" },
    });
    this.postAbortReply.push(late.output);
    return { delivered: request.tools.delivered, note: "cancelled" };
  }
}

let counter = 0;

function inbound(overrides: Partial<Inbound> = {}): Inbound {
  counter += 1;
  const text = overrides.text ?? "do a thing";
  const event: NostrEvent = {
    id: overrides.id ?? `event-${counter}`,
    pubkey: overrides.author ?? PEER,
    created_at: overrides.createdAt ?? 1000,
    kind: 14,
    content: text,
    tags: [],
    sig: "",
  };
  return {
    id: event.id,
    author: event.pubkey,
    text,
    createdAt: event.created_at,
    room: DM,
    addressesSelf: true,
    event,
    ...overrides,
  };
}

function harness(brain: Brain, options: { dryRun?: boolean } = {}) {
  const transport = new FakeTransport();
  const relays = createRelays();
  const lines: string[] = [];
  const gate = new ReplyGate({
    selfPubkey: SELF,
    mentions: ["hex"],
    startedAt: 900,
    repliesPerRoomPerHour: 2,
    now: () => 1000,
  });
  const agent = runAgent({
    transports: [transport],
    gate,
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
  return { transport, agent, lines, gate, relays };
}

describe("interrupting a DM", () => {
  it("stops the running turn and answers the message that stopped it", async () => {
    const brain = new SlowBrain();
    const { transport, agent, relays } = harness(brain);

    const first = inbound({ id: "task", text: "refactor the adapter" });
    transport.inbox.next(first);
    await brain.entered;

    const second = inbound({ id: "steer", text: "actually, tests first" });
    transport.inbox.next(second);
    await agent.idle();

    // The signal fired, and the cancelled turn was refused when it tried to
    // speak anyway.
    expect(brain.aborted).toEqual([true]);
    expect(brain.postAbortReply[0]).toMatch(/cancelled/);

    // 👀 on the task, 🛑 on the message that stopped it.
    expect(transport.reactions).toEqual([
      { to: "task", emoji: ACK_EMOJI },
      { to: "steer", emoji: STOP_EMOJI },
    ]);

    // The notice, then the steering answer. Neither message vanished.
    expect(transport.replies).toHaveLength(2);
    expect(transport.replies[0].text).toContain("Stopped");
    expect(transport.replies[0].text).toContain("still there");
    expect(transport.replies[1].text).toBe("doing that instead");

    // The steering turn ran for the interrupting message, not the abandoned one.
    expect(brain.seen).toHaveLength(2);
    expect(brain.seen[1].incoming.id).toBe("steer");

    agent.stop();
    relays.pool.close?.();
  });

  it("does not answer its own cancel notice", async () => {
    // The notice is a published event that comes straight back through the same
    // subscription; without `remember` Hex would reply to itself.
    const brain = new SlowBrain();
    const { transport, agent, relays } = harness(brain);

    transport.inbox.next(inbound({ id: "task" }));
    await brain.entered;
    transport.inbox.next(inbound({ id: "steer" }));
    await agent.idle();

    const before = transport.replies.length;
    transport.inbox.next(
      inbound({ id: "reply-1", author: SELF, text: "Stopped." }),
    );
    await agent.idle();
    expect(transport.replies).toHaveLength(before);

    agent.stop();
    relays.pool.close?.();
  });

  it("treats a second copy of the interrupt as a duplicate, not a second stop", async () => {
    // Several relays deliver the same event. Cancelling twice would abandon the
    // steering turn that the first cancel started.
    const brain = new SlowBrain();
    const { transport, agent, relays } = harness(brain);

    transport.inbox.next(inbound({ id: "task" }));
    await brain.entered;
    transport.inbox.next(inbound({ id: "steer" }));
    transport.inbox.next(inbound({ id: "steer" }));
    await agent.idle();

    expect(
      transport.reactions.filter((r) => r.emoji === STOP_EMOJI),
    ).toHaveLength(1);
    expect(brain.seen).toHaveLength(2);

    agent.stop();
    relays.pool.close?.();
  });

  it("leaves the room usable and the rate limit unspent", async () => {
    // The cancelled turn published nothing, so it must not have spent budget —
    // and `gate.end` must have run or the room stays claimed forever.
    const brain = new SlowBrain();
    const { transport, agent, gate, relays } = harness(brain);

    transport.inbox.next(inbound({ id: "task" }));
    await brain.entered;
    transport.inbox.next(inbound({ id: "steer" }));
    await agent.idle();

    expect(gate.holderFor(inbound({ id: "probe" }))).toBeUndefined();

    // The limit is 2 an hour and only the steering turn delivered, so exactly
    // one is spent. Had the abandoned turn been charged for a reply it never
    // sent, this would already be exhausted — which is the invariant.
    const verdict = gate.consider(inbound({ id: "third" }));
    expect(verdict.reply).toBe(true);

    agent.stop();
    relays.pool.close?.();
  });

  it("publishes nothing on a dry run", async () => {
    const brain = new SlowBrain();
    const { transport, agent, lines, relays } = harness(brain, {
      dryRun: true,
    });

    transport.inbox.next(inbound({ id: "task" }));
    await brain.entered;
    transport.inbox.next(inbound({ id: "steer" }));
    await agent.idle();

    expect(transport.replies).toHaveLength(0);
    expect(transport.reactions).toHaveLength(0);
    expect(lines.some((line) => line.includes("would say"))).toBe(true);

    agent.stop();
    relays.pool.close?.();
  });

  it("does not interrupt in a relay group", async () => {
    // A group has other conversations in it, and a mention during a turn is not
    // an instruction to drop what you are doing.
    const brain = new SlowBrain();
    const { transport, agent, lines, relays } = harness(brain);

    transport.inbox.next(inbound({ id: "task", room: GROUP }));
    await brain.entered;
    transport.inbox.next(inbound({ id: "later", room: GROUP }));

    expect(brain.aborted).toHaveLength(0);
    expect(lines.some((line) => line.includes("in-flight"))).toBe(true);

    brain.finish();
    await agent.idle();
    agent.stop();
    relays.pool.close?.();
  });

  it("does not let one person cancel another person's task", async () => {
    const brain = new SlowBrain();
    const { transport, agent, relays } = harness(brain);

    transport.inbox.next(inbound({ id: "task", author: PEER }));
    await brain.entered;
    transport.inbox.next(inbound({ id: "nosy", author: OTHER }));

    expect(brain.aborted).toHaveLength(0);
    expect(
      transport.reactions.filter((r) => r.emoji === STOP_EMOJI),
    ).toHaveLength(0);

    brain.finish();
    await agent.idle();
    agent.stop();
    relays.pool.close?.();
  });
});
