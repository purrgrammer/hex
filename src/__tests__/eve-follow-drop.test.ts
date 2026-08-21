/**
 * A stream that stops is not a run that stopped.
 *
 * The follow loop ends on `turn.completed`. It also ends when the HTTP body
 * simply closes — undici cuts a response that has gone quiet — and that path
 * throws nothing, so the loop finishes as if the turn had. The head keeps
 * asserting whatever it last published, and asserts it until the process
 * restarts, because the only thing that ever reconciled a stale head was the
 * catch-up at startup. Live, one said `active` for eleven hours.
 *
 * The same shape as the relay rule this package already lives by: silence is
 * not completion.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EveServer } from "../eve/serve.js";
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
const SESSION = "wrun_DROP";

/** A turn that starts, says something, and is cut off before it ends. */
const CUT_OFF = [
  { type: "session.started", data: {}, meta: { id: "e1" } },
  { type: "turn.started", data: { turnId: "turn_0" }, meta: { id: "e2" } },
  {
    type: "message.received",
    data: { message: "do the long thing", turnId: "turn_0" },
    meta: { id: "e3" },
  },
  {
    type: "step.started",
    data: { modelId: "anthropic/claude-sonnet-5", stepIndex: 0 },
    meta: { id: "e4" },
  },
];

/** What the run went on to do while nobody was reading it. */
const THE_REST = [
  {
    type: "message.completed",
    data: { message: "done", finishReason: "stop", stepIndex: 0 },
    meta: { id: "e5" },
  },
  { type: "turn.completed", data: { turnId: "turn_0" }, meta: { id: "e6" } },
  { type: "session.waiting", data: {}, meta: { id: "e7" } },
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

/**
 * An Eve whose stream ENDS rather than staying open.
 *
 * The first read is served `CUT_OFF` and then the body closes — no abort, no
 * error, just a finished generator, which is what undici hands a reader whose
 * response was terminated. Every later read serves everything, which is the
 * run having carried on without a reader.
 */
function droppingEve() {
  const encoder = new TextEncoder();
  const reads: number[] = [];
  const state = { dropped: false };

  const impl = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === "POST")
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ ok: true, sessionId: SESSION }),
      };

    const from = Number(
      new URL(String(url)).searchParams.get("startIndex") ?? 0,
    );
    reads.push(from);
    const serve = state.dropped ? [...CUT_OFF, ...THE_REST] : CUT_OFF;
    state.dropped = true;

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: (async function* () {
        for (let at = from; at < serve.length; at += 1)
          yield encoder.encode(JSON.stringify(serve[at]) + "\n");
        // And then the body is over — the case that throws nothing.
      })(),
    };
  }) as unknown as typeof fetch;

  return { impl, reads };
}

