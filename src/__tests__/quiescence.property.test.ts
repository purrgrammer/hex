/**
 * What is left in memory when there is nothing left to do.
 *
 * Two sets guard against handing the same work out twice — the ingestor's
 * `inFlight`, the spool's `sending` — and both are invisible from outside. A
 * seq stranded in either is a row nothing will ever offer again: the message is
 * not lost, it is not retried either, and only a restart notices. Nothing
 * asserted this, because "the set is empty" is not a thing an example test
 * naturally reaches for.
 *
 * Quiescent is the only state where the answer is known, so these drive to it
 * and then look.
 */

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { pbtRuns } from "../../test/pbt-runs.js";
import { Ingestor, type QueuedEvent } from "../ingest.js";
import { Spool } from "../outbound.js";
import { FencedWriteError } from "../store.js";
import { tempStore } from "./support/store.js";
import { messageEventArb } from "./arbitraries/store.js";
import type { Inbound } from "../transports/types.js";

vi.setConfig({ testTimeout: pbtRuns(30_000) });

/** What a dispatched row is answered with, or nothing at all. */
const outcomeArb = fc.constantFrom(
  "handled",
  "ignored",
  "refused",
  "dropped:overflow",
);

describe("the ingestor, once everything is settled", () => {
  it("is holding nothing", () => {
    fc.assert(
      fc.property(
        fc.array(messageEventArb, { minLength: 1, maxLength: 12 }),
        fc.array(outcomeArb, { minLength: 1, maxLength: 12 }),
        (events, outcomes) => {
          const tmp = tempStore("hex-quiescent-");
          try {
            const seen: QueuedEvent[] = [];
            const ingest: Ingestor = new Ingestor({
              store: tmp.store,
              dispatch: (queued) => seen.push(queued),
            });

            // Enqueued through the store and drained, which is the same path
            // `accept` takes — and lets the generated event go in as itself.
            for (const event of events) tmp.store.enqueueInbound(event);
            ingest.drain();
            // Settle everything that was handed out, in the order it was.
            seen.forEach((queued, index) =>
              ingest.finish(queued.seq, outcomes[index % outcomes.length]!),
            );

            // invariant: I10 — nothing owed, nothing held. A seq left here is
            // a row `drain` will skip forever.
            expect(ingest.inFlightCount).toBe(0);
            expect(tmp.store.pendingInbound()).toEqual([]);
          } finally {
            tmp.dispose();
          }
        },
      ),
      { numRuns: pbtRuns(60) },
    );
  });

  it("hands a row out once however often it drains", () => {
    fc.assert(
      fc.property(
        fc.array(messageEventArb, { minLength: 1, maxLength: 8 }),
        fc.nat({ max: 4 }),
        (events, extraDrains) => {
          const tmp = tempStore("hex-redrain-");
          try {
            const seen: QueuedEvent[] = [];
            const ingest: Ingestor = new Ingestor({
              store: tmp.store,
              dispatch: (queued) => seen.push(queued),
            });
            for (const event of events) tmp.store.enqueueInbound(event);
            ingest.drain();
            const afterAccept = seen.length;
            for (let i = 0; i < extraDrains; i++) ingest.drain();
            // Nothing is dispatched twice while it is still in flight — two
            // dispatches of one row is one message answered twice.
            expect(seen.length).toBe(afterAccept);
          } finally {
            tmp.dispose();
          }
        },
      ),
      { numRuns: pbtRuns(50) },
    );
  });
});

const inboundFor = (id: string): Inbound =>
  ({
    id,
    author: "aa".repeat(32),
    text: "?",
    createdAt: 1,
    room: { transport: "nip-29", id: "room" },
    addressesSelf: true,
    event: {
      id,
      pubkey: "aa".repeat(32),
      kind: 9,
      tags: [],
      content: "?",
      created_at: 1,
      sig: "",
    },
  }) as unknown as Inbound;

describe("the spool, after a pass that went wrong", () => {
  /** Every way one delivery can end, including the two that used to strand it. */
  const failureArb = fc.constantFrom("ok", "throws", "fenced", "rejects-late");

  it("is holding nothing, however the delivery ended", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(failureArb, { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        async (failures, stealLease) => {
          const tmp = tempStore("hex-spool-quiescent-");
          try {
            let call = 0;
            const spool = new Spool({
              store: tmp.store,
              generation: tmp.lease.generation,
              transport: {
                reply: async () => {
                  const mode = failures[call++ % failures.length];
                  if (mode === "throws") throw new Error("relay said no");
                  if (mode === "fenced")
                    throw new FencedWriteError("somebody took the home");
                  if (mode === "rejects-late") {
                    await Promise.resolve();
                    throw new Error("the socket went away");
                  }
                  return "ff".repeat(32);
                },
              },
              maxAttempts: 2,
              log: () => {},
            });

            for (let i = 0; i < failures.length; i++)
              await spool.reply(inboundFor(`${i}`.padEnd(64, "0")), "answer");
            /*
             * The path that reaches `send`'s own catch.
             *
             * A transport error is caught a level down, in `deliverOnce`, so
             * throwing from the relay never leaves that block by the exception
             * route — and a first draft of this property could not tell a
             * try/finally from a delete on the success path. Taking the lease
             * makes `beginOutbound` throw, which is what that catch is for.
             */
            if (stealLease) tmp.store.acquireWriterLease({ takeover: true });
            await spool.drain();

            // invariant: I10 — the try/finally is the guarantee; this is the
            // assertion that it stays one. A row stuck here is never retried.
            expect(spool.sendingCount).toBe(0);
            spool.stop();
          } finally {
            tmp.dispose();
          }
        },
      ),
      { numRuns: pbtRuns(30) },
    );
  });
});

/**
 * The one path that reaches `send`'s own catch.
 *
 * A relay error is caught a level down, in `deliverOnce`, so nothing a
 * transport does ever leaves that try block by the exception route. Only a
 * STORE failure does — and the ordinary one is the lease having moved on, which
 * `beginOutbound` refuses by throwing. Written deliberately rather than
 * generated, because the property above could not tell a try/finally from a
 * delete on the success path: every case it drew went down the caught branch.
 */
describe("a send made by a writer that no longer owns the home", () => {
  it("leaves nothing behind when it is refused", async () => {
    const tmp = tempStore("hex-spool-fenced-");
    try {
      const spool = new Spool({
        store: tmp.store,
        // Stale by one: whatever this writer thought it held, the lease is
        // somewhere else, and every begin will say so.
        generation: tmp.lease.generation - 1,
        transport: { reply: async () => "ff".repeat(32) },
        log: () => {},
      });

      await spool.reply(inboundFor("1".padEnd(64, "0")), "answer");
      await spool.drain();

      // invariant: I10 — the row is still owed, and nothing is holding it.
      expect(spool.sendingCount).toBe(0);
      expect(tmp.store.owedOutbound(1)).toBeDefined();
      spool.stop();
    } finally {
      tmp.dispose();
    }
  });
});
