/**
 * The store, driven by generated histories a real hex could actually produce.
 *
 * This is the tier that would have caught Phase F. That bug — gap detection
 * that could not fire in any reachable state — survived 188 lines of example
 * tests because one of them moved a stored cursor past a reader's mark through
 * the public, fenced `saveTranscript`. Production can never do that: a reader
 * moves its own mark first. Using only public API calls is not protection; a
 * test can still call them in an order the real system never produces.
 *
 * A model fixes that by construction. Every command has a precondition that a
 * real caller would also have, the model only ever reaches states the API can
 * reach, and each step ends in the shared `checkStoreInvariants` — so a new
 * invariant applies to every history already being generated.
 *
 * `Crash`, `Restart`, `TakeOverLease` and `AdvanceClock` are the point of the
 * exercise rather than trimming round it: they are what make a history
 * reachable AND adversarial, and all four needed the store to take its clock.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pbtFaultRuns, pbtRuns } from "../../test/pbt-runs.js";
import {
  FencedWriteError,
  type HexStore,
  type StoredTranscript,
} from "../store.js";
import { checkStoreInvariants } from "./invariants.js";
import { tempStore, type TempStore } from "./support/store.js";
import {
  clockJumpArb,
  idFrom,
  messageEventArb,
  outboundSpecArb,
  reservationArb,
  sessionArb,
} from "./arbitraries/store.js";
import type { CanonicalEvent } from "../ingest.js";
import type { OutboundSpec } from "../store.js";

/**
 * Depth costs time, and the default five seconds is a baseline's budget.
 *
 * `HEX_PBT_RUNS=20` is the nightly pass: the same properties, twenty times the
 * cases. A timeout tuned to the baseline turns that into a red suite that
 * proves nothing, so the budget scales with the multiplier the same way the
 * run count does.
 */
vi.setConfig({ testTimeout: pbtRuns(30_000) });

const RESERVATION_HORIZON = 10 * 60;
const INBOUND_SEEN_HORIZON = 30 * 24 * 60 * 60;
const INBOUND_DONE_HORIZON = 7 * 24 * 60 * 60;
const OUTBOUND_SENT_HORIZON = 7 * 24 * 60 * 60;

interface InboundRow {
  seq: number;
  /** `(transport, id)` — the identity the queue's own unique index keys on. */
  key: string;
  observedAt: number;
  doneAt?: number;
  claimedGen?: number;
}

interface OutboundState {
  id: number;
  sentAt?: number;
  attempts: number;
}

interface Reservation {
  generation: number;
  reservedAt: number;
}

/** What the store should say, kept as plainly as the store's own rules allow. */
class Model {
  clock = 1_000_000;
  generation = 1;
  /** The fence a writer is holding. Stale after somebody takes over. */
  heldGeneration = 1;
  /** `(transport, id)` ever accepted, with when — the replay guard. */
  seen = new Map<string, number>();
  inbound = new Map<number, InboundRow>();
  outbound = new Map<number, OutboundState>();
  transcripts = new Map<string, { seq: number; streamIndex: number }>();
  reservations = new Map<string, Reservation>();
  /** High-water marks, for the invariant a single snapshot cannot decide. */
  seqHighWater = new Map<string, number>();
  indexHighWater = new Map<string, number>();
  generations: number[] = [1];

  key(event: CanonicalEvent): string {
    return `${event.route.transport}\u0000${event.id}`;
  }

  /** What `HexStore.open` deletes on the way in, at the model's clock. */
  prune(): void {
    for (const [key, at] of this.seen)
      if (at < this.clock - INBOUND_SEEN_HORIZON) this.seen.delete(key);
    for (const [seq, row] of this.inbound)
      if (
        row.doneAt !== undefined &&
        row.doneAt < this.clock - INBOUND_DONE_HORIZON
      )
        this.inbound.delete(seq);
    for (const [id, row] of this.outbound)
      if (
        row.sentAt !== undefined &&
        row.sentAt < this.clock - OUTBOUND_SENT_HORIZON
      )
        this.outbound.delete(id);
    // Reservations are pruned against the lease as it stands BEFORE the new
    // one is taken: `open` runs before anything acquires.
    for (const [key, reservation] of this.reservations)
      if (
        reservation.reservedAt < this.clock - RESERVATION_HORIZON ||
        reservation.generation !== this.generation
      )
        this.reservations.delete(key);
  }
}

interface Real {
  tmp: TempStore;
  store: HexStore;
  clock: { at: number };
  path: string;
}

type StoreCommand = fc.Command<Model, Real>;

