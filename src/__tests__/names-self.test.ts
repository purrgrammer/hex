/**
 * A `p` tag means two different things, and only one of them is a summons.
 *
 * NIP-27 asks a client to add one for every `nostr:` reference in the content,
 * so a mention is a p-tag. But NIP-10 and NIP-22 also put the parent's author —
 * and NIP-22's uppercase `P`, the ROOT's author — on every reply in a thread.
 * Once Hex has said one thing anywhere, every later message between two humans
 * under it carries Hex's pubkey, written by their client, meaning nothing but
 * "this is who is upstream".
 *
 * Reading that as an address is worse than the text-matching rule it replaced:
 * there, a human had to type `@hex` for it to misfire. Here nobody has to do
 * anything at all, and the place it is most likely — a busy thread on something
 * Hex posted — is the place it costs the most.
 *
 * The shapes below are taken from the live queue, not invented.
 */

import { describe, it, expect } from "vitest";
import { nip19 } from "nostr-tools";

import { namesSelf, mentionsSelf, tagsSelf } from "../policy.js";

const SELF = "a9".repeat(32);
const OTHER = "7f".repeat(32);
const SELF_NPUB = nip19.npubEncode(SELF);
const OTHER_NPUB = nip19.npubEncode(OTHER);
const EVENT = "11".repeat(32);

const event = (content: string, tags: string[][] = []) => ({ content, tags });

describe("a message that names Hex", () => {
  it("names it by a nostr: reference in the content", () => {
    // The live shape of every real mention: the reference a person typed, and
    // the tag their client wrote for it.
    expect(
      namesSelf(
        event(`nostr:${SELF_NPUB} research NIP 5D`, [["p", SELF]]),
        SELF,
      ),
    ).toBe(true);
  });

  it("names it by an nprofile too, which carries relay hints", () => {
    const nprofile = nip19.nprofileEncode({
      pubkey: SELF,
      relays: ["wss://relay.example/"],
    });
    expect(namesSelf(event(`hello nostr:${nprofile}`, []), SELF)).toBe(true);
  });

  it("names it by a p-tag on an event that points at nothing", () => {
    // No parent, no root, no quote: there is no threading to explain the tag,
    // so somebody put it there deliberately. This is the door for clients that
    // write a mention without a reference in the content.
    expect(namesSelf(event("any thoughts?", [["p", SELF]]), SELF)).toBe(true);
  });
});

describe("a message that does not", () => {
  it("is a reply whose p-tag is just the author upstream", () => {
    /**
     * Two humans talking under something Hex said. Their client tags the
     * parent's author on every message; none of them is speaking to Hex, and
     * answering each one is a turn nobody asked for.
     */
    const reply = event("what do you reckon?", [
      ["e", EVENT],
      ["p", SELF],
    ]);
    expect(namesSelf(reply, SELF)).toBe(false);
    // The tag really is there — this is a judgement about why, not about what.
    expect(tagsSelf(reply.tags, SELF)).toBe(true);
  });

  it("is a NIP-22 comment carrying the ROOT author", () => {
    // Uppercase P is the thread's author, and it rides every message in a
    // thread on something Hex posted — however deep, however long.
    const deep = event("agreed", [
      ["E", EVENT],
      ["P", SELF],
      ["e", "22".repeat(32)],
      ["p", OTHER],
    ]);
    expect(namesSelf(deep, SELF)).toBe(false);
  });

  it("is somebody quoting an event Hex wrote", () => {
    // Citing is not addressing. The `q` explains the tag.
    expect(
      namesSelf(
        event("look at this", [
          ["q", EVENT],
          ["p", SELF],
        ]),
        SELF,
      ),
    ).toBe(false);
  });

  it("names somebody else", () => {
    // Straight off the live queue: a message referencing the operator, in a
    // room Hex is in. Decoding is what tells the two apart.
    expect(
      namesSelf(
        event(`nostr:${OTHER_NPUB} what do you think?`, [["p", OTHER]]),
        SELF,
      ),
    ).toBe(false);
  });

  it("only looks like it has a reference", () => {
    expect(mentionsSelf("nostr:npub1thisisnotreal", SELF)).toBe(false);
    expect(mentionsSelf("my npub is " + SELF, SELF)).toBe(false);
  });
});

describe("the reference wins over the threading", () => {
  it("addresses Hex when a threaded reply names it in the content", () => {
    // Somebody in a thread turning to Hex explicitly. The `e` tag would have
    // explained a bare p-tag; it does not explain a typed reference.
    const asking = event(`nostr:${SELF_NPUB} what does NIP-22 say here?`, [
      ["e", EVENT],
      ["p", OTHER],
      ["p", SELF],
    ]);
    expect(namesSelf(asking, SELF)).toBe(true);
  });
});
