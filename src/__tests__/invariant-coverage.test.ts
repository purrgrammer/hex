/**
 * Which invariant is proven where — the one checked-in answer, so it is tracked
 * rather than reconstructed by grep every time someone asks.
 *
 * The map verifies what it claims. Every owner path must exist on disk, so
 * deleting an owning test trips a gate that NAMES the invariant that went
 * uncovered; and the high-consequence ones must be pinned by a sentinel comment
 * beside the assertion that proves them:
 *
 *   // invariant: I5
 *
 * The grep is anchored and word-bounded, so `I1` never matches `I13`. An
 * emptied-out file passing on existence alone is exactly the failure this
 * closes: a data-corrupting change landing green because the test that would
 * have caught it was deleted along with the behaviour.
 *
 * A `gap` is allowed, and must say why. Untriaged is not.
 *
 * The shape is fragua's `packages/daemon/test/invariant-coverage.test.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
);

const TESTS = "src/__tests__";
const INVARIANTS = `${TESTS}/invariants.ts`;
const STORE_FENCE = `${TESTS}/store-fence.test.ts`;
const WRITER_LEASE = `${TESTS}/writer-lease.test.ts`;
const INGEST = `${TESTS}/ingest.test.ts`;
const RUNNER = `${TESTS}/runner.test.ts`;
const OUTBOUND = `${TESTS}/outbound.test.ts`;
const FOLLOW_DROP = `${TESTS}/eve-follow-drop.test.ts`;
const THREAD = `${TESTS}/thread-session.test.ts`;
const CONCORD = `${TESTS}/concord-transport.test.ts`;
const STORE_PBT = `${TESTS}/store.property.test.ts`;
const POLICY_PBT = `${TESTS}/policy.property.test.ts`;
const RUNNER_PBT = `${TESTS}/runner.property.test.ts`;
const QUIESCENCE_PBT = `${TESTS}/quiescence.property.test.ts`;
const TRANSPORTS = `${TESTS}/thread-transports.test.ts`;
const ROOM_TOOLS = `${TESTS}/room-tools.test.ts`;

type Status = "covered" | "partial" | "gap";

interface Coverage {
  id: string;
  statement: string;
  status: Status;
  /** Who proves it, or `GAP: <reason>` when nobody does. */
  owner: string;
  /** Repo-relative paths backing `owner`. Each must exist. */
  ownerFiles: string[];
}

const COVERAGE: Coverage[] = [
  {
    id: "I1",
    statement: "seq and stream_index never move backwards",
    status: "covered",
    owner:
      "store-fence.test.ts, the store state machine's SaveTranscript, and the shared checker's high-water comparison",
    ownerFiles: [STORE_FENCE, STORE_PBT, INVARIANTS],
  },
  {
    id: "I2",
    statement: "at most one live generation; generations strictly increase",
    status: "covered",
    owner:
      "writer-lease.test.ts, the state machine's TakeOverLease/Heartbeat/AcquireExpired driven across the TTL by AdvanceClock, and the shared checker",
    ownerFiles: [WRITER_LEASE, STORE_PBT, INVARIANTS],
  },
  {
    id: "I3",
    statement: "an event enqueues at most once per (transport, event_id)",
    status: "covered",
    owner:
      "ingest.test.ts, the state machine's Arrive — which found the redelivery that outlived its guard — and the shared checker",
    ownerFiles: [INGEST, STORE_PBT, INVARIANTS],
  },
  {
    id: "I4",
    statement: "no two dispatches overlap for one session",
    status: "covered",
    owner: "runner.test.ts, and thread-session.test.ts for the group case",
    ownerFiles: [RUNNER, THREAD],
  },
  {
    id: "I5",
    statement: "a composed reply is delivered exactly once",
    status: "covered",
    owner:
      "outbound.test.ts, the state machine's BeginSend/MarkSent, and the shared checker",
    ownerFiles: [OUTBOUND, STORE_PBT, INVARIANTS],
  },
  {
    id: "I6",
    statement: "a reservation prevents a duplicate publish",
    status: "covered",
    owner:
      "store-fence.test.ts, the state machine's Reserve/Release under AdvanceClock, and the shared checker",
    ownerFiles: [STORE_FENCE, STORE_PBT, INVARIANTS],
  },
  {
    id: "I7",
    statement: "decide always returns a member of DISPOSITIONS",
    status: "covered",
    owner:
      "policy.property.test.ts, over arbitrary events x lane states x operator tables",
    ownerFiles: [POLICY_PBT],
  },
  {
    id: "I8",
    statement: "a stalled follow is eventually reported",
    status: "covered",
    owner: "eve-follow-drop.test.ts",
    ownerFiles: [FOLLOW_DROP],
  },
  {
    id: "I9",
    statement: "PENDING_CAP bounds a lane and never evicts a control",
    status: "covered",
    owner:
      "runner.test.ts for the ordinary evictions, runner.property.test.ts over arbitrary lines — including the all-controls branch an example never reached",
    ownerFiles: [RUNNER, RUNNER_PBT],
  },
  {
    id: "I10",
    statement: "no in-memory set leaks: inFlight/sending/lanes empty at rest",
    status: "partial",
    owner:
      "quiescence.property.test.ts covers the ingestor's inFlight and the spool's sending, including the fenced path that is the only way to reach send's own catch. The runner's lanes map is not covered: emptying it needs turns to finish, which needs the driven tier.",
    ownerFiles: [QUIESCENCE_PBT],
  },
  {
    id: "I11",
    statement: "a reply resumes only its own thread's session",
    status: "covered",
    owner: "thread-session.test.ts",
    ownerFiles: [THREAD],
  },
  {
    id: "I12",
    statement:
      "a reply in a thread hex is running addresses hex, mention or not",
    status: "covered",
    owner:
      "thread-session.test.ts, concord-transport.test.ts, and thread-transports.test.ts for the NIP-29 case it was reported in",
    ownerFiles: [THREAD, CONCORD, TRANSPORTS],
  },
  {
    id: "I13",
    statement:
      "every field of an inbound message survives the queue round trip",
    status: "covered",
    owner:
      "policy.property.test.ts compares the whole payload, thread-session.test.ts pins the case that prompted it, and the type manifest in ingest.ts refuses to compile without it",
    ownerFiles: [POLICY_PBT, THREAD],
  },
  {
    id: "I14",
    statement:
      "reply resolution reads each protocol's own tag shape, and binds every id a later reply could name",
    status: "covered",
    owner:
      "thread-transports.test.ts for the three shapes, room-tools.test.ts for the answer a room sees — the one the spool never touches",
    ownerFiles: [TRANSPORTS, ROOM_TOOLS],
  },
];

