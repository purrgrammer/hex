import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HexStore, LeaseHeldError } from "../store.js";

/**
 * The invariant these pin down: at most one live generation at any instant,
 * and generations never repeat or decrease — across expiry takeovers, clean
 * releases, and a second process opening the same file.
 */
describe("writer lease", () => {
  let dir: string;
  let store: HexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hex-lease-"));
    store = HexStore.open(join(dir, "data.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a second acquire on one file throws, naming the holder", () => {
    const lease = store.acquireWriterLease();
    expect(lease.generation).toBe(1);

    // A different connection on the same file, as a second process would be.
    const other = HexStore.open(join(dir, "data.db"));
    try {
      expect(() => other.acquireWriterLease()).toThrow(LeaseHeldError);
      try {
        other.acquireWriterLease();
        expect.unreachable("acquire should have thrown");
      } catch (error) {
        const held = error as LeaseHeldError;
        expect(held.holder.pid).toBe(process.pid);
        expect(held.holder.hostname).toBe(hostname());
        expect(held.holder.generation).toBe(1);
        expect(held.message).toContain(String(process.pid));
        expect(held.message).toContain(hostname());
      }
    } finally {
      other.close();
    }
  });

  it("taking over an expired lease bumps the generation", () => {
    const dead = store.acquireWriterLease({ ttlSecs: 0 });
    expect(dead.generation).toBe(1);

    const other = HexStore.open(join(dir, "data.db"));
    try {
      const next = other.acquireWriterLease();
      expect(next.generation).toBe(2);
    } finally {
      other.close();
    }
  });

  it("the old holder's heartbeat reports the lease lost", () => {
    const dead = store.acquireWriterLease({ ttlSecs: 0 });

    const other = HexStore.open(join(dir, "data.db"));
    try {
      const next = other.acquireWriterLease();
      expect(dead.heartbeat()).toBe(false);
      expect(next.heartbeat()).toBe(true);
    } finally {
      other.close();
    }
  });

  it("a heartbeat keeps a live lease held", () => {
    const lease = store.acquireWriterLease();
    expect(lease.heartbeat()).toBe(true);
    expect(store.writerLeaseHolder()?.generation).toBe(1);
  });

  it("release frees the lease but the generation never restarts", () => {
    const first = store.acquireWriterLease();
    expect(first.generation).toBe(1);
    first.release();
    expect(store.writerLeaseHolder()).toBeUndefined();

    // The next holder — even on a fresh connection — continues the count.
    const other = HexStore.open(join(dir, "data.db"));
    try {
      const second = other.acquireWriterLease();
      expect(second.generation).toBe(2);
      // A released lease's heartbeat cannot resurrect it over the new holder.
      expect(first.heartbeat()).toBe(false);
      expect(second.heartbeat()).toBe(true);
    } finally {
      other.close();
    }
  });

  it("writerLeaseHolder reports a live holder and nothing after expiry", () => {
    expect(store.writerLeaseHolder()).toBeUndefined();

    store.acquireWriterLease({ ttlSecs: 0 });
    expect(store.writerLeaseHolder()).toBeUndefined();

    const lease = store.acquireWriterLease();
    const holder = store.writerLeaseHolder();
    expect(holder?.generation).toBe(lease.generation);
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.hostname).toBe(hostname());
  });

  it("a failed acquire leaves the connection usable", () => {
    store.acquireWriterLease();
    const other = HexStore.open(join(dir, "data.db"));
    try {
      expect(() => other.acquireWriterLease()).toThrow(LeaseHeldError);
      // The transaction rolled back: an ordinary write still goes through.
      other.markObeyed("control-after-rollback");
      expect(other.wasObeyed("control-after-rollback")).toBe(true);
    } finally {
      other.close();
    }
  });
});
