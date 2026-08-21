/**
 * Talking about someone is not talking to them.
 *
 * NIP-17 has no participant field: the `p` tags ARE the conversation, and a
 * client keys a thread on that set. applesauce's `setShortTextContent` runs
 * `tagPubkeyMentions()`, so a "nostr:npub1…" in the prose silently adds that
 * pubkey as a participant — turning a private reply into a group thread with
 * someone who never receives a wrap and can never read it.
 */

import { describe, expect, it } from "vitest";

import { participantsOnly } from "../transports/nip17.js";

const PEER = "1".repeat(64);
const BYSTANDER = "2".repeat(64);
const OTHER = "3".repeat(64);

describe("participantsOnly", () => {
  it("drops a pubkey the prose only mentioned", () => {
    const tags = participantsOnly(
      [
        ["p", PEER],
        ["p", BYSTANDER],
      ],
      PEER,
    );
    expect(tags).toEqual([["p", PEER]]);
  });

  it("keeps the recipient when mention-tagging replaced it entirely", () => {
    // The shape that leaks worst: the only `p` present names someone else.
    expect(participantsOnly([["p", BYSTANDER]], PEER)).toEqual([["p", PEER]]);
  });

  it("adds the recipient when nothing tagged anyone", () => {
    expect(participantsOnly([], PEER)).toEqual([["p", PEER]]);
  });

  it("leaves every other tag untouched and in order", () => {
    const tags = participantsOnly(
      [
        ["e", "abc"],
        ["p", BYSTANDER],
        ["subject", "a thread"],
        ["p", PEER],
        ["q", "def"],
        ["p", OTHER],
      ],
      PEER,
    );
    expect(tags).toEqual([
      ["e", "abc"],
      ["subject", "a thread"],
      ["p", PEER],
      ["q", "def"],
    ]);
  });

  it("does not duplicate the recipient", () => {
    expect(
      participantsOnly(
        [
          ["p", PEER],
          ["p", PEER],
        ],
        PEER,
      ),
    ).toEqual([
      ["p", PEER],
      ["p", PEER],
    ]);
  });
});
