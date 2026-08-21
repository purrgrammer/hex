/**
 * A thread binding is a routing table, and it was writable by anyone.
 *
 * Both of these are reachable from a public room by a stranger, cost nothing to
 * attempt, and were found by asking the adversarial question rather than by
 * anything going wrong: what does a thread binding let someone else decide?
 *
 * 1. **Steal a thread.** `rememberThread` upserted, and the root it binds comes
 *    off the incoming event's tags — attacker-controlled. Post a mention whose
 *    `E` tag names the root of somebody ELSE'S live thread and Hex opens a run
 *    for you and repoints their thread at it. Their next reply lands in your
 *    session: your context, your tools, your instructions.
 *
 * 2. **Cross a room.** The table is keyed on the root id alone, so a binding
 *    made in one room answers a lookup from another. Quote the id of an answer
 *    Hex published in a public group, from anywhere, and you resume that room's
 *    run — with its history — and Hex replies wherever you asked.
 *
 * The fix is two rules with no exceptions: a thread is claimed by whoever gets
 * there first and never reassigned while it lives, and a binding only answers
 * for the room it was made in.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HexStore } from "../store.js";

const ROOT = "11".repeat(32);
const MINE = "wrun_mine";
const THEIRS = "wrun_theirs";
const ROOM = "nip-29:groups.example/general";
const OTHER_ROOM = "nip-29:groups.example/random";

describe("who a thread belongs to", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "thread-hijack-"));
    store = HexStore.open(join(home, "data.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("goes to whoever claimed it first", () => {
    store.rememberThread(ROOT, MINE, ROOM, 1);
    // A stranger naming the same root in the same room. The id is theirs to
    // write and nobody can stop them writing it; what they cannot do is move
    // the thread.
    store.rememberThread(ROOT, THEIRS, ROOM, 2);

    expect(store.threadSession(ROOT, ROOM)).toBe(MINE);
  });

  it("is released when its run is, and can be claimed again after", () => {
    store.rememberThread(ROOT, MINE, ROOM, 1);
    // What the 409 path does: a session the runtime will not take work for is
    // unbound, and the thread is free again.
    store.forgetThread(MINE);
    store.rememberThread(ROOT, THEIRS, ROOM, 2);

    expect(store.threadSession(ROOT, ROOM)).toBe(THEIRS);
  });

  it("answers only for the room it was made in", () => {
    store.rememberThread(ROOT, MINE, ROOM, 1);

    expect(store.threadSession(ROOT, ROOM)).toBe(MINE);
    // The same id, quoted from somewhere else. A run belongs to a room, so a
    // binding that answered here would resume that room's history in this one.
    expect(store.threadSession(ROOT, OTHER_ROOM)).toBeUndefined();
    expect(store.threadIsOurs(ROOT, OTHER_ROOM)).toBe(false);
  });

  it("is Hex's thread in the room that owns it", () => {
    store.rememberThread(ROOT, MINE, ROOM, 1);
    expect(store.threadIsOurs(ROOT, ROOM)).toBe(true);
  });

  it("lets the same run hold the same thread twice, which is not a conflict", () => {
    // Every message in a thread binds it again; that has to be a no-op rather
    // than a refusal, or the second message would look like an intruder.
    store.rememberThread(ROOT, MINE, ROOM, 1);
    store.rememberThread(ROOT, MINE, ROOM, 2);
    expect(store.threadSession(ROOT, ROOM)).toBe(MINE);
  });
});
