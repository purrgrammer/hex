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

import { describe, it, expect, afterEach } from "vitest";
import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";

import { createRelays } from "../relays.js";
import { nip10Parent, nip10Root } from "../transports/nip10.js";
import {
  Nip29Transport,
  KIND_GROUP_MESSAGE,
  replyTarget,
  threadRoot,
} from "../transports/nip29.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

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

describe("a NIP-29 reply with no mention in it", () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const signer = PrivateKeySigner.fromKey(key);
  const authorKey = generateSecretKey();
  const GROUP = "NkeVhXuWHGKKJCpn";

  let relay: MockRelay | undefined;
  let relays: ReturnType<typeof createRelays> | undefined;

  afterEach(async () => {
    relays?.close();
    relays = undefined;
    await relay?.close();
    relay = undefined;
  });

  const quoting = (parent: string, content: string) =>
    finalizeEvent(
      {
        kind: KIND_GROUP_MESSAGE,
        content,
        created_at: 2000,
        tags: [
          ["h", GROUP],
          ["q", parent, "wss://groups.0xchat.com/"],
        ],
      },
      authorKey,
    );

  async function inboundFor(threadIsOurs?: (id: string) => boolean) {
    relays = createRelays();
    const transport = new Nip29Transport({
      relays,
      signer,
      pubkey,
      groups: [{ relay: relay!.url, id: GROUP }],
      mentions: ["hex"],
      since: 0,
      publishTimeoutMs: 1000,
      ...(threadIsOurs ? { threadIsOurs } : {}),
    });
    const [inbound] = await firstValueFrom(
      transport.start().pipe(take(1), toArray()),
    );
    return inbound!;
  }

  it("addresses Hex when it hangs under a thread Hex is running", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [quoting(PARENT, "no mention this time — carry on")],
    });
    // The store's answer: this id belongs to a run. The parent is the only
    // handle a kind 9 offers, and it is enough.
    const inbound = await inboundFor((id) => id === PARENT);
    expect(inbound.addressesSelf).toBe(true);
  });

  it("is still room chatter when the thread belongs to nobody", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [quoting(OTHER, "two people talking about something else")],
    });
    const inbound = await inboundFor(() => false);
    // Answering this would be Hex joining a conversation it was not in.
    expect(inbound.addressesSelf).toBe(false);
  });
});
