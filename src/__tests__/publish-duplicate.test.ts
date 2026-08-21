/**
 * Publishing the same proposal twice, which is what actually happened.
 *
 * The runtime re-executes a turn — the run that filed seven issues for four
 * ideas emitted five `turn.started` and eight `turn.completed` — and each
 * execution composes the issue afresh. So the second attempt arrives with a new
 * tool-call id, new bytes and a rephrased subject, and every dedup that keys on
 * identity of the CALL is blind to it. These tests are the three shapes that
 * really landed on the relays.
 */

import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { createRelays } from "../relays.js";
import {
  PublishTools,
  normaliseSubject,
  signerFromSecret,
  type PublishLedger,
} from "../tools/publish.js";
import { PUBLISH_TOOL } from "../tools/types.js";
import { HexStore } from "../store.js";
import { startMockRelay } from "./mock-relay.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);

const REPO = "30617:7fa56f5d:hex";

/** The store's two methods, in memory. */
function ledger(): PublishLedger & { rows: number } {
  const rows: {
    id: string;
    kind: number;
    scope: string;
    subject: string;
    sha256: string;
    at: number;
  }[] = [];
  return {
    get rows() {
      return rows.length;
    },
    publishedSince: (kind, scope, since) =>
      rows.filter(
        (row) => row.kind === kind && row.scope === scope && row.at >= since,
      ),
    rememberPublished: (entry) => rows.push(entry),
  };
}

// Unix SECONDS, matching the ledger rows below and every clock in this package.
function tools(book: PublishLedger, now = () => 1_700_000_000) {
  return new PublishTools({
    signer: signerFromSecret(secret),
    pubkey,
    relays: createRelays(),
    publishRelays: [],
    ledger: book,
    // Nothing leaves the process, but the whole path up to the relay runs —
    // including the record, which a dry run deliberately skips, so these tests
    // seed the ledger through it rather than around it.
    dryRun: false,
    now,
  });
}

/**
 * A publish that never reaches a relay is not recorded, so seeding goes
 * straight to the ledger — the same rows `record` would have written.
 */
function seed(
  book: PublishLedger,
  subject: string,
  options: { id?: string; kind?: number; scope?: string; at?: number } = {},
) {
  book.rememberPublished({
    id: options.id ?? "a".repeat(64),
    kind: options.kind ?? 1621,
    scope: options.scope ?? REPO,
    subject: normaliseSubject(subject),
    sha256: "0".repeat(64),
    at: options.at ?? 1_700_000_000,
  });
}

const issue = (subject: string, content = "body") => ({
  kind: 1621,
  content,
  tags: [
    ["a", REPO],
    ["subject", subject],
  ],
});

