import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";

import { EveServer } from "../eve/serve.js";
import { Ingestor, settleControl, type ControlPayload } from "../ingest.js";
import { Runner } from "../runner.js";
import { EveRuntime } from "../runtime/eve.js";
import type { RumorSink } from "../eve/transcript.js";
import type { Rumor } from "../nostr/types.js";
import type { Inbound } from "../transports/types.js";
import { HexStore, agentHome } from "../store.js";

/** One lease per store: every transcript save is fenced on its generation. */
const generations = new WeakMap<HexStore, number>();
function fenceFor(store: HexStore): { generation: number } {
  let generation = generations.get(store);
  if (generation === undefined) {
    generation = store.acquireWriterLease({ takeover: true }).generation;
    generations.set(store, generation);
  }
  return { generation };
}

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
  /**
   * Append on a `cancel` too, which a real host does — `turn.cancelled` and the
   * `session.waiting` after it are the whole result of a stop. Off by default
   * because most tests hand `later` a whole extra TURN, and a stop does not
   * produce one of those.
   */
  cancelAppends = false,
) {
  const posts: { path: string; body: unknown }[] = [];
  const encoder = new TextEncoder();
  const session = sessionId ?? `wrun_TEST_${(hostCounter += 1)}`;
  const stored = [...events];
  /** Every create mints a new id, as a real host does. */
  const created: string[] = [];
  /** Set to refuse the next POST, the way a host that is down refuses one. */
  const state = { failNext: false };

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST") {
      if (state.failNext) {
        state.failNext = false;
        return { ok: false, status: 503, statusText: "Service Unavailable" };
      }
      posts.push({ path, body: JSON.parse(String(init.body)) });
      // Only a CONTINUE appends. Creating a session with the first message is
      // what produced the events already stored, and a cancel produces none.
      if (
        path.startsWith("/eve/v1/session/") &&
        (cancelAppends || !path.endsWith("/cancel"))
      )
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
          sessionId:
            created.length > 1 ? `${session}_${created.length}` : session,
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

  return {
    impl,
    posts,
    session,
    set failNext(value: boolean) {
      state.failNext = value;
    },
  };
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

function transport(options: { failing?: boolean } = {}) {
  const replies: { to: string; text: string; tags?: string[][] }[] = [];
  const reactions: { to: string; emoji: string }[] = [];
  return {
    replies,
    reactions,
    // Failing is a relay that will not take the event: the answer exists, the
    // turn is paid for, and there is nowhere for it to go.
    reply: async (to: Inbound, text: string, tags?: string[][]) => {
      if (options.failing) throw new Error("no relay took the reply");
      replies.push({ to: to.id, text, tags });
      return "reply-id";
    },
    react: async (to: Inbound, emoji: string) => {
      if (options.failing) throw new Error("no relay took the reaction");
      reactions.push({ to: to.id, emoji });
      return "reaction-id";
    },
  };
}

/** Poll until it is true, or give up loudly rather than hang the suite. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("gave up waiting for the queue");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  /**
   * Rewind a session's cursor the way a kill does: the row on disk lags because
   * the batched save never happened. `saveTranscript` now refuses to walk a
   * cursor backwards — which is the point — so the lagging row is written raw.
   */
  function rewindOnDisk(sessionId: string, streamIndex: number) {
    const raw = new DatabaseSync(agentHome(home, AGENT).db);
    raw
      .prepare(
        `UPDATE transcripts SET status = 'active', stream_index = ? WHERE session_id = ?`,
      )
      .run(streamIndex, sessionId);
    raw.close();
  }

  function server(
    eve: ReturnType<typeof fakeEve>,
    bus: ReturnType<typeof transport>,
    sinkImpl: RumorSink,
    reply = true,
  ) {
    return new EveServer({
      runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
      transport: bus,
      reply,
      /**
       * Short of the production window, long enough to survive a busy machine.
       *
       * At 40ms this was flaky: the drain ends on SILENCE, and when two dozen
       * test files run at once the event loop can starve the fake's replay for
       * longer than the window, so the read gives up before the first event and
       * the verb under test never posts. A flaky suite is worse than a slow one
       * — it is the thing that decides whether a proposal gets merged.
       */
      drainQuietMs: 250,
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        fence: fenceFor(store),
        sink: sinkImpl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    });
  }

  /**
   * The daemon's own wiring: the queue, and the runner that drains it.
   *
   * Built here rather than mocked because what is under test is the ORDER two
   * dispatches reach one session in, and only the real pair produces it.
   */
  function runnerFor(
    hex: EveServer,
    options: { generation?: number; settle?: boolean } = {},
  ) {
    const generation = options.generation ?? fenceFor(store).generation;
    const ingest: Ingestor = new Ingestor({
      store,
      dispatch: (queued) => runner.offer(queued),
    });
    const runner = new Runner({
      store,
      // `settle: false` is a process that died before it could write done_at.
      queue: options.settle === false ? { finish: () => {} } : ingest,
      target: hex,
      generation,
      selfPubkey: AGENT,
      // Nothing here is backfill, and the limit is not what is under test.
      startedAt: 0,
      repliesPerRoomPerHour: 100,
    });
    return {
      ingest,
      generation,
      /** Wait for every row to be settled, one way or the other. */
      quiet: (seqs: number[]) =>
        until(() =>
          seqs.every((seq) => store.inboundOutcome(seq) !== undefined),
        ),
    };
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
      {
        type: "turn.started",
        data: { turnId: "turn_1" },
        meta: { id: "evt_9" },
      },
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

    await hex.runTurn(inbound("m1", "how many kinds are there?"));
    const first = sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(tag(first, "title")).toEqual(["title", "which relays serve 30166?"]);

    // A second message steers the same run. It must not rename it.
    await hex.runTurn(inbound("m2", "now delete it", "m1"));
    const later = sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(tag(later, "title")).toEqual(["title", "which relays serve 30166?"]);
  });

  it("gives a steered turn a room, so what it produces can be said", async () => {
    /**
     * A steer runs a real turn with real tools, and the tool host was bound in
     * the DM path ONLY — so every `chat_respond` from an operator-started turn
     * came back "this session has no room bound to it". The agent worked,
     * reasoned, built its answer and could not speak it: silent, and
     * indistinguishable from an agent with nothing to add.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const bus = transport();
    const { impl } = sink();
    const bound: string[] = [];

    const hex = new EveServer({
      runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
      transport: bus,
      drainQuietMs: 250,
      tools: {
        bridge: {
          bind: (sessionId: string) => bound.push(sessionId),
          release: () => {},
        } as never,
        host: () => ({}) as never,
      },
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        fence: fenceFor(store),
        sink: impl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    });

    await hex.runTurn(inbound("m1", "how many kinds?"));
    const before = bound.length;

    const head = (await hex.runTurn(inbound("m2", "again", "m1")), undefined);
    void head;

    await hex.applyControl({
      id: "ctl_1",
      session: store.transcriptFor(eve.session)!.nostrId,
      operator: PEER,
      command: "steer",
      text: "now do the other thing",
    } as never);

    // The room was bound again for the turn the operator started.
    expect(bound.length).toBeGreaterThan(before);
    expect(bound.at(-1)).toBe(eve.session);
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
    await server(eve, bus, impl).runTurn(inbound("m1", "how many kinds?"));

    const head = sent.filter((rumor) => rumor.kind === 31777).at(-1)!;
    expect(tag(head, "transport")).toEqual(["transport", "nip-17"]);
    expect(tag(head, "channel")).toEqual(["channel", PEER]);

    /**
     * Unindexed on purpose: a single-letter tag would let a relay group every
     * session an agent ever ran with one person, which is the association the
     * gift wrap exists to withhold.
     *
     * A NIP-29 run is the one exception and it is not one really — its `h` tag
     * names the ROOM, not the correspondent, on a relay where the room is the
     * one thing that is already public. This is a NIP-17 run, so there is none.
     */
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

    await hex.runTurn(inbound("m1", "publish my note"));

    // Asked out loud, with the options spelled out and a pointer to the session.
    const question = bus.replies.at(-1)!;
    expect(question.text).toContain("Which relay should I publish it to?");
    expect(question.text).toContain("nos.lol");
    // As a NIP-21 pointer, not the bare coordinate: a client has to be able to
    // open it, which is the only reason it is in the message at all.
    const pointer = question.text.match(/nostr:(naddr1[0-9a-z]+)/)?.[1];
    expect(pointer).toBeDefined();
    expect(nip19.decode(pointer!).data).toMatchObject({
      kind: 31777,
      pubkey: AGENT,
    });

    // A reply to THAT message resolves the request rather than steering.
    await hex.runTurn(inbound("m2", "nos.lol", "reply-id"));

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

  it("closes a question the runtime took an answer for and never resolved", async () => {
    /**
     * Eve is supposed to answer an `inputResponses` post with `input.resolved`.
     * A request raised after its turn was already finalised is never parked, so
     * the answer arrives against no pending batch: the model reads it as
     * ordinary text and carries on, and nothing ever closes the request. The
     * head then says `awaiting-input` for a question settled minutes ago, and
     * every client renders a live prompt over a decision already made.
     *
     * `SECOND_TURN` is exactly that stream — a turn that runs and completes
     * with no resolution in it.
     */
    const eve = fakeEve(ASKING_TURN, 0, undefined, SECOND_TURN);
    const out = sink();
    const hex = server(eve, transport(), out.impl);

    await hex.runTurn(inbound("m1", "publish my note"));

    const parked = store.transcriptFor(eve.session)!;
    expect(parked.pending).toEqual(["req_1"]);
    expect(parked.status).toBe("awaiting-input");

    await hex.applyControl({
      id: "c1",
      operator: PEER,
      agent: AGENT,
      session: parked.nostrId,
      command: "respond",
      request: "req_1",
      option: "opt_a",
    });

    // Said in the transcript, with what was actually answered — a reader coming
    // back to this later sees the decision, not a prompt.
    const resolved = out.sent.filter(
      (rumor) =>
        rumor.kind === 1777 && rumor.content.includes('"input_resolved"'),
    );
    expect(resolved).toHaveLength(1);
    expect(JSON.parse(resolved[0]!.content)).toContainEqual(
      expect.objectContaining({
        type: "input_resolved",
        requestId: "req_1",
        response: { optionId: "opt_a" },
      }),
    );

    // And the head stops waiting on somebody who already answered.
    const after = store.transcriptFor(eve.session)!;
    expect(after.pending).toBeUndefined();
    expect(after.status).not.toBe("awaiting-input");
  });

  it("closes the questions a stop leaves behind", async () => {
    /**
     * A stopped run is not a waiting one. The turn that would read the answer
     * is gone, so the question it asked can never be resolved — and left open
     * the head goes on saying `awaiting-input` forever, offering buttons that
     * do nothing to whoever opens the session next.
     */
    const eve = fakeEve(ASKING_TURN, 0, undefined, SECOND_TURN);
    const out = sink();
    const hex = server(eve, transport(), out.impl);

    await hex.runTurn(inbound("m1", "publish my note"));
    const parked = store.transcriptFor(eve.session)!;
    expect(parked.pending).toEqual(["req_1"]);

    await hex.applyControl({
      id: "c1",
      operator: PEER,
      agent: AGENT,
      session: parked.nostrId,
      command: "cancel",
    });

    // Recorded rather than dropped, and with an outcome that says the question
    // was stopped rather than answered.
    const resolved = out.sent.filter(
      (rumor) =>
        rumor.kind === 1777 && rumor.content.includes('"input_resolved"'),
    );
    expect(resolved).toHaveLength(1);
    expect(JSON.parse(resolved.at(-1)!.content)).toContainEqual(
      expect.objectContaining({
        type: "input_resolved",
        requestId: "req_1",
        outcome: "cancelled",
      }),
    );

    const after = store.transcriptFor(eve.session)!;
    expect(after.pending).toBeUndefined();
    expect(after.status).not.toBe("awaiting-input");
  });

  it("does not publish one session's turns twice when two commands arrive", async () => {
    /**
     * A control event builds a reader over the session it names. Two arriving
     * together each built their own, from the same stored cursor, and each
     * published everything between it and the tail: the session got those turns
     * twice, under the same `seq`, from two writers that could not see each
     * other. One reader per session, one command at a time.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const out = sink();
    const hex = server(eve, transport(), out.impl);

    await hex.runTurn(inbound("m1", "first"));
    const record = store.transcriptFor(eve.session)!;
    const before = out.sent.length;

    const base = {
      operator: PEER,
      agent: AGENT,
      session: record.nostrId,
      command: "steer" as const,
    };
    // Through the queue, the way a relay hands two instructions over at once.
    // The runner's lane is what keeps them apart now: `EveServer` serialises
    // nothing of its own any more.
    const lane = runnerFor(hex);
    const seqs = [
      lane.ingest.acceptControl({ ...base, id: "c1", text: "do this" })!,
      lane.ingest.acceptControl({ ...base, id: "c2", text: "and this" })!,
    ];
    await lane.quiet(seqs);

    const turns = out.sent
      .slice(before)
      .filter((rumor) => rumor.kind === 1777)
      .map((rumor) => tag(rumor, "seq")?.[1]);
    expect(turns).toEqual([...new Set(turns)]);
  });

  it("names the message that started the session on the head", async () => {
    // This is the link the whole design rests on: the SESSION points at the
    // message, so a client holding a conversation can ask what a message set
    // running instead of the answer having to carry a pointer back.
    const eve = fakeEve();
    const bus = transport();
    const out = sink();
    const server_ = server(eve, bus, out.impl);

    await server_.runTurn(inbound("msg-1", "which relays serve 30166?"));

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

    await server_.runTurn(inbound("msg-1", "which relays serve 30166?"));

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
    await server(eve, bus, sink().impl).runTurn(inbound("msg-1", "hello"));
    expect(bus.replies).toEqual([
      { to: "msg-1", text: "41 of them.", tags: undefined },
    ]);

    // A second correspondent, so this is a fresh conversation rather than a
    // follow-up with nothing new to read.
    const eve2 = fakeEve();
    const bus2 = transport();
    await server(eve2, bus2, sink().impl, false).runTurn({
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
    await server(eve, bus, sink().impl).runTurn(inbound("msg-1", "hello"));
    expect(bus.reactions).toEqual([{ to: "msg-1", emoji: "👀" }]);
  });

  it("continues one session for a follow-up rather than starting another", async () => {
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const bus = transport();
    const out = sink();
    const server_ = server(eve, bus, out.impl);

    await server_.runTurn(inbound("msg-1", "first"));
    await server_.runTurn(inbound("msg-2", "second", "msg-1"));

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

    await server_.runTurn(inbound("msg-1", "first"));
    await server_.runTurn(inbound("msg-2", "second", "msg-1"));

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

    await server_.runTurn(inbound("msg-1", "first"));
    await server_.runTurn(inbound("msg-2", "second", "msg-1"));

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

    await server_.runTurn(inbound("msg-1", "first"));
    /**
     * Two calls, in the runner's order: the stop is asked for out of band, and
     * the turn that takes over is started only once the abandoned one has
     * returned. Here that is the same tick; under the runner it is a wait.
     */
    const second = inbound("msg-2", "never mind — this instead", "msg-1");
    await server_.abandon(second);
    await server_.runTurn(second);

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

    await server_.runTurn(inbound("msg-1", "first"));
    await server_.runTurn(inbound("msg-2", "an unrelated question"));

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
    await first.runTurn(inbound("msg-1", "first"));

    // Rewind the cursor to mid-turn and reopen the head, the way a kill does.
    rewindOnDisk(eve.session, 3);

    const out = sink();
    const resumed = server(eve, transport(), out.impl);
    await resumed.catchUp();

    expect(store.transcriptFor(eve.session)!.status).toBe("idle");
    // And it published the turns nobody had published, rather than silently
    // moving a cursor past them.
    expect(out.sent.some((rumor) => rumor.kind === 1777)).toBe(true);
  });

  it("refuses a control event a previous process already carried out", async () => {
    /**
     * The load-bearing one, and it was watched happening. The DM read floor is
     * two days below the start time — NIP-59 randomises a wrap's timestamp
     * backwards, so a strict floor drops messages sent now — which means every
     * restart is handed the whole two-day window again. An in-memory guard has
     * forgotten all of it, so a stop the operator pressed an hour before the
     * restart was pressed again on whatever was running after it.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const first = server(eve, transport(), sink().impl);
    await first.runTurn(inbound("msg-1", "first"));
    const nostrId = store.transcriptFor(eve.session)!.nostrId;
    const stop = {
      id: "c-stop",
      operator: PEER,
      agent: AGENT,
      session: nostrId,
      command: "cancel" as const,
    };

    const before = eve.posts.length;
    await first.applyControl(stop);
    const after = eve.posts.length;
    // The first one has to have LANDED, or this test passes for the wrong
    // reason — two refusals also leave the count unchanged.
    expect(after).toBe(before + 1);

    // A different process, reading the same home and the same relay window.
    store.close();
    store = HexStore.open(agentHome(home, AGENT).db);
    const second = server(eve, transport(), sink().impl);
    await second.applyControl(stop);

    expect(eve.posts.length).toBe(after);
  });

  it("retries a control event whose runtime was down, rather than dropping it", async () => {
    // The other side of marking on success: an instruction that never landed is
    // not an instruction that was carried out, and the next relay's redelivery
    // is its retry.
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.runTurn(inbound("msg-1", "first"));
    const nostrId = store.transcriptFor(eve.session)!.nostrId;
    const stop = {
      id: "c-stop",
      operator: PEER,
      agent: AGENT,
      session: nostrId,
      command: "cancel" as const,
    };

    eve.failNext = true;
    await server_.applyControl(stop);
    expect(store.wasObeyed("c-stop")).toBe(false);

    // A second process, so the in-memory guard is not what lets it through.
    const retry = server(eve, transport(), sink().impl);
    const before = eve.posts.length;
    await retry.applyControl(stop);
    expect(eve.posts.length).toBe(before + 1);
  });

  it("takes no instructions for a run that already ended", async () => {
    /**
     * The scope rule at the granularity this side can be trusted at. Terminal
     * is the only status that cannot be stale in the dangerous direction —
     * `idle` can be, because the mirror updates on a drain, so refusing a stop
     * on that basis would refuse the instruction that most needs to land.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.runTurn(inbound("msg-1", "first"));
    const record = store.transcriptFor(eve.session)!;
    store.saveTranscript({ ...record, status: "aborted" }, fenceFor(store));
    const before = eve.posts.length;

    const base = {
      operator: PEER,
      agent: AGENT,
      session: record.nostrId,
    };
    await server_.applyControl({ ...base, id: "c1", command: "cancel" });
    await server_.applyControl({ ...base, id: "c2", command: "compact" });
    await server_.applyControl({
      ...base,
      id: "c3",
      command: "steer",
      text: "more",
    });

    expect(eve.posts.length).toBe(before);
    // And a refusal computed from a local mirror stays open to reconsidering.
    expect(store.wasObeyed("c1")).toBe(false);
  });

  it("ignores an answer to a question the run is not waiting on", async () => {
    // A redelivered `respond` for a request Eve has already closed would be
    // posted as a second answer to a settled question.
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.runTurn(inbound("msg-1", "first"));
    const nostrId = store.transcriptFor(eve.session)!.nostrId;
    const before = eve.posts.length;

    await server_.applyControl({
      id: "c1",
      operator: PEER,
      agent: AGENT,
      session: nostrId,
      command: "respond",
      request: "req_gone",
      option: "approve",
    });

    expect(eve.posts.length).toBe(before);
  });

  it("gives a caught-up run its room back, in the protocol it was in", async () => {
    /**
     * The live failure, and an expensive one. The bridge binds tool hosts in
     * memory, so a restart left every run it picked up with no room — and a
     * host with no room offers no `chat.*`. The model finished its work,
     * reached for `chat.respond`, was told there is no such tool, and having no
     * way to report the result DID THE WORK AGAIN: the same patch published
     * twice, ninety-nine seconds apart.
     *
     * The second half matters as much. Binding used to hardcode a NIP-17 room,
     * so a group run rebound after a restart would have answered one person
     * privately instead of the room that asked.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const bound: {
      session: string;
      room?: { transport: string; id?: string };
    }[] = [];
    const tools = {
      bridge: { bind: () => {}, release: () => {} } as never,
      host: (incoming?: Inbound) => {
        bound.push({ session: "", room: incoming?.room });
        return {} as never;
      },
    };

    const options = () => ({
      runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
      transport: transport(),
      drainQuietMs: 250,
      tools,
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        fence: fenceFor(store),
        sink: sink().impl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    });

    await new EveServer(options()).runTurn({
      ...inbound("msg-group", "first"),
      room: {
        transport: "nip-29",
        id: "GROUPID",
        relay: "wss://groups.example",
      },
    });

    // Reopen the run the way a kill does, then catch it up in a new process.
    rewindOnDisk(eve.session, 3);
    bound.length = 0;
    await new EveServer(options()).catchUp();

    // A room, and the RIGHT room.
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.at(-1)!.room).toEqual({
      transport: "nip-29",
      id: "GROUPID",
      relay: "wss://groups.example",
    });
  });

  it("gives one person two conversations when they are in two rooms", async () => {
    /**
     * Watched happen. A long DM run was going; the same person asked something
     * in a NIP-29 group eight minutes later; the group message was accepted and
     * then nothing. It had queued behind the DM — the queue and the session map
     * were both keyed on the AUTHOR — and would have continued the DM's session
     * and answered in the wrong place once it got there.
     *
     * A person is not a conversation. A person in a room is.
     */
    const dm = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = new EveServer({
      runtime: new EveRuntime({ host: HOST, fetchImpl: dm.impl }),
      transport: transport(),
      drainQuietMs: 250,
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        fence: fenceFor(store),
        sink: sink().impl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    });

    await server_.runTurn(inbound("msg-dm", "in a direct message"));
    await server_.runTurn({
      ...inbound("msg-group", "in a group"),
      room: {
        transport: "nip-29",
        id: "GROUPID",
        relay: "wss://groups.example",
      },
    });

    // Two sessions, not one continued: the fake mints a new id per create, so
    // a second `POST /eve/v1/session` is the observable difference.
    const created = dm.posts.filter((p) => p.path === "/eve/v1/session");
    expect(created).toHaveLength(2);

    // And each is remembered against its own room.
    expect(store.conversationFor(PEER, "nip-17|" + PEER)).toBeTruthy();
    expect(
      store.conversationFor(PEER, "nip-29|wss://groups.example|GROUPID"),
    ).toBeTruthy();
    expect(store.conversationFor(PEER, "nip-17|" + PEER)).not.toBe(
      store.conversationFor(PEER, "nip-29|wss://groups.example|GROUPID"),
    );
  });

  it("files a run in its group, and leaves every other run wrapped", async () => {
    /**
     * The room decides, and the GROUP RELAY decides who may read it. That is
     * the whole reason there is no config gate here: the group's own access
     * control is the decision, and asking an operator to make it a second time
     * in a config file lets the two answers disagree.
     */
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const bus = transport();

    const open = (room?: { transport: string; id: string; relay?: string }) =>
      new EveServer({
        runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
        transport: bus,
        drainQuietMs: 250,
        transcript: {
          agentPubkey: AGENT,
          slug: "hex",
          recipients: [PEER],
          store,
          fence: fenceFor(store),
          sink: sink().impl,
          setTimer: () => 0,
          clearTimer: () => {},
        },
      }).runTurn({
        ...inbound("msg-" + (room?.id ?? "dm"), "first"),
        ...(room ? { room } : {}),
      } as Inbound);

    // A NIP-17 conversation has no group and no second reader.
    await open();
    expect(store.transcriptFor(eve.session)!.carriage).toBeUndefined();

    // A NIP-29 group does, and the relay hosting it is where the copy goes.
    const grouped = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    await new EveServer({
      runtime: new EveRuntime({ host: HOST, fetchImpl: grouped.impl }),
      transport: bus,
      drainQuietMs: 250,
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        fence: fenceFor(store),
        sink: sink().impl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    }).runTurn({
      ...inbound("msg-group", "first"),
      room: {
        transport: "nip-29",
        id: "GROUPID",
        relay: "wss://groups.example",
      },
    });

    const record = store.transcriptFor(grouped.session)!;
    expect(record.carriage).toBe("group");
    expect(record.group).toBe("GROUPID");
    expect(record.groupRelay).toBe("wss://groups.example");
  });

  it("carries each control verb to the route that serves it", async () => {
    // The run has to actually be waiting on the request being answered — an
    // answer to a question nobody asked is refused, which is the whole point of
    // the scope rule. So it is asked the way a real one is: on the stream, read
    // by the follower that holds the open set.
    const eve = fakeEve(ASKING_TURN, 0, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.runTurn(inbound("msg-1", "first"));
    const before = eve.posts.length;

    // A reader knows the WIRE's session id — 32 random bytes — and never the
    // runtime's. Using the runtime's here would test a path no reader can take.
    const record = store.transcriptFor(eve.session)!;
    const nostrId = record.nostrId;
    const base = { id: "", operator: PEER, agent: AGENT, session: nostrId };
    await server_.applyControl({
      ...base,
      id: "c1",
      command: "respond",
      request: "req_1",
      option: "approve",
    });
    await server_.applyControl({
      ...base,
      id: "c2",
      command: "steer",
      text: "do the other thing",
    });
    await server_.applyControl({
      ...base,
      id: "c3",
      command: "cancel",
      turn: "turn_0",
    });
    await server_.applyControl({ ...base, id: "c4", command: "compact" });
    await server_.applyControl({ ...base, id: "c5", command: "clear" });
    await server_.applyControl({
      ...base,
      id: "c6",
      command: "reset",
      text: "start over",
    });

    const sent = eve.posts.slice(before);
    expect(sent.map((post) => post.path)).toEqual([
      `/eve/v1/session/${eve.session}`,
      `/eve/v1/session/${eve.session}`,
      `/eve/v1/session/${eve.session}/cancel`,
      `/eve/v1/session/${eve.session}/compact`,
      `/eve/v1/session/${eve.session}/clear`,
      `/eve/v1/session/${eve.session}/reset`,
    ]);
    // A response resolves the request it names and never steers; a message
    // steers and resolves nothing. Sending the wrong one is the whole bug this
    // shape exists to prevent.
    expect(sent[0]!.body).toEqual({
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    });
    /**
     * A steer QUEUES by default.
     *
     * Eve's own default is the other one — a message sent into a live turn
     * cancels it — which is right for a room and wrong for an operator watching
     * the work and adding to it. A client that means "stop that" says so.
     */
    expect(sent[1]!.body).toEqual({
      message: "do the other thing",
      turnPolicy: "queue",
    });
    expect(sent[2]!.body).toEqual({ turnId: "turn_0" });
    expect(sent[5]!.body).toEqual({ reason: "start over" });
  });

  it("reads the result of a stop, so the head stops saying active", async () => {
    /**
     * `cancel`, `compact` and `clear` start no turn, and nothing was reading
     * the stream for what they DID — so the head kept saying `active` for a run
     * that had been stopped, until some later catch-up noticed. An operator who
     * presses stop and watches the status not change has been told the button
     * did not work.
     */
    const eve = fakeEve(
      FIRST_TURN,
      8,
      undefined,
      [
        { type: "turn.cancelled", data: { turnId: "turn_0" } },
        { type: "session.waiting", data: { wait: "next-user-message" } },
      ] as never,
      true,
    );
    const out = sink();
    const server_ = server(eve, transport(), out.impl);
    await server_.runTurn(inbound("msg-1", "do something long"));
    const before = out.sent.length;

    const nostrId = store.transcriptFor(eve.session)!.nostrId;
    await server_.applyControl({
      id: "c1",
      operator: PEER,
      agent: AGENT,
      session: nostrId,
      command: "cancel",
    });

    // Something was published AFTER the stop, which is the whole point: the
    // reader watching this address learns the run is no longer running.
    expect(out.sent.length).toBeGreaterThan(before);
  });

  it("lets a steer cancel the running turn when the operator asks for it", async () => {
    const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
    const server_ = server(eve, transport(), sink().impl);
    await server_.runTurn(inbound("msg-1", "first"));
    const before = eve.posts.length;
    const nostrId = store.transcriptFor(eve.session)!.nostrId;

    await server_.applyControl({
      id: "c1",
      operator: PEER,
      agent: AGENT,
      session: nostrId,
      command: "steer",
      text: "no, this instead",
      policy: "steer",
    });

    expect(eve.posts.slice(before)[0]!.body).toEqual({
      message: "no, this instead",
      turnPolicy: "steer",
    });
  });

  it("publishes a session that died as dead, not as idle", async () => {
    /**
     * A turn failing and a SESSION failing are different, and Eve says which in
     * the event after the one that ends the turn. Stopping at the turn read the
     * first and never the second, so a run that had died — an exhausted balance,
     * a provider refusing — was published `idle`: a session sitting quietly,
     * waiting for a message it would never take.
     */
    const eve = fakeEve(
      [
        { type: "session.started", data: {} },
        { type: "turn.started", data: { turnId: "turn_0" } },
        {
          type: "step.failed",
          data: { turnId: "turn_0", message: "no funds" },
        },
        {
          type: "turn.failed",
          data: { turnId: "turn_0", message: "no funds" },
        },
        { type: "session.failed", data: { message: "no funds" } },
      ] as never,
      8,
    );
    const out = sink();
    const server_ = server(eve, transport(), out.impl);
    await server_.runTurn(inbound("msg-1", "spend money I do not have"));

    const heads = out.sent.filter((rumor) => rumor.kind === 31777);
    expect(tag(heads[heads.length - 1]!, "status")?.[1]).toBe("error");
  });

  it("points a head at no definition rather than at the wrong one", async () => {
    /**
     * It used to fall back to the agent's STANDING definition when a session
     * had no snapshot of its own, on the reasoning that one pointer beats none.
     * That listed every tool the agent can ever offer, so a run with no room
     * was shown as having chat tools it was never given — and a reader cannot
     * tell a snapshot from a stand-in by looking, so it believed it.
     */
    const eve = fakeEve(FIRST_TURN, 8);
    const out = sink();
    const server_ = server(eve, transport(), out.impl);
    await server_.runTurn(inbound("msg-1", "hello"));

    const head = out.sent.filter((rumor) => rumor.kind === 31777)[0]!;
    expect(tag(head, "agent")).toBeUndefined();
  });

  it("starts a run nobody said anything to start", async () => {
    const eve = fakeEve(FIRST_TURN, 8);
    const bus = transport();
    const server_ = server(eve, bus, sink().impl);

    // The client picks the published name, so it can subscribe to the address
    // before the first head exists rather than poll for a run it cannot name.
    const chosen = "b".repeat(64);
    await server_.applyControl({
      id: "start-1",
      operator: PEER,
      agent: AGENT,
      session: chosen,
      command: "start",
      text: "audit the repo",
      subjects: [["a", "30617:" + AGENT + ":grimoire"]],
    });

    const record = store.transcriptForNostrId(chosen);
    expect(record?.sessionId).toBe(eve.session);
    expect(eve.posts[0]!.path).toBe("/eve/v1/session");
    expect((eve.posts[0]!.body as { message: string }).message).toBe(
      "audit the repo",
    );
    // Nothing was said in any room, because there is no room: the transcript
    // is the whole of the answer.
    expect(bus.replies).toEqual([]);
    expect(bus.reactions).toEqual([]);
  });

  it("ignores a start for a session it has already published", async () => {
    const eve = fakeEve(FIRST_TURN, 8);
    const server_ = server(eve, transport(), sink().impl);
    const chosen = "c".repeat(64);
    const start = {
      operator: PEER,
      agent: AGENT,
      session: chosen,
      command: "start" as const,
      text: "do it",
    };

    await server_.applyControl({ ...start, id: "start-1" });
    const after = eve.posts.length;
    /**
     * A DIFFERENT event id, so the dedupe on rumor id cannot be what saves it.
     *
     * This is the backlog case: a NIP-17 inbox filter reaches two days back
     * because a wrap's timestamp is randomised that far, so every restart reads
     * old wraps — and a start replayed out of that backlog must not open a
     * second session and spend a second time.
     */
    await server_.applyControl({ ...start, id: "start-2" });
    expect(eve.posts.length).toBe(after);
  });

  it("refuses a start whose session id is not one", async () => {
    const eve = fakeEve(FIRST_TURN, 8);
    const server_ = server(eve, transport(), sink().impl);
    await server_.applyControl({
      id: "start-1",
      operator: PEER,
      agent: AGENT,
      // A `d` tag the agent would publish under, chosen by somebody else. It
      // has to look like a session id or it is not one.
      session: "../../etc/passwd",
      command: "start",
      text: "do it",
    });
    expect(eve.posts).toEqual([]);
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
    await server_.runTurn(inbound("msg-1", "first"));
    const before = eve.posts.length;

    await server_.applyControl({
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
    await server_.runTurn(inbound("msg-1", "first"));
    const before = eve.posts.length;

    const twice = {
      id: "c1",
      operator: PEER,
      agent: AGENT,
      session: store.transcriptFor(eve.session)!.nostrId,
      command: "cancel" as const,
    };
    await server_.applyControl(twice);
    await server_.applyControl(twice);

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
      runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
      transport: transport(),
      reply: true,
      drainQuietMs: 250,
      describe: async () => ({
        name: "Hex",
        instructions: "You are Hex.",
        // What the runtime reports: its OWN tools. A tool resolved per turn
        // does not exist yet when `/info` answers, so this list never carries
        // one — the snapshot's other half comes from the host below.
        tools: [{ name: "bash", description: "Run a command." }],
      }),
      tools: {
        bridge: { bind: () => {}, release: () => {} } as never,
        host: () =>
          ({
            list: () => [
              {
                name: "chat.respond",
                description: "Speak.",
                parameters: { type: "object" },
                prompt: "",
              },
            ],
          }) as never,
      },
      transcript: {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [PEER],
        store,
        fence: fenceFor(store),
        sink: out.impl,
        setTimer: () => 0,
        clearTimer: () => {},
      },
    });

    await server_.runTurn(inbound("msg-1", "first"));
    await server_.runTurn(inbound("msg-2", "second", "msg-1"));

    const definitions = out.sent.filter((rumor) => rumor.kind === 31779);
    // Once, not once per turn: a snapshot that kept up with its subject would
    // not be one.
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.content).toBe("You are Hex.");
    // Both halves, each from the side that knows it: the runtime's own tool,
    // and the one this package offered for this run. Neither side can report
    // the other's, and a snapshot missing either describes an agent that did
    // not run — one with no shell, or one with no way to speak.
    expect(
      definitions[0]!.tags.filter((t) => t[0] === "tool").map((t) => t[1]),
    ).toEqual(["bash", "chat_respond"]);

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
    await server(first, transport(), sink().impl).runTurn(
      inbound("msg-1", "first"),
    );
    expect(first.posts.map((p) => p.path)).toEqual(["/eve/v1/session"]);

    // A new server over the same store, serving the same session: a different
    // process, same disk, same Eve.
    const second = fakeEve(FIRST_TURN, 8, first.session, SECOND_TURN);
    await server(second, transport(), sink().impl).runTurn(
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

    await server(eve, bus, out.impl, true).runTurn(inbound("msg-1", "hello"));

    expect(bus.replies[0]?.text).toContain("the model refused");
  });

  /**
   * The queue is the retry now, so its row has to say what really happened.
   *
   * `inbound_seen` keeps a rumor id for thirty days and NIP-17's replay window
   * is two, so a relay will never offer the same wrap again: an instruction
   * whose row was settled "handled" because the CALL returned — not because the
   * runtime took it — is lost for good. The operator pressed stop, hex said it
   * could not, and nothing ever tried again.
   */
  describe("a control that came through the queue", () => {
    /** The daemon's glue, exactly: `settleControl` decides what the row says. */
    function controlQueue(hex: EveServer) {
      const acting: Promise<void>[] = [];
      const ingest: Ingestor = new Ingestor({
        store,
        dispatch: ({ seq, type, event }) => {
          if (type !== "control") return;
          const { instruction } = event.payload as ControlPayload;
          acting.push(
            hex.applyControl(instruction).then((outcome) => {
              settleControl(ingest, seq, outcome);
            }),
          );
        },
      });
      return { ingest, done: () => Promise.all(acting) };
    }

    const stopFor = (nostrId: string) => ({
      id: "c-stop",
      operator: PEER,
      agent: AGENT,
      session: nostrId,
      command: "cancel" as const,
    });

    it("stays owed when the runtime was down, and lands at the next start", async () => {
      const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN, true);
      const first = server(eve, transport(), sink().impl);
      await first.runTurn(inbound("msg-1", "first"));
      const stop = stopFor(store.transcriptFor(eve.session)!.nostrId);

      eve.failNext = true;
      const down = controlQueue(first);
      const seq = down.ingest.acceptControl(stop)!;
      await down.done();

      expect(store.wasObeyed("c-stop")).toBe(false);
      // Unsettled is the whole point: this row is the only retry left.
      expect(store.inboundOutcome(seq)).toBeUndefined();
      expect(store.pendingInbound().map((row) => row.seq)).toContain(seq);

      // A second process over the same home. The payload comes back out of
      // sqlite, which is the round-trip the live path never exercises.
      const retry = server(eve, transport(), sink().impl);
      const back = controlQueue(retry);
      const before = eve.posts.length;
      back.ingest.start();
      await back.done();
      back.ingest.stop();

      expect(eve.posts.length).toBe(before + 1);
      expect(store.wasObeyed("c-stop")).toBe(true);
      expect(store.inboundOutcome(seq)).toBe("handled");
    });

    it("redelivers what a dead generation claimed, and it takes effect once", async () => {
      /**
       * The crash this phase's claims are for.
       *
       * A process claims a control row, carries the instruction out, and is
       * killed before it can write `done_at`. The row is still owed and no
       * relay will ever offer the wrap again — `inbound_seen` keeps it for
       * thirty days — so the next start has to redeliver it. Redelivering into
       * an unfenced writer is the duplicate-publish bug, which is why this
       * could not ship before the fence and the obeyed ledger: the ledger is
       * what turns the second delivery into a no-op.
       */
      const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN, true);
      const hex = server(eve, transport(), sink().impl);
      await hex.runTurn(inbound("msg-1", "first"));
      const stop = {
        ...stopFor(store.transcriptFor(eve.session)!.nostrId),
        id: "c-kill",
      };

      const live = fenceFor(store).generation;
      const dead = runnerFor(hex, { generation: live - 1, settle: false });
      const seq = dead.ingest.acceptControl(stop)!;
      await until(() => store.wasObeyed("c-kill"));
      const after = eve.posts.length;
      expect(store.inboundOutcome(seq)).toBeUndefined();
      expect(store.inboundClaim(seq)).toBe(live - 1);

      // A second process over the same home, with an empty in-memory guard.
      const revived = server(eve, transport(), sink().impl);
      const alive = runnerFor(revived);
      alive.ingest.start();
      await alive.quiet([seq]);
      alive.ingest.stop();

      // Exactly one effect: the durable ledger refused the second delivery.
      expect(eve.posts.length).toBe(after);
      expect(store.inboundOutcome(seq)).toBe("duplicate");
      expect(store.inboundClaim(seq)).toBe(live);
    });

    it("settles an instruction that can never land, rather than owing it forever", async () => {
      const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
      const hex = server(eve, transport(), sink().impl);
      await hex.runTurn(inbound("msg-1", "first"));

      const queue = controlQueue(hex);
      const seq = queue.ingest.acceptControl({
        id: "c-respond",
        operator: PEER,
        agent: AGENT,
        session: store.transcriptFor(eve.session)!.nostrId,
        command: "respond",
      })!;
      await queue.done();

      // Nothing names what to answer, so no redelivery can help.
      expect(store.inboundOutcome(seq)).toBe("refused");
      expect(store.wasObeyed("c-respond")).toBe(false);
    });

    it("settles a row for an instruction a previous run already obeyed", async () => {
      const eve = fakeEve(FIRST_TURN, 8, undefined, SECOND_TURN);
      const hex = server(eve, transport(), sink().impl);
      await hex.runTurn(inbound("msg-1", "first"));
      const stop = stopFor(store.transcriptFor(eve.session)!.nostrId);
      // The crash gap: obeyed on disk, its row never settled.
      store.markObeyed(stop.id);
      const before = eve.posts.length;

      const queue = controlQueue(hex);
      const seq = queue.ingest.acceptControl(stop)!;
      await queue.done();

      expect(eve.posts.length).toBe(before);
      expect(store.inboundOutcome(seq)).toBe("duplicate");
    });
  });

  describe("an answer that never reached the room", () => {
    it("goes out at the next start, once, without running the turn again", async () => {
      /**
       * The gap this phase closes. The model ran, the answer was composed, and
       * the relay refused it — or the process died between the two. Nothing
       * anywhere knew an answer was owed, so the person was left with silence
       * and the only record was a log line.
       *
       * Two halves, both in one test because they are one behaviour: the reply
       * survives, and the message that produced it is NOT asked again. Running
       * the turn twice is the expensive half of the bug.
       */
      const eve = fakeEve();
      const refusing = transport({ failing: true });
      const hex = server(eve, refusing, sink().impl);
      const dead = runnerFor(hex, { settle: false });
      const seq = dead.ingest.accept(inbound("msg-1", "how many kinds?"))!;

      await until(
        () =>
          store.pendingOutbound(5).filter((row) => row.kind === "reply")
            .length === 1,
      );
      expect(refusing.replies).toEqual([]);
      // Unsettled and claimed: a process that died before it could finish.
      expect(store.inboundOutcome(seq)).toBeUndefined();
      const owed = store.pendingOutbound(5).find((row) => row.kind === "reply");
      expect(owed?.inboundSeq).toBe(seq);
      const turns = eve.posts.length;

      // A second process over the same home, and a relay that takes events.
      const working = transport();
      const revived = server(eve, working, sink().impl);
      const alive = runnerFor(revived);
      alive.ingest.start();
      // What the daemon does at startup, and what drains the spool with it.
      await revived.catchUp();
      alive.ingest.stop();

      expect(working.replies).toEqual([
        { to: "msg-1", text: "41 of them.", tags: undefined },
      ]);
      // The turn did not run again: no new request reached the runtime.
      expect(eve.posts.length).toBe(turns);
      expect(store.inboundOutcome(seq)).toBe("handled");
      expect(store.pendingOutbound(5)).toEqual([]);

      // And it stays sent: a third start has nothing left to owe.
      const third = server(eve, transport(), sink().impl);
      await third.catchUp();
      expect(store.pendingOutbound(5)).toEqual([]);
    });
  });
});
