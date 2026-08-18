import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NostrEvent } from "nostr-tools";
import { HexStore, agentHome, expandHome } from "../store.js";
import { SessionTracker } from "../sessions.js";
import type { Inbound, Room } from "../transports/types.js";

const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};
const ROOM_KEY = "nip-29|wss://g.example/|dev";
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const HEX_PUBKEY = "c".repeat(64);

let counter = 0;
const open: HexStore[] = [];

afterEach(() => {
  while (open.length) open.pop()!.close();
});

function track(path: string, now = () => 1000, idleSecs?: number) {
  const store = HexStore.open(path);
  open.push(store);
  return {
    store,
    sessions: new SessionTracker({ store, maxMessages: 10, now, idleSecs }),
  };
}

async function home() {
  const root = await mkdtemp(join(tmpdir(), "hex-home-"));
  return agentHome(root, HEX_PUBKEY);
}

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

/** A human turn and Hex's answer to it, as the agent loop records them. */
function exchange(
  sessions: SessionTracker,
  message: Inbound,
  answer: string,
  answerId: string,
) {
  const session = sessions.resolve(message);
  sessions.record(session.id, {
    id: message.id,
    room: ROOM_KEY,
    author: message.author,
    text: message.text,
    at: message.createdAt,
    replyToId: message.replyToId,
  });
  sessions.recordOwn(session.id, {
    id: answerId,
    room: ROOM_KEY,
    author: "",
    text: answer,
    at: message.createdAt + 1,
    replyToId: message.id,
  });
  return session;
}

describe("agentHome", () => {
  it("gives each agent its own directory, named by its pubkey", async () => {
    const root = await mkdtemp(join(tmpdir(), "hex-home-"));
    const mine = agentHome(root, HEX_PUBKEY);
    const theirs = agentHome(root, ALICE);

    expect(mine.dir).toBe(join(root, HEX_PUBKEY));
    expect(mine.db).toBe(join(root, HEX_PUBKEY, "data.db"));
    expect(mine.worktrees).toBe(join(root, HEX_PUBKEY, "worktrees"));
    // Two agents on one machine share nothing.
    expect(theirs.dir).not.toBe(mine.dir);
  });

  it("creates the worktrees directory up front", async () => {
    // At startup, with a path in the error — not at the first message.
    const place = await home();
    expect((await stat(place.worktrees)).isDirectory()).toBe(true);
  });

  it("expands ~ and resolves a relative home against the config", () => {
    expect(expandHome("~/somewhere")).toMatch(/^\/.*somewhere$/);
    expect(expandHome("./state", "/tmp/config")).toBe("/tmp/config/state");
  });
});

describe("SessionTracker", () => {
  it("continues the session when someone mentions Hex again, without replying", async () => {
    // The case a reply chain misses: people address a bot again a minute later
    // rather than threading, and a fresh session answers as if nothing happened.
    const { sessions } = track((await home()).db);
    const opened = exchange(
      sessions,
      inbound(ALICE, "hex, what is kind 9?", 1000),
      "a group chat message",
      "hex-1",
    );

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
    const { sessions } = track((await home()).db, () => clock, 60);
    const opened = exchange(
      sessions,
      inbound(ALICE, "hex?", 1000),
      "yes?",
      "hex-1",
    );

    clock = 100_000;
    expect(
      sessions.resolve(inbound(ALICE, "as I was saying", clock, "hex-1")).id,
    ).toBe(opened.id);
  });

  it("opens a new session once the window has passed", async () => {
    let clock = 1000;
    const { sessions } = track((await home()).db, () => clock, 60);
    const opened = exchange(
      sessions,
      inbound(ALICE, "hex?", 1000),
      "yes?",
      "hex-1",
    );

    clock = 5000;
    const resolved = sessions.resolve(inbound(ALICE, "hex, different", clock));
    expect(resolved.id).not.toBe(opened.id);
    expect(resolved.isNew).toBe(true);
  });

  it("keeps two people's conversations apart", async () => {
    const { sessions } = track((await home()).db);
    const hers = exchange(
      sessions,
      inbound(ALICE, "hex, mine", 1000),
      "for alice",
      "hex-1",
    );
    const his = sessions.resolve(inbound(BOB, "hex, mine too", 1010));

    expect(his.id).not.toBe(hers.id);
    expect(his.isNew).toBe(true);
  });

  it("pulls a second person into a conversation they replied to", async () => {
    // A room is not a set of private channels: if Bob answers Alice's thread,
    // his message belongs to it.
    const { sessions } = track((await home()).db);
    const hers = exchange(
      sessions,
      inbound(ALICE, "hex, mine", 1000),
      "an answer",
      "hex-1",
    );
    expect(
      sessions.resolve(inbound(BOB, "what about X?", 1010, "hex-1")).id,
    ).toBe(hers.id);
  });

  it("does not join a session from another room", async () => {
    const { sessions } = track((await home()).db);
    exchange(sessions, inbound(ALICE, "hex?", 1000), "here", "hex-1");
    const elsewhere: Inbound = {
      ...inbound(ALICE, "hex?", 1010),
      room: { transport: "nip-29", id: "other", relay: "wss://g.example/" },
    };
    expect(sessions.resolve(elsewhere).isNew).toBe(true);
  });

  it("knows what Hex published, so a reply to it is addressed to it", async () => {
    const { sessions } = track((await home()).db);
    exchange(sessions, inbound(ALICE, "hex?", 1000), "an answer", "hex-1");
    expect(sessions.isOwn("hex-1")).toBe(true);
    expect(sessions.isOwn("someone-else")).toBe(false);
  });

  it("bounds the history it hands over, keeping the nearest turns", async () => {
    const place = await home();
    const store = HexStore.open(place.db);
    open.push(store);
    const sessions = new SessionTracker({ store, maxMessages: 3 });
    const opened = sessions.resolve(inbound(ALICE, "turn 0", 1000));
    for (let i = 0; i < 10; i += 1)
      sessions.record(opened.id, {
        id: `t${i}`,
        room: ROOM_KEY,
        author: ALICE,
        text: `turn ${i}`,
        at: 1000 + i,
      });

    expect(sessions.history(opened.id).map((m) => m.text)).toEqual([
      "turn 7",
      "turn 8",
      "turn 9",
    ]);
  });
});

