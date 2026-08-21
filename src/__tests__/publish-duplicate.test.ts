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

function tools(book: PublishLedger, now = () => 1_700_000_000_000) {
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
      now: () => 1_700_000_000_000,
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
        issue("Memory lives in Eve, not in the key — swapping eve.host loses everything"),
      );
      expect(first.ok).toBe(true);
      expect(relay.received).toHaveLength(1);

      // A second PublishTools over a second HexStore: the process restarted,
      // which under re-execution is exactly when the twin gets composed.
      const twin = await open().call(
        PUBLISH_TOOL,
        issue("Memory lives in whichever Eve is running, not in the agent's own home"),
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
