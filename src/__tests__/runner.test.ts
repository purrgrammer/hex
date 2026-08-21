import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NostrEvent } from "nostr-tools";

import { Ingestor } from "../ingest.js";
import { Runner, type RunnerTarget } from "../runner.js";
import { HexStore, agentHome, type StoredTranscript } from "../store.js";
import type { ControlOutcome } from "../eve/serve.js";
import type { SessionControl } from "../nostr/decode-control.js";
import { roomKey } from "../transports/types.js";
import type { Inbound, Room } from "../transports/types.js";

const AGENT = "9".repeat(64);
const PEER = "1".repeat(64);
const OTHER = "2".repeat(64);
const DM: Room = { transport: "nip-17", id: PEER };
const GROUP: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://groups.example/",
};

let counter = 0;

function inbound(overrides: Partial<Inbound> = {}): Inbound {
  counter += 1;
  const author = overrides.author ?? PEER;
  const text = overrides.text ?? "hex, how many kinds are there?";
  const event: NostrEvent = {
    id: overrides.id ?? `m${counter}`,
    pubkey: author,
    created_at: overrides.createdAt ?? 1000,
    kind: 14,
    content: text,
    tags: [],
    sig: "",
  };
  return {
    id: event.id,
    author,
    text,
    createdAt: event.created_at,
    room: overrides.room ?? DM,
    addressesSelf: overrides.addressesSelf ?? true,
    event,
    ...overrides,
  };
}

function control(overrides: Partial<SessionControl> = {}): SessionControl {
  counter += 1;
  return {
    id: overrides.id ?? `c${counter}`,
    operator: PEER,
    agent: AGENT,
    session: overrides.session ?? "n".repeat(64),
    command: overrides.command ?? "cancel",
    ...overrides,
  };
}

/**
 * A target that records the order it was called in and hands back the deferred
 * that ends each call.
 *
 * The point of the runner is WHEN it calls, so nothing here does any work: a
 * call is recorded and left open until the test ends it, which is the only way
 * to observe two dispatches overlapping.
 */
function target() {
  const calls: string[] = [];
  const open: Array<{ what: string; end: (outcome?: ControlOutcome) => void }> =
    [];
  const open2: Array<{ what: string; fail: (error: Error) => void }> = [];
  const settle = (what: string) =>
    new Promise<ControlOutcome>((resolve, reject) => {
      open.push({ what, end: (outcome) => resolve(outcome ?? "handled") });
      open2.push({ what, fail: reject });
    });
  const impl: RunnerTarget = {
    runTurn: async (message) => {
      calls.push(`turn ${message.id}`);
      await settle(`turn ${message.id}`);
    },
    interrupt: async (message) => {
      calls.push(`interrupt ${message.id}`);
      await settle(`interrupt ${message.id}`);
    },
    applyControl: async (instruction) => {
      calls.push(`control ${instruction.id}`);
      return settle(`control ${instruction.id}`);
    },
  };
  return {
    impl,
    calls,
    /** Let a dispatch finish, and give the microtasks behind it a tick. */
    async finish(what: string, outcome?: ControlOutcome) {
      const found = open.find((entry) => entry.what === what);
      if (!found) throw new Error(`nothing open called ${what}`);
      open.splice(open.indexOf(found), 1);
      found.end(outcome);
      await tick();
    },
    /** End a dispatch the way a turn that published nothing ends: badly. */
    async fail(what: string) {
      const found = open2.find((entry) => entry.what === what);
      if (!found) throw new Error(`nothing open called ${what}`);
      open.splice(
        open.findIndex((entry) => entry.what === what),
        1,
      );
      found.fail(new Error("the runtime refused"));
      await tick();
    },
    running: () => open.map((entry) => entry.what),
  };
}