describe("durability", () => {
  it("resumes a conversation after a restart", async () => {
    // The whole point: a restart used to make Hex meet everyone again.
    const place = await home();
    const before = track(place.db);
    const opened = exchange(
      before.sessions,
      inbound(ALICE, "hex, what is kind 9?", 1000),
      "a group chat message",
      "hex-1",
    );
    before.store.close();
    open.pop();

    const after = track(place.db, () => 1100);
    expect(after.sessions.isOwn("hex-1")).toBe(true);
    expect(
      after.sessions.resolve(inbound(ALICE, "and kind 11?", 1100, "hex-1")).id,
    ).toBe(opened.id);
    expect(after.sessions.history(opened.id).map((m) => m.text)).toEqual([
      "hex, what is kind 9?",
      "a group chat message",
    ]);
  });

  it("lets a second process write without erasing the first's work", async () => {
    // This is why it is not a JSON file: two holders of one document each write
    // the whole thing back, and the last one wins. Two connections, two rows.
    const place = await home();
    const daemon = track(place.db);
    const other = track(place.db);

    const session = daemon.sessions.resolve(inbound(ALICE, "hex?", 1000));
    daemon.sessions.record(session.id, {
      id: "from-daemon",
      room: ROOM_KEY,
      author: ALICE,
      text: "written by the daemon",
      at: 1000,
    });
    other.sessions.record(session.id, {
      id: "from-other",
      room: ROOM_KEY,
      author: BOB,
      text: "written by another process",
      at: 1001,
    });

    // Both survive, and each connection sees the other's row.
    expect(daemon.sessions.history(session.id).map((m) => m.text)).toEqual([
      "written by the daemon",
      "written by another process",
    ]);
    expect(other.sessions.history(session.id)).toHaveLength(2);
  });

  it("survives the same message arriving twice", async () => {
    // Relays deliver duplicates; a primary key is the answer, not a check.
    const { sessions } = track((await home()).db);
    const message = inbound(ALICE, "hex?", 1000);
    const session = sessions.resolve(message);
    const row = {
      id: message.id,
      room: ROOM_KEY,
      author: ALICE,
      text: message.text,
      at: message.createdAt,
    };
    sessions.record(session.id, row);
    sessions.record(session.id, row);
    expect(sessions.history(session.id)).toHaveLength(1);
  });

  it("prunes to a bound, oldest first", async () => {
    const place = await home();
    const store = HexStore.open(place.db);
    open.push(store);
    const sessions = new SessionTracker({ store, maxMessages: 100 });
    const opened = sessions.resolve(inbound(ALICE, "start", 1000));
    for (let i = 0; i < 50; i += 1)
      sessions.record(opened.id, {
        id: `p${i}`,
        room: ROOM_KEY,
        author: ALICE,
        text: `turn ${i}`,
        at: 1000 + i,
      });

    store.prune(10, 10);
    const counts = store.counts();
    expect(counts.messages).toBe(10);
    // The newest survive.
    expect(store.getMessage("p49")).toBeDefined();
    expect(store.getMessage("p0")).toBeUndefined();
  });

  it("opens a database that is not there yet", async () => {
    const place = await home();
    const store = HexStore.open(place.db);
    open.push(store);
    expect(store.counts()).toEqual({ messages: 0, sessions: 0 });
  });

  it("refuses to read a file that is not a database, rather than pretending", async () => {
    // Silent data loss is the failure this replaced; a clear throw at startup is
    // the acceptable one.
    const place = await home();
    await writeFile(place.db, "this is not sqlite", "utf8");
    expect(() => HexStore.open(place.db)).toThrow();
  });
});
