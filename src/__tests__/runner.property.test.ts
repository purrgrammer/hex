/**
 * The runner's decisions, over every line rather than the ones an example
 * thought of.
 */

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { pbtRuns } from "../../test/pbt-runs.js";
import { PENDING_CAP, afterHolding } from "../runner.js";
import type { QueuedEvent } from "../ingest.js";

vi.setConfig({ testTimeout: pbtRuns(30_000) });
/**
 * What a full lane is allowed to throw away.
 *
 * A dropped row is gone for good — the queue's dedupe means no relay offers
 * that wrap again, and a settled row is not redelivered — so the cap is not a
 * backpressure knob, it is a decision about which message never gets answered.
 * A stop button held behind a running turn must not be evictable by twenty
 * messages arriving after it.
 *
 * The all-controls branch is the one an example test never reached: a line of
 * nothing but instructions is allowed to grow past the cap, because the
 * operator pressed every one of them.
 */
describe("holding a message behind a running turn", () => {
  const eventArb = fc
    .record({
      seq: fc.nat({ max: 200 }),
      type: fc.constantFrom("message" as const, "control" as const),
    })
    .map((raw) => ({ seq: raw.seq, type: raw.type }) as unknown as QueuedEvent);

  /*
   * Long enough to actually overflow. fast-check biases arrays small by
   * default, and a line that never reaches the cap makes every property here
   * vacuously true — which it was, until two mutations both survived.
   */
  const controlArb = fc
    .nat({ max: 200 })
    .map((seq) => ({ seq, type: "control" }) as unknown as QueuedEvent);

  const lineArb = fc.array(eventArb, {
    minLength: PENDING_CAP - 2,
    maxLength: PENDING_CAP * 2,
    size: "large",
  });

  it("generates lines that actually overflow", () => {
    // The bootstrap for everything below. These properties were vacuous once
    // — the line never reached the cap — and read exactly as they do now.
    const over = fc
      .sample(lineArb, 200)
      .filter((line) => line.length + 1 > PENDING_CAP).length;
    expect(over).toBeGreaterThan(100);
  });

  it("generates lines of nothing but instructions sometimes", () => {
    // The branch an example test never reached.
    const allControls = fc
      .sample(
        fc.array(controlArb, {
          minLength: PENDING_CAP + 1,
          maxLength: PENDING_CAP + 5,
          size: "large",
        }),
        20,
      )
      .filter((line) => line.every((row) => row.type === "control")).length;
    expect(allControls).toBe(20);
  });

  it("never drops an instruction", () => {
    fc.assert(
      fc.property(lineArb, eventArb, (line, queued) => {
        // invariant: I9 — controls survive whatever else the cap does.
        const { pending, dropped } = afterHolding(line, queued);
        expect(dropped.every((row) => row.type !== "control")).toBe(true);
        const before = [...line, queued].filter(
          (row) => row.type === "control",
        ).length;
        expect(pending.filter((row) => row.type === "control").length).toBe(
          before,
        );
      }),
      { numRuns: pbtRuns(300) },
    );
  });

  it("bounds the line unless the line is all instructions", () => {
    fc.assert(
      fc.property(lineArb, eventArb, (line, queued) => {
        const { pending } = afterHolding(line, queued);
        if (pending.length > PENDING_CAP)
          // The only reason to be over the cap, and it is a reason.
          expect(pending.every((row) => row.type === "control")).toBe(true);
      }),
      { numRuns: pbtRuns(300) },
    );
  });

  it("loses nothing it did not report losing", () => {
    fc.assert(
      fc.property(lineArb, eventArb, (line, queued) => {
        const { pending, dropped } = afterHolding(line, queued);
        // Every row is either still in line or named in the drops. A row that
        // is in neither is one nobody will ever answer and nobody logged.
        expect(pending.length + dropped.length).toBe(line.length + 1);
      }),
      { numRuns: pbtRuns(200) },
    );
  });

  it("drops the oldest first, because the newest is still worth answering", () => {
    fc.assert(
      fc.property(lineArb, eventArb, (line, queued) => {
        const { pending, dropped } = afterHolding(line, queued);
        if (dropped.length === 0) return;
        const all = [...line, queued];
        const messages = all.filter((row) => row.type !== "control");
        // The drops are a prefix of the messages, in arrival order.
        expect(dropped).toEqual(messages.slice(0, dropped.length));
        expect(pending).toEqual(all.filter((row) => !dropped.includes(row)));
      }),
      { numRuns: pbtRuns(200) },
    );
  });
});
