/**
 * A store to test against, and the lease every fenced write needs.
 *
 * Both idioms were copy-pasted across a dozen test files — the temp directory
 * with its `afterEach` cleanup, and the WeakMap of generations that lets an
 * example call `saveTranscript` without spelling out a lease each time. One
 * copy, so a property suite and an example suite exercise the same setup and a
 * fix to it reaches both.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HexStore, type StoreClock, type WriterLease } from "../../store.js";

/** One lease per store: every transcript save is fenced on its generation. */
const generations = new WeakMap<HexStore, number>();

const leases = new WeakMap<HexStore, WriterLease>();

export function fenceFor(store: HexStore): { generation: number } {
  let generation = generations.get(store);
  if (generation === undefined) {
    const lease = store.acquireWriterLease({ takeover: true });
    leases.set(store, lease);
    generation = lease.generation;
    generations.set(store, generation);
  }
  return { generation };
}

/** The lease object itself, for a test that has to heartbeat or release it. */
export function leaseFor(store: HexStore): WriterLease {
  fenceFor(store);
  return leases.get(store)!;
}

export interface TempStore {
  store: HexStore;
  /** The directory holding it, for a test that reopens the same file. */
  home: string;
  path: string;
  /** Close and delete. Safe to call twice. */
  dispose(): void;
  /** Reopen the same file, as a restart does, and return the new store. */
  restart(): HexStore;
  /** The lease the current store holds. */
  readonly lease: WriterLease;
}

/**
 * A store in its own directory, with the lease already held.
 *
 * `takeover` because the directory is new: there is no other holder, and a
 * test that had to wait out a TTL to prove that would just be slow.
 */
export function tempStore(
  prefix = "hex-store-",
  /** The clock the store — and every store it is reopened as — reads. */
  now?: StoreClock,
): TempStore {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const path = join(home, "data.db");
  let store = HexStore.open(path, now ? { now } : undefined);
  fenceFor(store);
  let gone = false;
  return {
    get store() {
      return store;
    },
    home,
    path,
    get lease() {
      return leaseFor(store);
    },
    dispose() {
      if (gone) return;
      gone = true;
      try {
        store.close();
      } catch {
        // Already closed by a restart case; the directory still has to go.
      }
      rmSync(home, { recursive: true, force: true });
    },
    restart(): HexStore {
      store.close();
      store = HexStore.open(path, now ? { now } : undefined);
      fenceFor(store);
      return store;
    },
  };
}