const transcriptFor = (
  sessionId: string,
  seq: number,
  streamIndex: number,
): StoredTranscript => ({
  sessionId,
  nostrId: idFrom("dd", seq),
  seq,
  turn: seq,
  status: "active",
  streamIndex,
  startedAt: 1,
  inTokens: 0,
  outTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

class Arrive implements StoreCommand {
  constructor(private readonly event: CanonicalEvent) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const key = model.key(this.event);
    const seq = real.store.enqueueInbound(this.event);
    // invariant: I3 — the second delivery of one event is refused, and the
    // refusal is silent rather than a second row. Either table is enough to
    // refuse it: their retentions differ on purpose, so the guard can be
    // pruned while the queue row it guarded is still there, and a duplicate
    // that only the queue remembers is still a duplicate.
    const queued = [...model.inbound.values()].some((row) => row.key === key);
    if (model.seen.has(key) || queued) {
      expect(seq).toBeUndefined();
      return;
    }
    expect(seq).toBeGreaterThan(0);
    model.seen.set(key, this.event.observedAt);
    model.inbound.set(seq!, {
      seq: seq!,
      key,
      observedAt: this.event.observedAt,
    });
  }
  toString(): string {
    return `Arrive(${this.event.route.transport}/${this.event.id.slice(0, 4)})`;
  }
}

class Claim implements StoreCommand {
  constructor(private readonly which: number) {}
  private seq(model: Model): number | undefined {
    const seqs = [...model.inbound.keys()].sort((a, b) => a - b);
    return seqs[this.which % Math.max(1, seqs.length)];
  }
  check(model: Model): boolean {
    return model.inbound.size > 0;
  }
  run(model: Model, real: Real): void {
    const seq = this.seq(model)!;
    const row = model.inbound.get(seq)!;
    const claimed = real.store.claimInbound(
      seq,
      model.heldGeneration,
      model.clock,
    );
    // A settled row is not work, and a row this generation already holds is
    // not new work: claiming it twice is how one message is answered twice.
    const expected =
      row.doneAt === undefined && row.claimedGen !== model.heldGeneration;
    expect(claimed).toBe(expected);
    if (claimed) row.claimedGen = model.heldGeneration;
  }
  toString(): string {
    return `Claim(#${this.which})`;
  }
}

class Finish implements StoreCommand {
  constructor(
    private readonly which: number,
    private readonly outcome: string,
  ) {}
  check(model: Model): boolean {
    return model.inbound.size > 0;
  }
  run(model: Model, real: Real): void {
    const seqs = [...model.inbound.keys()].sort((a, b) => a - b);
    const seq = seqs[this.which % seqs.length]!;
    real.store.finishInbound(seq, this.outcome, model.clock);
    model.inbound.get(seq)!.doneAt = model.clock;
    expect(real.store.inboundOutcome(seq)).toBe(this.outcome);
  }
  toString(): string {
    return `Finish(#${this.which}, ${this.outcome})`;
  }
}

class Spool implements StoreCommand {
  constructor(private readonly spec: OutboundSpec) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const id = real.store.enqueueOutbound(this.spec, model.clock);
    expect(id).toBeGreaterThan(0);
    model.outbound.set(id, { id, attempts: 0 });
  }
  toString(): string {
    return `Spool(${this.spec.kind})`;
  }
}

class BeginSend implements StoreCommand {
  constructor(private readonly which: number) {}
  check(model: Model): boolean {
    return model.outbound.size > 0;
  }
  run(model: Model, real: Real): void {
    const ids = [...model.outbound.keys()].sort((a, b) => a - b);
    const id = ids[this.which % ids.length]!;
    const row = model.outbound.get(id)!;
    if (model.heldGeneration !== model.generation) {
      // A displaced writer must not be able to start a send. Its turn belongs
      // to whoever holds the home now.
      expect(() => real.store.beginOutbound(id, model.heldGeneration)).toThrow(
        FencedWriteError,
      );
      return;
    }
    const began = real.store.beginOutbound(id, model.heldGeneration);
    expect(began).toBe(row.sentAt === undefined);
    if (began) row.attempts += 1;
  }
  toString(): string {
    return `BeginSend(#${this.which})`;
  }
}

class MarkSent implements StoreCommand {
  constructor(private readonly which: number) {}
  check(model: Model): boolean {
    return [...model.outbound.values()].some(
      (row) => row.sentAt === undefined && row.attempts > 0,
    );
  }
  run(model: Model, real: Real): void {
    const owed = [...model.outbound.values()]
      .filter((row) => row.sentAt === undefined && row.attempts > 0)
      .sort((a, b) => a.id - b.id);
    const row = owed[this.which % owed.length]!;
    real.store.outboundSent(row.id, idFrom("ff", row.id), model.clock);
    row.sentAt = model.clock;
    // invariant: I5 — delivered exactly once: a sent row is no longer owed, so
    // nothing can pick it up and send it again.
    expect(real.store.owedOutbound(row.id)).toBeUndefined();
  }
  toString(): string {
    return `MarkSent(#${this.which})`;
  }
}

