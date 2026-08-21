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
import { nip19 } from "nostr-tools";

import { attributed, refusesWork } from "../eve/serve.js";
import { whyIgnored } from "../policy-table.js";
import { laneForMessage } from "../runner.js";
import { roomKey } from "../transports/types.js";
import { KIND_COMMENT, KIND_MESSAGE } from "../concord/kinds.js";
import {
  carrierFor,
  messageEvent,
  type CanonicalEvent,
  type MessagePayload,
} from "../ingest.js";

const ROOT = "8f44c425c3".padEnd(64, "0");
const REPLY = "967e23e9f2".padEnd(64, "0");
const OPERATOR = "7fa56f5d69".padEnd(64, "0");
const SESSION = "wrun_01M0J1WS9FNEYKWSP620B9VJF4";
const OTHER_SPEAKER = "aa".repeat(32);
/** A binding belongs to the room it was made in, so every call names one. */
const BOUND_ROOM = "concord:community:channel";

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
    expect(store.threadIsOurs(ROOT, BOUND_ROOM)).toBe(false);
    store.rememberThread(ROOT, SESSION, BOUND_ROOM, 1);
    expect(store.threadIsOurs(ROOT, BOUND_ROOM)).toBe(true);
    expect(store.threadSession(ROOT, BOUND_ROOM)).toBe(SESSION);
  });

  it("keeps two threads in one room on two sessions", () => {
    const other = "bb".repeat(32);
    store.rememberThread(ROOT, SESSION, BOUND_ROOM, 1);
    store.rememberThread(other, "wrun_OTHER", BOUND_ROOM, 2);
    expect(store.threadSession(ROOT, BOUND_ROOM)).toBe(SESSION);
    expect(store.threadSession(other, BOUND_ROOM)).toBe("wrun_OTHER");
  });

  it("survives a restart, because the binding outlives the process", () => {
    store.rememberThread(ROOT, SESSION, BOUND_ROOM, 1);
    store.close();
    store = HexStore.open(join(home, "data.db"));
    expect(store.threadSession(ROOT, BOUND_ROOM)).toBe(SESSION);
  });

  it("forgets every thread a dead session held", () => {
    const second = "cc".repeat(32);
    store.rememberThread(ROOT, SESSION, BOUND_ROOM, 1);
    store.rememberThread(second, SESSION, BOUND_ROOM, 2);
    store.rememberThread("dd".repeat(32), "wrun_LIVE", BOUND_ROOM, 3);

    // What a 409 must do: nothing may resume the refused session again.
    store.forgetThread(SESSION);
    expect(store.threadSession(ROOT, BOUND_ROOM)).toBeUndefined();
    expect(store.threadSession(second, BOUND_ROOM)).toBeUndefined();
    expect(store.threadSession("dd".repeat(32), BOUND_ROOM)).toBe("wrun_LIVE");
  });

  it("keeps one row per root rather than growing a second", () => {
    store.rememberThread(ROOT, SESSION, BOUND_ROOM, 1);
    store.rememberThread(ROOT, SESSION, BOUND_ROOM, 2);
    expect(store.threadSession(ROOT, BOUND_ROOM)).toBe(SESSION);
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

/**
 * The queue is the only path a message takes to the runtime, so a field the
 * queue does not carry does not exist by the time anything reads it.
 *
 * Watched live: `threadRoot` was read correctly off the tags, and then dropped
 * on the way into `inbound_events`. Every reply rebuilt without it fell back to
 * its immediate parent, so replying to one of Hex's own answers opened a new
 * session and bound the thread to that reply — a fresh run per message, and the
 * real root left pointing at a run nothing would reach again.
 */
describe("a message crossing the durable queue", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "thread-queue-"));
    store = HexStore.open(join(home, "data.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const inbound = {
    id: REPLY,
    author: OPERATOR,
    text: "check NIP 5A",
    createdAt: 1,
    room: { transport: "concord" as const, id: "community:channel" },
    addressesSelf: true,
    replyToId: "85bf509a4d".padEnd(64, "0"),
    threadRoot: ROOT,
    event: {
      id: REPLY,
      pubkey: OPERATOR,
      kind: KIND_COMMENT,
      tags: [],
      content: "check NIP 5A",
      created_at: 1,
      sig: "",
    },
  };

  it("keeps the root and the parent apart", () => {
    const event = messageEvent(inbound, 2);
    const payload = event.payload as MessagePayload;

    expect(payload.threadRoot).toBe(ROOT);
    expect(payload.replyToId).toBe(inbound.replyToId);
    // The route names the exchange, and only the root is common to all of it.
    expect(event.route.thread).toBe(ROOT);
  });

  it("hands the root back to the transport that has to answer", () => {
    const seq = store.enqueueInbound(messageEvent(inbound, 2));
    expect(seq).toBeGreaterThan(0);

    const row = store.pendingInbound().find((r) => r.seq === seq)!;
    const carrier = carrierFor(row)!;

    expect(carrier.threadRoot).toBe(ROOT);
    expect(carrier.replyToId).toBe(inbound.replyToId);
  });

  it("falls back to the parent only when the protocol names no root", () => {
    const { threadRoot: _root, ...unthreaded } = inbound;
    expect(messageEvent(unthreaded, 2).route.thread).toBe(inbound.replyToId);
  });
});
/**
 * A lane is a session's serialisation domain, and a thread is what reaches a
 * session — so a thread is what the lane has to be named by.
 *
 * In a group two people answering in one thread are one session. Keyed on the
 * author, they were two lanes, and the runner is free to dispatch two lanes at
 * once: two turns sent into one session and two readers of one stream, which
 * publishes its turns twice. Keyed on the thread's own conversation, a control
 * for that session lands on the same key too.
 */
