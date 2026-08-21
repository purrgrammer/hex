import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";

import { channelGroupKey } from "../concord/derive.js";
import {
  KIND_MESSAGE,
  KIND_SEAL_ENCRYPTED,
  KIND_SEAL_PLAINTEXT,
} from "../concord/kinds.js";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  resolveMs,
  sealRumor,
  StreamError,
  wrapSeal,
} from "../concord/stream.js";

const SECRET = new Uint8Array(32).fill(9);
const CHANNEL = new Uint8Array(32).fill(4);
const EPOCH = 3n;

const authorKey = generateSecretKey();
const author = getPublicKey(authorKey);
const authorSigner = PrivateKeySigner.fromKey(authorKey);

function stream() {
  return channelGroupKey(SECRET, CHANNEL, EPOCH);
}

async function send(
  content: string,
  options: { tags?: string[][]; ms?: number } = {},
) {
  const group = stream();
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content,
    tags: [
      ...channelBindingTags("04".repeat(32), EPOCH),
      ...(options.tags ?? []),
    ],
    pubkey: author,
    ms: options.ms ?? 1_700_000_000_123,
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, authorSigner);
  return { group, rumor, wrap: wrapSeal(seal, group) };
}

describe("the stream envelope (CORD-01)", () => {
  it("round-trips a message and proves its author", async () => {
    const { group, rumor, wrap } = await send("hello, hex");
    // The wrap is addressed to nobody: a random ephemeral `p`, an author that
    // is the channel rather than a person.
    expect(wrap.pubkey).toBe(group.pk);
    expect(wrap.tags.find((tag) => tag[0] === "p")?.[1]).not.toBe(author);

    const opened = openWrap(wrap, group);
    expect(opened.rumorId).toBe(rumor.id);
    // The seal is the only authorship proof there is — the wrap's signature is
    // made with a key every member holds.
    expect(opened.author).toBe(author);
    expect(opened.content).toBe("hello, hex");
    expect(opened.ms).toBe(1_700_000_000_123);
  });

  it("refuses a wrap from another channel's address", async () => {
    const { wrap } = await send("hello");
    const other = channelGroupKey(SECRET, new Uint8Array(32).fill(5), EPOCH);
    expect(() => openWrap(wrap, other)).toThrow(StreamError);
  });

  it("refuses a rumor spliced into a channel it does not commit to", async () => {
    const { group, wrap } = await send("hello");
    const opened = openWrap(wrap, group);
    // The binding is what stops a keyholder replaying one author's words into a
    // room they never wrote in.
    expect(() => checkChannelBinding(opened, "05".repeat(32), EPOCH)).toThrow(
      StreamError,
    );
    expect(() => checkChannelBinding(opened, "04".repeat(32), 4n)).toThrow(
      StreamError,
    );
  });

  it("refuses a duplicated binding tag", async () => {
    const { group, wrap } = await send("hello", {
      tags: [["channel", "05".repeat(32)]],
    });
    const opened = openWrap(wrap, group);
    // Two channel tags is an ambiguous binding, which is not a binding.
    expect(() => checkChannelBinding(opened, "04".repeat(32), EPOCH)).toThrow(
      StreamError,
    );
  });

  it("refuses a rumor whose id is not its own hash", async () => {
    const group = stream();
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "hello",
      tags: channelBindingTags("04".repeat(32), EPOCH),
      pubkey: author,
      ms: 1_700_000_000_000,
    });
    const forged = { ...rumor, id: "f".repeat(64) };
    const seal = await authorSigner.signEvent({
      kind: KIND_SEAL_PLAINTEXT,
      content: JSON.stringify(forged),
      tags: [],
      created_at: rumor.created_at,
    });
    // An id is the ordering tiebreak; a claimed one is never trusted.
    expect(() => openWrap(wrapSeal(seal, group), group)).toThrow(
      /rumor id is not its event hash/,
    );
  });

  it("refuses a rumor sealed by somebody other than its author", async () => {
    const group = stream();
    const rumor = buildRumor({
      kind: KIND_MESSAGE,
      content: "not mine",
      tags: channelBindingTags("04".repeat(32), EPOCH),
      pubkey: getPublicKey(generateSecretKey()),
      ms: 1_700_000_000_000,
    });
    const seal = await sealRumor(
      rumor,
      KIND_SEAL_ENCRYPTED,
      group,
      authorSigner,
    );
    // Otherwise a keyholder could re-seal a member's rumor under their name.
    expect(() => openWrap(wrapSeal(seal, group), group)).toThrow(
      /does not match the seal's signer/,
    );
  });

  it("reads sub-second ordering strictly", () => {
    expect(resolveMs(10, [])).toBe(10_000);
    expect(resolveMs(10, [["ms", "999"]])).toBe(10_999);
    // Out of range is malformed rather than clamped: clamping would let the
    // excess smuggle arbitrary "future" past a clock check.
    expect(() => resolveMs(10, [["ms", "1000"]])).toThrow(StreamError);
    // `Number()` would take every one of these, and a peer that refuses them
    // would order the same channel differently.
    for (const bad of ["1e2", "0x1f", " 5 ", "+5", "007", ""])
      expect(() => resolveMs(10, [["ms", bad]])).toThrow(StreamError);
  });
});
