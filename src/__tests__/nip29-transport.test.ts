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
import { Nip29Transport, KIND_GROUP_MESSAGE } from "../transports/nip29.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";
import type { Inbound } from "../transports/types.js";

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const signer = PrivateKeySigner.fromKey(key);
const authorKey = generateSecretKey();
const author = getPublicKey(authorKey);

const GROUP = "NkeVhXuWHGKKJCpn";

function message(content: string, group = GROUP, tags: string[][] = []) {
  return finalizeEvent(
    {
      kind: KIND_GROUP_MESSAGE,
      content,
      created_at: 2000,
      tags: [["h", group], ...tags],
    },
    authorKey,
  );
}

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;

afterEach(async () => {
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

function transportFor(url: string, mentions = ["hex"]) {
  return new Nip29Transport({
    relays: relays!,
    signer,
    pubkey,
    groups: [{ relay: url, id: GROUP }],
    mentions,
    since: 0,
    publishTimeoutMs: 1000,
  });
}

describe("Nip29Transport.start", () => {
  it("yields messages from the configured group", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [message("hex are you there?")],
    });
    relays = createRelays();

    const [inbound] = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );

    expect(inbound!.text).toBe("hex are you there?");
    expect(inbound!.room).toEqual({
      transport: "nip-29",
      id: GROUP,
      relay: relay.url,
    });
    expect(inbound!.author).toBe(author);
    // The transport decides this — it is the layer that knows the tag shape.
    expect(inbound!.addressesSelf).toBe(true);
  });

  it("marks a message that names nobody as not addressing Hex", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [message("morning everyone")],
    });
    relays = createRelays();
    const [inbound] = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );
    expect(inbound!.addressesSelf).toBe(false);
  });

  it("addresses Hex on a p-tag with no name in the text", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [message("thoughts?", GROUP, [["p", pubkey]])],
    });
    relays = createRelays();
    const [inbound] = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );
    expect(inbound!.addressesSelf).toBe(true);
  });

  it("drops a message for a group that is not configured", async () => {
    // A relay hosts many rooms; the subscription filter is not the only line of
    // defence, because a relay may over-serve.
    relay = await startMockRelay({
      kind: "normal",
      events: [message("hex hello", "some-other-room"), message("hex hello")],
    });
    relays = createRelays();
    const messages = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.room.id).toBe(GROUP);
  });

  it("does not confuse two casings of one group id", async () => {
    // `#h` is case-sensitive: `Bitcoin` and `bitcoin` on one relay are two rooms.
    relay = await startMockRelay({
      kind: "normal",
      events: [
        message("hex hi", GROUP.toLowerCase()),
        message("hex hi", GROUP),
      ],
    });
    relays = createRelays();
    const messages = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );
    expect(messages[0]!.room.id).toBe(GROUP);
  });
});

describe("Nip29Transport.history", () => {
  it("returns the room's messages oldest first", async () => {
    const older = finalizeEvent(
      {
        kind: KIND_GROUP_MESSAGE,
        content: "first",
        created_at: 1000,
        tags: [["h", GROUP]],
      },
      authorKey,
    );
    relay = await startMockRelay({
      kind: "normal",
      events: [message("second"), older],
    });
    relays = createRelays();

    const history = await transportFor(relay.url).history(
      { transport: "nip-29", id: GROUP, relay: relay.url },
      10,
    );
    expect(history.map((entry) => entry.text)).toEqual(["first", "second"]);
  });
});

describe("Nip29Transport.reply", () => {
  function inboundFor(url: string): Inbound {
    const event = message("hex what is kind 9?");
    return {
      id: event.id,
      author,
      text: event.content,
      createdAt: event.created_at,
      room: { transport: "nip-29", id: GROUP, relay: url },
      addressesSelf: true,
      event,
    };
  }

  it("publishes a kind 9 h-tagged to the group, threaded under the mention", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const inbound = inboundFor(relay.url);

    const id = await transportFor(relay.url).reply(inbound, "it is a message");

    expect(relay.received).toHaveLength(1);
    const reply = relay.received[0]!;
    expect(reply.id).toBe(id);
    expect(reply.kind).toBe(KIND_GROUP_MESSAGE);
    expect(reply.pubkey).toBe(pubkey);
    // The factory writes the relay hint into the `h` tag alongside the id, so
    // match on the id rather than the whole tag.
    expect(reply.tags.some((tag) => tag[0] === "h" && tag[1] === GROUP)).toBe(
      true,
    );
    // Threaded, so a client shows the answer under the question.
    expect(
      reply.tags.some((tag) => tag[0] === "e" && tag[1] === inbound.id),
    ).toBe(true);
  });

  it("throws when the group relay does not accept it", async () => {
    // Reporting success for a message no member will ever see is worse than
    // failing: the room looks answered and is not.
    relay = await startMockRelay({ kind: "silent" });
    relays = createRelays();
    await expect(
      transportFor(relay.url).reply(inboundFor(relay.url), "hello"),
    ).rejects.toThrow(/did not accept the reply/);
  });

  it("reacts with an h-tagged kind 7 pointing at the message", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const inbound = inboundFor(relay.url);

    await transportFor(relay.url).react(inbound, "👀");

    const reaction = relay.received[0]!;
    expect(reaction.kind).toBe(7);
    expect(reaction.content).toBe("👀");
    // Without the `h` tag the relay does not count it as part of the group.
    expect(reaction.tags).toContainEqual(["h", GROUP]);
    expect(
      reaction.tags.some((tag) => tag[0] === "e" && tag[1] === inbound.id),
    ).toBe(true);
  });
});
