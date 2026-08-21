/**
 * The one thing a transport can answer on its own.
 *
 * Whether a message is FOR Hex moved to `addressing.ts`, where it can be stated
 * as a function of an event, a room and what Hex remembers. What is left here
 * is the fact that decision is built on, and it is a fact about tags.
 */

import { describe, it, expect } from "vitest";
import { tagsSelf } from "../policy.js";

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("tagsSelf", () => {
  it("is true when a p tag names Hex", () => {
    expect(tagsSelf([["p", SELF]], SELF)).toBe(true);
  });

  it("is true among other tags", () => {
    expect(
      tagsSelf(
        [
          ["e", "1".repeat(64)],
          ["p", OTHER],
          ["p", SELF],
        ],
        SELF,
      ),
    ).toBe(true);
  });

  it("is false for somebody else's p tag", () => {
    expect(tagsSelf([["p", OTHER]], SELF)).toBe(false);
  });

  it("is false for no tags at all", () => {
    expect(tagsSelf([], SELF)).toBe(false);
  });

  it("never looks at anything but p tags", () => {
    // A `q`, an `e` or an `a` naming Hex is a citation, not an address.
    expect(tagsSelf([["q", SELF]], SELF)).toBe(false);
    expect(tagsSelf([["e", SELF]], SELF)).toBe(false);
  });
});
