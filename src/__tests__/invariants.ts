/**
 * Everything the store must never say, checked in one place.
 *
 * Called at the end of every store property, so a new invariant applies to
 * every history already being generated instead of only to the property whose
 * author thought of it. The invariant → owner map lives in
 * `invariant-coverage.test.ts`, which is what keeps this file honest: deleting
 * a check here trips a gate that names the invariant that went uncovered.
 *
 * Read straight off the file with a second connection rather than through the
 * API under test. The point of a property is to catch the API lying about what
 * it stored, and a checker that asks the same code the same question would
 * agree with it.
 */

import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";

/** What the model believes, for the checks a single snapshot cannot decide. */
export interface StoreExpectation {
  /** Highest `seq` any reader has been handed, per session. */
  transcriptSeq?: Map<string, number>;
  /** Highest `stream_index` saved, per session. */
  streamIndex?: Map<string, number>;
  /** Generations the model has seen handed out, in order. */
  generations?: number[];
}

function rows<T>(db: DatabaseSync, sql: string): T[] {
  return db.prepare(sql).all() as unknown as T[];
}

/**
 * @param path the store file. Opened read-only: a checker must not be able to
 *   change what it is checking, and a property that mutated through it would
 *   pass by moving the goalposts.
 */
export function checkStoreInvariants(
  path: string,
  expected: StoreExpectation = {},
): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // invariant: I3 — an event enqueues at most once per (transport, id). The
    // unique index enforces it; this catches a migration that drops it, which
    // is the only way it has ever been at risk.
    const duplicates = rows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM (
         SELECT transport, event_id FROM inbound_events
          GROUP BY transport, event_id HAVING COUNT(*) > 1)`,
    );
    expect(duplicates[0]?.n ?? 0).toBe(0);

    // A settled row is settled for good: an outcome and a time, together or
    // not at all. Half-settled is how a row gets answered twice.
    const halfSettled = rows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM inbound_events
        WHERE (done_at IS NULL) != (outcome IS NULL)`,
    );
    expect(halfSettled[0]?.n ?? 0).toBe(0);

    // invariant: I5 — a composed reply is delivered exactly once. A row that
    // was sent has the id the relay gave it, and one that was not has neither.
    const badlySent = rows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM outbound
        WHERE (sent_at IS NULL) != (sent_id IS NULL)`,
    );
    expect(badlySent[0]?.n ?? 0).toBe(0);

    // Nothing is delivered without having been attempted. A sent row with no
    // attempt means the spool marked it from somewhere other than a send.
    const unattempted = rows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM outbound WHERE sent_at IS NOT NULL AND attempts < 1`,
    );
    expect(unattempted[0]?.n ?? 0).toBe(0);

    // invariant: I2 — at most one live generation. The table is a single row by
    // CHECK constraint; this catches a schema that stopped saying so.
    const leases = rows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM writer_lease`,
    );
    expect(leases[0]?.n ?? 0).toBeLessThanOrEqual(1);

    // invariant: I6 — one reservation per (kind, scope, subject). Two would be
    // two publishes of one thing, which is what the reservation exists to stop.
    const doubleBooked = rows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM (
         SELECT kind, scope, subject FROM publish_reservations
          GROUP BY kind, scope, subject HAVING COUNT(*) > 1)`,
    );
    expect(doubleBooked[0]?.n ?? 0).toBe(0);

    // A thread names exactly one session, and a conversation one session per
    // (peer, room). Both are primary keys; both are what a reply resolves
    // through, and a second row for either is a message with two homes.
    const forkedThreads = rows<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM (
         SELECT root_id FROM threads GROUP BY root_id HAVING COUNT(*) > 1)`,
    );
    expect(forkedThreads[0]?.n ?? 0).toBe(0);

    // invariant: I1 — seq and stream_index never move backwards. A snapshot
    // cannot see a rewind on its own, so the model carries the high-water mark
    // and this compares against it.
    const transcripts = rows<{
      session_id: string;
      seq: number;
      stream_index: number;
      turn: number;
    }>(db, `SELECT session_id, seq, stream_index, turn FROM transcripts`);
    for (const row of transcripts) {
      expect(row.seq).toBeGreaterThanOrEqual(0);
      expect(row.stream_index).toBeGreaterThanOrEqual(0);
      const seq = expected.transcriptSeq?.get(row.session_id);
      if (seq !== undefined) expect(row.seq).toBeGreaterThanOrEqual(seq);
      const index = expected.streamIndex?.get(row.session_id);
      if (index !== undefined)
        expect(row.stream_index).toBeGreaterThanOrEqual(index);
    }

    // invariant: I2 — generations strictly increase. A repeat means two writers
    // could hold the same fence, which is the fence not fencing.
    const seen = expected.generations ?? [];
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  } finally {
    db.close();
  }
}
