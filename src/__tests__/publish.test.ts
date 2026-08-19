import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  GUARDED_KINDS,
  PublishTools,
  signerFromSecret,
} from "../tools/publish.js";
import { PUBLISH_TOOL, SIGN_TOOL } from "../tools/types.js";
import { createRelays } from "../relays.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);

function tools(overrides: Partial<Parameters<typeof make>[0]> = {}) {
  return make(overrides);
}

function make(options: {
  publishRelays?: string[];
  allowKinds?: number[];
  perHour?: number;
  dryRun?: boolean;
  relays?: ReturnType<typeof createRelays>;
  now?: () => number;
}) {
  return new PublishTools({
    signer: signerFromSecret(secret),
    pubkey,
    relays: options.relays ?? createRelays(),
    publishRelays: options.publishRelays ?? [],
    allowKinds: options.allowKinds,
    perHour: options.perHour,
    dryRun: options.dryRun ?? true,
    now: options.now,
  });
}

describe("PublishTools", () => {
  it("signs an ordinary note with the agent's key", async () => {
    const result = await tools().call(SIGN_TOOL, {
      kind: 1,
      content: "hello",
      tags: [["t", "nostr"]],
    });
    const { signed } = JSON.parse(result.output) as {
      signed: { pubkey: string; kind: number; sig: string; content: string };
    };

    expect(result.ok).toBe(true);
    expect(signed.pubkey).toBe(pubkey);
    expect(signed.kind).toBe(1);
    expect(signed.sig).toHaveLength(128);
  });

  it("refuses a guarded kind, and names how to allow it", async () => {
    /**
     * These break the agent in ways it cannot undo or even notice: a new 10050
     * silently redirects every private message sent to it afterwards, and
     * nothing in the transcript would say so.
     */
    for (const kind of GUARDED_KINDS) {
      const result = await tools().call(PUBLISH_TOOL, {
        kind,
        content: "",
      });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("tools.publish.kinds");
    }
  });

  it("signs a guarded kind once the operator allowed it", async () => {
    const result = await tools({ allowKinds: [0] }).call(SIGN_TOOL, {
      kind: 0,
      content: "{}",
    });
    expect(result.ok).toBe(true);
  });

  it("bounds signing exactly as it bounds publishing", async () => {
    // A signed event is one relay call away from being published by whoever
    // holds it, so a tool that signs what it will not publish has a loophole.
    const result = await tools().call(SIGN_TOOL, { kind: 5, content: "" });
    expect(result.ok).toBe(false);
  });

  it("stops at the hourly limit rather than spending a reputation", async () => {
    let clock = 1_000_000;
    const host = make({ perHour: 2, now: () => clock, dryRun: true });
    // A dry run does not count, so publish for real against a mock relay.
    let relay: MockRelay | undefined;
    try {
      relay = await startMockRelay({ kind: "normal", events: [] });
      const live = make({
        perHour: 2,
        now: () => clock,
        dryRun: false,
        publishRelays: [relay.url],
      });
      for (let at = 0; at < 2; at += 1) {
        const ok = await live.call(PUBLISH_TOOL, { kind: 1, content: `n${at}` });
        expect(ok.ok).toBe(true);
      }
      const refused = await live.call(PUBLISH_TOOL, { kind: 1, content: "n3" });
      expect(refused.ok).toBe(false);
      expect(refused.output).toContain("limit");

      // An hour later it may speak again.
      clock += 61 * 60 * 1000;
      const after = await live.call(PUBLISH_TOOL, { kind: 1, content: "n4" });
      expect(after.ok).toBe(true);
    } finally {
      await relay?.close();
    }
    expect(host).toBeDefined();
  });

  it("refuses a malformed tag rather than signing something else", async () => {
    const result = await tools().call(SIGN_TOOL, {
      kind: 1,
      content: "x",
      tags: [["e", 42]],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("tag");
  });
});
