import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EveServer } from "../eve/serve.js";
import type { RumorSink } from "../eve/transcript.js";
import type { Rumor } from "../nostr/types.js";
import type { Inbound } from "../transports/types.js";
import { HexStore, agentHome } from "../store.js";

const AGENT = "9".repeat(64);
const PEER = "1".repeat(64);
const HOST = "http://127.0.0.1:2000";

/** One Eve turn, in the order a running `eve dev` actually emits it. */
const TURN = [
  { type: "session.started", data: {}, meta: { id: "evt_1" } },
  { type: "turn.started", data: { turnId: "turn_0" }, meta: { id: "evt_2" } },
  {
    type: "message.received",
    data: { message: "which relays serve 30166?", turnId: "turn_0" },
    meta: { id: "evt_3" },
  },
  {
    type: "step.started",
    data: { modelId: "ppq/moonshotai/kimi-k3", stepIndex: 0 },
    meta: { id: "evt_4" },
  },
  {
    type: "message.completed",
    data: { message: "41 of them.", finishReason: "stop", stepIndex: 0 },
    meta: { id: "evt_5" },
  },
  {
    type: "step.completed",
    data: { finishReason: "stop", stepIndex: 0, turnId: "turn_0" },
    meta: { id: "evt_6" },
  },
  { type: "turn.completed", data: { turnId: "turn_0" }, meta: { id: "evt_7" } },
];

/**
 * The same session after a second question.
 *
 * A real host keeps appending, so a follow-up has new events to read. A fake that
 * served only the first turn would leave the second follow waiting on a stream
 * that never says anything again — which is a fault in the fake, not the code.
 */
const TWO_TURNS = [
  ...TURN,
  { type: "session.waiting", data: {}, meta: { id: "evt_8" } },
  { type: "turn.started", data: { turnId: "turn_1" }, meta: { id: "evt_9" } },
  {
    type: "message.completed",
    data: {
      message: "and the second answer.",
      finishReason: "stop",
      stepIndex: 0,
    },
    meta: { id: "evt_10" },
  },
  {
    type: "turn.completed",
    data: { turnId: "turn_1" },
    meta: { id: "evt_11" },
  },
];

function inbound(id: string, text: string): Inbound {
  return {
    id,
    author: PEER,
    text,
    createdAt: 1000,
    room: { transport: "nip-17", id: PEER },
    addressesSelf: true,
    event: {
      id,
      pubkey: PEER,
      created_at: 1000,
      kind: 1059,
      tags: [],
      content: "",
      sig: "",
    },
  } as unknown as Inbound;
}

/** A fake Eve: one POST to start or continue, one NDJSON stream to read. */
/** Distinct per fake host: two of them are two different Eves, not one. */
let hostCounter = 0;

function fakeEve(events = TURN, tailIndex = 0, sessionId?: string) {
  const posts: { path: string; body: unknown }[] = [];
  const encoder = new TextEncoder();
  const session = sessionId ?? `wrun_TEST_${(hostCounter += 1)}`;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, sessionId: session }),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "x-eve-stream-tail-index": String(tailIndex) }),
      body: (async function* () {
        // Honour `startIndex`, as a real host does: the consumer numbers what it
        // reads from that offset, so serving from the beginning every time would
        // label the events wrongly and mask exactly the bug under test.
        const start = Number(
          new URL(String(url)).searchParams.get("startIndex") ?? 0,
        );
        for (const event of events.slice(start))
          yield encoder.encode(JSON.stringify(event) + "\n");
        // A live follow never ends on its own; the server stops at the turn
        // boundary, and hanging here is what proves it.
        await new Promise(() => {});
      })(),
    };
  }) as unknown as typeof fetch;

  return { impl, posts, session };
}

function sink() {
  const sent: Rumor[] = [];
  const impl: RumorSink = {
    publishRumor: async (rumor) => {
      sent.push(rumor);
      return { delivered: [PEER], undeliverable: [] };
    },
  };
  return { impl, sent };
}

function transport() {
  const replies: { to: string; text: string; tags?: string[][] }[] = [];
  const reactions: { to: string; emoji: string }[] = [];
  return {
    replies,
    reactions,
    reply: async (to: Inbound, text: string, tags?: string[][]) => {
      replies.push({ to: to.id, text, tags });
      return "reply-id";
    },
    react: async (to: Inbound, emoji: string) => {
      reactions.push({ to: to.id, emoji });
      return "reaction-id";
    },
  };
}

const tag = (rumor: Rumor, name: string) =>
  rumor.tags.find((t) => t[0] === name);

