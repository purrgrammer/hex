/**
 * The endpoint IS the protocol, so something has to read the endpoint.
 *
 * This package deliberately does not depend on `eve/client`: taking the typed
 * client means taking the framework into the gateway's own dependencies. The
 * price of that choice is that every other test here runs against a fake, and a
 * fake only ever agrees with whoever wrote it. One did not agree with the
 * runtime — it reported the stream's tail as a count when Eve reports the index
 * of the last event — and the code was written to match the fake, so a bounded
 * read dropped its last event and the gap detector went blind at exactly one
 * event behind. Both suites were green throughout.
 *
 * So: an opt-in suite that asks a real `eve dev`. Skipped when no host is
 * named, which is always in CI.
 *
 *   HEX_EVE_HOST=http://127.0.0.1:2000 \
 *   HEX_EVE_SESSION=wrun_… npx vitest run src/__tests__/eve-contract.test.ts
 *
 * Read-only on purpose. Opening a session costs a model call, and a suite that
 * spends money is a suite nobody runs.
 */

import { describe, expect, it } from "vitest";

import {
  SessionGoneError,
  streamSession,
  streamTailIndex,
  streamUrl,
} from "../eve/stream.js";
import { readAgentInfo } from "../eve/info.js";

const HOST = process.env.HEX_EVE_HOST;
const SESSION = process.env.HEX_EVE_SESSION;

const live = HOST ? describe : describe.skip;
const withSession = HOST && SESSION ? it : it.skip;

/**
 * Nonempty NDJSON lines, read straight rather than through the reader.
 *
 * `from` is the cursor the URL asked for, because the stop condition depends on
 * it: the tail names an absolute index, so a read resuming at N is finished
 * after `tail - N + 1` lines, not after `tail`.
 */
async function lines(
  url: string,
  from = 0,
  timeoutMs = 10_000,
): Promise<string[]> {
  const response = await fetch(url, {
    headers: { accept: "application/x-ndjson" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  expect(response.ok).toBe(true);
  const out: string[] = [];
  let buffered = "";
  const decoder = new TextDecoder();
  const tail = Number(response.headers.get("x-eve-stream-tail-index"));
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let at = buffered.indexOf("\n");
      while (at !== -1) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        at = buffered.indexOf("\n");
        if (line) out.push(line);
      }
      // The endpoint is a live follow and never ends by itself.
      if (Number.isSafeInteger(tail) && out.length >= tail - from + 1) break;
    }
  } catch {
    // A deadline reached on a follow that had nothing more to say.
  }
  return out;
}

live("the Eve HTTP contract, against a running runtime", () => {
  it("describes itself at /eve/v1/info", async () => {
    const info = await readAgentInfo({ host: HOST! });
    expect(info).toBeDefined();
    // What the transcript publishes as the run's setup. A shape change here is
    // a transcript that starts describing an agent that never ran.
    expect(Array.isArray(info!.tools)).toBe(true);
    expect(typeof info!.instructions === "string").toBe(true);
  });

  /**
   * The fact that forced `SessionGoneError` to exist.
   *
   * An id the runtime has never seen is answered 200, with an empty body, a
   * tail of -1, and a follow that stays open forever. Nothing about the status
   * or the silence says the session is not there, so the header is the only
   * signal — and without reading it, a reader resuming a session Eve has
   * forgotten waits for an event that cannot arrive.
   */
  it("answers 200 and a tail of -1 for a session it does not have", async () => {
    const response = await fetch(
      streamUrl({ host: HOST!, sessionId: "wrun_definitely_not_a_session" }),
      {
        headers: { accept: "application/x-ndjson" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    expect(response.ok).toBe(true);
    expect(response.headers.get("x-eve-stream-tail-index")).toBe("-1");
    await response.body?.cancel();
  });

  it("stops a resumed follow of a session it does not have", async () => {
    // What the fake asserts in eve-stream.test.ts, against the real thing.
    await expect(
      (async () => {
        for await (const _ of streamSession({
          host: HOST!,
          sessionId: "wrun_definitely_not_a_session",
          startIndex: 7,
          signal: AbortSignal.timeout(10_000),
        }));
      })(),
    ).rejects.toThrow(SessionGoneError);
  });

  withSession(
    "names the LAST STORED INDEX in the tail header, one below the count",
    async () => {
      const url = streamUrl({
        host: HOST!,
        sessionId: SESSION!,
        startIndex: 0,
        untilTail: true,
      });
      const stored = await lines(url);
      const tail = await streamTailIndex({
        host: HOST!,
        sessionId: SESSION!,
        from: 0,
      });

      expect(tail).toBeDefined();
      // The whole finding, as one assertion: thirty events, tail 29.
      expect(tail).toBe(stored.length - 1);
    },
  );

  withSession("stores exactly one event per nonempty line", async () => {
    const all = await lines(
      streamUrl({ host: HOST!, sessionId: SESSION!, startIndex: 0, untilTail: true }),
    );
    for (const line of all) expect(() => JSON.parse(line)).not.toThrow();
    // If a line were ever half an event, the reader's cursor — which counts
    // lines — would drift from the index Eve resumes at.
    expect(all.length).toBeGreaterThan(0);
  });

  withSession("resumes from a cursor that names events not yet read", async () => {
    const all = await lines(
      streamUrl({ host: HOST!, sessionId: SESSION!, startIndex: 0, untilTail: true }),
    );
    const from = all.length - 1;
    const rest = await lines(
      streamUrl({
        host: HOST!,
        sessionId: SESSION!,
        startIndex: from,
        untilTail: true,
      }),
      from,
    );
    // `startIndex` is where to START, so asking from N-1 returns the last one.
    expect(rest.length).toBe(1);
    expect(rest[0]).toBe(all[from]);
  });

  withSession("hands the reader every stored event and then stops", async () => {
    const raw = await lines(
      streamUrl({ host: HOST!, sessionId: SESSION!, startIndex: 0, untilTail: true }),
    );
    const read: number[] = [];
    for await (const event of streamSession({
      host: HOST!,
      sessionId: SESSION!,
      startIndex: 0,
      untilTail: true,
      signal: AbortSignal.timeout(20_000),
    }))
      read.push(event.index);

    // Every one, including the last — and the indices are a cursor: the final
    // one is what a resume would ask for next.
    expect(read.length).toBe(raw.length);
    expect(read.at(-1)).toBe(raw.length);
  });
});
