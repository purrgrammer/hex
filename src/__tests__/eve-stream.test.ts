import { describe, expect, it } from "vitest";

import {
  SessionGoneError,
  streamSession,
  streamTailIndex,
  streamUrl,
} from "../eve/stream.js";
import type { EveEnvelope } from "../eve/types.js";

const HOST = "http://127.0.0.1:2000";
const SESSION = "ses_01KYJBZA88B4M9XN3RTC5FDGHJ";

/**
 * A fetch that hands back the given chunks as an NDJSON body.
 *
 * `stored` is how many events the session HOLDS, and the header is derived from
 * it — because that derivation is the contract this fake exists to model. It
 * used to take the header value directly, and every test in this file named one
 * a real `eve dev` would never send: two events reported as a tail of 2, when
 * the endpoint answers 1. The code agreed with the fake and both were wrong.
 */
function body(
  chunks: string[],
  init: ResponseInit & { stored?: number } = {},
): typeof fetch {
  const encoder = new TextEncoder();
  return (async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: new Headers(
      init.stored === undefined
        ? {}
        : // 0-based index of the last stored event: thirty events, tail 29.
          { "x-eve-stream-tail-index": String(init.stored - 1) },
    ),
    body: (async function* () {
      for (const chunk of chunks) yield encoder.encode(chunk);
      // A live follow never ends on its own. A reader that does not stop at the
      // tail hangs here, which is the bug this models.
      await new Promise(() => {});
    })(),
  })) as unknown as typeof fetch;
}

async function collect(
  fetchImpl: typeof fetch,
  startIndex?: number,
  untilTail = true,
) {
  const out: { index: number; event: EveEnvelope }[] = [];
  for await (const item of streamSession({
    host: HOST,
    sessionId: SESSION,
    startIndex,
    untilTail,
    fetchImpl,
  }))
    out.push(item);
  return out;
}

describe("streamUrl", () => {
  it("names the session endpoint and carries the cursor", () => {
    // `includeTailIndex` is the endpoint's real parameter and it is always
    // asked for. There is no `follow`. A live follow ignores the value, but the
    // header is the only thing that distinguishes a quiet session from one the
    // runtime does not have — which answers 200 and then says nothing, forever.
    expect(streamUrl({ host: HOST, sessionId: SESSION, startIndex: 12 })).toBe(
      `${HOST}/eve/v1/session/${SESSION}/stream?startIndex=12&includeTailIndex=1`,
    );
    expect(streamUrl({ host: HOST, sessionId: SESSION, untilTail: true })).toBe(
      `${HOST}/eve/v1/session/${SESSION}/stream?includeTailIndex=1`,
    );
    // No cursor means from the beginning, and the parameter is absent rather
    // than zero — a host is free to read those differently.
    expect(streamUrl({ host: HOST, sessionId: SESSION })).toBe(
      `${HOST}/eve/v1/session/${SESSION}/stream?includeTailIndex=1`,
    );
  });
});

