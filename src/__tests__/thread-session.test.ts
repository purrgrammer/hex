/**
 * A thread is one subject, and it owns the run that answers it.
 *
 * Both halves of this were live failures, minutes apart, in the same room:
 * a reply typed into a thread was ignored because the message it threads onto
 * is the OPERATOR'S own opening message and not anything Hex wrote; and a reply
 * resumed whatever session that person last had open in the room, which was an
 * hours-old run the runtime then refused with a 409 — leaving an acknowledged
 * question that was never answered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HexStore } from "../store.js";
import { replyTargetOf, threadRootOf } from "../transports/concord.js";
import { refusesWork } from "../eve/serve.js";
import { whyIgnored } from "../policy-table.js";
import { KIND_COMMENT, KIND_MESSAGE } from "../concord/kinds.js";
import type { CanonicalEvent } from "../ingest.js";

const ROOT = "8f44c425c3".padEnd(64, "0");
const REPLY = "967e23e9f2".padEnd(64, "0");
const OPERATOR = "7fa56f5d69".padEnd(64, "0");
const SESSION = "wrun_01M0J1WS9FNEYKWSP620B9VJF4";

/** Exactly the tags the ignored message carried, in its order. */
const asItArrived = {
  kind: KIND_COMMENT,
  rumorId: REPLY,
  author: OPERATOR,
  content: "oh yea i meant that one 5A",
  createdAt: 1,
  tags: [
    ["E", ROOT],
    ["P", OPERATOR],
    ["e", ROOT],
    ["p", OPERATOR],
  ],
} as never;

describe("reading a thread off a Concord comment", () => {
  it("tells the root apart from the parent", () => {
    // Both are the root here — the reply replies TO the root — and that is
    // exactly the case that made reading only the parent look sufficient.
    expect(replyTargetOf(asItArrived)).toBe(ROOT);
    expect(threadRootOf(asItArrived)).toBe(ROOT);
  });

  it("reads the root from E when the parent is deeper in", () => {
    const deeper = {
      ...(asItArrived as unknown as { tags: string[][] }),
      kind: KIND_COMMENT,
      tags: [
        ["E", ROOT],
        ["e", "aa".repeat(32)],
      ],
    } as never;
    expect(threadRootOf(deeper)).toBe(ROOT);
    expect(replyTargetOf(deeper)).toBe("aa".repeat(32));
  });

  it("gives a plain message no thread at all", () => {
    const plain = { kind: KIND_MESSAGE, tags: [["q", ROOT]] } as never;
    expect(threadRootOf(plain)).toBeUndefined();
    // A kind 9's `q` is an inline quote, and stays the reply target.
    expect(replyTargetOf(plain)).toBe(ROOT);
  });
});

describe("what a thread binding is for", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "thread-session-"));
    store = HexStore.open(join(home, "data.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("answers 'is this thread ours' only where a run was opened", () => {
    expect(store.threadIsOurs(ROOT)).toBe(false);
    store.rememberThread(ROOT, SESSION, 1);
    expect(store.threadIsOurs(ROOT)).toBe(true);
    expect(store.threadSession(ROOT)).toBe(SESSION);
  });

  it("keeps two threads in one room on two sessions", () => {
    const other = "bb".repeat(32);
    store.rememberThread(ROOT, SESSION, 1);
    store.rememberThread(other, "wrun_OTHER", 2);
    expect(store.threadSession(ROOT)).toBe(SESSION);
    expect(store.threadSession(other)).toBe("wrun_OTHER");
  });

  it("survives a restart, because the binding outlives the process", () => {
    store.rememberThread(ROOT, SESSION, 1);
    store.close();
    store = HexStore.open(join(home, "data.db"));
    expect(store.threadSession(ROOT)).toBe(SESSION);
  });

  it("forgets every thread a dead session held", () => {
    const second = "cc".repeat(32);
    store.rememberThread(ROOT, SESSION, 1);
    store.rememberThread(second, SESSION, 2);
    store.rememberThread("dd".repeat(32), "wrun_LIVE", 3);

    // What a 409 must do: nothing may resume the refused session again.
    store.forgetThread(SESSION);
    expect(store.threadSession(ROOT)).toBeUndefined();
    expect(store.threadSession(second)).toBeUndefined();
    expect(store.threadSession("dd".repeat(32))).toBe("wrun_LIVE");
  });

  it("rebinds a root rather than growing a second row for it", () => {
    store.rememberThread(ROOT, SESSION, 1);
    store.rememberThread(ROOT, "wrun_FRESH", 2);
    expect(store.threadSession(ROOT)).toBe("wrun_FRESH");
  });
});

describe("a session the runtime will not take work for", () => {
  it("is recognised from the status in the message", () => {
    expect(
      refusesWork(new Error("eve /eve/v1/session/wrun_X: 409 Conflict")),
    ).toBe(true);
    expect(refusesWork(new Error("404 Not Found"))).toBe(true);
  });

  it("is NOT a server fault or a dropped socket", () => {
    // Retrying these into a fresh session would fork a run that was fine.
    expect(refusesWork(new Error("500 Internal Server Error"))).toBe(false);
    expect(refusesWork(new Error("503 Service Unavailable"))).toBe(false);
    expect(refusesWork(new Error("socket hang up"))).toBe(false);
  });
});

describe("saying why nothing answered", () => {
  const message = (addressesSelf: boolean): CanonicalEvent =>
    ({ type: "message", payload: { addressesSelf } }) as CanonicalEvent;

  it("names the predicate that declined, not the table", () => {
    expect(whyIgnored(message(false), { inTurn: false })).toBe("not addressed");
  });

  it("says so when the lane was busy instead", () => {
    expect(whyIgnored(message(true), { inTurn: true })).toBe(
      "no rule for a message arriving mid-turn",
    );
  });
});
