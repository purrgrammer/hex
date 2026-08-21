import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";

import { Spool, type SpoolSink, type SpoolTransport } from "../outbound.js";
import type { Rumor } from "../nostr/types.js";
import { HexStore, agentHome } from "../store.js";
import type { Inbound, Room } from "../transports/types.js";

const AGENT = "9".repeat(64);
const PEER = "1".repeat(64);
const OTHER = "2".repeat(64);
const DM: Room = { transport: "nip-17", id: PEER };

function inbound(id = "m1"): Inbound {
  const event: NostrEvent = {
    id,
    pubkey: PEER,
    created_at: 1000,
    kind: 14,
    content: "how many kinds are there?",
    tags: [],
    sig: "",
  };
  return {
    id,
    author: PEER,
    text: event.content,
    createdAt: event.created_at,
    room: DM,
    addressesSelf: true,
    event,
  };
}

/**
 * A transport that refuses until it is told to stop refusing.
 *
 * The refusal is the whole subject: what a relay that will not take the event
 * leaves behind is what every test here reads.
 */
function transport(options: { failing?: boolean } = {}) {
  const replies: { to: string; text: string }[] = [];
  const reactions: string[] = [];
  let failing = options.failing ?? false;
  let sent = 0;
  const impl: SpoolTransport = {
    reply: async (to, text) => {
      if (failing) throw new Error("the relay did not take the reply");
      replies.push({ to: to.id, text });
      sent += 1;
      return `published_${sent}`;
    },
    react: async (_to, emoji) => {
      if (failing) throw new Error("the relay did not take the reaction");
      reactions.push(emoji);
      return `reaction_${reactions.length}`;
    },
  };
  return {
    impl,
    replies,
    reactions,
    heal: () => {
      failing = false;
    },
  };
}

function rumor(id = "r1"): Rumor {
  return {
    id,
    pubkey: AGENT,
    created_at: 1000,
    kind: 1777,
    content: "a turn",
    tags: [],
  } as Rumor;
}

/** A sink that will only deliver to the recipients it is told about. */
function sink(reachable: string[]) {
  const calls: { recipients: string[]; selfCopy?: boolean }[] = [];
  const impl: SpoolSink = {
    publishRumor: async (_rumor, recipients, options) => {
      calls.push({ recipients, selfCopy: options?.selfCopy });
      return {
        delivered: recipients.filter((peer) => reachable.includes(peer)),
        undeliverable: recipients.filter((peer) => !reachable.includes(peer)),
      };
    },
  };
  return { impl, calls };
}