describe("streamSession", () => {
  it("reads events that arrive split across chunk boundaries", async () => {
    // A line is a line whatever the TCP segmentation was; this is the failure
    // that shows up only against a real host.
    const events = await collect(
      body(
        [
          '{"type":"session.star',
          'ted","data":{}}\n{"type":"turn.st',
          'arted","data":{"turnId":"trn_1"}}\n',
        ],
        { stored: 2 },
      ),
    );
    expect(events.map((e) => e.event.type)).toEqual([
      "session.started",
      "turn.started",
    ]);
  });

  it("counts from the cursor it resumed at", async () => {
    const events = await collect(
      body(['{"type":"a","data":{}}\n{"type":"b","data":{}}\n'], {
        stored: 43,
      }),
      41,
    );
    expect(events.map((e) => e.index)).toEqual([42, 43]);
  });

  it("skips a line that will not parse but still counts it", async () => {
    const events = await collect(
      body(['{"type":"a","data":{}}\n', "not json\n", '{"type":"b"}\n'], {
        stored: 3,
      }),
    );
    expect(events.map((e) => e.event.type)).toEqual(["a", "b"]);
    /*
     * The bad line was still an event Eve stored, so it still moves the cursor.
     * Yielding `b` as index 2 would name the malformed line, and every resume
     * after it would ask for one event less than it had read — replaying a turn
     * that was already published, for the rest of the session.
     */
    expect(events.map((e) => e.index)).toEqual([1, 3]);
  });

  it("ends on a tail whose last stored line will not parse", async () => {
    // The increment alone is not enough: with the tail check inside the parse
    // branch, an unreadable last line means the check never runs and the read
    // waits on a follow that has nothing left to say.
    const events = await collect(
      body(['{"type":"a","data":{}}\n', "not json\n"], { stored: 2 }),
    );
    expect(events.map((e) => e.event.type)).toEqual(["a"]);
  });

  it("returns at once when it resumed at the tail", async () => {
    // Nothing arrives, so no per-line check ever fires. Without the check made
    // before the loop, this hangs on a session that is simply up to date.
    const events = await collect(body([], { stored: 7 }), 7);
    expect(events).toEqual([]);
  });

  it("stops at the tail instead of hanging on a live follow", async () => {
    // The endpoint has no `follow` parameter: a request for a FINISHED session
    // stays open. A reader that does not stop at the tail index hangs forever,
    // which is what the fake body models by never ending.
    const events = await collect(
      body(['{"type":"a","data":{}}\n{"type":"b","data":{}}\n'], {
        stored: 2,
      }),
    );
    // invariant: I18
    // Both of them. Stopping at `index >= tail` yielded only the first, and the
    // event a stream ends on is the one a turn is declared complete by.
    expect(events.map((e) => e.event.type)).toEqual(["a", "b"]);
  });

  it("reads past the tail when it was never asked for", async () => {
    // Without `untilTail` the header is ignored, because a follower wants the
    // events that have not happened yet.
    const events: string[] = [];
    for await (const item of streamSession({
      host: HOST,
      sessionId: SESSION,
      fetchImpl: body(['{"type":"a","data":{}}\n'], { stored: 1 }),
    })) {
      events.push(item.event.type);
      break; // It would otherwise hang, which is the point.
    }
    expect(events).toEqual(["a"]);
  });

  /**
   * Measured against a running `eve dev`: an id it has never seen is answered
   * 200, with an empty body, a tail of -1, and a follow that stays open. So the
   * status cannot be the signal, and neither can silence.
   */
  it("refuses to follow a session the runtime does not have", async () => {
    // invariant: I20
    await expect(
      collect(body([], { stored: 0 }), 12, false),
    ).rejects.toThrow(SessionGoneError);
  });

  it("waits on a new session that has simply not spoken yet", async () => {
    // Same empty answer, but from the beginning: a session opened a moment ago
    // has nothing stored either, and abandoning it would drop its first turn.
    const events = await collect(body([], { stored: 0 }), 0, true);
    expect(events).toEqual([]);
  });

  it("throws on a status, rather than reporting an empty session", async () => {
    await expect(
      collect(body([], { status: 404, statusText: "Not Found" })),
    ).rejects.toThrow(/404/);
  });
});

/**
 * The tail without the stream.
 *
 * The one thing a consumer cannot work out for itself: hex's own cursor is
 * written by its own reader, so "has this session moved past us" can only be
 * answered by the side that stores the events.
 */
describe("streamTailIndex", () => {
  /** A response with headers and a body that would never end. */
  function probe(init: ResponseInit & { tailIndex?: number } = {}) {
    const calls: { url: string; aborted: () => boolean }[] = [];
    const impl = (async (url: string | URL, init2?: RequestInit) => {
      const signal = init2?.signal;
      calls.push({
        url: String(url),
        aborted: () => signal?.aborted === true,
      });
      return {
        ok: (init.status ?? 200) < 400,
        status: init.status ?? 200,
        statusText: init.statusText ?? "OK",
        headers: new Headers(
          init.tailIndex === undefined
            ? {}
            : { "x-eve-stream-tail-index": String(init.tailIndex) },
        ),
        body: (async function* () {
          await new Promise(() => {});
        })(),
      };
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("asks from where the caller is and reads the header", async () => {
    const { impl, calls } = probe({ tailIndex: 41 });
    expect(
      await streamTailIndex({
        host: HOST,
        sessionId: SESSION,
        from: 12,
        fetchImpl: impl,
      }),
    ).toBe(41);
    expect(calls[0]!.url).toBe(
      `${HOST}/eve/v1/session/${SESSION}/stream?startIndex=12&includeTailIndex=1`,
    );
    // The endpoint is a live follow: a probe that left the body open would leak
    // one hanging request per session per sweep.
    expect(calls[0]!.aborted()).toBe(true);
  });

  it("says nothing rather than zero when the host names no tail", async () => {
    const { impl } = probe();
    expect(
      await streamTailIndex({
        host: HOST,
        sessionId: SESSION,
        fetchImpl: impl,
      }),
    ).toBeUndefined();
  });

  it("says nothing on a status, which is not a stream that moved", async () => {
    const { impl } = probe({ status: 503, statusText: "Unavailable" });
    expect(
      await streamTailIndex({
        host: HOST,
        sessionId: SESSION,
        fetchImpl: impl,
      }),
    ).toBeUndefined();
  });
});