/** Two turns of the event loop: enough for a settled promise's `.then` chain. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Runner", () => {
  let home: string;
  let store: HexStore;
  let generation: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "runner-"));
    store = HexStore.open(agentHome(home, AGENT).db);
    generation = store.acquireWriterLease({ takeover: true }).generation;
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  function transcriptRow(sessionId: string, nostrId: string): void {
    const row: StoredTranscript = {
      sessionId,
      nostrId,
      seq: 1,
      turn: 0,
      status: "active",
      streamIndex: 0,
      startedAt: 1000,
      inTokens: 0,
      outTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    store.saveTranscript(row, { generation });
  }

  function runner(
    bus: ReturnType<typeof target>,
    overrides: Partial<ConstructorParameters<typeof Runner>[0]> = {},
  ) {
    const ingest = new Ingestor({
      store,
      dispatch: (queued) => run.offer(queued),
    });
    const run = new Runner({
      store,
      queue: ingest,
      target: bus.impl,
      generation,
      selfPubkey: AGENT,
      startedAt: 900,
      repliesPerRoomPerHour: 20,
      now: () => 1000,
      ...overrides,
    });
    return { run, ingest };
  }

  it("serialises a control and a message about one session, in arrival order", async () => {
    /**
     * The race this phase exists for. Turns were serialised per (author, room)
     * and instructions per session, in two maps that could not see each other,
     * so a `cancel` and a question about ONE session ran at once: two readers
     * of one stream, publishing its turns twice under one `seq`.
     */
    const nostrId = "a".repeat(64);
    transcriptRow("wrun_1", nostrId);
    store.rememberConversation(PEER, roomKey(DM), "wrun_1", 1000);

    const bus = target();
    const { ingest } = runner(bus);
    ingest.accept(inbound({ id: "m1" }));
    ingest.acceptControl(control({ id: "c1", session: nostrId }));
    await tick();

    // The message is running; the control about the same session is waiting.
    expect(bus.calls).toEqual(["turn m1"]);
    await bus.finish("turn m1");
    expect(bus.calls).toEqual(["turn m1", "control c1"]);
    expect(bus.running()).toEqual(["control c1"]);
  });

  it("runs two conversations at the same time", async () => {
    const bus = target();
    const { ingest } = runner(bus);
    ingest.accept(inbound({ id: "m1", author: PEER }));
    ingest.accept(
      inbound({ id: "m2", author: OTHER, room: { ...DM, id: OTHER } }),
    );
    await tick();
    expect(bus.running().sort()).toEqual(["turn m1", "turn m2"]);
  });

  it("holds a mid-turn message and answers it when the turn ends", async () => {
    // The one behaviour this phase changes: a second message used to be
    // dropped in silence.
    const bus = target();
    const { ingest } = runner(bus);
    const first = ingest.accept(inbound({ id: "m1" }))!;
    // A group message, so the turn holder's DM steer rule does not apply.
    const second = ingest.accept(inbound({ id: "m2", room: GROUP }))!;
    const third = ingest.accept(inbound({ id: "m3", room: GROUP }))!;
    await tick();

    expect(bus.calls).toEqual(["turn m1", "turn m2"]);
    expect(store.inboundOutcome(first)).toBe("handled");
    // Same lane as m2 — one group room — so it waits.
    expect(store.inboundOutcome(third)).toBeUndefined();

    await bus.finish("turn m2");
    expect(bus.calls).toEqual(["turn m1", "turn m2", "turn m3"]);
    expect(store.inboundOutcome(second)).toBe("handled");
  });

  it("replays a collected event individually, in order", async () => {
    const bus = target();
    const { ingest } = runner(bus, {
      policy: [{ types: ["message"], do: "collect" }],
    });
    ingest.accept(inbound({ id: "m1", room: GROUP }));
    ingest.accept(inbound({ id: "m2", room: GROUP }));
    await tick();
    // Collected, not concurrent: the lane runs one and holds the other.
    expect(bus.calls).toEqual(["turn m1"]);
    await bus.finish("turn m1");
    expect(bus.calls).toEqual(["turn m1", "turn m2"]);
  });

  it("lets the turn holder steer, and does not free the lane behind them", async () => {
    const bus = target();
    const { ingest } = runner(bus);
    ingest.accept(inbound({ id: "m1" }));
    await tick();
    ingest.accept(inbound({ id: "m2" }));
    await tick();
    expect(bus.calls).toEqual(["turn m1", "interrupt m2"]);

    /**
     * The cancelled turn's own ending must not free its successor's claim.
     * When it did, the lane sat open for the length of the handover — long
     * enough for a third message to start a turn the pending interrupt killed.
     */
    await bus.finish("turn m1");
    ingest.accept(inbound({ id: "m3", room: GROUP }));
    ingest.accept(inbound({ id: "m4" }));
    await tick();
    // m4 lands on the DM lane, which the steer still holds: an interrupt is
    // what a held lane produces, and `turn m4` is what a freed one would.
    expect(bus.calls).toEqual([
      "turn m1",
      "interrupt m2",
      "turn m3",
      "interrupt m4",
    ]);
  });

  it("drops the oldest of a full lane, and says so in the row", async () => {
    const bus = target();
    const { ingest } = runner(bus);
    const seqs: number[] = [];
    for (let at = 0; at < 23; at += 1)
      seqs.push(ingest.accept(inbound({ id: `m${at}`, room: GROUP }))!);
    await tick();

    // One running, twenty waiting, two pushed out of the line.
    expect(store.inboundOutcome(seqs[0]!)).toBe("handled");
    expect(store.inboundOutcome(seqs[1]!)).toBe("dropped:overflow");
    expect(store.inboundOutcome(seqs[2]!)).toBe("dropped:overflow");
    expect(store.inboundOutcome(seqs[3]!)).toBeUndefined();
    expect(store.inboundOutcome(seqs[22]!)).toBeUndefined();
  });

  it("caps how many turns run at once, and starts the next when one ends", async () => {
    const bus = target();
    const { ingest } = runner(bus, { maxConcurrentTurns: 1 });
    ingest.accept(inbound({ id: "m1", author: PEER }));
    ingest.accept(
      inbound({ id: "m2", author: OTHER, room: { ...DM, id: OTHER } }),
    );
    await tick();
    expect(bus.calls).toEqual(["turn m1"]);
    await bus.finish("turn m1");
    expect(bus.calls).toEqual(["turn m1", "turn m2"]);
  });

  it("ignores what no rule names, and records why", async () => {
    const bus = target();
    const { ingest } = runner(bus);
    const seq = ingest.accept(
      inbound({ id: "m1", room: GROUP, addressesSelf: false }),
    )!;
    await tick();
    expect(bus.calls).toEqual([]);
    expect(store.inboundOutcome(seq)).toBe("ignored");
  });

  it("drops backfill from before the start, and never hears itself", async () => {
    const bus = target();
    const { ingest } = runner(bus);
    const old = ingest.accept(inbound({ id: "m1", createdAt: 500 }))!;
    const own = ingest.accept(inbound({ id: "m2", author: AGENT }))!;
    await tick();
    expect(bus.calls).toEqual([]);
    expect(store.inboundOutcome(old)).toBe("dropped:before-start");
    expect(store.inboundOutcome(own)).toBe("ignored");
  });

  describe("the hourly rate limit", () => {
    it("counts per room, and only the replies that landed", async () => {
      const bus = target();
      const clock = { at: 1000 };
      const { ingest } = runner(bus, {
        repliesPerRoomPerHour: 2,
        now: () => clock.at,
      });

      for (const id of ["m1", "m2"]) {
        ingest.accept(inbound({ id, room: GROUP }));
        await tick();
        await bus.finish(`turn ${id}`);
      }
      const capped = ingest.accept(inbound({ id: "m3", room: GROUP }))!;
      await tick();
      expect(store.inboundOutcome(capped)).toBe("dropped:rate-limited");

      // Another room has its own count.
      ingest.accept(inbound({ id: "m4", room: DM }));
      await tick();
      expect(bus.calls).toContain("turn m4");

      // An hour later the room is free again.
      clock.at = 1000 + 3601;
      const later = ingest.accept(inbound({ id: "m5", room: GROUP }))!;
      await tick();
      expect(store.inboundOutcome(later)).toBe("handled");
    });

    it("does not spend the limit on a turn that said nothing", async () => {
      const bus = target();
      const { ingest } = runner(bus, { repliesPerRoomPerHour: 1 });
      ingest.accept(inbound({ id: "m1", room: GROUP }));
      await tick();
      // A failed turn published nothing, so it did not spend the allowance.
      await bus.fail("turn m1");
      const next = ingest.accept(inbound({ id: "m2", room: GROUP }))!;
      await tick();
      expect(store.inboundOutcome(next)).toBe("handled");
    });
  });

  describe("claims", () => {
    it("takes a row for the live generation, and not twice", () => {
      const bus = target();
      const { ingest } = runner(bus);
      const seq = ingest.accept(inbound({ id: "m1" }))!;
      expect(store.inboundClaim(seq)).toBe(generation);
      // The same generation never gets it again — that is what stops one
      // process dispatching a row twice.
      expect(store.claimInbound(seq, generation)).toBe(false);
    });

    it("hands a dead generation's control back to the next one", async () => {
      /**
       * Crash redelivery. A control claimed by a process that was killed is
       * still owed: the queue's durable dedupe means no relay will ever hand
       * the wrap over again, so the row is the only thing that can bring it
       * back. Safe only because the `obeyed` ledger makes a second delivery a
       * no-op — see the exactly-one-effect test in eve-serve.test.ts.
       */
      const nostrId = "b".repeat(64);
      transcriptRow("wrun_2", nostrId);
      const instruction = control({ id: "c9", session: nostrId });
      const dead = target();
      const first = runner(dead, { generation: generation - 1 });
      const seq = first.ingest.acceptControl(instruction)!;
      await tick();
      expect(dead.calls).toEqual(["control c9"]);
      expect(store.inboundClaim(seq)).toBe(generation - 1);
      // Killed here: the row is claimed, unsettled, and nobody is running it.

      const alive = target();
      const second = runner(alive);
      second.ingest.drain();
      await tick();
      expect(alive.calls).toEqual(["control c9"]);
      expect(store.inboundClaim(seq)).toBe(generation);
    });

    it("leaves an instruction that did not land owed", async () => {
      const nostrId = "c".repeat(64);
      transcriptRow("wrun_3", nostrId);
      const bus = target();
      const { ingest } = runner(bus);
      const seq = ingest.acceptControl(
        control({ id: "c8", session: nostrId }),
      )!;
      await tick();
      await bus.finish("control c8", "unavailable");
      expect(store.inboundOutcome(seq)).toBeUndefined();
    });
  });
});
