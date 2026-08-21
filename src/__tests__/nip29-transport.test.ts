import { describe, it, expect, afterEach } from "vitest";
import { firstValueFrom } from "rxjs";
import { take, toArray, filter as rxFilter } from "rxjs/operators";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";
import { createRelays, publishTo } from "../relays.js";
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

function transportFor(url: string) {
  return new Nip29Transport({
    relays: relays!,
    signer,
    pubkey,
    groups: [{ relay: url, id: GROUP }],
    since: 0,
    publishTimeoutMs: 1000,
  });
}

describe("Nip29Transport.start", () => {
  it("yields messages from the configured group", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [message("are you there?", GROUP, [["p", pubkey]])],
    });
    relays = createRelays();

    const [inbound] = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );

    expect(inbound!.text).toBe("are you there?");
    expect(inbound!.room).toEqual({
      transport: "nip-29",
      id: GROUP,
      relay: relay.url,
    });
    expect(inbound!.author).toBe(author);
    // The tag is the fact the transport owns; the decision is addressing.ts's.
    expect(inbound!.namesSelf).toBe(true);
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
    expect(inbound!.namesSelf).toBe(false);
  });

  it("reports a p-tag naming Hex", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [message("thoughts?", GROUP, [["p", pubkey]])],
    });
    relays = createRelays();
    const [inbound] = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );
    expect(inbound!.namesSelf).toBe(true);
  });

  it("drops a message for a group that is not configured", async () => {
    // A relay hosts many rooms; the subscription filter is not the only line of
    // defence, because a relay may over-serve.
    relay = await startMockRelay({
      kind: "normal",
      events: [
        message("hello", "some-other-room", [["p", pubkey]]),
        message("hello", GROUP, [["p", pubkey]]),
      ],
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
      namesSelf: true,
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
    // Threaded, so a client shows the answer under the question. The `q` tag is
    // the load-bearing one: grimoire reads `q` for a kind-9 reply and ignores
    // `e`, so without it the answer renders as a loose message.
    expect(reply.tags).toContainEqual([
      "q",
      inbound.id,
      relay.url,
      inbound.author,
    ]);
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

  it("reports the message a reply quotes, so addressing can use it", async () => {
    // Nobody repeats the bot's name in their second sentence. Without this, every
    // exchange dies after one turn.
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const bus = transportFor(relay.url);
    const own = await bus.reply(inboundFor(relay.url), "an answer");

    const followUp = finalizeEvent(
      {
        kind: KIND_GROUP_MESSAGE,
        content: "and what about kind 11?",
        created_at: 3000,
        // As grimoire would write it: a `q` tag, no mention, no p-tag.
        tags: [
          ["h", GROUP],
          ["q", own, relay!.url, pubkey],
        ],
      },
      authorKey,
    );

    // Into the relay first, then read it back: this mock serves on REQ.
    await publishTo(relays, [relay.url], followUp);
    const inbound = await firstValueFrom(
      bus.start().pipe(
        rxFilter((message) => message.id === followUp.id),
        take(1),
      ),
    );

    /*
     * The `q` off the wire, which is what only a transport can read. No mention
     * and no p-tag, so nothing here addresses Hex on its own — whether quoting
     * something Hex wrote does is `addressing.ts`'s call, and it needs no relay
     * to state. See addressing.test.ts.
     */
    expect(inbound.text).not.toContain("hex");
    expect(inbound.replyToId).toBe(own);
    expect(inbound.namesSelf).toBe(false);
  });

  it("does not treat a reply to somebody else as addressing it", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [message("replying to a human", GROUP, [["e", "someone-elses"]])],
    });
    relays = createRelays();
    const [inbound] = await firstValueFrom(
      transportFor(relay.url).start().pipe(take(1), toArray()),
    );
    expect(inbound!.namesSelf).toBe(false);
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
