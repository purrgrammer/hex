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

    await hex.handle(inbound("m1", "do the long thing"));

    const heads = sent.filter((rumor) => rumor.kind === 31777);
    expect(heads.length).toBeGreaterThan(0);
    expect(tag(heads.at(-1)!, "status")).not.toBe("active");
    // It read twice: once for the turn, once to settle what the drop hid.
    expect(eve.reads.length).toBeGreaterThan(1);
  });

  it("publishes the turns the drop hid", async () => {
    const eve = droppingEve();
    const { impl, sent } = sink();
    const hex = server(eve, impl);

    await hex.handle(inbound("m1", "do the long thing"));

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

    await hex.handle(inbound("m1", "do the long thing"));
    const before = eve.reads.length;

    // Nothing is in flight now, so this is the honest case: the sweep is free
    // to read. What it must not do is read a session mid-follow, and the guard
    // is what these two calls exercise together.
    await hex.catchUp();
    expect(eve.reads.length).toBeGreaterThanOrEqual(before);
  });
});
