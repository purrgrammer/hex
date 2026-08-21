import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FencedWriteError, HexStore, type StoredTranscript } from "../store.js";

/**
 * The invariants these pin down: between any duplicate check and its ledger
 * record there is a durable reservation every other process's check sees
 * inside its own transaction; and a transcript's seq/stream_index never move
 * backwards, with only the live generation allowed to move them forward.
 */

const record = (
  sessionId: string,
  seq: number,
  streamIndex: number,
): StoredTranscript => ({
  sessionId,
  nostrId: "f".repeat(64),
  seq,
  turn: seq,
  status: "active",
  streamIndex,
  startedAt: 1_700_000_000,
  inTokens: 0,
  outTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

describe("transactions", () => {
  let dir: string;
  let store: HexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hex-txn-"));
    store = HexStore.open(join(dir, "data.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rolls the whole write back when the function throws", () => {
    expect(() =>
      store.transaction(() => {
        store.markObeyed("c-rolled-back");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.wasObeyed("c-rolled-back")).toBe(false);

    // And the connection is usable afterwards — not wedged inside BEGIN.
    store.transaction(() => store.markObeyed("c-kept"));
    expect(store.wasObeyed("c-kept")).toBe(true);
  });

  it("refuses to nest, because nothing here needs savepoints", () => {
    expect(() =>
      store.transaction(() => store.transaction(() => undefined)),
    ).toThrow(/nested transaction/);
  });

  it("obeyOnce is first-caller-wins", () => {
    expect(store.obeyOnce("c-once")).toBe(true);
    expect(store.obeyOnce("c-once")).toBe(false);
    expect(store.wasObeyed("c-once")).toBe(true);
  });
});

describe("fenced transcript writes", () => {
  let dir: string;
  let store: HexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hex-fence-"));
    store = HexStore.open(join(dir, "data.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a write from a generation the lease has moved past", () => {
    const first = store.acquireWriterLease();
    store.saveTranscript(record("ses_A", 1, 1), {
      generation: first.generation,
    });

    // Another process seizes the home — a restart, or `stop --force`.
    const other = HexStore.open(join(dir, "data.db"));
    try {
      const second = other.acquireWriterLease({ takeover: true });
      expect(second.generation).toBe(first.generation + 1);
      // The displaced holder learns it on its next heartbeat…
      expect(first.heartbeat()).toBe(false);

      // …and its writes are refused, loudly, naming both generations.
      try {
        store.saveTranscript(record("ses_A", 2, 2), {
          generation: first.generation,
        });
        expect.unreachable("the stale generation should have been fenced");
      } catch (error) {
        expect(error).toBeInstanceOf(FencedWriteError);
        expect((error as Error).message).toContain(
          `generation ${first.generation}`,
        );
        expect((error as Error).message).toContain(
          `generation ${second.generation}`,
        );
      }

      // The new holder writes the same session onward without ceremony.
      other.saveTranscript(record("ses_A", 2, 2), {
        generation: second.generation,
      });
      expect(other.transcriptFor("ses_A")!.seq).toBe(2);
    } finally {
      other.close();
    }
  });

  it("refuses a write with no lease behind it at all", () => {
    expect(() =>
      store.saveTranscript(record("ses_B", 1, 1), { generation: 1 }),
    ).toThrow(FencedWriteError);
  });

  it("never moves seq or stream_index backwards", () => {
    const lease = store.acquireWriterLease();
    const fence = { generation: lease.generation };
    store.saveTranscript(record("ses_C", 2, 5), fence);

    // A stale transcript object saving what it read at construction.
    expect(() => store.saveTranscript(record("ses_C", 1, 5), fence)).toThrow(
      FencedWriteError,
    );
    expect(() => store.saveTranscript(record("ses_C", 2, 4), fence)).toThrow(
      FencedWriteError,
    );
    expect(store.transcriptFor("ses_C")!.seq).toBe(2);
    expect(store.transcriptFor("ses_C")!.streamIndex).toBe(5);

    // Equal is a status change on the same publish; forward is normal life.
    store.saveTranscript({ ...record("ses_C", 2, 5), status: "idle" }, fence);
    expect(store.transcriptFor("ses_C")!.status).toBe("idle");
    store.saveTranscript(record("ses_C", 3, 6), fence);
    expect(store.transcriptFor("ses_C")!.seq).toBe(3);
  });
});

describe("publish reservations", () => {
  let dir: string;
  let store: HexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hex-reserve-"));
    store = HexStore.open(join(dir, "data.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const KIND = 1621;
  const SCOPE = "30617:7fa56f5d:hex";
  const SUBJECT = "no way for one hex identity to delegate to another";

  it("a concurrent reserve on a second store sees the claim", () => {
    const lease = store.acquireWriterLease();
    store.transaction(() => {
      expect(store.liveReservation(KIND, SCOPE, SUBJECT)).toBeUndefined();
      store.reservePublish({
        kind: KIND,
        scope: SCOPE,
        subject: SUBJECT,
        generation: lease.generation,
      });
    });

    // The other execution, in another process, running its own check.
    const other = HexStore.open(join(dir, "data.db"));
    try {
      const seen = other.transaction(() =>
        other.liveReservation(KIND, SCOPE, SUBJECT),
      );
      expect(seen).toBeDefined();
      expect(seen!.generation).toBe(lease.generation);
    } finally {
      other.close();
    }

    // Confirming retires the claim and writes the ledger row as one.
    store.confirmPublish(
      {
        kind: KIND,
        scope: SCOPE,
        subject: SUBJECT,
        generation: lease.generation,
      },
      {
        id: "a".repeat(64),
        kind: KIND,
        scope: SCOPE,
        subject: SUBJECT,
        sha256: "0".repeat(64),
        at: Math.floor(Date.now() / 1000),
      },
    );
    expect(store.liveReservation(KIND, SCOPE, SUBJECT)).toBeUndefined();
    expect(store.publishedSince(KIND, SCOPE, 0)).toHaveLength(1);
  });

  it("a dead generation's reservation is skipped and reserved over", () => {
    const dead = store.acquireWriterLease({ ttlSecs: 0 });
    store.reservePublish({
      kind: KIND,
      scope: SCOPE,
      subject: SUBJECT,
      generation: dead.generation,
    });

    // The crashed holder's successor: new generation, same subject.
    const lease = store.acquireWriterLease();
    expect(store.liveReservation(KIND, SCOPE, SUBJECT)).toBeUndefined();
    store.transaction(() =>
      store.reservePublish({
        kind: KIND,
        scope: SCOPE,
        subject: SUBJECT,
        generation: lease.generation,
      }),
    );
    expect(store.liveReservation(KIND, SCOPE, SUBJECT)!.generation).toBe(
      lease.generation,
    );
  });

  it("a reservation older than the horizon is skipped even under the live generation", () => {
    const lease = store.acquireWriterLease();
    store.reservePublish({
      kind: KIND,
      scope: SCOPE,
      subject: SUBJECT,
      generation: lease.generation,
      at: Math.floor(Date.now() / 1000) - 11 * 60,
    });
    expect(store.liveReservation(KIND, SCOPE, SUBJECT)).toBeUndefined();
  });

  it("orphans are pruned at open, so a crash never blocks a subject", () => {
    const dead = store.acquireWriterLease({ ttlSecs: 0 });
    store.reservePublish({
      kind: KIND,
      scope: SCOPE,
      subject: SUBJECT,
      generation: dead.generation,
    });
    // A new generation exists, so the old row is recognisably dead.
    store.acquireWriterLease();
    store.close();

    store = HexStore.open(join(dir, "data.db"));
    const raw = new DatabaseSync(join(dir, "data.db"));
    try {
      const rows = raw
        .prepare(`SELECT COUNT(*) AS n FROM publish_reservations`)
        .get() as { n: number };
      expect(Number(rows.n)).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("releasing gives the subject back", () => {
    const lease = store.acquireWriterLease();
    store.reservePublish({
      kind: KIND,
      scope: SCOPE,
      subject: SUBJECT,
      generation: lease.generation,
    });
    store.releasePublish(KIND, SCOPE, SUBJECT, lease.generation);
    expect(store.liveReservation(KIND, SCOPE, SUBJECT)).toBeUndefined();
  });
});
