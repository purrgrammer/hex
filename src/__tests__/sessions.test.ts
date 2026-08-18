import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NostrEvent } from "nostr-tools";
import { StateStore, defaultStatePath } from "../state.js";
import { SessionTracker } from "../sessions.js";
import type { Inbound, Room } from "../transports/types.js";

const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

let counter = 0;

function inbound(
  author: string,
  text: string,
  at: number,
  replyToId?: string,
): Inbound {
  counter += 1;
  const id = `m${counter}`;
  return {
    id,
    author,
    text,
    createdAt: at,
    room: ROOM,
    addressesSelf: true,
    replyToId,
    event: {
      id,
      pubkey: author,
      created_at: at,
      kind: 9,
      content: text,
      tags: [],
      sig: "",
    } as NostrEvent,
  };
}

async function tracker(now = () => 1000, idleSecs?: number) {
  const dir = await mkdtemp(join(tmpdir(), "hex-state-"));
  const store = new StateStore(defaultStatePath(dir));
  await store.load();
  return {
    dir,
    store,
    sessions: new SessionTracker({ store, maxMessages: 10, now, idleSecs }),
  };
}

/** Record a human turn and Hex's answer to it, as the agent loop does. */
function exchange(
  sessions: SessionTracker,
  message: Inbound,
  answer: string,
  answerId: string,
) {
  const session = sessions.resolve(message);
  sessions.record(session.id, {
    id: message.id,
    room: "nip-29|wss://g.example/|dev",
    author: message.author,
    text: message.text,
    at: message.createdAt,
    replyToId: message.replyToId,
  });
  sessions.recordOwn(session.id, {
    id: answerId,
    room: "nip-29|wss://g.example/|dev",
    author: "",
    text: answer,
    at: message.createdAt + 1,
    replyToId: message.id,
  });
  return session;
}

describe("SessionTracker", () => {
  it("continues the session when someone mentions Hex again, without replying", async () => {
    // The case a reply chain misses: people address a bot again a minute later
    // rather than threading, and a fresh session answers as if nothing happened.
    const { sessions } = await tracker();
    const first = inbound(ALICE, "hex, what is kind 9?", 1000);
    const opened = exchange(sessions, first, "a group chat message", "hex-1");

    const followUp = inbound(ALICE, "hex, and kind 11?", 1100);
    const resolved = sessions.resolve(followUp);

    expect(resolved.id).toBe(opened.id);
    expect(resolved.isNew).toBe(false);
    expect(sessions.history(resolved.id).map((m) => m.text)).toEqual([
      "hex, what is kind 9?",
      "a group chat message",
    ]);
  });

  it("continues on an explicit reply however old the session is", async () => {
    // Threading is intent, and outranks the idle window.
    let clock = 1000;
    const { sessions } = await tracker(
      () => clock,
      60, // a one-minute idle window
    );
    const first = inbound(ALICE, "hex?", 1000);
    const opened = exchange(sessions, first, "yes?", "hex-1");

    clock = 100_000;
    const muchLater = inbound(ALICE, "as I was saying", clock, "hex-1");
    expect(sessions.resolve(muchLater).id).toBe(opened.id);
  });

  it("opens a new session once the window has passed", async () => {
    let clock = 1000;
    const { sessions } = await tracker(() => clock, 60);
    const first = inbound(ALICE, "hex?", 1000);
    const opened = exchange(sessions, first, "yes?", "hex-1");

    clock = 5000;
    const unrelated = inbound(ALICE, "hex, different question", clock);
    const resolved = sessions.resolve(unrelated);
    expect(resolved.id).not.toBe(opened.id);
    expect(resolved.isNew).toBe(true);
  });

  it("keeps two people's conversations apart", async () => {
    const { sessions } = await tracker();
    const alice = inbound(ALICE, "hex, mine", 1000);
    const hers = exchange(sessions, alice, "answer for alice", "hex-1");

    const bob = inbound(BOB, "hex, mine too", 1010);
    const his = sessions.resolve(bob);

    expect(his.id).not.toBe(hers.id);
    expect(his.isNew).toBe(true);
  });

  it("pulls a second person into a conversation they replied to", async () => {
    // A room is not a set of private channels: if Bob answers Alice's thread,
    // his message belongs to it.
    const { sessions } = await tracker();
    const alice = inbound(ALICE, "hex, mine", 1000);
    const hers = exchange(sessions, alice, "an answer", "hex-1");

    const bob = inbound(BOB, "actually, what about X?", 1010, "hex-1");
    expect(sessions.resolve(bob).id).toBe(hers.id);
  });

  it("knows what Hex published, so a reply to it is addressed to it", async () => {
    const { sessions } = await tracker();
    exchange(sessions, inbound(ALICE, "hex?", 1000), "an answer", "hex-1");
    expect(sessions.isOwn("hex-1")).toBe(true);
    expect(sessions.isOwn("someone-else")).toBe(false);
  });

  it("bounds the history it hands over", async () => {
    const { store } = await tracker();
    const sessions = new SessionTracker({ store, maxMessages: 3 });
    const first = inbound(ALICE, "turn 0", 1000);
    const opened = sessions.resolve(first);
    for (let i = 0; i < 10; i += 1)
      sessions.record(opened.id, {
        id: `t${i}`,
        room: "nip-29|wss://g.example/|dev",
        author: ALICE,
        text: `turn ${i}`,
        at: 1000 + i,
      });

    const history = sessions.history(opened.id);
    expect(history).toHaveLength(3);
    // The nearest turns, not the oldest.
    expect(history.map((m) => m.text)).toEqual(["turn 7", "turn 8", "turn 9"]);
  });
});