function transport() {
  return {
    reply: async () => "reply-id",
    react: async () => "reaction-id",
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

const tag = (rumor: Rumor, name: string) =>
  rumor.tags.find((t) => t[0] === name)?.[1];

describe("a follow that stops before its turn does", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eve-drop-"));
    store = HexStore.open(agentHome(home, AGENT).db);
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  function server(eve: ReturnType<typeof droppingEve>, sinkImpl: RumorSink) {
    return new EveServer({
      runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
      transport: transport() as never,
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
   * The load-bearing one. Without the reconcile the last head says `active`,
   * and nothing in this process ever says otherwise.
   */
  it("settles the head instead of leaving it claiming active", async () => {
    const eve = droppingEve();
    const { impl, sent } = sink();
    const hex = server(eve, impl);

    await hex.runTurn(inbound("m1", "do the long thing"));

    const heads = sent.filter((rumor) => rumor.kind === 31777);
    expect(heads.length).toBeGreaterThan(0);
    expect(tag(heads.at(-1)!, "status")).not.toBe("active");
    // It read twice: once for the turn, once to settle what the drop hid.
    expect(eve.reads.length).toBeGreaterThan(1);
  });

  it("publishes the turns the drop hid", async () => {
    const eve = droppingEve();
    const { impl } = sink();
    const hex = server(eve, impl);

    await hex.runTurn(inbound("m1", "do the long thing"));

    expect(store.transcriptFor(SESSION)?.status).not.toBe("active");
  });

  /**
   * A sweep must never open a second reader on a session already being
   * followed: two readers of one stream publish one session's turns twice,
   * which is the failure the whole publish ledger exists to contain.
   */
  it("does not catch up a session it is already following", async () => {
    const eve = droppingEve();
    const { impl } = sink();
    const hex = server(eve, impl);

    await hex.runTurn(inbound("m1", "do the long thing"));
    const before = eve.reads.length;

    // Nothing is in flight now, so this is the honest case: the sweep is free
    // to read. What it must not do is read a session mid-follow, and the guard
    // is what these two calls exercise together.
    await hex.catchUp();
    expect(eve.reads.length).toBeGreaterThanOrEqual(before);
  });
});

/**
 * The sweep has to be free to run every few minutes, which means it must find
 * nothing almost every time. A head at `idle` is resting and saying so; only
 * `active` is a claim that stops being true when the reading stops.
 */
describe("the periodic sweep", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eve-sweep-"));
    store = HexStore.open(agentHome(home, AGENT).db);
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  function serverFor(eve: ReturnType<typeof droppingEve>) {
    return new EveServer({
      runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
      transport: transport() as never,
      drainQuietMs: 50,
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
  }

  const record = (sessionId: string, status: string) => ({
    sessionId,
    nostrId: sessionId.padEnd(64, "0").slice(0, 64),
    seq: 1,
    turn: 1,
    status,
    streamIndex: 0,
    startedAt: 1,
    inTokens: 0,
    outTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

  it("reads a session claiming work and leaves a resting one alone", async () => {
    store.saveTranscript(
      record("wrun_RESTING", "idle") as never,
      fenceFor(store),
    );
    const idleOnly = droppingEve();
    await serverFor(idleOnly).catchUp({ claimingWork: true });
    expect(idleOnly.reads).toEqual([]);

    store.saveTranscript(
      record("wrun_CLAIMING", "active") as never,
      fenceFor(store),
    );
    const working = droppingEve();
    await serverFor(working).catchUp({ claimingWork: true });
    expect(working.reads.length).toBe(1);
  });

  it("still reads every open session at startup", async () => {
    store.saveTranscript(
      record("wrun_RESTING", "idle") as never,
      fenceFor(store),
    );
    const eve = droppingEve();
    await serverFor(eve).catchUp();
    expect(eve.reads.length).toBe(1);
  });
});

/**
 * A run started over the control plane belongs to no room, so it is never put
 * in the room-keyed conversation map — and asking that map whether a session is
 * being followed therefore answered "no" about one being actively read. The
 * sweep would have opened a second reader on it.
 */
describe("what counts as already being read", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eve-readers-"));
    store = HexStore.open(agentHome(home, AGENT).db);
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * An Eve that holds its stream open until the test lets go, so the follow is
   * provably still in flight when the sweep runs. Timing sleeps do not prove
   * this: if the follow finishes first the head is no longer `active`, the
   * sweep finds nothing, and the assertion passes without touching the guard.
   */
  function heldEve() {
    const encoder = new TextEncoder();
    const reads: number[] = [];
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));

    const impl = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ ok: true, sessionId: SESSION }),
        };
      reads.push(
        Number(new URL(String(url)).searchParams.get("startIndex") ?? 0),
      );
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: (async function* () {
          for (const event of CUT_OFF)
            yield encoder.encode(JSON.stringify(event) + "\n");
          open();
          await held;
          for (const event of THE_REST)
            yield encoder.encode(JSON.stringify(event) + "\n");
        })(),
      };
    }) as unknown as typeof fetch;

    return { impl, reads, opened, release };
  }

  /**
   * The gap, exactly: a run started over the CONTROL PLANE. It belongs to no
   * room, so it is never put in the room-keyed conversation map, and asking
   * that map whether it is being followed answers "no" about a session with a
   * live reader on it. Driving the DM path instead proves nothing — that one
   * IS in the map, and the assertion passes with or without the guard.
   */
  it("does not sweep a control-plane run while it is being read", async () => {
    const eve = heldEve();
    const { impl } = sink();
    const hex = new EveServer({
      runtime: new EveRuntime({ host: HOST, fetchImpl: eve.impl }),
      transport: transport() as never,
      drainQuietMs: 50,
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

    const wire = "a".repeat(64);
    const working = hex.applyControl({
      id: "ctl_1",
      operator: PEER,
      agent: AGENT,
      session: wire,
      command: "start",
      text: "do the long thing",
    } as never);
    await eve.opened;

    // There has to be something for the sweep to find, or the guard is not
    // what the assertion is measuring.
    const record = store.transcriptFor(SESSION);
    expect(record?.status).toBe("active");
    const before = eve.reads.length;
    await hex.catchUp({ claimingWork: true });
    expect(eve.reads.length).toBe(before);

    eve.release();
    await working;
  });
});