/**
 * The invariants where file-existence is not a high enough bar: an emptied-out
 * owner would let a change that corrupts the queue, forks a run, or answers a
 * person twice land green.
 */
const SENTINELS: Record<string, string[]> = {
  I1: [INVARIANTS, STORE_PBT],
  I2: [INVARIANTS, STORE_PBT],
  I3: [INVARIANTS, STORE_PBT],
  I5: [INVARIANTS, STORE_PBT],
  I6: [INVARIANTS, STORE_PBT],
  I7: [POLICY_PBT],
  I9: [RUNNER_PBT],
  I10: [QUIESCENCE_PBT],
  I13: [POLICY_PBT],
};

function sentinelPattern(id: string): RegExp {
  return new RegExp(`// invariant: (?:[A-Za-z0-9-]+, )*${id}\\b`);
}

describe("the invariant coverage map", () => {
  it("is well formed: unique ids, every entry triaged", () => {
    const ids = new Set<string>();
    for (const invariant of COVERAGE) {
      expect(ids.has(invariant.id)).toBe(false);
      ids.add(invariant.id);
      expect(invariant.owner.trim().length).toBeGreaterThan(0);
      expect(invariant.statement.trim().length).toBeGreaterThan(0);
    }
  });

  it("names every invariant the plan set out", () => {
    const ids = new Set(COVERAGE.map((c) => c.id));
    for (let i = 1; i <= 14; i++) expect(ids.has(`I${i}`)).toBe(true);
  });

  it("makes every gap say why", () => {
    for (const invariant of COVERAGE.filter((c) => c.status === "gap")) {
      expect(invariant.owner).toMatch(/^GAP:/);
      // A gap owns no file: citing one would read as covered in a listing.
      expect(invariant.ownerFiles).toEqual([]);
    }
  });

  it("cites only files that exist", () => {
    const missing: string[] = [];
    for (const invariant of COVERAGE) {
      if (invariant.status === "gap") continue;
      expect(invariant.ownerFiles.length).toBeGreaterThan(0);
      for (const file of invariant.ownerFiles)
        if (!existsSync(join(REPO_ROOT, file)))
          missing.push(`${invariant.id}: ${file}`);
    }
    expect(missing).toEqual([]);
  });

  it("pins the high-consequence invariants to a sentinel comment", () => {
    const unpinned: string[] = [];
    for (const [id, files] of Object.entries(SENTINELS)) {
      const pattern = sentinelPattern(id);
      for (const file of files) {
        const path = join(REPO_ROOT, file);
        if (!existsSync(path)) {
          unpinned.push(`${id}: ${file} (file missing)`);
          continue;
        }
        if (!pattern.test(readFileSync(path, "utf8")))
          unpinned.push(`${id}: ${file} (no \`// invariant: ${id}\` sentinel)`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it("keeps the sentinel registry consistent with the map", () => {
    const byId = new Map(COVERAGE.map((c) => [c.id, c]));
    for (const [id, files] of Object.entries(SENTINELS)) {
      const entry = byId.get(id);
      expect(entry).toBeDefined();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(entry!.ownerFiles).toContain(file);
    }
  });
});
