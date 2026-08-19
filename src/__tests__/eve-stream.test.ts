import { describe, expect, it } from "vitest";

import { streamSession, streamUrl } from "../eve/stream.js";
import type { EveEnvelope } from "../eve/types.js";

const HOST = "http://127.0.0.1:2000";
const SESSION = "ses_01KYJBZA88B4M9XN3RTC5FDGHJ";

/** A fetch that hands back the given chunks as an NDJSON body. */
function body(chunks: string[], init: ResponseInit = {}): typeof fetch {
  const encoder = new TextEncoder();
  return (async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    body: (async function* () {
      for (const chunk of chunks) yield encoder.encode(chunk);
    })(),
  })) as unknown as typeof fetch;
}

async function collect(fetchImpl: typeof fetch, startIndex?: number) {
  const out: { index: number; event: EveEnvelope }[] = [];
  for await (const item of streamSession({
    host: HOST,
    sessionId: SESSION,
    startIndex,
    fetchImpl,
  }))
    out.push(item);
  return out;
}

describe("streamUrl", () => {
  it("names the session endpoint and carries the cursor", () => {
    expect(streamUrl({ host: HOST, sessionId: SESSION, startIndex: 12 })).toBe(
      `${HOST}/eve/v1/session/${SESSION}/stream?startIndex=12`,
    );
    // No cursor means from the beginning, and the parameter is absent rather
    // than zero — a host is free to read those differently.
    expect(streamUrl({ host: HOST, sessionId: SESSION })).toBe(
      `${HOST}/eve/v1/session/${SESSION}/stream`,
    );
  });
});

describe("streamSession", () => {
  it("reads events that arrive split across chunk boundaries", async () => {
    // A line is a line whatever the TCP segmentation was; this is the failure
    // that shows up only against a real host.
    const events = await collect(
      body([
        '{"type":"session.star',
        'ted","data":{}}\n{"type":"turn.st',
        'arted","data":{"turnId":"trn_1"}}\n',
      ]),
    );
    expect(events.map((e) => e.event.type)).toEqual([
      "session.started",
      "turn.started",
    ]);
  });

  it("counts from the cursor it resumed at", async () => {
    const events = await collect(
      body(['{"type":"a","data":{}}\n{"type":"b","data":{}}\n']),
      41,
    );
    expect(events.map((e) => e.index)).toEqual([42, 43]);
  });

  it("skips a line that will not parse instead of ending the transcript", async () => {
    const events = await collect(
      body(['{"type":"a","data":{}}\n', "not json\n", '{"type":"b"}\n']),
    );
    expect(events.map((e) => e.event.type)).toEqual(["a", "b"]);
    // The bad line consumed no index, so the cursor still names real events.
    expect(events.map((e) => e.index)).toEqual([1, 2]);
  });

  it("throws on a status, rather than reporting an empty session", async () => {
    await expect(
      collect(body([], { status: 404, statusText: "Not Found" })),
    ).rejects.toThrow(/404/);
  });
});