describe("durability", () => {
  it("resumes a conversation after a restart", async () => {
    // The whole point: a restart used to make Hex meet everyone again.
    const dir = await mkdtemp(join(tmpdir(), "hex-state-"));
    const path = defaultStatePath(dir);

    const first = new StateStore(path);
    await first.load();
    const before = new SessionTracker({ store: first, maxMessages: 10 });
    const opened = exchange(
      before,
      inbound(ALICE, "hex, what is kind 9?", 1000),
      "a group chat message",
      "hex-1",
    );
    await first.flush();

    // A different process, same file.
    const second = new StateStore(path);
    await second.load();
    const after = new SessionTracker({
      store: second,
      maxMessages: 10,
      now: () => 1100,
    });

    expect(after.isOwn("hex-1")).toBe(true);
    const followUp = inbound(ALICE, "and kind 11?", 1100, "hex-1");
    expect(after.resolve(followUp).id).toBe(opened.id);
    expect(after.history(opened.id).map((m) => m.text)).toEqual([
      "hex, what is kind 9?",
      "a group chat message",
    ]);
  });

  it("starts fresh on an unreadable state file rather than refusing to boot", async () => {
    // The contents are a convenience; a crash loop over them trades a small loss
    // for a total one.
    const dir = await mkdtemp(join(tmpdir(), "hex-state-"));
    const path = defaultStatePath(dir);
    await writeFile(path, "{ this is not json", "utf8");

    const store = new StateStore(path);
    await store.load();
    expect(store.data.sessions).toEqual({});
  });

  it("writes atomically, leaving no partial file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hex-state-"));
    const path = defaultStatePath(dir);
    const store = new StateStore(path);
    await store.load();
    const sessions = new SessionTracker({ store, maxMessages: 10 });
    exchange(sessions, inbound(ALICE, "hex?", 1000), "hi", "hex-1");
    await store.flush();

    // Parses, which a truncated write would not.
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
    };
    expect(parsed.version).toBe(1);
  });

  it("writes nothing when nothing changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hex-state-"));
    const store = new StateStore(defaultStatePath(dir));
    await store.load();
    await store.flush();
    await expect(readFile(defaultStatePath(dir), "utf8")).rejects.toThrow();
  });
});
