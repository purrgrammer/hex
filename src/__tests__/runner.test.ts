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
    tagsSelf: overrides.tagsSelf ?? overrides.addressesSelf ?? true,
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
    /**
     * Recorded and answered at once, so a test that sees `abandon` but not the
     * turn behind it is seeing the wait, not a slow fake.
     */
    abandon: async (message) => {
      calls.push(`abandon ${message.id}`);
    },
    abandonSession: async (instruction) => {
      calls.push(`stop ${instruction.id}`);
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

    // The message is running; the control about the same session is waiting,
    // having asked the runtime to stop the turn on its way into the line.
    expect(bus.calls).toEqual(["turn m1", "stop c1"]);
    expect(bus.running()).toEqual(["turn m1"]);
    await bus.finish("turn m1");
    expect(bus.calls).toEqual(["turn m1", "stop c1", "control c1"]);
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

  it("lets the turn holder steer, and waits for the turn it abandons", async () => {
    /**
     * The steering turn must not start until the abandoned one has RETURNED.
     * The map this class replaced awaited it; for one commit nothing did, and
     * two turns read one session's stream at once — the abandoned follow could
     * see the new turn's `turn.completed` and publish its own reply, which is
     * the two-readers failure this whole file exists to prevent.
     */
    const bus = target();
    const { ingest } = runner(bus);
    ingest.accept(inbound({ id: "m1" }));
    await tick();
    ingest.accept(inbound({ id: "m2" }));
    await tick();
    // Asked to stop, and nothing more: `turn m1` is still the only reader.
    expect(bus.calls).toEqual(["turn m1", "abandon m2"]);
    expect(bus.running()).toEqual(["turn m1"]);

    await bus.finish("turn m1");
    expect(bus.calls).toEqual(["turn m1", "abandon m2", "turn m2"]);

    /**
     * The cancelled turn's own ending must not free its successor's claim.
     * When it did, the lane sat open for the length of the handover — long
     * enough for a third message to start a turn the pending interrupt killed.
     */
    ingest.accept(inbound({ id: "m3", room: GROUP }));
    ingest.accept(inbound({ id: "m4" }));
    await tick();
    // m4 lands on the DM lane, which the steer still holds: an `abandon` is
    // what a held lane produces, and `turn m4` is what a freed one would.
    expect(bus.calls).toEqual([
      "turn m1",
      "abandon m2",
      "turn m2",
      "turn m3",
      "abandon m4",
    ]);
    expect(bus.running().sort()).toEqual(["turn m2", "turn m3"]);
  });

  it("stops a runaway turn when the operator asks, before the stop's turn", async () => {
    /**
     * The stop button has to work while the work it targets is still running.
     * Queued behind that turn and nothing else, it landed on a turn that had
     * already ended by itself — and if the turn never ended, never at all.
     *
     * The instruction still waits its turn: carrying it out reads the session's
     * stream, which the turn being stopped is still reading. Only the ASK is
     * out of band, and it is what makes the turn end.
     */
    const nostrId = "e".repeat(64);
    transcriptRow("wrun_5", nostrId);
    store.rememberConversation(PEER, roomKey(GROUP), "wrun_5", 1000);

    const bus = target();
    const { ingest } = runner(bus);
    ingest.accept(inbound({ id: "m1", room: GROUP }));
    await tick();
    const stop = ingest.acceptControl(
      control({ id: "c1", session: nostrId, command: "cancel" }),
    )!;
    await tick();

    expect(bus.calls).toEqual(["turn m1", "stop c1"]);
    // Not dispatched, and not settled either: it is owed until it obeys.
    expect(store.inboundOutcome(stop)).toBeUndefined();

    // A verb that only reads waits in silence — there is nothing to abort.
    const other = ingest.acceptControl(
      control({ id: "c2", session: nostrId, command: "compact" }),
    )!;
    await tick();
    expect(bus.calls).toEqual(["turn m1", "stop c1"]);
    expect(store.inboundOutcome(other)).toBeUndefined();

    await bus.finish("turn m1");
    expect(bus.calls).toEqual(["turn m1", "stop c1", "control c1"]);
  });

  it("puts a control-plane start and the steer that follows it in one lane", async () => {
    /**
     * The lane was derived from the conversation row alone, and a `start` has
     * not written one yet: the start ran in `session\0<id>` and the steer that
     * came minutes later resolved to `<operator>\0` — an idle lane — and
     * dispatched at once. `obey` then built a second transcript over the live
     * session, because a control-plane run is deliberately absent from the
     * conversations map, so the seq chain had two writers.
     */
    const nostrId = "f".repeat(64);
    const bus = target();
    const { ingest } = runner(bus);
    ingest.acceptControl(
      control({
        id: "cs",
        session: nostrId,
        command: "start",
        text: "read the room",
      }),
    );
    await tick();
    expect(bus.calls).toEqual(["control cs"]);

    // What `start` publishes while it runs: the head, and its conversation row
    // — an operator and no room.
    transcriptRow("wrun_6", nostrId);
    store.rememberConversation(PEER, "", "wrun_6", 1000);

    const steer = ingest.acceptControl(
      control({
        id: "c2",
        session: nostrId,
        command: "steer",
        text: "and now",
      }),
    )!;
    await tick();
    // Held behind the start, not run alongside it.
    expect(bus.calls).toEqual(["control cs"]);
    expect(store.inboundOutcome(steer)).toBeUndefined();

    await bus.finish("control cs");
    expect(bus.calls).toEqual(["control cs", "control c2"]);
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

  it("never lets a message flood push a held control out of the line", async () => {
    /**
     * A dropped row is gone for good: the queue's dedupe means no relay offers
     * the wrap again, and a settled row is not redelivered at the next start.
     * A stop the operator pressed while a turn was running must therefore
     * outlive whatever arrives after it.
     */
    const nostrId = "d".repeat(64);
    transcriptRow("wrun_4", nostrId);
    store.rememberConversation(PEER, roomKey(GROUP), "wrun_4", 1000);

    const bus = target();
    const { ingest } = runner(bus);
    ingest.accept(inbound({ id: "m0", room: GROUP }));
    const held = ingest.acceptControl(control({ id: "c7", session: nostrId }))!;
    for (let at = 1; at < 40; at += 1)
      ingest.accept(inbound({ id: `m${at}`, room: GROUP }));
    await tick();

    expect(store.inboundOutcome(held)).toBeUndefined();
    await bus.finish("turn m0");
    // The control is still first in line, and it is what runs next.
    expect(bus.calls).toEqual(["turn m0", "stop c7", "control c7"]);
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
    it("counts per room, off the queue rather than off memory", async () => {
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

    it("spends the limit on a turn that failed, because it cost the same", async () => {
      /**
       * This used to be the opposite, and the opposite was a hole: the meter
       * counted replies that LANDED, so anything that made a turn end without
       * publishing was free. A turn is what costs money — the tokens are spent
       * whether or not the answer reaches the room — so a turn is what it
       * counts.
       */
      const bus = target();
      const { ingest } = runner(bus, { repliesPerRoomPerHour: 1 });
      ingest.accept(inbound({ id: "m1", room: GROUP }));
      await tick();
      await bus.fail("turn m1");

      const next = ingest.accept(inbound({ id: "m2", room: GROUP }))!;
      await tick();
      expect(store.inboundOutcome(next)).toBe("dropped:rate-limited");
    });

    it("survives a restart, because the meter is not in this process", async () => {
      /**
       * The old counter was a Map of timestamps, so every restart handed the
       * room a fresh hour. A daemon that restarts eight times in an afternoon
       * had no rate limit at all — and restarting is the ordinary case here,
       * not the exceptional one.
       */
      const bus = target();
      const first = runner(bus, { repliesPerRoomPerHour: 1 });
      first.ingest.accept(inbound({ id: "m1", room: GROUP }));
      await tick();
      await bus.finish("turn m1");

      // A whole new Runner and Ingestor over the same store: what the last
      // process spent is still spent.
      const second = runner(bus, { repliesPerRoomPerHour: 1 });
      const next = second.ingest.accept(inbound({ id: "m2", room: GROUP }))!;
      await tick();
      expect(store.inboundOutcome(next)).toBe("dropped:rate-limited");
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

    it("does not answer a message whose answer is already owed", async () => {
      /**
       * The redelivery hole, closed by the spool. A message row a dead
       * generation claimed can be handed to the next one, and the turn behind
       * it may already have run — its answer spooled and waiting for a relay.
       * Asking again costs a second run of a model and answers one question
       * twice; the outbound row is the marker that says not to.
       */
      const bus = target();
      // A queue that never settles: the process died before it could.
      const { ingest } = runner(bus, { queue: { finish: () => {} } });
      const message = inbound({ id: "m7" });
      const seq = ingest.accept(message)!;
      await tick();
      expect(bus.calls).toEqual(["turn m7"]);
      expect(store.inboundOutcome(seq)).toBeUndefined();
      store.enqueueOutbound({
        inboundSeq: seq,
        kind: "reply",
        transport: "nip-17",
        room: PEER,
        payload: { to: message, text: "already composed" },
      });

      // The same row, offered to the next generation the way a restart does.
      const revived = target();
      const second = runner(revived, {
        generation: store.acquireWriterLease({ takeover: true }).generation,
      });
      second.ingest.drain();
      await tick();
      expect(revived.calls).toEqual([]);
      expect(store.inboundOutcome(seq)).toBe("handled");
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
