import { describe, it, expect, afterEach } from "vitest";
import { firstValueFrom } from "rxjs";
import { take } from "rxjs/operators";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";
import {
  GiftWrapFactory,
  WrappedMessageFactory,
} from "applesauce-common/factories";
import { unlockGiftWrap } from "applesauce-common/helpers";
import { createRelays } from "../relays.js";
import {
  Nip17Transport,
  KIND_DM_RELAYS,
  KIND_GIFT_WRAP,
  KIND_PRIVATE_MESSAGE,
  KIND_REACTION,
} from "../transports/nip17.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";
import type { Inbound } from "../transports/types.js";

const hexKey = generateSecretKey();
const hexPubkey = getPublicKey(hexKey);
const hexSigner = PrivateKeySigner.fromKey(hexKey);

const peerKey = generateSecretKey();
const peerPubkey = getPublicKey(peerKey);
const peerSigner = PrivateKeySigner.fromKey(peerKey);

const strangerKey = generateSecretKey();
const strangerPubkey = getPublicKey(strangerKey);
const strangerSigner = PrivateKeySigner.fromKey(strangerKey);

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;
let transport: Nip17Transport | undefined;

afterEach(async () => {
  transport?.stop();
  transport = undefined;
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

/** A wrap addressed to Hex, as a peer's client would build it. */
async function dmToHex(from: PrivateKeySigner, text: string) {
  const rumor = await WrappedMessageFactory.create(hexPubkey, text).stamp(from);
  return GiftWrapFactory.create(from, hexPubkey, rumor);
}

function build(url: string, allow: string[] = [peerPubkey]) {
  transport = new Nip17Transport({
    relays: relays!,
    signer: hexSigner,
    pubkey: hexPubkey,
    inboxRelays: [url],
    readRelays: [url],
    allow,
    since: 0,
    publishTimeoutMs: 1000,
  });
  return transport;
}

describe("Nip17Transport.start", () => {
  it("opens a wrap from someone on the allow list", async () => {
    const wrap = await dmToHex(peerSigner, "hex, are you there?");
    relay = await startMockRelay({ kind: "normal", events: [wrap] });
    relays = createRelays();

    const inbound = await firstValueFrom(
      build(relay.url).start().pipe(take(1)),
    );

    expect(inbound.text).toBe("hex, are you there?");
    expect(inbound.author).toBe(peerPubkey);
    // A DM needs no mention: it was sent to Hex and nobody else.
    expect(inbound.addressesSelf).toBe(true);
    expect(inbound.room).toEqual({
      transport: "nip-17",
      id: peerPubkey,
      label: `dm:${peerPubkey.slice(0, 8)}`,
    });
  });

  it("ignores a wrap from someone who is not allowed", async () => {
    // The allow list is the only gate a DM has.
    const allowed = await dmToHex(peerSigner, "from the allow list");
    const stranger = await dmToHex(strangerSigner, "from a stranger");
    relay = await startMockRelay({
      kind: "normal",
      events: [stranger, allowed],
    });
    relays = createRelays();

    const inbound = await firstValueFrom(
      build(relay.url).start().pipe(take(1)),
    );
    expect(inbound.author).toBe(peerPubkey);
  });

  it("says who it refused, so an unanswered DM is explicable", async () => {
    const stranger = await dmToHex(strangerSigner, "hello?");
    relay = await startMockRelay({ kind: "normal", events: [stranger] });
    relays = createRelays();
    const lines: string[] = [];
    const bus = new Nip17Transport({
      relays: relays,
      signer: hexSigner,
      pubkey: hexPubkey,
      inboxRelays: [relay.url],
      readRelays: [relay.url],
      allow: [peerPubkey],
      since: 0,
      log: (line) => lines.push(line),
    });
    transport = bus;

    bus.start().subscribe();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(
      lines.some(
        (line) =>
          line.includes("not on the allow list") &&
          line.includes(strangerPubkey.slice(0, 8)),
      ),
    ).toBe(true);
  });
});

describe("Nip17Transport.reply", () => {
  function inboundFrom(id = "rumor-1"): Inbound {
    return {
      id,
      author: peerPubkey,
      text: "hex?",
      createdAt: 1000,
      room: { transport: "nip-17", id: peerPubkey },
      addressesSelf: true,
      event: {
        id,
        pubkey: peerPubkey,
        created_at: 1000,
        kind: KIND_PRIVATE_MESSAGE,
        content: "hex?",
        tags: [],
        sig: "",
      },
    };
  }

  it("sends two wraps — the peer's and its own — and nothing in the clear", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const bus = new Nip17Transport({
      relays,
      signer: hexSigner,
      pubkey: hexPubkey,
      inboxRelays: [relay.url],
      readRelays: [relay.url],
      allow: [peerPubkey],
      since: 0,
      publishTimeoutMs: 1000,
    });
    transport = bus;

    // Seed a real 10050 pointing at this relay.
    const list = finalizeEvent(
      {
        kind: KIND_DM_RELAYS,
        content: "",
        created_at: 2000,
        tags: [["relay", relay.url]],
      },
      peerKey,
    );
    const { publishTo } = await import("../relays.js");
    await publishTo(relays, [relay.url], list);
    // Not cleared: this mock serves what it has been given, and the 10050 is
    // what tells Hex where the peer reads.
    const before = relay.received.length;

    await bus.reply(inboundFrom(), "an answer");

    const published = relay.received.slice(before);
    const wraps = published.filter((event) => event.kind === KIND_GIFT_WRAP);
    // One for the peer, one for Hex.
    expect(wraps).toHaveLength(2);
    // Nothing readable was published: no kind 14 in the clear.
    expect(published.some((event) => event.kind === KIND_PRIVATE_MESSAGE)).toBe(
      false,
    );
    // Each wrap is signed by a throwaway key, never by Hex.
    expect(wraps.every((wrap) => wrap.pubkey !== hexPubkey)).toBe(true);

    // The peer's copy opens with their key, and says what Hex said.
    const theirs = wraps.find((wrap) =>
      wrap.tags.some((tag) => tag[0] === "p" && tag[1] === peerPubkey),
    );
    const rumor = await unlockGiftWrap(theirs!, peerSigner);
    expect(rumor.kind).toBe(KIND_PRIVATE_MESSAGE);
    expect(rumor.content).toBe("an answer");
    expect(rumor.pubkey).toBe(hexPubkey);
  });

  it("refuses to send when the peer publishes no inbox", async () => {
    // Delivering to a relay they do not read is a message that was never sent.
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    await expect(
      build(relay.url).reply(inboundFrom(), "hello"),
    ).rejects.toThrow(/no kind 10050/);
  });

  it("authenticates as the wrap when the inbox relay demands NIP-42", async () => {
    // The failure this fixes: your inbox lists a relay that requires AUTH, Hex
    // refused to authenticate at all, and the reply never arrived. Answering with
    // the wrap's own throwaway key satisfies the relay without telling it who
    // sent the message — that pubkey is already on the event.
    relay = await startMockRelay({ kind: "auth-to-write" });
    relays = createRelays();
    const bus = build(relay.url);

    const list = finalizeEvent(
      {
        kind: KIND_DM_RELAYS,
        content: "",
        created_at: 2000,
        tags: [["relay", relay.url]],
      },
      peerKey,
    );
    // The relay refuses unauthenticated writes, so seeding the list means
    // authenticating too — as somebody else, which is the point: the test's own
    // AUTH must not be what lets Hex's wrap through.
    const seeder = await startMockRelay({ kind: "normal", events: [list] });
    const seedRelays = createRelays();
    const readOnly = new Nip17Transport({
      relays: seedRelays,
      signer: hexSigner,
      pubkey: hexPubkey,
      inboxRelays: [relay.url],
      readRelays: [seeder.url],
      allow: [peerPubkey],
      since: 0,
      publishTimeoutMs: 2000,
    });

    try {
      await readOnly.reply(inboundFrom("rumor-auth"), "an answer");

      // It got in, and only after authenticating.
      expect(
        relay.received.some((event) => event.kind === KIND_GIFT_WRAP),
      ).toBe(true);
      expect(relay.authenticated.length).toBeGreaterThan(0);
      // As the wrap, never as Hex.
      expect(relay.authenticated).not.toContain(hexPubkey);
      const wrap = relay.received.find(
        (event) => event.kind === KIND_GIFT_WRAP,
      )!;
      expect(relay.authenticated).toContain(wrap.pubkey);
    } finally {
      readOnly.stop();
      seedRelays.close();
      await seeder.close();
      bus.stop();
    }
  });

  it("acks with a gift-wrapped reaction, not a public one", async () => {
    // A plain kind 7 would announce to anyone watching that Hex is talking to
    // this person about an event nobody else can see.
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const bus = build(relay.url);

    const list = finalizeEvent(
      {
        kind: KIND_DM_RELAYS,
        content: "",
        created_at: 2000,
        tags: [["relay", relay.url]],
      },
      peerKey,
    );
    const { publishTo } = await import("../relays.js");
    await publishTo(relays, [relay.url], list);
    const before = relay.received.length;

    await bus.react(inboundFrom("rumor-9"), "👀");

    const published = relay.received.slice(before);
    const wraps = published.filter((event) => event.kind === KIND_GIFT_WRAP);
    expect(wraps).toHaveLength(2);
    // No kind 7 in the open.
    expect(published.some((event) => event.kind === KIND_REACTION)).toBe(false);

    const theirs = wraps.find((wrap) =>
      wrap.tags.some((tag) => tag[0] === "p" && tag[1] === peerPubkey),
    );
    const rumor = await unlockGiftWrap(theirs!, peerSigner);
    expect(rumor.kind).toBe(KIND_REACTION);
    expect(rumor.content).toBe("👀");
    // Pointing at the rumor it acknowledges.
    expect(rumor.tags).toContainEqual(["e", "rumor-9"]);
  });
});