describe("publishing the same proposal twice", () => {
  it("refuses an identical subject and names the event already published", async () => {
    const book = ledger();
    seed(book, "No way for one hex identity to delegate to another", {
      id: "b".repeat(64),
    });

    const result = await tools(book).call(
      PUBLISH_TOOL,
      issue("No way for one hex identity to delegate to another"),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("b".repeat(64));
    expect(result.output).toContain("the same subject");
    // Being told only "duplicate" is what makes a model rephrase and retry.
    expect(result.output).toMatch(/do not compose it again/);
  });

  /**
   * The pair that no content hash and no similarity threshold would have
   * caught: three shared significant words out of fourteen, but the same
   * opening.
   */
  it("refuses a rephrased subject that begins the same way", async () => {
    const book = ledger();
    seed(
      book,
      "Memory lives in Eve, not in the key — swapping eve.host loses everything",
    );

    const result = await tools(book).call(
      PUBLISH_TOOL,
      issue(
        "Memory lives in whichever Eve is running, not in the agent's own home",
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("begins the same way");
  });

  it("refuses the same bytes even under a different subject", async () => {
    const book = ledger();
    const body = "the same argument, twice";
    const first = await tools(book).call(PUBLISH_TOOL, {
      ...issue("One subject", body),
      relays: [],
    });
    // No relay took it, so nothing was recorded — record it as a relay would.
    expect(first.ok).toBe(false);
    book.rememberPublished({
      id: "c".repeat(64),
      kind: 1621,
      scope: REPO,
      subject: normaliseSubject("One subject"),
      sha256: require("node:crypto")
        .createHash("sha256")
        .update(body, "utf8")
        .digest("hex"),
      at: 1_700_000_000,
    });

    const again = await tools(book).call(
      PUBLISH_TOOL,
      issue("A completely different subject", body),
    );
    expect(again.ok).toBe(false);
    expect(again.output).toContain("byte for byte");
  });
});

describe("what the duplicate check must not refuse", () => {
  it("allows the same subject on a different repository", async () => {
    const book = ledger();
    seed(book, "Subjects are not identity", {
      scope: "30617:7fa56f5d:grimoire",
    });

    const result = await tools(book).call(
      PUBLISH_TOOL,
      issue("Subjects are not identity"),
    );
    // No relay to publish to, which is as far as it gets — but it got past the
    // duplicate check, which is what this asserts.
    expect(result.output).toBe("no relay to publish to");
  });

  it("allows a genuinely different proposal on the same repository", async () => {
    const book = ledger();
    seed(book, "Memory lives in whichever Eve is running");

    const result = await tools(book).call(
      PUBLISH_TOOL,
      issue("No opt-in path for hex to speak unprompted"),
    );
    expect(result.output).toBe("no relay to publish to");
  });

  it("allows a note, which people repeat on purpose", async () => {
    const book = ledger();
    seed(book, "gm", { kind: 1, scope: "" });

    const result = await tools(book).call(PUBLISH_TOOL, {
      kind: 1,
      content: "gm",
      tags: [],
    });
    expect(result.output).toBe("no relay to publish to");
  });

  it("forgets a proposal older than the window", async () => {
    const book = ledger();
    seed(book, "An old proposal", { at: 1_700_000_000 - 7 * 60 * 60 });

    const result = await tools(book).call(
      PUBLISH_TOOL,
      issue("An old proposal"),
    );
    expect(result.output).toBe("no relay to publish to");
  });

  it("does not spend the hourly budget on a refusal", async () => {
    const book = ledger();
    seed(book, "Filed once");
    const publishing = new PublishTools({
      signer: signerFromSecret(secret),
      pubkey,
      relays: createRelays(),
      publishRelays: [],
      ledger: book,
      perHour: 1,
      // Unix seconds, like every clock in this package.
      now: () => 1_700_000_000,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await publishing.call(PUBLISH_TOOL, issue("Filed once"));
      expect(result.output).toContain("already published");
      expect(result.output).not.toContain("this hour");
    }
  });
});

/**
 * The whole point, end to end: a relay that took the first proposal never sees
 * the second, and a restart does not forget that.
 */
describe("against a relay, and across a restart", () => {
  it("publishes the first and never sends the twin", async () => {
    const relay = await startMockRelay({ kind: "normal" });
    const home = mkdtempSync(join(tmpdir(), "hex-ledger-"));
    // Real time here, not the frozen clock the other tests use: `HexStore.open`
    // prunes the ledger against `Date.now()`, so a row stamped in 2023 is
    // pruned by the restart this test is about.
    try {
      const open = () =>
        new PublishTools({
          signer: signerFromSecret(secret),
          pubkey,
          relays: createRelays(),
          publishRelays: [relay.url],
          ledger: HexStore.open(join(home, "data.db")),
        });

      const first = await open().call(
        PUBLISH_TOOL,
        issue(
          "Memory lives in Eve, not in the key — swapping eve.host loses everything",
        ),
      );
      expect(first.ok).toBe(true);
      expect(relay.received).toHaveLength(1);

      // A second PublishTools over a second HexStore: the process restarted,
      // which under re-execution is exactly when the twin gets composed.
      const twin = await open().call(
        PUBLISH_TOOL,
        issue(
          "Memory lives in whichever Eve is running, not in the agent's own home",
        ),
      );
      expect(twin.ok).toBe(false);
      expect(twin.output).toContain(JSON.parse(first.output).id);
      expect(relay.received).toHaveLength(1);
    } finally {
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * The false positive that would have bitten hardest.
 *
 * Every conventional-commit patch to a repository opens on the same two
 * significant words — "patch fix" — so the opening rule would refuse the second
 * unrelated fix of the day. Patches lean on the two exact rules instead.
 */
describe("patch subjects are not prose", () => {
  const patch = (subject: string, line: string) =>
    ({
      kind: 1617,
      content: [
        "From 9ca208fe5dcaf0e3d725e1d41f1548508a813c63 Mon Sep 17 00:00:00 2001",
        "From: Hex <hex@example.com>",
        "Date: Wed, 20 Aug 2026 17:00:00 +0000",
        `Subject: ${subject}`,
        "",
        "---",
        " src/thing.ts | 2 +-",
        "",
        "diff --git a/src/thing.ts b/src/thing.ts",
        "index 1111111..2222222 100644",
        "--- a/src/thing.ts",
        "+++ b/src/thing.ts",
        "@@ -1,3 +1,3 @@",
        " const before = 1;",
        "-const wrong = true;",
        `+const ${line} = true;`,
        " const after = 2;",
        "-- ",
        "2.53.0",
        "",
      ].join("\n"),
      tags: [["a", REPO]],
    }) as Record<string, unknown>;

  it("allows two different fixes whose subjects begin the same way", async () => {
    const book = ledger();
    book.rememberPublished({
      id: "d".repeat(64),
      kind: 1617,
      scope: REPO,
      subject: normaliseSubject("[PATCH] fix: the first thing"),
      sha256: "1".repeat(64),
      at: Math.floor(Date.now() / 1000),
    });

    const result = await new PublishTools({
      signer: signerFromSecret(secret),
      pubkey,
      relays: createRelays(),
      publishRelays: [],
      ledger: book,
    }).call(
      PUBLISH_TOOL,
      patch("[PATCH] fix: a completely other thing", "other"),
    );

    expect(result.output).toBe("no relay to publish to");
  });

  it("still refuses the same patch subject", async () => {
    const book = ledger();
    book.rememberPublished({
      id: "e".repeat(64),
      kind: 1617,
      scope: REPO,
      subject: normaliseSubject("[PATCH] fix: the first thing"),
      sha256: "1".repeat(64),
      at: Math.floor(Date.now() / 1000),
    });

    const result = await new PublishTools({
      signer: signerFromSecret(secret),
      pubkey,
      relays: createRelays(),
      publishRelays: [],
      ledger: book,
    }).call(PUBLISH_TOOL, patch("[PATCH] fix: the first thing", "first"));

    expect(result.ok).toBe(false);
    expect(result.output).toContain("the same subject");
  });
});

/**
 * The two executions of a re-executed turn OVERLAP.
 *
 * Proved in the stream that started all this: turn_2's second `turn.started`
 * arrived at index 103 while the first execution's `web_search` at 101 was
 * still in flight, and its first `turn.completed` landed at 141 before the
 * second execution's search at 145. So two publishes of the same proposal can
 * be in the air at once — and a check that reads the ledger, then spends ten
 * seconds talking to relays, then writes it, lets both through.
 */
describe("two executions publishing at the same time", () => {
  it("publishes one of them and refuses the other", async () => {
    const relay = await startMockRelay({ kind: "normal" });
    const home = mkdtempSync(join(tmpdir(), "hex-race-"));
    try {
      const publishing = new PublishTools({
        signer: signerFromSecret(secret),
        pubkey,
        relays: createRelays(),
        publishRelays: [relay.url],
        ledger: HexStore.open(join(home, "data.db")),
      });

      const both = await Promise.all([
        publishing.call(PUBLISH_TOOL, issue("Filed by two executions at once")),
        publishing.call(PUBLISH_TOOL, issue("Filed by two executions at once")),
      ]);

      expect(both.filter((result) => result.ok)).toHaveLength(1);
      expect(both.find((result) => !result.ok)?.output).toContain(
        "already published",
      );
      expect(relay.received).toHaveLength(1);
    } finally {
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * The durable half: the check and the claim in one transaction, so the window
 * as wide as the relay round-trip is closed against OTHER processes too — the
 * in-memory queue above only serialises executions that share a process.
 */
describe("reservations across processes", () => {
  it("refuses a subject another process is publishing right now", async () => {
    const relay = await startMockRelay({ kind: "normal" });
    const home = mkdtempSync(join(tmpdir(), "hex-reserve-race-"));
    try {
      // Process one: mid-publish, holding the reservation, not yet confirmed.
      const first = HexStore.open(join(home, "data.db"));
      const lease = first.acquireWriterLease();
      const subject = "Filed while the other execution is still in flight";
      first.transaction(() =>
        first.reservePublish({
          kind: 1621,
          scope: REPO,
          subject: normaliseSubject(subject),
          generation: lease.generation,
        }),
      );

      // Process two: its check runs in its own transaction and sees the claim.
      const second = new PublishTools({
        signer: signerFromSecret(secret),
        pubkey,
        relays: createRelays(),
        publishRelays: [relay.url],
        ledger: HexStore.open(join(home, "data.db")),
      });
      const refused = await second.call(PUBLISH_TOOL, issue(subject));

      expect(refused.ok).toBe(false);
      expect(refused.output).toContain("right now");
      expect(relay.received).toHaveLength(0);
      // The claim itself was not clobbered.
      expect(
        first.liveReservation(1621, REPO, normaliseSubject(subject)),
      ).toBeDefined();
    } finally {
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("releases the reservation when the publish never lands", async () => {
    const home = mkdtempSync(join(tmpdir(), "hex-reserve-release-"));
    try {
      const store = HexStore.open(join(home, "data.db"));
      const lease = store.acquireWriterLease();
      const publishing = new PublishTools({
        signer: signerFromSecret(secret),
        pubkey,
        relays: createRelays(),
        publishRelays: [],
        ledger: store,
        generation: lease.generation,
      });

      const subject = "A proposal no relay ever took";
      const failed = await publishing.call(PUBLISH_TOOL, issue(subject));
      expect(failed.output).toBe("no relay to publish to");

      // The subject was given back, not held for ten minutes: the same
      // attempt again reaches the same refusal instead of "in flight".
      expect(
        store.liveReservation(1621, REPO, normaliseSubject(subject)),
      ).toBeUndefined();
      const again = await publishing.call(PUBLISH_TOOL, issue(subject));
      expect(again.output).toBe("no relay to publish to");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a landed publish leaves a ledger row and no reservation", async () => {
    const relay = await startMockRelay({ kind: "normal" });
    const home = mkdtempSync(join(tmpdir(), "hex-reserve-confirm-"));
    try {
      const store = HexStore.open(join(home, "data.db"));
      const lease = store.acquireWriterLease();
      const publishing = new PublishTools({
        signer: signerFromSecret(secret),
        pubkey,
        relays: createRelays(),
        publishRelays: [relay.url],
        ledger: store,
        generation: lease.generation,
      });

      const subject = "Filed exactly once, durably";
      const landed = await publishing.call(PUBLISH_TOOL, issue(subject));
      expect(landed.ok).toBe(true);

      expect(
        store.liveReservation(1621, REPO, normaliseSubject(subject)),
      ).toBeUndefined();
      expect(store.publishedSince(1621, REPO, 0)).toHaveLength(1);

      const twin = await publishing.call(PUBLISH_TOOL, issue(subject));
      expect(twin.ok).toBe(false);
      expect(twin.output).toContain("already published");
      expect(relay.received).toHaveLength(1);
    } finally {
      await relay.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
