import { describe, it, expect, afterEach } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";
import { createRelays } from "../relays.js";
import { announceIdentity } from "../identity.js";
import { parseConfig } from "../config.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const signer = PrivateKeySigner.fromKey(key);

/**
 * The relay URL is part of what kind 10002 and 10050 SAY, so both runs of an
 * idempotency test have to talk to the same relay — moving Hex to a new relay is
 * a genuine change to its identity, not a false positive.
 */
function configFor(url: string, about = "grimoire assistant") {
  return parseConfig({
    identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
    brain: { type: "echo" },
    relays: { read: [url], publish: [url], dm: [url] },
    profile: { publish: true, name: "Hex", about },
    transports: [{ type: "nip-29", groups: [{ relay: url, id: "dev" }] }],
  });
}

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;

afterEach(async () => {
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

describe("announceIdentity", () => {
  it("publishes all three kinds when the relay holds nothing", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const results = await announceIdentity(
      relays,
      signer,
      pubkey,
      configFor(relay.url),
      { now: () => 1000 },
    );

    expect(results.map((result) => result.action)).toEqual([
      "published",
      "published",
      "published",
    ]);
    expect(relay.received.map((event) => event.kind)).toEqual([
      0, 10002, 10050,
    ]);
    // Signed as Hex, and as nothing else.
    expect(new Set(relay.received.map((event) => event.pubkey))).toEqual(
      new Set([pubkey]),
    );
  });

  it("publishes nothing on a second run", async () => {
    // The claim the README makes: a restart does not churn every replaceable.
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const config = configFor(relay.url);

    await announceIdentity(relays, signer, pubkey, config, { now: () => 1000 });
    const afterFirst = relay.received.length;

    // A later clock, so a naive "is mine newer" check could not pass this.
    const results = await announceIdentity(relays, signer, pubkey, config, {
      now: () => 2000,
    });

    expect(results.map((result) => result.action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(relay.received.length).toBe(afterFirst);
  });

  it("republishes only the kind whose config changed", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();

    await announceIdentity(relays, signer, pubkey, configFor(relay.url), {
      now: () => 1000,
    });

    const results = await announceIdentity(
      relays,
      signer,
      pubkey,
      configFor(relay.url, "now with an opinion"),
      { now: () => 2000 },
    );

    expect(results.map((result) => [result.kind, result.action])).toEqual([
      [0, "published"],
      [10002, "unchanged"],
      [10050, "unchanged"],
    ]);
    expect(relay.received.map((event) => event.kind)).toEqual([
      0, 10002, 10050, 0,
    ]);
  });

  it("backfills a publish relay that does not hold it, and only that one", async () => {
    // The blocker this replaced: evidence came from `read ∪ publish` while the
    // write went to `publish`, so a stale copy on a relay Hex no longer writes to
    // reported `unchanged` and the real outbox stayed empty forever.
    const stale = await startMockRelay({ kind: "normal" });
    relay = stale;
    relays = createRelays();

    // First run announces to `stale` alone.
    const first = parseConfig({
      identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
      brain: { type: "echo" },
      relays: { read: [stale.url], publish: [stale.url], dm: [stale.url] },
      profile: { publish: true, name: "Hex" },
      transports: [{ type: "nip-29", groups: [{ relay: stale.url, id: "d" }] }],
    });
    await announceIdentity(relays, signer, pubkey, first, { now: () => 1000 });
    const staleCount = stale.received.length;

    // Now the outbox moves: `fresh` is the only publish relay, `stale` stays in
    // `read` and still answers with everything it holds.
    const fresh = await startMockRelay({ kind: "normal" });
    const moved = parseConfig({
      identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
      brain: { type: "echo" },
      relays: { read: [stale.url], publish: [fresh.url], dm: [fresh.url] },
      profile: { publish: true, name: "Hex" },
      transports: [{ type: "nip-29", groups: [{ relay: fresh.url, id: "d" }] }],
    });

    try {
      const results = await announceIdentity(relays, signer, pubkey, moved, {
        now: () => 2000,
      });

      // All three land on the new relay; the kind 0 is byte-identical to the one
      // `stale` is serving, and that must not be taken as evidence.
      expect(results.map((result) => result.action)).toEqual([
        "published",
        "published",
        "published",
      ]);
      expect(fresh.received.map((event) => event.kind)).toEqual([
        0, 10002, 10050,
      ]);
      expect(stale.received.length).toBe(staleCount);
    } finally {
      await fresh.close();
    }
  });

  it("sends nothing at all on a dry run", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const results = await announceIdentity(
      relays,
      signer,
      pubkey,
      configFor(relay.url),
      { dryRun: true, now: () => 1000 },
    );
    expect(results.every((result) => result.action === "published")).toBe(true);
    expect(relay.received).toEqual([]);
  });

  it("reports a kind as failed when the relay never answers", async () => {
    // A relay that took the EVENT and said nothing did not store it, and must
    // not be able to hold startup open either.
    relay = await startMockRelay({ kind: "silent" });
    relays = createRelays();
    const results = await announceIdentity(
      relays,
      signer,
      pubkey,
      configFor(relay.url),
      { now: () => 1000, publishTimeoutMs: 300, lookupTimeoutMs: 300 },
    );
    expect(results.every((result) => result.action === "failed")).toBe(true);
  });
});
