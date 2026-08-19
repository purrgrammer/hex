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

/** Turn one, over: the state a session sits in between questions. */
const FIRST_TURN = [
  ...TURN,
  { type: "session.waiting", data: {}, meta: { id: "evt_8" } },
];

/**
 * What a second question appends.
 *
 * Appended when the continue POST arrives, not served from the start — because
 * the whole question a follow-up asks is "which of these events are mine", and a
 * fake that has already published the answer before the question was asked
 * cannot pose it.
 */
const SECOND_TURN = [
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

/**
 * A turn that stops and asks, which ends exactly like one that answered.
 *
 * `session.waiting` carries the hardcoded literal `"next-user-message"` either
 * way, so nothing at this boundary distinguishes "finished" from "blocked on a
 * person" — the open request is the only thing that does.
 */
const ASKING_TURN = [
  { type: "turn.started", data: { turnId: "turn_0" }, meta: { id: "evt_1" } },
  {
    type: "input.requested",
    data: {
      requests: [
        {
          requestId: "req_1",
          prompt: "Which relay should I publish it to?",
          kind: "question",
          allowFreeform: true,
          options: [
            { id: "opt_a", label: "nos.lol" },
            { id: "opt_b", label: "relay.ditto.pub" },
          ],
        },
      ],
    },
    meta: { id: "evt_2" },
  },
  { type: "turn.completed", data: { turnId: "turn_0" }, meta: { id: "evt_3" } },
  { type: "session.waiting", data: {}, meta: { id: "evt_4" } },
];

function inbound(id: string, text: string, replyToId?: string): Inbound {
  return {
    id,
    author: PEER,
    text,
    replyToId,
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

/**
 * `tailIndex` is deliberately NOT the consumer's count of the same events.
 *
 * The real host's `x-eve-stream-tail-index` ran two below what a reader of the
 * same stream had counted, and a boundary taken from it ended a turn on the
 * previous turn's ending. Nothing may depend on this number agreeing with
 * anything; it is served wrong here on purpose so that a change which starts
 * trusting it fails.
 */
function fakeEve(
  events = TURN,
  tailIndex = 0,
  sessionId?: string,
  /** Appended when a message is sent, the way a real host answers one. */
  later: typeof TURN = [],
) {
  const posts: { path: string; body: unknown }[] = [];
  const encoder = new TextEncoder();
  const session = sessionId ?? `wrun_TEST_${(hostCounter += 1)}`;
  const stored = [...events];
  /** Every create mints a new id, as a real host does. */
  const created: string[] = [];

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      // Only a CONTINUE appends. Creating a session with the first message is
      // what produced the events already stored, and a cancel produces none.
      if (path.startsWith("/eve/v1/session/") && !path.endsWith("/cancel"))
        stored.push(...later);
      const isCreate = path === "/eve/v1/session";
      if (isCreate) created.push(session);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
          // The first create is the session everything else refers to; a second
          // one is a second session, and it must not be mistaken for the first.
          sessionId: created.length > 1 ? `${session}_${created.length}` : session,
        }),
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
        let at = Number(
          new URL(String(url)).searchParams.get("startIndex") ?? 0,
        );
        // A live tail: whatever is stored, then whatever arrives, until the
        // reader gives up. Ends only on an abort, as a real socket does — that
        // is what the pre-message read waits for silence to decide.
        const signal = init?.signal;
        while (!signal?.aborted) {
          if (at < stored.length) {
            yield encoder.encode(JSON.stringify(stored[at]) + "\n");
            at += 1;
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
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
      // The fake replays instantly; a real host would too. Kept short so the
      // suite does not sit through the production quiet window.
      drainQuietMs: 40,
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

  it("names the run after what was asked, not after the runtime's id", async () => {
    /**
     * The head's title was the runtime session id, so a client listing twenty
     * sessions showed twenty `wrun_…` strings and no way to tell which was
     * which. Only the FIRST message titles a run — a later one steers the same
     * conversation, and renaming a session mid-flight moves it under whoever is
     * reading the list.
     *
     * Taken from the stream's `message.received` rather than from the inbound
     * DM, because the stream is what the runtime actually received: a resumed
     * or steered session is titled by the same event either way.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, [
      { type: "turn.started", data: { turnId: "turn_1" }, meta: { id: "evt_9" } },
      {
        type: "message.received",
        data: { message: "now delete it", turnId: "turn_1" },
        meta: { id: "evt_9b" },
      },
      {
        type: "turn.completed",
        data: { turnId: "turn_1" },
        meta: { id: "evt_11" },
      },
    ]);
    const bus = transport();
    const { impl, sent } = sink();
    const hex = server(eve, bus, impl);

    await hex.handle(inbound("m1", "how many kinds are there?"));
    const first = sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(tag(first, "title")).toEqual(["title", "which relays serve 30166?"]);

    // A second message steers the same run. It must not rename it.
    await hex.handle(inbound("m2", "now delete it", "m1"));
    const later = sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(tag(later, "title")).toEqual(["title", "which relays serve 30166?"]);
  });

  it("says which protocol and which room the session is running in", async () => {
    /**
     * A transcript read later is read away from the conversation that produced
     * it, so "where did this happen" is not answerable from context. The room's
     * identifier is written in its own protocol's notation — a pubkey for a
     * NIP-17 conversation — so a client can act on it rather than parse a shape
     * invented here.
     */
    const eve = fakeEve();
    const bus = transport();
    const { impl, sent } = sink();
    await server(eve, bus, impl).handle(inbound("m1", "how many kinds?"));

    const head = sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(tag(head, "transport")).toEqual(["transport", "nip-17"]);
    expect(tag(head, "channel")).toEqual(["channel", PEER]);

    // Unindexed on purpose: a single-letter tag would let a relay group every
    // session an agent ever ran with one person, which is the association the
    // gift wrap exists to withhold.
    expect(head.tags.some((t) => t[0] === "t" || t[0] === "h")).toBe(false);
  });

  it("puts a parked run's question to the room, and reads the reply as its answer", async () => {
    /**
     * Two failures in one, and the first is the one nobody sees. A run that
     * stops to ask ends its turn like any other, so without this the
     * conversation just goes quiet — the agent waits indefinitely on a person
     * who was never told they were asked.
     *
     * The second is what happens when they do reply. Eve resolves a request
     * through `inputResponses` and NOTHING else: a plain `message` starts a new
     * turn and leaves the question standing, so the obvious thing to do — type
     * the answer into the room — is precisely the thing that does not work.
     */
    const eve = fakeEve(ASKING_TURN, 0, undefined, SECOND_TURN);
    const bus = transport();
    const { impl } = sink();
    const hex = server(eve, bus, impl);

    await hex.handle(inbound("m1", "publish my note"));

    // Asked out loud, with the options spelled out and a pointer to the session.
    const question = bus.replies.at(-1)!;
    expect(question.text).toContain("Which relay should I publish it to?");
    expect(question.text).toContain("nos.lol");
    expect(question.text).toContain(`31777:${AGENT}:`);

    // A reply to THAT message resolves the request rather than steering.
    await hex.handle(inbound("m2", "nos.lol", "reply-id"));

    const answered = eve.posts.filter(
      (post) =>
        typeof post.body === "object" &&
        post.body !== null &&
        "inputResponses" in post.body,
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]!.body).toEqual({
      inputResponses: [{ requestId: "req_1", text: "nos.lol" }],
    });

    // And it did NOT go in as a message, which would have steered the run.
    expect(
      eve.posts.some(
        (post) =>
          typeof post.body === "object" &&
          post.body !== null &&
          "message" in post.body &&
          (post.body as { message?: string }).message === "nos.lol",
      ),
    ).toBe(false);
  });

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
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const bus = transport();
    const out = sink();
    const server_ = server(eve, bus, out.impl);

    await server_.handle(inbound("msg-1", "first"));
    await server_.handle(inbound("msg-2", "second", "msg-1"));

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
    // the previous turn's and must not end this one — and the host reports 6,
    // as a real one does, which is the number that used to be believed.
    const eve = fakeEve(FIRST_TURN, 6, undefined, SECOND_TURN);
    const bus = transport();
    const server_ = server(eve, bus, sink().impl);

    await server_.handle(inbound("msg-1", "first"));
    await server_.handle(inbound("msg-2", "second", "msg-1"));

    expect(bus.replies.at(-1)?.text).toBe("and the second answer.");
  });

  it("does not end a turn on the previous turn's ending, replayed", async () => {
    /**
     * The live failure, in the shape Eve actually produced it.
     *
     * Resuming a session replays the previous turn's ending: a second
     * `turn.completed` for `turn_0` with a NEW event id, arriving after the
     * message was sent and before this turn starts. No index separates those —
     * they genuinely come later — so the follow ended on `turn_0`, and the
     * person who asked got a reaction and nothing else while the agent worked on.
     *
     * The turn id is the only thing that tells them apart.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, [
      // Eve says goodbye to turn_0 a second time, on the way in.
      {
        type: "turn.completed",
        data: { turnId: "turn_0" },
        meta: { id: "evt_replay_1" },
      },
      { type: "session.waiting", data: {}, meta: { id: "evt_replay_2" } },
      ...SECOND_TURN,
    ]);
    const bus = transport();
    const server_ = server(eve, bus, sink().impl);

    await server_.handle(inbound("msg-1", "first"));
    await server_.handle(inbound("msg-2", "second", "msg-1"));

    expect(bus.replies.at(-1)?.text).toBe("and the second answer.");
  });

  it("cancels the running turn when the same person writes again", async () => {
    /**
     * Seen live: writing while Hex was working produced `not answered:
     * interrupt` and nothing else — the gate said "abandon that and do this",
     * and nobody was listening. The message was simply lost.
     *
     * Eve steers on its own once a message reaches it, but it cannot reach it
     * while the turn that must be cancelled is still holding the queue, so the
     * cancel is asked for out of band first.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const bus = transport();
    const server_ = server(eve, bus, sink().impl);

    await server_.handle(inbound("msg-1", "first"));
    await server_.interrupt(inbound("msg-2", "never mind — this instead", "msg-1"));

    expect(eve.posts.map((post) => post.path)).toEqual([
      "/eve/v1/session",
      `/eve/v1/session/${eve.session}/cancel`,
      `/eve/v1/session/${eve.session}`,
    ]);
    expect(bus.replies.at(-1)?.text).toBe("and the second answer.");
  });

  it("starts a new session for a message that threads onto nothing", async () => {
    /**
     * One session per correspondent forever meant a new subject inherited an
     * hour of unrelated work, and the reader was handed one endless transcript
     * rather than one run per thing they asked for.
     *
     * The protocol says which it is: an `e` tag means "about this", and its
     * absence means a new subject.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);

    await server_.handle(inbound("msg-1", "first"));
    await server_.handle(inbound("msg-2", "an unrelated question"));

    // Two creates, no continue: the second message opened its own run.
    expect(eve.posts.map((post) => post.path)).toEqual([
      "/eve/v1/session",
      "/eve/v1/session",
    ]);
  });

  it("settles a head left saying active by a process that died", async () => {
    /**
     * Seen live: `serve` was killed mid-turn, the run carried on and finished,
     * and the head said `active` forever — a lie no reader can detect and one
     * that never expires. Only the reading stopped.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const first = server(eve, transport(), sink().impl);
    await first.handle(inbound("msg-1", "first"));

    // Rewind the cursor to mid-turn and reopen the head, the way a kill does.
    const record = store.transcriptFor(eve.session)!;
    store.saveTranscript({ ...record, status: "active", streamIndex: 3 });

    const out = sink();
    const resumed = server(eve, transport(), out.impl);
    await resumed.catchUp();

    expect(store.transcriptFor(eve.session)!.status).toBe("idle");
    // And it published the turns nobody had published, rather than silently
    // moving a cursor past them.
    expect(out.sent.some((rumor) => rumor.kind === 1777)).toBe(true);
  });

  it("carries each control verb to the route that serves it", async () => {
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.handle(inbound("msg-1", "first"));
    const before = eve.posts.length;

    // A reader knows the WIRE's session id — 32 random bytes — and never the
    // runtime's. Using the runtime's here would test a path no reader can take.
    const nostrId = store.transcriptFor(eve.session)!.nostrId;
    const base = { id: "", operator: PEER, agent: AGENT, session: nostrId };
    await server_.control({ ...base, id: "c1", command: "respond", request: "req_1", option: "approve" });
    await server_.control({ ...base, id: "c2", command: "steer", text: "do the other thing" });
    await server_.control({ ...base, id: "c3", command: "cancel", turn: "turn_0" });
    await server_.control({ ...base, id: "c4", command: "compact" });
    await server_.control({ ...base, id: "c5", command: "clear" });

    const sent = eve.posts.slice(before);
    expect(sent.map((post) => post.path)).toEqual([
      `/eve/v1/session/${eve.session}`,
      `/eve/v1/session/${eve.session}`,
      `/eve/v1/session/${eve.session}/cancel`,
      `/eve/v1/session/${eve.session}/compact`,
      `/eve/v1/session/${eve.session}/clear`,
    ]);
    // A response resolves the request it names and never steers; a message
    // steers and resolves nothing. Sending the wrong one is the whole bug this
    // shape exists to prevent.
    expect(sent[0]!.body).toEqual({
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    });
    expect(sent[1]!.body).toEqual({ message: "do the other thing" });
    expect(sent[2]!.body).toEqual({ turnId: "turn_0" });
  });

  it("refuses an instruction for a session it never published", async () => {
    /**
     * The two ids are the point. A reader can only know the published one, and a
     * control event naming something this agent never published is either a
     * stale instruction for a forgotten run or somebody guessing — either way
     * not a session id to hand to a runtime.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.handle(inbound("msg-1", "first"));
    const before = eve.posts.length;

    await server_.control({
      id: "c9",
      operator: PEER,
      agent: AGENT,
      session: "f".repeat(64),
      command: "cancel",
    });

    expect(eve.posts.slice(before)).toHaveLength(0);
  });

  it("obeys a redelivered command once", async () => {
    // Four relays hand over the same wrap four times. A `cancel` obeyed twice
    // stops a turn that had nothing to do with it.
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.handle(inbound("msg-1", "first"));
    const before = eve.posts.length;

    const twice = {
      id: "c1",
      operator: PEER,
      agent: AGENT,
      session: store.transcriptFor(eve.session)!.nostrId,
      command: "cancel" as const,
    };
    await server_.control(twice);
    await server_.control(twice);

    expect(eve.posts.slice(before)).toHaveLength(1);
  });

  it("publishes how the run was set up, once, addressed by session", async () => {
    /**
     * A standing definition says what the agent is in general and goes stale the
     * moment its config changes. This says what applied to THIS run, so a
     * transcript read next month still shows the prompt that produced it — and
     * it is its own event rather than head tags, because the head is republished
     * dozens of times a session and a prompt plus tool schemas is kilobytes.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const out = sink();
    const server_ = new EveServer({
      host: HOST,
      transport: transport(),
      reply: true,
      fetchImpl: eve.impl,
      drainQuietMs: 40,
      describe: async () => ({
        name: "Hex",
        instructions: "You are Hex.",
        tools: [{ name: "chat_respond", description: "Speak." }],
      }),
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        sink: out.impl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    });

    await server_.handle(inbound("msg-1", "first"));
    await server_.handle(inbound("msg-2", "second", "msg-1"));

    const definitions = out.sent.filter((rumor) => rumor.kind === 31779);
    // Once, not once per turn: a snapshot that kept up with its subject would
    // not be one.
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.content).toBe("You are Hex.");
    expect(
      definitions[0]!.tags.filter((t) => t[0] === "tool").map((t) => t[1]),
    ).toEqual(["chat_respond"]);

    // The `d` is the session, and the head points at exactly that address.
    const d = definitions[0]!.tags.find((t) => t[0] === "d")![1]!;
    const head = out.sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(head.tags.find((t) => t[0] === "agent")?.[1]).toBe(
      `31779:${AGENT}:${d}`,
    );
  });

  it("picks up the conversation a previous process was having", async () => {
    /**
     * Seen live: `serve` restarted, the peer-to-session map was in memory, and the
     * next message opened a NEW session. The person's history was gone, the old
     * session sat idle forever with nobody to close it, and the reader was shown
     * two unrelated runs for one conversation.
     */
    const first = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    await server(first, transport(), sink().impl).handle(
      inbound("msg-1", "first"),
    );
    expect(first.posts.map((p) => p.path)).toEqual(["/eve/v1/session"]);

    // A new server over the same store, serving the same session: a different
    // process, same disk, same Eve.
    const second = fakeEve(FIRST_TURN, 8, first.session, SECOND_TURN);
    await server(second, transport(), sink().impl).handle(
      inbound("msg-2", "second", "msg-1"),
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
