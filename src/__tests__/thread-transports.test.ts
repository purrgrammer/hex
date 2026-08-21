/**
 * Three protocols thread three different ways, and the code that read them was
 * written against one.
 *
 * Reported live, in a NIP-29 group: a reply tagging Hex did not continue the
 * run. The reason was not a bad tag reader, it was that reply resolution was
 * Concord's — NIP-22's uppercase `E` — applied to protocols that do not have
 * one. These pin what each protocol actually puts on the wire, taken from what
 * grimoire writes rather than from what the NIPs permit.
 */

import { describe, it, expect } from "vitest";

import { nip10Parent, nip10Root } from "../transports/nip10.js";
import {
  KIND_GROUP_MESSAGE,
  replyTarget,
  threadRoot,
} from "../transports/nip29.js";
import { replyTargetOf, threadRootOf } from "../transports/concord.js";
import { KIND_COMMENT } from "../concord/kinds.js";

const ROOT = "11".repeat(32);
const PARENT = "22".repeat(32);
const OTHER = "33".repeat(32);

describe("NIP-10 markers, which is how NIP-17 threads", () => {
  it("reads a marked root and a marked reply apart", () => {
    const marked = {
      tags: [
        ["e", ROOT, "", "root"],
        ["e", PARENT, "", "reply"],
        ["e", OTHER, "", "mention"],
      ],
    };
    expect(nip10Root(marked)).toBe(ROOT);
    expect(nip10Parent(marked)).toBe(PARENT);
  });

  it("reads the deprecated positional form: first is root, last is parent", () => {
    const positional = {
      tags: [
        ["e", ROOT],
        ["e", OTHER],
        ["e", PARENT],
      ],
    };
    expect(nip10Root(positional)).toBe(ROOT);
    expect(nip10Parent(positional)).toBe(PARENT);
  });

  it("treats a lone unmarked tag as both, which is what it means", () => {
    // Every reply written before markers existed looks like this. Reporting it
    // as both threads the reply under its parent — one level shallower than the
    // truth, and visible, which beats an orphan.
    const lone = { tags: [["e", PARENT]] };
    expect(nip10Root(lone)).toBe(PARENT);
    expect(nip10Parent(lone)).toBe(PARENT);
  });

  it("never reads a mention as either", () => {
    const mentionOnly = { tags: [["e", OTHER, "", "mention"]] };
    expect(nip10Root(mentionOnly)).toBeUndefined();
    expect(nip10Parent(mentionOnly)).toBeUndefined();
  });

  it("says nothing about an event that threads onto nothing", () => {
    expect(nip10Root({ tags: [["p", OTHER]] })).toBeUndefined();
    expect(nip10Parent({ tags: [] })).toBeUndefined();
  });
});

describe("a NIP-22 comment rooted on something that is not an event id", () => {
  const comment = (tags: string[][]) => ({ kind: KIND_COMMENT, tags }) as never;

  const ADDRESS = "30617:" + "aa".repeat(32) + ":hex";

  it("reads an addressable root, which an article or a repo has", () => {
    // A thread hanging off a repository announcement or a long-form post has
    // no root event id at all — the root IS an address.
    const reply = comment([
      ["A", ADDRESS],
      ["K", "30617"],
      ["a", ADDRESS],
    ]);
    expect(threadRootOf(reply)).toBe(ADDRESS);
    expect(replyTargetOf(reply)).toBe(ADDRESS);
  });

  it("reads an external root, which is not a Nostr event at all", () => {
    const url = "https://example.com/thing";
    const reply = comment([
      ["I", url],
      ["K", "web"],
      ["i", url],
    ]);
    expect(threadRootOf(reply)).toBe(url);
    expect(replyTargetOf(reply)).toBe(url);
  });

  it("prefers an event id when the comment carries both", () => {
    // E is the most specific of the three and the one every in-channel thread
    // uses; an A beside it names the container, not the subject.
    const reply = comment([
      ["A", ADDRESS],
      ["E", ROOT],
      ["e", PARENT],
      ["a", ADDRESS],
    ]);
    expect(threadRootOf(reply)).toBe(ROOT);
    expect(replyTargetOf(reply)).toBe(PARENT);
  });

  it("keeps a deep reply on the thread's root, not its parent's address", () => {
    const reply = comment([
      ["A", ADDRESS],
      ["e", PARENT],
    ]);
    expect(threadRootOf(reply)).toBe(ADDRESS);
    expect(replyTargetOf(reply)).toBe(PARENT);
  });
});

describe("a kind 9, which is how NIP-29 threads", () => {
  const kind9 = (tags: string[][]) =>
    ({ kind: KIND_GROUP_MESSAGE, tags }) as never;

  it("names its parent with q, and no root at all", () => {
    // Exactly what grimoire writes: ["q", id, relay, pubkey], nothing else.
    // This is the shape the bug was reported in.
    const reply = kind9([
      ["h", "group"],
      ["q", PARENT, "wss://groups.0xchat.com/", OTHER],
    ]);
    expect(replyTarget(reply)).toBe(PARENT);
    expect(threadRoot(reply)).toBeUndefined();
  });

  it("reads a root when a client threads with NIP-10 instead", () => {
    const reply = kind9([
      ["e", ROOT, "", "root"],
      ["e", PARENT, "", "reply"],
    ]);
    expect(threadRoot(reply)).toBe(ROOT);
    expect(replyTarget(reply)).toBe(PARENT);
  });

  it("does not invent a root out of a lone e tag", () => {
    // The positional rules report a single tag as both; calling that a root
    // would make every reply the head of its own thread.
    const reply = kind9([["e", PARENT]]);
    expect(replyTarget(reply)).toBe(PARENT);
    expect(threadRoot(reply)).toBeUndefined();
  });

  it("prefers q over e, because that is what a kind 9 reply carries", () => {
    const both = kind9([
      ["q", PARENT],
      ["e", ROOT, "", "root"],
    ]);
    expect(replyTarget(both)).toBe(PARENT);
  });
});
