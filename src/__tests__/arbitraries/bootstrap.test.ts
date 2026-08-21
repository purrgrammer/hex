/**
 * The generators, checked before anything that depends on them.
 *
 * A property that never generates the interesting shape passes for the wrong
 * reason, and reads exactly like one that passes for the right one. It happened
 * here: the runner's line arbitrary was bounded above the cap but fast-check
 * biases arrays small, so the line never overflowed — and two mutations that
 * should have failed it both survived. Nothing about the property said so.
 *
 * So every arbitrary the suites lean on states the shape it must reach, and
 * says it here rather than being trusted. A generator bug fails as a generator
 * bug, not as a mysterious invariant that holds.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { clockJumpArb, messageEventArb, outboundSpecArb } from "./store.js";
import type { MessagePayload } from "../../ingest.js";

/** How often a shape shows up across a sample, as a fraction. */
function share<T>(
  arb: fc.Arbitrary<T>,
  count: number,
  predicate: (value: T) => boolean,
): number {
  const samples = fc.sample(arb, count);
  return samples.filter(predicate).length / samples.length;
}

describe("the message generator", () => {
  it("offers the same event more than once, so dedupe is reachable", () => {
    const ids = fc.sample(messageEventArb, 200).map((event) => event.id);
    // The whole point of the id pool being small. Without repeats, I3 is a
    // property about a case that never arises.
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it("threads some of them and not others", () => {
    const threaded = share(
      messageEventArb,
      200,
      (event) => (event.payload as MessagePayload).threadRoot !== undefined,
    );
    expect(threaded).toBeGreaterThan(0.15);
    expect(threaded).toBeLessThan(0.9);
  });

  it("names a parent deeper than the root sometimes", () => {
    // The case that made reading only the parent look sufficient is the one
    // where they are equal; the one that broke it is where they differ.
    const deeper = share(messageEventArb, 300, (event) => {
      const payload = event.payload as MessagePayload;
      return (
        payload.threadRoot !== undefined &&
        payload.replyToId !== undefined &&
        payload.threadRoot !== payload.replyToId
      );
    });
    expect(deeper).toBeGreaterThan(0.05);
  });

  it("spreads across every transport", () => {
    const transports = new Set(
      fc.sample(messageEventArb, 200).map((event) => event.route.transport),
    );
    expect(transports.size).toBe(3);
  });
});

describe("the outbound generator", () => {
  it("produces all three kinds", () => {
    const kinds = new Set(
      fc.sample(outboundSpecArb, 200).map((spec) => spec.kind),
    );
    expect(kinds).toEqual(new Set(["reply", "reaction", "wrap"]));
  });
});

describe("the clock generator", () => {
  it("reaches past every horizon it is supposed to", () => {
    const jumps = new Set(fc.sample(clockJumpArb, 200));
    // A reservation lapses at ten minutes and a settled queue row at seven
    // days: a uniform integer would essentially never land on either.
    expect([...jumps].some((by) => by > 10 * 60)).toBe(true);
    expect([...jumps].some((by) => by > 7 * 24 * 60 * 60)).toBe(true);
    expect([...jumps].some((by) => by > 30 * 24 * 60 * 60)).toBe(true);
  });
});