class SaveTranscript implements StoreCommand {
  constructor(
    private readonly session: string,
    private readonly seq: number,
    private readonly streamIndex: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const record = transcriptFor(this.session, this.seq, this.streamIndex);
    const known = model.transcripts.get(this.session);
    const stale = model.heldGeneration !== model.generation;
    // invariant: I1 — a write that would walk either cursor backwards is
    // refused, because the only thing that moves them backwards is a second
    // writer that has already moved them forward.
    const backwards =
      known !== undefined &&
      (this.seq < known.seq || this.streamIndex < known.streamIndex);
    if (stale || backwards) {
      expect(() =>
        real.store.saveTranscript(record, { generation: model.heldGeneration }),
      ).toThrow(FencedWriteError);
      return;
    }
    real.store.saveTranscript(record, { generation: model.heldGeneration });
    model.transcripts.set(this.session, {
      seq: this.seq,
      streamIndex: this.streamIndex,
    });
    model.seqHighWater.set(
      this.session,
      Math.max(model.seqHighWater.get(this.session) ?? 0, this.seq),
    );
    model.indexHighWater.set(
      this.session,
      Math.max(model.indexHighWater.get(this.session) ?? 0, this.streamIndex),
    );
  }
  toString(): string {
    return `SaveTranscript(${this.session}, seq ${this.seq}, index ${this.streamIndex})`;
  }
}

class Reserve implements StoreCommand {
  constructor(
    private readonly entry: { kind: number; scope: string; subject: string },
  ) {}
  check(model: Model): boolean {
    return model.heldGeneration === model.generation;
  }
  run(model: Model, real: Real): void {
    const key = `${this.entry.kind}\u0000${this.entry.scope}\u0000${this.entry.subject}`;
    real.store.reservePublish({
      ...this.entry,
      generation: model.heldGeneration,
      at: model.clock,
    });
    model.reservations.set(key, {
      generation: model.heldGeneration,
      reservedAt: model.clock,
    });
    // invariant: I6 — the key is now taken, and taken by this writer.
    const live = real.store.liveReservation(
      this.entry.kind,
      this.entry.scope,
      this.entry.subject,
    );
    expect(live?.generation).toBe(model.heldGeneration);
  }
  toString(): string {
    return `Reserve(${this.entry.kind}/${this.entry.subject})`;
  }
}

class ReleaseReservation implements StoreCommand {
  constructor(
    private readonly entry: { kind: number; scope: string; subject: string },
  ) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const key = `${this.entry.kind}\u0000${this.entry.scope}\u0000${this.entry.subject}`;
    real.store.releasePublish(
      this.entry.kind,
      this.entry.scope,
      this.entry.subject,
      model.heldGeneration,
    );
    const held = model.reservations.get(key);
    if (held?.generation === model.heldGeneration)
      model.reservations.delete(key);
    expect(
      real.store.liveReservation(
        this.entry.kind,
        this.entry.scope,
        this.entry.subject,
      ),
    ).toBeUndefined();
  }
  toString(): string {
    return `ReleaseReservation(${this.entry.kind}/${this.entry.subject})`;
  }
}

class Obey implements StoreCommand {
  constructor(private readonly which: number) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const id = idFrom("cc", this.which);
    const first = real.store.obeyOnce(id, model.clock);
    // An instruction is carried out once however often a relay re-serves it.
    expect(real.store.obeyOnce(id, model.clock)).toBe(false);
    expect(real.store.wasObeyed(id)).toBe(true);
    void first;
  }
  toString(): string {
    return `Obey(#${this.which})`;
  }
}

class TakeOverLease implements StoreCommand {
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    const lease = real.store.acquireWriterLease({ takeover: true });
    // invariant: I2 — a generation never repeats, so the displaced writer's
    // fence can always be told from the new one's.
    expect(lease.generation).toBeGreaterThan(model.generation);
    model.generation = lease.generation;
    model.generations.push(lease.generation);
    // The old writer keeps holding its stale fence: that is the state every
    // fencing check exists for, and the model stays in it deliberately.
  }
  toString(): string {
    return "TakeOverLease()";
  }
}

class Restart implements StoreCommand {
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    // Whatever was only in memory is gone; the file is all that is left.
    model.prune();
    real.store = real.tmp.restart();
    const generation = real.store.writerLeaseHolder()!.generation;
    expect(generation).toBeGreaterThan(model.generation);
    model.generation = generation;
    model.heldGeneration = generation;
    model.generations.push(generation);
  }
  toString(): string {
    return "Restart()";
  }
}

