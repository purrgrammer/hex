import { describe, it, expect, afterEach } from "vitest";
import { firstValueFrom } from "rxjs";
import { filter as rxFilter, take, toArray } from "rxjs/operators";
import {
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";

import { createRelays, publishTo } from "../relays.js";
import { ConcordTransport } from "../transports/concord.js";
import {
  bytesToHex,
  channelGroupKey,
  communityIdOf,
} from "../concord/derive.js";
import {
  KIND_COMMENT,
  KIND_MESSAGE,
  KIND_SEAL_ENCRYPTED,
} from "../concord/kinds.js";
import {
  buildRumor,
  channelBindingTags,
  openWrap,
  sealRumor,
  wrapSeal,
} from "../concord/stream.js";
import {
  adoptRoot,
  membershipFromBundle,
  type Membership,
} from "../concord/membership.js";
import type { InviteBundle } from "../concord/invite.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const hexKey = generateSecretKey();
const hexPubkey = getPublicKey(hexKey);
const signer = PrivateKeySigner.fromKey(hexKey);

const memberKey = generateSecretKey();
const member = getPublicKey(memberKey);
const memberSigner = PrivateKeySigner.fromKey(memberKey);

const OWNER = new Uint8Array(32).fill(0x11);
const SALT = new Uint8Array(32).fill(0x22);
const COMMUNITY = bytesToHex(communityIdOf(OWNER, SALT));
const ROOT = new Uint8Array(32).fill(0x33);
const PUBLIC_CHANNEL = "0a".repeat(32);
const PRIVATE_CHANNEL = "0b".repeat(32);
const PRIVATE_KEY_HEX = "0c".repeat(32);

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;
let transport: ConcordTransport | undefined;

afterEach(async () => {
  transport?.stop();
  transport = undefined;
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

function bundle(url: string): InviteBundle {
  return {
    community_id: COMMUNITY,
    owner: bytesToHex(OWNER),
    owner_salt: bytesToHex(SALT),
    community_root: bytesToHex(ROOT),
    root_epoch: 2,
    channels: [
      {
        id: PRIVATE_CHANNEL,
        key: PRIVATE_KEY_HEX,
        epoch: 5,
        name: "backroom",
      },
    ],
    relays: [url],
    name: "Mages Guild",
  };
}

function membership(url: string): Membership {
  return membershipFromBundle(bundle(url), [
    { id: PUBLIC_CHANNEL, name: "grimoire" },
  ]);
}

function transportFor(url: string, held = membership(url)) {
  return new ConcordTransport({
    signer,
    pubkey: hexPubkey,
    memberships: [held],
    since: 0,
    publishTimeoutMs: 1000,
    relays: relays!,
  });
}

/** A message from a member, on the public channel's stream at the root epoch. */
async function memberMessage(
  content: string,
  tags: string[][] = [],
  channelIdHex = PUBLIC_CHANNEL,
  secret = ROOT,
  epoch = 2n,
) {
  const group = channelGroupKey(
    secret,
    Uint8Array.from(Buffer.from(channelIdHex, "hex")),
    epoch,
  );
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content,
    tags: [...channelBindingTags(channelIdHex, epoch), ...tags],
    pubkey: member,
    ms: Date.now(),
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, group, memberSigner);
  return { group, rumor, wrap: wrapSeal(seal, group) };
}

describe("ConcordTransport.start", () => {
  it("hears a p-tagged message in a public channel and names the room", async () => {
    const { wrap } = await memberMessage("are you there?", [["p", hexPubkey]]);
    relay = await startMockRelay({ kind: "normal", events: [wrap] });
    relays = createRelays();
    transport = transportFor(relay.url);

    const [inbound] = await firstValueFrom(
      transport.start().pipe(take(1), toArray()),
    );
    expect(inbound?.text).toBe("are you there?");
    expect(inbound?.author).toBe(member);
    // The tag is the fact; `addressing.ts` turns facts into the decision.
    expect(inbound?.namesSelf).toBe(true);
    // A channel id means nothing without its community: both travel in the id.
    expect(inbound?.room.id).toBe(`${COMMUNITY}:${PUBLIC_CHANNEL}`);
    expect(inbound?.room.label).toContain("grimoire");
  });

  it("hears a p-tagged message with no name in it", async () => {
    const { wrap } = await memberMessage("what do you make of this?", [
      ["p", hexPubkey],
    ]);
    relay = await startMockRelay({ kind: "normal", events: [wrap] });
    relays = createRelays();
    transport = transportFor(relay.url);

    const [inbound] = await firstValueFrom(
      transport.start().pipe(take(1), toArray()),
    );
    // The `p` tag rides the ENCRYPTED rumor, so it addresses Hex without
    // telling the relay that anybody addressed anybody.
    // The tag is the fact; `addressing.ts` turns facts into the decision.
    expect(inbound?.namesSelf).toBe(true);
  });

  it("reads a private channel with the key the invite granted", async () => {
    const { wrap } = await memberMessage(
      "hex, in private",
      [],
      PRIVATE_CHANNEL,
      Uint8Array.from(Buffer.from(PRIVATE_KEY_HEX, "hex")),
      5n,
    );
    relay = await startMockRelay({ kind: "normal", events: [wrap] });
    relays = createRelays();
    transport = transportFor(relay.url);

    const [inbound] = await firstValueFrom(
      transport.start().pipe(take(1), toArray()),
    );
    expect(inbound?.room.id).toBe(`${COMMUNITY}:${PRIVATE_CHANNEL}`);
    expect(inbound?.text).toBe("hex, in private");
  });

  it("authenticates as the stream, not as Hex, to read a gated relay", async () => {
    const { group, wrap } = await memberMessage("hex, over an auth wall");
    relay = await startMockRelay({ kind: "auth-to-read", events: [wrap] });
    relays = createRelays();
    transport = transportFor(relay.url);

    const [inbound] = await firstValueFrom(
      transport.start().pipe(take(1), toArray()),
    );
    expect(inbound?.text).toBe("hex, over an auth wall");
    // The whole reason this transport holds its own pool: the relay is told a
    // channel address is on the socket, and never that Hex is.
    expect(relay.authenticated).toContain(group.pk);
    expect(relay.authenticated).not.toContain(hexPubkey);
  });

  it("ignores a message it cannot bind to the channel it arrived on", async () => {
    // Sealed and wrapped correctly for the public channel's stream, but
    // committing to a DIFFERENT channel: a splice, and it is dropped.
    const group = channelGroupKey(
      ROOT,
      Uint8Array.from(Buffer.from(PUBLIC_CHANNEL, "hex")),
      2n,
    );
    const spliced = buildRumor({
      kind: KIND_MESSAGE,
      content: "hex, spliced",
      tags: channelBindingTags(PRIVATE_CHANNEL, 2n),
      pubkey: member,
      ms: Date.now(),
    });
    const seal = await sealRumor(
      spliced,
      KIND_SEAL_ENCRYPTED,
      group,
      memberSigner,
    );
    const { wrap } = await memberMessage("hex, the real one");

    relay = await startMockRelay({
      kind: "normal",
      events: [wrapSeal(seal, group), wrap],
    });
    relays = createRelays();
    transport = transportFor(relay.url);

    const [inbound] = await firstValueFrom(
      transport.start().pipe(take(1), toArray()),
    );
    expect(inbound?.text).toBe("hex, the real one");
  });
});

describe("ConcordTransport.reply", () => {
  it("threads as a NIP-22 comment the whole room can read", async () => {
    const { group, wrap } = await memberMessage(
      "hex, what kind is a group message?",
    );
    relay = await startMockRelay({ kind: "normal", events: [wrap] });
    relays = createRelays();
    transport = transportFor(relay.url);

    const [inbound] = await firstValueFrom(
      transport.start().pipe(take(1), toArray()),
    );

    const id = await transport.reply(inbound!, "Kind 9.");
    const published = relay.received.find(
      (event) => event.pubkey === group.pk && event.id !== wrap.id,
    );
    expect(published).toBeDefined();

    const opened = openWrap(published!, group);
    expect(opened.rumorId).toBe(id);
    // A reply is a comment, never a kind 9 with a `q` — getting this backwards
    // renders wrong in every other Concord client.
    expect(opened.kind).toBe(KIND_COMMENT);
    expect(opened.tags).toContainEqual(["e", inbound!.id, "", member]);
    expect(opened.tags).toContainEqual(["E", inbound!.id, "", member]);
    expect(opened.tags).toContainEqual(["p", member]);
    // And it still commits to the channel it was said in.
    expect(opened.tags).toContainEqual(["channel", PUBLIC_CHANNEL]);
    expect(opened.tags).toContainEqual(["epoch", "2"]);
  });

  it("reports the thread a reply hangs under, and that nothing names Hex", async () => {
    /**
     * The live miss. A thread whose ROOT is the operator's own mention: the
     * follow-up threads onto that root, so its parent is their message and not
     * anything Hex wrote. "Did Hex write the parent" says no, and every message
     * after the first would need the mention typed again.
     */
    const opening = await memberMessage("research NIP 5D", [["p", hexPubkey]]);
    relay = await startMockRelay({ kind: "normal", events: [opening.wrap] });
    relays = createRelays();
    transport = transportFor(relay.url);

    const stream = transport.start();
    const [inbound] = await firstValueFrom(stream.pipe(take(1), toArray()));
    // The tag is the fact; `addressing.ts` turns facts into the decision.
    expect(inbound?.namesSelf).toBe(true);

    const root = inbound!.id;
    const followUp = buildRumor({
      kind: KIND_COMMENT,
      content: "oh yea i meant that one 5A",
      tags: [
        ...channelBindingTags(PUBLIC_CHANNEL, 2n),
        // Threaded onto the ROOT, which is theirs — exactly what was observed.
        ["E", root, "", member],
        ["P", member],
        ["e", root, "", member],
        ["p", member],
      ],
      pubkey: member,
      ms: Date.now(),
    });
    const seal = await sealRumor(
      followUp,
      KIND_SEAL_ENCRYPTED,
      opening.group,
      memberSigner,
    );
    await publishTo(relays, [relay.url], wrapSeal(seal, opening.group), 1000);

    transport.stop();
    transport = new ConcordTransport({
      signer,
      pubkey: hexPubkey,
      memberships: [membership(relay.url)],
      since: 0,
      publishTimeoutMs: 1000,
      relays: relays!,
      durability: {
        cursorFor: () => undefined,
        rememberCursor: () => {},
        sawRumor: () => false,
        rememberRumor: () => {},
        isOwnRumor: () => false,
        saveMembership: () => {},
      },
    });
    const [next] = await firstValueFrom(
      transport.start().pipe(
        rxFilter((m) => m.text === "oh yea i meant that one 5A"),
        take(1),
        toArray(),
      ),
    );
    /*
     * The FACTS, which is all a transport owes anybody now.
     *
     * Whether this addresses Hex is decided from these plus what the store
     * remembers, in `addressing.ts` — and that is the whole reason the decision
     * moved: it can be stated there without a relay, a key and a wrap.
     */
    expect(next?.threadRoot).toBe(root);
    expect(next?.replyToId).toBe(root);
    // Nothing here names Hex. The thread is what will.
    expect(next?.namesSelf).toBe(false);
  });

  it("reports the message a reply quotes, wrap and restart included", async () => {
    const opening = await memberMessage("hex, hello");
    relay = await startMockRelay({ kind: "normal", events: [opening.wrap] });
    relays = createRelays();
    transport = transportFor(relay.url);

    const stream = transport.start();
    const [inbound] = await firstValueFrom(stream.pipe(take(1), toArray()));

    const answerId = await transport.reply(inbound!, "Hello.");

    // Nobody says "hex" again in their second sentence.
    const followUp = buildRumor({
      kind: KIND_COMMENT,
      content: "and what about relays?",
      tags: [
        ...channelBindingTags(PUBLIC_CHANNEL, 2n),
        ["e", answerId, "", hexPubkey],
      ],
      pubkey: member,
      ms: Date.now(),
    });
    const seal = await sealRumor(
      followUp,
      KIND_SEAL_ENCRYPTED,
      opening.group,
      memberSigner,
    );
    // A fresh transport, because the mock relay serves a REQ and never pushes:
    // this is the restart case too, which is where an in-memory "did Hex say
    // that?" would have forgotten.
    const followUpWrap = wrapSeal(seal, opening.group);
    await publishTo(relays, [relay.url], followUpWrap, 1000);

    transport.stop();
    const durable = new Map<string, boolean>([[answerId, true]]);
    transport = new ConcordTransport({
      signer,
      pubkey: hexPubkey,
      memberships: [membership(relay.url)],
      since: 0,
      publishTimeoutMs: 1000,
      relays: relays!,
      durability: {
        cursorFor: () => undefined,
        rememberCursor: () => {},
        sawRumor: () => false,
        rememberRumor: () => {},
        isOwnRumor: (id) => durable.get(id) === true,
        saveMembership: () => {},
      },
    });
    const [next] = await firstValueFrom(
      transport.start().pipe(
        rxFilter((message) => message.text === "and what about relays?"),
        take(1),
        toArray(),
      ),
    );
    /*
     * The parent, off a wrap, after a restart — which is the part only a
     * transport can be asked for. Whether quoting something Hex wrote counts as
     * addressing it is `addressing.ts`'s call now; see addressing.test.ts.
     */
    expect(next?.replyToId).toBe(answerId);
    expect(next?.namesSelf).toBe(false);
  });
});

describe("the transcript carriage", () => {
  function transcriptRumor(tags: string[][] = []) {
    const rumor = {
      kind: 1777,
      content: "a turn",
      tags,
      pubkey: hexPubkey,
      created_at: 1_700_000_000,
    };
    return { ...rumor, id: getEventHash(rumor) };
  }

  it("binds a transcript rumor to the channel, once, before it is hashed", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    transport = transportFor(relay.url);

    const room = `${COMMUNITY}:${PUBLIC_CHANNEL}`;
    // A session head already carries a `channel` tag of its own, in the
    // agent-session NIP's notation. Two vocabularies, one tag name: the binding
    // replaces it, because a rumor with two `channel` tags is bound to nothing.
    const original = transcriptRumor([["channel", room]]);
    const bound = transport.bindTranscript(original, room);

    expect(bound.tags).toContainEqual(["channel", PUBLIC_CHANNEL]);
    expect(bound.tags).toContainEqual(["epoch", "2"]);
    expect(bound.tags.filter((tag) => tag[0] === "channel")).toHaveLength(1);
    // Re-hashed, or the id would be a lie about the tags it names.
    expect(bound.id).not.toBe(original.id);
    expect(bound.id).toBe(getEventHash(bound as never));

    // Idempotent: two `channel` tags is an ambiguous binding, which every
    // reader — this transport included — is right to refuse.
    expect(transport.bindTranscript(bound, room)).toBe(bound);
  });

  it("publishes on the epoch the rumor committed to, not the newest one", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const held = membership(relay.url);
    transport = transportFor(relay.url, held);

    const room = `${COMMUNITY}:${PUBLIC_CHANNEL}`;
    const bound = transport.bindTranscript(transcriptRumor(), room);
    const epoch2 = channelGroupKey(
      ROOT,
      Uint8Array.from(Buffer.from(PUBLIC_CHANNEL, "hex")),
      2n,
    );

    // A rotation lands between binding and publishing. Adoption is additive, so
    // the epoch the id names is still held — and moving the event to the new
    // address would publish it under an id that claims the old one.
    adoptRoot(held, { epoch: 3n, key: new Uint8Array(32).fill(0x44) });

    const { delivered } = await transport.carryTranscript(bound, room);
    expect(delivered.length).toBeGreaterThan(0);
    const published = relay.received.find(
      (event) => event.pubkey === epoch2.pk,
    );
    expect(published).toBeDefined();
    expect(openWrap(published!, epoch2).rumorId).toBe(bound.id);
  });

  it("refuses to carry a rumor bound to another channel", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    transport = transportFor(relay.url);

    // The splice, from the writing side: a keyholder publishing one room's
    // words under another room's key.
    const foreign = transcriptRumor([
      ["channel", PRIVATE_CHANNEL],
      ["epoch", "5"],
    ]);
    await expect(
      transport.carryTranscript(foreign, `${COMMUNITY}:${PUBLIC_CHANNEL}`),
    ).rejects.toThrow(/not bound to/);
  });
});

describe("ConcordTransport.describeRoom", () => {
  it("says which community, which channel, and that nothing here is public", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    transport = transportFor(relay.url);

    const described = await transport.describeRoom({
      transport: "concord",
      id: `${COMMUNITY}:${PRIVATE_CHANNEL}`,
    });
    expect(described).toMatchObject({
      community: "Mages Guild",
      channel: "backroom",
      private: true,
      encrypted: true,
    });
  });
});
