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

/**
 * A real, minimal `git format-patch` output. Every corruption below is this
 * file with something taken out of it, which is exactly how the broken ones
 * arrived.
 */
const PATCH = [
  "From 9ca208fe5dcaf0e3d725e1d41f1548508a813c63 Mon Sep 17 00:00:00 2001",
  "From: Hex <hex@example.com>",
  "Date: Wed, 20 Aug 2026 17:00:00 +0000",
  "Subject: [PATCH] fix: say something true",
  "",
  "---",
  " src/thing.ts | 2 +-",
  " 1 file changed, 1 insertion(+), 1 deletion(-)",
  "",
  "diff --git a/src/thing.ts b/src/thing.ts",
  "index 1111111..2222222 100644",
  "--- a/src/thing.ts",
  "+++ b/src/thing.ts",
  "@@ -1,3 +1,3 @@",
  " const before = 1;",
  "-const wrong = true;",
  "+const right = true;",
  " const after = 2;",
  "-- ",
  "2.53.0",
  "",
].join("\n");

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
        const ok = await live.call(PUBLISH_TOOL, {
          kind: 1,
          content: `n${at}`,
        });
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

  it("refuses a patch that lost its beginning", async () => {
    /**
     * Seen on the wire: 4b15a232, 11636 bytes, ending in a proper git version
     * line and not starting with `From ` at all. The model was retyping the
     * patch out of a bash result and dropped the first chunk.
     */
    const headless = PATCH.split("\n").slice(4).join("\n");
    const result = await tools().call(PUBLISH_TOOL, {
      kind: 1617,
      content: headless,
      tags: [],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("begins with");
    expect(result.output).toContain("first chunk");
  });

  it("refuses a patch that stops in the middle of a hunk", async () => {
    // 62b167c6, 5263 bytes, ending after a context line with no closing hunk
    // and no signature. The tail was simply never typed.
    const cut = PATCH.slice(0, PATCH.indexOf("+const right"));
    const result = await tools().call(PUBLISH_TOOL, {
      kind: 1617,
      content: cut,
      tags: [],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("end is missing");
  });

  it("refuses a patch whose hunk is short, with both ends intact", async () => {
    /**
     * The one the two end checks cannot see, and the one that actually shipped:
     * 88b7d025 started right, ended right, and was missing a hunk out of the
     * middle. The header's promised line counts are the only witness.
     */
    const gutted = PATCH.replace(" const before = 1;\n", "");
    const result = await tools().call(PUBLISH_TOOL, {
      kind: 1617,
      content: gutted,
      tags: [],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("lost");
    expect(result.output).toContain("middle");
  });

  it("publishes a whole patch, and only checks the shape of a 1617", async () => {
    const relayed = tools({ publishRelays: ["wss://relay.example"] });
    const good = await relayed.call(PUBLISH_TOOL, {
      kind: 1617,
      content: PATCH,
      tags: [],
    });
    expect(good.ok).toBe(true);

    // A note is not a patch. Nothing about its content is this guard's business.
    const note = await relayed.call(PUBLISH_TOOL, {
      kind: 1,
      content: "not a patch, and does not need to be",
      tags: [],
    });
    expect(note.ok).toBe(true);
  });

  it("catches damage that still parses, when a digest comes with it", async () => {
    /**
     * The shape checks are a net with holes: a patch can lose something and
     * still satisfy every rule above. A digest taken where the content was
     * BUILT is the only thing that knows what was meant — one of the four
     * broken patches differed from its intact twin by twenty-seven bytes.
     */
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(PATCH, "utf8").digest("hex");
    const relayed = tools({ publishRelays: ["wss://relay.example"] });
    const honest = await relayed.call(PUBLISH_TOOL, {
      kind: 1617,
      content: PATCH,
      tags: [],
      sha256: digest,
    });
    expect(honest.ok).toBe(true);

    const damaged = await relayed.call(PUBLISH_TOOL, {
      kind: 1617,
      content: PATCH.replace("const right", "const rihgt"),
      tags: [],
      sha256: digest,
    });
    expect(damaged.ok).toBe(false);
    expect(damaged.output).toContain("damaged on the way here");
    expect(damaged.output).toContain("Nothing was published");
  });
});