describe("Spool", () => {
  let home: string;
  let store: HexStore;
  let generation: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "spool-"));
    store = HexStore.open(agentHome(home, AGENT).db);
    generation = store.acquireWriterLease({ takeover: true }).generation;
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  function spool(
    bus: ReturnType<typeof transport>,
    overrides: Partial<ConstructorParameters<typeof Spool>[0]> = {},
  ): Spool {
    return new Spool({
      store,
      generation,
      transport: bus.impl,
      // No waiting in a test: the backoff is exercised by asking for a drain,
      // not by sleeping through one.
      backoffMs: 0,
      ...overrides,
    });
  }

  it("keeps an answer the relay refused, and sends it once on the next start", async () => {
    /**
     * The failure this phase is for. The turn ran, the money was spent, and the
     * reply was handed to a transport that dropped it — after which nothing
     * anywhere knew an answer was owed.
     */
    const refusing = transport({ failing: true });
    const first = spool(refusing);
    const id = await first.reply(inbound(), "there are rather a lot");
    expect(id).toBeUndefined();
    expect(refusing.replies).toEqual([]);

    const owed = store.pendingOutbound(5);
    expect(owed).toHaveLength(1);
    expect(owed[0]!.kind).toBe("reply");
    expect(owed[0]!.attempts).toBe(1);
    expect(owed[0]!.lastError).toContain("did not take the reply");

    // A different process: a new store on the same file, and the generation it
    // takes over with.
    const restarted = HexStore.open(agentHome(home, AGENT).db);
    const takeover = restarted.acquireWriterLease({ takeover: true });
    const working = transport();
    const second = new Spool({
      store: restarted,
      generation: takeover.generation,
      transport: working.impl,
      backoffMs: 0,
    });
    await second.start();

    expect(working.replies).toEqual([
      { to: "m1", text: "there are rather a lot" },
    ]);
    // And only once: a second drain finds nothing owed.
    await second.drain();
    expect(working.replies).toHaveLength(1);
    expect(restarted.pendingOutbound(5)).toEqual([]);
    second.stop();
    restarted.close();
  });

  it("sends a row once even when the loop and a live turn both reach for it", async () => {
    /**
     * The recovery path's own duplicate. A relay outage leaves rows owed, which
     * arms the retry loop; the relay comes back, a turn ends and spools its
     * answer, and the loop is mid-pass over that very row. Neither the row's
     * `sent_at` nor its attempt count can tell the two apart — the same
     * generation retrying IS allowed — so without a claim in this process both
     * deliver, and the person reads the answer twice.
     */
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replies: string[] = [];
    const slow: SpoolTransport = {
      reply: async (_to, text) => {
        await blocked;
        replies.push(text);
        return `published_${replies.length}`;
      },
    };
    const owed = new Spool({ store, generation, transport: slow });

    // The turn's own reply, and the loop that woke on the same row.
    const live = owed.reply(inbound(), "once, please");
    const loop = owed.drain();
    release();
    await Promise.all([live, loop]);

    expect(replies).toEqual(["once, please"]);
    expect(store.outboundRow(1)?.attempts).toBe(1);
    expect(store.pendingOutbound(5)).toEqual([]);
    owed.stop();
  });

  it("parks a row that can never go, after a bounded number of tries", async () => {
    const refusing = transport({ failing: true });
    const owed = spool(refusing, { maxAttempts: 3 });
    await owed.reply(inbound(), "nobody will take this");
    await owed.drain();
    await owed.drain();
    // The fourth pass has nothing to look at: the row is parked.
    await owed.drain();

    const [row] = store.pendingOutbound(3);
    expect(row).toBeUndefined();
    const parked = store.outboundRow(1);
    expect(parked?.attempts).toBe(3);
    expect(parked?.sentAt).toBeUndefined();
    expect(parked?.lastError).toContain("did not take the reply");
    owed.stop();
  });

  it("a parked row does not hold up the ones behind it", async () => {
    const bus = transport({ failing: true });
    const owed = spool(bus, { maxAttempts: 1 });
    await owed.reply(inbound("m1"), "the poisoned one");
    bus.heal();
    await owed.reply(inbound("m2"), "the one behind it");
    expect(bus.replies).toEqual([{ to: "m2", text: "the one behind it" }]);
    expect(store.pendingOutbound(1)).toEqual([]);
    owed.stop();
  });

  it("retries a wrap for the recipient who is missing it, and nobody else", async () => {
    const bus = transport();
    // Only the operator can be reached; the second reader cannot, yet.
    const reachable = sink([PEER]);
    const owed = spool(bus, { sink: reachable.impl });
    owed.owe(rumor(), [OTHER], "n".repeat(64), "turn 1");
    await owed.drain();

    expect(reachable.calls).toEqual([{ recipients: [OTHER], selfCopy: false }]);
    // Still owed: the recipient is still unreachable.
    expect(store.pendingOutbound(5)).toHaveLength(1);

    const later = spool(bus, { sink: sink([PEER, OTHER]).impl });
    await later.drain();
    const sent = store.outboundRow(1);
    expect(sent?.sentAt).toBeDefined();
    expect(sent?.sentId).toBe("r1");
    expect(store.pendingOutbound(5)).toEqual([]);
    later.stop();
    owed.stop();
  });

  it("refuses to send once the lease has moved on", async () => {
    /**
     * A zombie holding an old generation must not drain the rows the new holder
     * is draining: both would send, which is the double-publish everything in
     * this store is fenced against.
     */
    const bus = transport({ failing: true });
    const zombie = spool(bus);
    await zombie.reply(inbound(), "sent twice, or not at all");

    store.acquireWriterLease({ takeover: true });
    bus.heal();
    await zombie.drain();
    expect(bus.replies).toEqual([]);
    expect(store.pendingOutbound(5)).toHaveLength(1);
    zombie.stop();
  });

  it("remembers the request a spooled question asked, when it lands", async () => {
    // The mapping travels with the row: a question delivered on the second try
    // is still answerable by replying to it in the room.
    const bus = transport({ failing: true });
    const owed = spool(bus);
    await owed.reply(inbound(), "which branch?", {
      remember: { sessionId: "wrun_1", requestId: "req_1" },
    });
    bus.heal();
    await owed.drain();
    expect(store.questionAsked("published_1")).toEqual({
      sessionId: "wrun_1",
      requestId: "req_1",
    });
    owed.stop();
  });

  it("keeps a store failure inside a send out of the process's face", async () => {
    /**
     * The ack reaction is sent from a place nothing awaits, and so is the retry
     * interval. A sqlite write that fails mid-send — a database a Ctrl-C closed
     * during the turn, a busy one, a full disk — would leave an unhandled
     * rejection there, and Node's default for that is to end the daemon.
     */
    const lines: string[] = [];
    const dying = transport();
    dying.impl.react = async () => {
      // The send is under way; the store goes out from under its bookkeeping.
      store.close();
      return "reaction_1";
    };
    const closing = spool(dying, { log: (line) => lines.push(line) });
    await expect(
      closing.react(inbound(), "\u{1F440}"),
    ).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("is still owed");
    closing.stop();
    // The suite's teardown closes it too, and node:sqlite refuses a second one.
    store = HexStore.open(agentHome(home, AGENT).db);
  });

  it("does not let the retry interval reject into nothing", async () => {
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    const lines: string[] = [];
    const bus = transport({ failing: true });
    const owed = spool(bus, { pollMs: 1, log: (line) => lines.push(line) });
    await owed.reply(inbound(), "owed while the store dies");
    store.close();
    // Long enough for the armed interval to fire on a dead store.
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.off("unhandledRejection", listener);
    owed.stop();
    expect(unhandled).toEqual([]);
    expect(lines.join("\n")).toContain("could not look for owed rows");
    store = HexStore.open(agentHome(home, AGENT).db);
  });
});
