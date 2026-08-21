/**
 * The two things the policy table and the queue must be true of for EVERY
 * input, not for the inputs someone thought of.
 *
 * `decide` is a total function over events, lane states and tables: whatever it
 * is handed, the answer is one of five words the runner knows how to carry out.
 * `DISPOSITIONS` has been exported since the table landed and used as an oracle
 * by nothing, which is how a rule could return a word nobody handles.
 *
 * The round trip is the other one, and it is the bug this suite was written
 * after: `threadRoot` was read off the tags correctly and dropped on the way
 * into the queue, and since the queue is the only path a message takes to the
 * runtime, every reply arrived with no thread. An exhaustive comparison —
 * every field, not the ones named in an assertion — catches the next one in
 * milliseconds.
 */

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { pbtRuns } from "../../test/pbt-runs.js";
import { carrierFor, messageEvent } from "../ingest.js";
import {
  DISPOSITIONS,
  DEFAULT_POLICY,
  decide,
  whyIgnored,
  type LaneState,
  type PolicyRule,
} from "../policy-table.js";
import { tempStore } from "./support/store.js";
import { idFrom, messageEventArb, TRANSPORTS } from "./arbitraries/store.js";
import type { Inbound } from "../transports/types.js";

/**
 * Depth costs time, and the default five seconds is a baseline's budget.
 *
 * `HEX_PBT_RUNS=20` is the nightly pass: the same properties, twenty times the
 * cases. A timeout tuned to the baseline turns that into a red suite that
 * proves nothing, so the budget scales with the multiplier the same way the
 * run count does.
 */
vi.setConfig({ testTimeout: pbtRuns(30_000) });

const laneArb: fc.Arbitrary<LaneState> = fc
  .record({
    inTurn: fc.boolean(),
    holder: fc.option(fc.nat({ max: 3 }), { nil: undefined }),
    threads: fc.array(fc.nat({ max: 5 }), { maxLength: 3 }),
  })
  .map((raw) => ({
    inTurn: raw.inTurn,
    ...(raw.holder !== undefined
      ? { turnHolder: idFrom("aa", raw.holder) }
      : {}),
    activeThreads: raw.threads.map((index) => idFrom("ee", index)),
  }));

/** A table built from the parts a rule is made of, never from free strings. */
const ruleArb: fc.Arbitrary<PolicyRule> = fc
  .record({
    types: fc.uniqueArray(
      fc.constantFrom("message" as const, "control" as const),
      {
        minLength: 1,
        maxLength: 2,
      },
    ),
    when: fc.constantFrom("idle" as const, "in-turn" as const, "any" as const),
    disposition: fc.constantFrom(...DISPOSITIONS),
    transport: fc.option(fc.constantFrom(...TRANSPORTS), { nil: undefined }),
    addressed: fc.option(fc.boolean(), { nil: undefined }),
    inActiveThread: fc.option(fc.boolean(), { nil: undefined }),
    peer: fc.option(fc.constantFrom("$turn-holder", idFrom("aa", 1)), {
      nil: undefined,
    }),
  })
  .map((raw) => ({
    types: raw.types,
    when: raw.when,
    do: raw.disposition,
    where: {
      ...(raw.transport !== undefined ? { transport: raw.transport } : {}),
      ...(raw.addressed !== undefined ? { addressed: raw.addressed } : {}),
      ...(raw.inActiveThread !== undefined
        ? { inActiveThread: raw.inActiveThread }
        : {}),
      ...(raw.peer !== undefined ? { peer: raw.peer } : {}),
    },
  }));

describe("deciding what to do with an event", () => {
  it("always answers with a word the runner knows", () => {
    fc.assert(
      fc.property(
        messageEventArb,
        laneArb,
        fc.array(ruleArb, { maxLength: 6 }),
        (event, lane, table) => {
          // invariant: I7 — totality. Over an ARBITRARY table, not just the
          // default one: an operator's table is data, and a decision outside
          // this set is one the runner has no branch for.
          expect(DISPOSITIONS).toContain(decide(event, lane, table));
          expect(DISPOSITIONS).toContain(decide(event, lane, DEFAULT_POLICY));
        },
      ),
      { numRuns: pbtRuns(300) },
    );
  });

  it("says why whenever it says no", () => {
    fc.assert(
      fc.property(messageEventArb, laneArb, (event, lane) => {
        if (decide(event, lane) !== "ignore") return;
        // A reason that names no predicate is the log line that turned a
        // five-second question into a database query.
        expect(whyIgnored(event, lane).length).toBeGreaterThan(0);
      }),
      { numRuns: pbtRuns(200) },
    );
  });

  it("is decided by the event and the lane, and nothing else", () => {
    fc.assert(
      fc.property(messageEventArb, laneArb, (event, lane) => {
        // Same inputs, same answer — a decision that drifts between two calls
        // is one that read something it was not given.
        expect(decide(event, lane)).toBe(decide(event, lane));
      }),
      { numRuns: pbtRuns(100) },
    );
  });
});

describe("a message crossing the queue", () => {
  it("comes back out with every field it went in with", () => {
    fc.assert(
      fc.property(messageEventArb, (event) => {
        const tmp = tempStore("hex-roundtrip-");
        try {
          const seq = tmp.store.enqueueInbound(event);
          expect(seq).toBeGreaterThan(0);
          const row = tmp.store.pendingInbound().find((r) => r.seq === seq)!;
          const carrier = carrierFor(row)!;

          // invariant: I13 — exhaustive, not a list of remembered fields. The
          // bug that prompted this suite was a field nobody thought to assert.
          const back = messageEvent(carrier, event.observedAt);
          expect(back.payload).toEqual(event.payload);
          expect(back.id).toBe(event.id);
          expect(back.route.transport).toBe(event.route.transport);
          expect(back.route.room).toBe(event.route.room);
          expect(back.route.peer).toBe(event.route.peer);
          expect(back.route.thread).toBe(event.route.thread);
          expect(back.createdAt).toBe(event.createdAt);
        } finally {
          tmp.dispose();
        }
      }),
      { numRuns: pbtRuns(60) },
    );
  });

  it("keeps a reply answerable after the process that heard it is gone", () => {
    fc.assert(
      fc.property(messageEventArb, (event) => {
        const tmp = tempStore("hex-restart-");
        try {
          const seq = tmp.store.enqueueInbound(event)!;
          tmp.restart();
          const row = tmp.store.pendingInbound().find((r) => r.seq === seq)!;
          const carrier: Inbound = carrierFor(row)!;
          // The raw event is what a Concord reply inherits its K/E/P from, so
          // a row that survives a restart without it cannot be answered.
          expect(carrier.event).toBeDefined();
          expect(carrier.id).toBe(event.id);
        } finally {
          tmp.dispose();
        }
      }),
      { numRuns: pbtRuns(40) },
    );
  });
});