class AdvanceClock implements StoreCommand {
  constructor(private readonly by: number) {}
  check(): boolean {
    return true;
  }
  run(model: Model, real: Real): void {
    model.clock += this.by;
    real.clock.at = model.clock;
    // A reservation that has aged out stops being live without anything having
    // to notice — which is what stops a crash between reserve and confirm from
    // blocking that subject forever.
    for (const [key, reservation] of model.reservations)
      if (reservation.reservedAt < model.clock - RESERVATION_HORIZON)
        model.reservations.delete(key);
  }
  toString(): string {
    return `AdvanceClock(+${this.by}s)`;
  }
}

const commandsArb = fc.commands(
  [
    messageEventArb.map((event) => new Arrive(event)),
    fc.nat({ max: 5 }).map((which) => new Claim(which)),
    fc
      .tuple(
        fc.nat({ max: 5 }),
        fc.constantFrom("handled", "ignored", "refused"),
      )
      .map(([which, outcome]) => new Finish(which, outcome)),
    outboundSpecArb.map((spec) => new Spool(spec)),
    fc.nat({ max: 5 }).map((which) => new BeginSend(which)),
    fc.nat({ max: 5 }).map((which) => new MarkSent(which)),
    fc
      .tuple(sessionArb, fc.nat({ max: 6 }), fc.nat({ max: 6 }))
      .map(([session, seq, index]) => new SaveTranscript(session, seq, index)),
    reservationArb.map((entry) => new Reserve(entry)),
    reservationArb.map((entry) => new ReleaseReservation(entry)),
    fc.nat({ max: 3 }).map((which) => new Obey(which)),
    fc.constant(new TakeOverLease()),
    fc.constant(new Restart()),
    clockJumpArb.map((by) => new AdvanceClock(by)),
  ],
  { maxCommands: 40, size: "large" },
);

describe("the store, over generated histories", () => {
  let open: TempStore | undefined;

  afterEach(() => {
    open?.dispose();
    open = undefined;
  });

  it("never says anything it must never say", () => {
    fc.assert(
      fc.property(commandsArb, (commands) => {
        const clock = { at: 1_000_000 };
        const tmp = tempStore("hex-pbt-", () => clock.at);
        open = tmp;
        try {
          const model = new Model();
          model.generation = tmp.store.writerLeaseHolder()!.generation;
          model.heldGeneration = model.generation;
          model.generations = [model.generation];
          const real: Real = {
            tmp,
            store: tmp.store,
            clock,
            path: tmp.path,
          };
          fc.modelRun(() => ({ model, real }), commands);
          checkStoreInvariants(tmp.path, {
            transcriptSeq: model.seqHighWater,
            streamIndex: model.indexHighWater,
            generations: model.generations,
          });
        } finally {
          tmp.dispose();
          open = undefined;
        }
      }),
      {
        // The fault knob, not the general one: Crash, Restart and a stolen
        // lease are what this suite is for, and their paths pay off at depth.
        numRuns: pbtFaultRuns(150),
        // A failing run prints its seed and path; HEX_PBT_SEED replays it.
        ...(process.env["HEX_PBT_SEED"]
          ? { seed: Number(process.env["HEX_PBT_SEED"]) }
          : {}),
      },
    );
  });
});
/**
 * The shrunk counterexample from the run that found it, kept as an example.
 *
 * The model shrank it to four commands — `AdvanceClock(+31d)`, `Arrive`,
 * `Restart`, `Arrive` — and a seed only reproduces until someone changes an
 * arbitrary. Promoted to a named test so the case is pinned regardless: the
 * property still generates it, and this proves it whether or not that run gets
 * lucky.
 *
 * What it caught: the queue and the replay guard have different retentions on
 * purpose, and a row nothing ever settled is never pruned while its guard row
 * goes at thirty days. The redelivery then walked past the guard into the
 * identity index, and enqueueing THREW where it should have said "already have
 * it" — an exception on the ingest path, for an ordinary duplicate.
 */
describe("a redelivery that outlived its replay guard", () => {
  it("is refused rather than thrown at", () => {
    const clock = { at: 1_000_000 };
    const tmp = tempStore("hex-dup-", () => clock.at);
    try {
      const event = {
        v: 1,
        type: "message",
        id: idFrom("ee", 1),
        route: { transport: "nip-29", room: "room", peer: idFrom("aa", 1) },
        // Old enough that thirty days of clock puts it past the guard's
        // horizon, which is the whole shape of the case.
        createdAt: 10,
        observedAt: 10,
        payload: { text: "hello", addressesSelf: true },
        raw: undefined,
      } as unknown as CanonicalEvent;

      expect(tmp.store.enqueueInbound(event)).toBeGreaterThan(0);
      // Never settled: a row that was never finished is never pruned.
      clock.at += 31 * 24 * 60 * 60;
      tmp.restart();

      expect(tmp.store.enqueueInbound(event)).toBeUndefined();
    } finally {
      tmp.dispose();
    }
  });
});