describe("EveServer", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eve-serve-"));
    store = HexStore.open(agentHome(home, AGENT).db);
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  function server(
    eve: ReturnType<typeof fakeEve>,
    bus: ReturnType<typeof transport>,
    sinkImpl: RumorSink,
    reply = true,
  ) {
    return new EveServer({
      host: HOST,
      transport: bus,
      reply,
      fetchImpl: eve.impl,
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        sink: sinkImpl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    });
  }

  it("names the message that started the session on the head", async () => {
    // This is the link the whole design rests on: the SESSION points at the
    // message, so a client holding a conversation can ask what a message set
    // running instead of the answer having to carry a pointer back.
    const eve = fakeEve();
    const bus = transport();
    const out = sink();
    const server_ = server(eve, bus, out.impl);

    await server_.handle(inbound("msg-1", "which relays serve 30166?"));

    const heads = out.sent.filter((rumor) => rumor.kind === 31777);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads)
      expect(tag(head, "e")).toEqual(["e", "msg-1", "", "trigger"]);
  });

  it("publishes the turn and stops at the turn boundary", async () => {
    const eve = fakeEve();
    const bus = transport();
    const out = sink();
    const server_ = server(eve, bus, out.impl);

    await server_.handle(inbound("msg-1", "which relays serve 30166?"));

    const turns = out.sent.filter((rumor) => rumor.kind === 1777);
    expect(turns.map((t) => tag(t, "role")?.[1])).toEqual([
      "user",
      "assistant",
    ]);
    // The stream hangs after the last event, so returning at all proves the
    // server stopped on `turn.completed` rather than waiting for an end that
    // never comes.
    expect(eve.posts[0]?.path).toBe("/eve/v1/session");
  });

  it("answers in the conversation, and can be told not to", async () => {
    // A DM is a conversation. One that goes quiet while something invisible
    // happens elsewhere reads as broken to everyone whose client knows nothing
    // about transcripts — so the reply is the default and the session is what
    // makes it checkable.
    const eve = fakeEve();
    const bus = transport();
    await server(eve, bus, sink().impl).handle(inbound("msg-1", "hello"));
    expect(bus.replies).toEqual([
      { to: "msg-1", text: "41 of them.", tags: undefined },
    ]);

    // A second correspondent, so this is a fresh conversation rather than a
    // follow-up with nothing new to read.
    const eve2 = fakeEve();
    const bus2 = transport();
    await server(eve2, bus2, sink().impl, false).handle({
      ...inbound("msg-2", "hello"),
      author: "2".repeat(64),
      room: { transport: "nip-17", id: "2".repeat(64) },
    } as unknown as Inbound);
    expect(bus2.replies).toHaveLength(0);
  });

  it("acknowledges the message before doing anything slow", async () => {
    // A model takes seconds and a tool can take minutes; without this there is no
    // difference a reader can see between "working on it" and "ignored you".
    const eve = fakeEve();
    const bus = transport();
    await server(eve, bus, sink().impl).handle(inbound("msg-1", "hello"));
    expect(bus.reactions).toEqual([{ to: "msg-1", emoji: "👀" }]);
  });

  it("continues one session for a follow-up rather than starting another", async () => {
    const eve = fakeEve(TWO_TURNS, 8);
    const bus = transport();
    const out = sink();
    const server_ = server(eve, bus, out.impl);

    await server_.handle(inbound("msg-1", "first"));
    await server_.handle(inbound("msg-2", "second"));

    expect(eve.posts.map((p) => p.path)).toEqual([
      "/eve/v1/session",
      `/eve/v1/session/${eve.session}`,
    ]);
    // And the trigger stays the message that OPENED the session: a head names
    // what set the run going, not the latest thing said to it.
    const head = out.sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(tag(head, "e")).toEqual(["e", "msg-1", "", "trigger"]);
  });

  it("answers a follow-up, rather than stopping on the last turn's ending", async () => {
    /**
     * The bug this closes, seen live: a follow-up resumed from the durable cursor,
     * replayed the tail of the previous turn — `session.waiting` included — and
     * ended instantly with "produced no answer to send", because a terminal event
     * from the turn before is indistinguishable from one for this turn.
     *
     * The stream here replays turn one and then serves turn two, and the tail index
     * says where turn one ended.
     */
    // Turn one ends at index 8 (`session.waiting`), so everything up to there is
    // the previous turn's and must not end this one.
    const eve = fakeEve(TWO_TURNS, 8);
    const bus = transport();
    const server_ = server(eve, bus, sink().impl);

    await server_.handle(inbound("msg-1", "first"));
    await server_.handle(inbound("msg-2", "second"));

    expect(bus.replies.at(-1)?.text).toBe("and the second answer.");
  });

  it("picks up the conversation a previous process was having", async () => {
    /**
     * Seen live: `serve` restarted, the peer-to-session map was in memory, and the
     * next message opened a NEW session. The person's history was gone, the old
     * session sat idle forever with nobody to close it, and the reader was shown
     * two unrelated runs for one conversation.
     */
    const first = fakeEve(TWO_TURNS, 8);
    await server(first, transport(), sink().impl).handle(
      inbound("msg-1", "first"),
    );
    expect(first.posts.map((p) => p.path)).toEqual(["/eve/v1/session"]);

    // A new server over the same store, serving the same session: a different
    // process, same disk, same Eve.
    const second = fakeEve(TWO_TURNS, 8, first.session);
    await server(second, transport(), sink().impl).handle(
      inbound("msg-2", "second"),
    );
    expect(second.posts.map((p) => p.path)).toEqual([
      `/eve/v1/session/${first.session}`,
    ]);
  });

  it("reports a failed turn instead of going quiet", async () => {
    const eve = fakeEve([
      { type: "session.started", data: {}, meta: { id: "evt_1" } },
      {
        type: "turn.started",
        data: { turnId: "turn_0" },
        meta: { id: "evt_2" },
      },
      {
        type: "turn.failed",
        data: { message: "the model refused", turnId: "turn_0" },
        meta: { id: "evt_3" },
      },
    ]);
    const bus = transport();
    const out = sink();

    await server(eve, bus, out.impl, true).handle(inbound("msg-1", "hello"));

    expect(bus.replies[0]?.text).toContain("the model refused");
  });
});