describe("two people, one thread", () => {
  let home: string;
  let store: HexStore;

  const ROOM = { transport: "concord" as const, id: "community:channel" };
  const OTHER = "aa".repeat(32);
  const lane = (peer: string) => `${peer}\u0000${roomKey(ROOM)}`;

  const reply = (author: string, root?: string) =>
    ({
      id: "cc".repeat(32),
      author,
      text: "and another thing",
      createdAt: 1,
      room: ROOM,
      addressesSelf: true,
      replyToId: "dd".repeat(32),
      ...(root ? { threadRoot: root } : {}),
      event: {
        id: "cc".repeat(32),
        pubkey: author,
        kind: KIND_COMMENT,
        tags: [],
        content: "",
        created_at: 1,
        sig: "",
      },
    }) as never;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "thread-lane-"));
    store = HexStore.open(join(home, "data.db"));
    store.rememberConversation(OPERATOR, roomKey(ROOM), SESSION, 1);
    store.rememberThread(ROOT, SESSION, roomKey(ROOM), 1);
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("puts every speaker in the thread on one lane", () => {
    expect(laneForMessage(reply(OTHER, ROOT), store)).toBe(
      laneForMessage(reply(OPERATOR, ROOT), store),
    );
  });

  it("names that lane after the session's own conversation", () => {
    // The same key a control for this session resolves to.
    expect(laneForMessage(reply(OTHER, ROOT), store)).toBe(lane(OPERATOR));
  });

  it("keeps an unbound thread on its own speaker's lane", () => {
    // Nothing to serialise against yet: no session, so no shared stream, and
    // the room names itself the way the store keys a fresh conversation.
    expect(laneForMessage(reply(OTHER, "ee".repeat(32)), store)).toBe(
      lane(OTHER),
    );
  });
});
/**
 * One session, two speakers — so the session has to be told which is talking.
 *
 * The run is grounded in whoever opened it. A second person answering in the
 * same thread reaches the same session, and with nothing said their words read
 * as the first person changing their mind.
 */
describe("a second speaker in someone else's run", () => {
  it("says who is talking, as something the runtime can resolve", () => {
    const said = attributed("and another thing", OTHER_SPEAKER, OPERATOR);
    expect(said).toContain("and another thing");
    expect(said).toContain(`nostr:${nip19.npubEncode(OTHER_SPEAKER)}`);
  });

  it("leaves the owner's own words exactly as they were", () => {
    // The ordinary case is one person in their own session; prefixing every
    // line of that would be noise the model has to read past.
    expect(attributed("carry on", OPERATOR, OPERATOR)).toBe("carry on");
  });

  it("says nothing when the session has no owner on record", () => {
    expect(attributed("carry on", OTHER_SPEAKER, undefined)).toBe("carry on");
  });
});