/**
 * A drop the process never notices is a drop nothing reconciles until restart.
 *
 * The reader stays registered — so the sweep skips the session as "already
 * being read" — while the stream it claims to be reading moves on without it.
 * The tell has to come from the RUNTIME: hex's stored cursor is written by the
 * very reader whose mark it would be compared against, so it is never ahead of
 * one and a drop looks exactly like a healthy follow. So: ask the stream where
 * it has got to, and only about a reader that has gone quiet.
 */
describe("a reader that stopped delivering", () => {
  let home: string;
  let store: HexStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eve-gap-"));
    store = HexStore.open(agentHome(home, AGENT).db);
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * `heldEve`, except that only the FIRST read is held: the forced reconcile is
   * itself a read, and a fake that held every one would hang it for a minute.
   *
   * A tail probe (`includeTailIndex=1`) is answered from `tail` in headers and
   * counts as neither a read nor the held one — which is the endpoint's own
   * behaviour, since the probe is a request whose body is thrown away.
   */
  function heldOnceEve() {
    const encoder = new TextEncoder();
    const reads: number[] = [];
    const probes: number[] = [];
    /** Where the run has actually got to, as only the runtime knows. */
    const state = { tail: undefined as number | undefined };
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;

    const impl = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ ok: true, sessionId: SESSION }),
        };
      const query = new URL(String(url)).searchParams;
      const from = Number(query.get("startIndex") ?? 0);
      if (query.get("includeTailIndex") === "1") {
        probes.push(from);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(
            state.tail === undefined
              ? {}
              : { "x-eve-stream-tail-index": String(state.tail) },
          ),
          body: (async function* () {})(),
        };
      }
      reads.push(from);
      const hold = first;
      first = false;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: (async function* () {
          const all = [...CUT_OFF, ...THE_REST];
          if (!hold) {
            for (let at = from; at < all.length; at += 1)
              yield encoder.encode(JSON.stringify(all[at]) + "\n");
            return;
          }
          for (const event of CUT_OFF)
            yield encoder.encode(JSON.stringify(event) + "\n");
          open();
          await held;
          for (const event of THE_REST)
            yield encoder.encode(JSON.stringify(event) + "\n");
        })(),
      };
    }) as unknown as typeof fetch;

    return { impl, reads, probes, state, opened, release };
  }

  function server(
    eve: ReturnType<typeof heldOnceEve>,
    options?: { gapSilenceMs?: number; blind?: boolean },
  ) {
    const eveRuntime = new EveRuntime({ host: HOST, fetchImpl: eve.impl });
    // A driver that cannot say where its stream is: the optional method absent,
    // which is the only thing that tells the two cases apart.
    const runtime = options?.blind
      ? (Object.assign(Object.create(EveRuntime.prototype) as EveRuntime, {
          ...eveRuntime,
          tailIndex: undefined,
        }) as never)
      : eveRuntime;
    return new EveServer({
      runtime,
      transport: transport() as never,
      drainQuietMs: 50,
      // The sweep is driven by hand here; a timer would race the assertions.
      sweepMs: 0,
      // Zero unless a test is about the silence gate itself: a mark that only
      // just moved is a reader keeping up, not a gap.
      gapSilenceMs: options?.gapSilenceMs ?? 0,
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
  }

  it("reports the gap and forces a read of the session anyway", async () => {
    const eve = heldOnceEve();
    const hex = server(eve);

    const working = hex.runTurn(inbound("m1", "do the long thing"));
    await eve.opened;

    // The run carried on without us. Nothing touches the stored cursor — no
    // production path does, which is why the cursor cannot be the signal.
    eve.state.tail = 500;
    const rowBefore = store.transcriptFor(SESSION)?.streamIndex;

    const gaps = await hex.detectGaps();
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.sessionId).toBe(SESSION);
    expect(gaps[0]!.tailIndex).toBe(500);
    expect(gaps[0]!.deliveredIndex).toBeLessThanOrEqual(CUT_OFF.length);
    expect(gaps[0]!.sinceMs).toBeGreaterThanOrEqual(0);
    expect(store.transcriptFor(SESSION)?.streamIndex).toBe(rowBefore);

    // The reader is still registered, so the ordinary sweep would leave this
    // session alone forever. The gap sweep reads it regardless, and counts it.
    const before = eve.reads.length;
    const swept = await hex.sweepGaps();
    expect(
      swept.map(({ sessionId, tailIndex, deliveredIndex }) => ({
        sessionId,
        tailIndex,
        deliveredIndex,
      })),
    ).toEqual([
      {
        sessionId: SESSION,
        tailIndex: 500,
        deliveredIndex: gaps[0]!.deliveredIndex,
      },
    ]);
    expect(eve.reads.length).toBe(before + 1);
    expect(hex.gapsDetected).toBe(1);

    eve.release();
    await working;
  });

  /**
   * The tail is ahead of the mark on every healthy turn — each delivered event
   * is a relay round trip and the run keeps emitting during it. Without the
   * silence gate the sweep would open a second reader on a working follow every
   * few minutes, which is the one thing the publish ledger exists to prevent.
   */
  it("says nothing about a reader that is merely behind the tail", async () => {
    const eve = heldOnceEve();
    const hex = server(eve, { gapSilenceMs: 60_000 });

    const working = hex.runTurn(inbound("m1", "do the long thing"));
    await eve.opened;
    eve.state.tail = 500;

    expect(await hex.detectGaps()).toEqual([]);
    // Not even asked: a mark that just moved settles it without the runtime.
    expect(eve.probes).toEqual([]);

    eve.release();
    await working;
  });

  it("says nothing when the stream is where the reader left it", async () => {
    const eve = heldOnceEve();
    const hex = server(eve);

    const working = hex.runTurn(inbound("m1", "do the long thing"));
    await eve.opened;

    // What the reader has delivered, as the runtime's own tail. Equal, not
    // ahead: the two numbers are in the same index space, and an off-by-one
    // here would report a gap on every quiet session.
    eve.state.tail = 500;
    const delivered = (await hex.detectGaps())[0]!.deliveredIndex;
    eve.state.tail = delivered;

    expect(await hex.detectGaps()).toEqual([]);

    eve.release();
    await working;
  });

  /** A runtime that cannot say where its stream is cannot be second-guessed. */
  it("says nothing when the runtime cannot name its tail", async () => {
    const eve = heldOnceEve();
    const hex = server(eve, { blind: true });

    const working = hex.runTurn(inbound("m1", "do the long thing"));
    await eve.opened;
    eve.state.tail = 500;

    expect(await hex.detectGaps()).toEqual([]);
    expect(eve.probes).toEqual([]);

    eve.release();
    await working;
  });

  /** No reader, no claim to be reading: an unfollowed session is the sweep's. */
  it("says nothing about a session nobody is reading", async () => {
    const eve = heldOnceEve();
    const hex = server(eve);

    const working = hex.runTurn(inbound("m1", "do the long thing"));
    await eve.opened;
    eve.release();
    await working;
    eve.state.tail = 500;

    expect(await hex.detectGaps()).toEqual([]);
  });
});
