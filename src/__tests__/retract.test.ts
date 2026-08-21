/**
 * What `nostr.rm` must never do: retract something this agent did not sign.
 *
 * The whole reason kind 5 stays guarded for `nostr.publish` is that a deletion
 * request aimed at the wrong id asks the network to destroy someone else's
 * work. `retract` earns its exemption by checking, so the check is what these
 * tests are about.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";

import { createRelays } from "../relays.js";
import { retract } from "../retract.js";
import { PublishTools, signerFromSecret } from "../tools/publish.js";
import { RM_TOOL } from "../tools/types.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const stranger = generateSecretKey();

const note = (key: Uint8Array, content: string): NostrEvent =>
  finalizeEvent(
    { kind: 1621, content, tags: [], created_at: 1_700_000_000 },
    key,
  );

const relaysOpen: MockRelay[] = [];
afterEach(async () => {
  await Promise.all(relaysOpen.splice(0).map((relay) => relay.close()));
});

async function relayServing(events: NostrEvent[]): Promise<MockRelay> {
  const relay = await startMockRelay({ kind: "normal", events });
  relaysOpen.push(relay);
  return relay;
}

describe("retract", () => {
  it("retracts the agent's own events and names the kinds", async () => {
    const mine = note(secret, "mine");
    const relay = await relayServing([mine]);

    const result = await retract([mine.id], {
      relays: createRelays(),
      signer: signerFromSecret(secret),
      pubkey,
      readRelays: [relay.url],
      publishRelays: [relay.url],
      reason: "duplicate",
    });

    expect(result.targets).toEqual([{ id: mine.id, kind: 1621 }]);
    expect(result.request?.kind).toBe(5);
    expect(result.request?.content).toBe("duplicate");
    expect(result.request?.tags).toContainEqual(["e", mine.id]);
    expect(result.request?.tags).toContainEqual(["k", "1621"]);
    expect(result.outcomes.some((outcome) => outcome.ok)).toBe(true);
  });

  it("refuses an event signed by somebody else, and publishes nothing", async () => {
    const theirs = note(stranger, "not mine");
    const relay = await relayServing([theirs]);

    const result = await retract([theirs.id], {
      relays: createRelays(),
      signer: signerFromSecret(secret),
      pubkey,
      readRelays: [relay.url],
      publishRelays: [relay.url],
    });

    expect(result.request).toBeUndefined();
    expect(result.outcomes).toEqual([]);
    expect(result.targets[0]?.refused).toMatch(/not by this agent/);
    expect(relay.received).toEqual([]);
  });

  /**
   * Not-found is refused rather than attempted: authorship could not be
   * established, and that is the one thing this must never guess at.
   */
  it("refuses an id it cannot find, and one that is not an id at all", async () => {
    const relay = await relayServing([]);

    const result = await retract(["nope", "a".repeat(64)], {
      relays: createRelays(),
      signer: signerFromSecret(secret),
      pubkey,
      readRelays: [relay.url],
      publishRelays: [relay.url],
    });

    expect(result.request).toBeUndefined();
    expect(result.targets.map((target) => target.refused)).toEqual([
      expect.stringMatching(/64-character hex/),
      expect.stringMatching(/not found/),
    ]);
  });

  it("retracts the ones it may and refuses the rest in the same call", async () => {
    const mine = note(secret, "mine");
    const theirs = note(stranger, "theirs");
    const relay = await relayServing([mine, theirs]);

    const result = await retract([mine.id, theirs.id], {
      relays: createRelays(),
      signer: signerFromSecret(secret),
      pubkey,
      readRelays: [relay.url],
      publishRelays: [relay.url],
    });

    expect(result.request?.tags.filter((tag) => tag[0] === "e")).toEqual([
      ["e", mine.id],
    ]);
  });
});

describe("nostr.rm", () => {
  /**
   * Kind 5 stays in `GUARDED_KINDS`, so the tool must not route through the
   * guard that would refuse it — and must still refuse what it does not own.
   */
  it("is offered and works without kind 5 being allowed", async () => {
    const mine = note(secret, "mine");
    const relay = await relayServing([mine]);
    const tools = new PublishTools({
      signer: signerFromSecret(secret),
      pubkey,
      relays: createRelays(),
      publishRelays: [relay.url],
      readRelays: [relay.url],
    });

    expect(tools.list().map((spec) => spec.name)).toContain(RM_TOOL);
    expect(tools.handles(RM_TOOL)).toBe(true);

    const result = await tools.call(RM_TOOL, { ids: [mine.id] });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output).retracted).toEqual([mine.id]);
  });

  it("fails the call when nothing could be retracted", async () => {
    const theirs = note(stranger, "theirs");
    const relay = await relayServing([theirs]);
    const tools = new PublishTools({
      signer: signerFromSecret(secret),
      pubkey,
      relays: createRelays(),
      publishRelays: [relay.url],
      readRelays: [relay.url],
    });

    const result = await tools.call(RM_TOOL, { ids: [theirs.id] });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.output).refused).toHaveLength(1);
  });

  it("needs at least one id", async () => {
    const tools = new PublishTools({
      signer: signerFromSecret(secret),
      pubkey,
      relays: createRelays(),
      publishRelays: [],
    });
    expect((await tools.call(RM_TOOL, { ids: [] })).ok).toBe(false);
  });
});
