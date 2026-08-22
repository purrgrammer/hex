/**
 * Reading an Eve session's event stream.
 *
 * The stream is NDJSON over HTTP and it is durable: every event is recorded
 * before the step that produced it completes, and `?startIndex=<n>` replays from
 * a cursor. That is why this package keeps a cursor and not a copy — a consumer
 * that died mid-turn resumes from the index it had, and Eve hands back the events
 * it missed.
 *
 * `fetch` and nothing else. Taking `eve/client` would mean taking the framework,
 * and the endpoint is the protocol.
 *
 * Both query parameters here are the endpoint's real ones — `startIndex` and
 * `includeTailIndex` — read off a running `eve dev` rather than assumed.
 */

import type { EveEnvelope } from "./types.js";

export interface StreamOptions {
  /** e.g. `http://127.0.0.1:2000`. */
  host: string;
  sessionId: string;
  /** Resume here. Omit to read from the beginning. */
  startIndex?: number;
  /**
   * Stop once the events that already exist have been read.
   *
   * The endpoint has NO `follow` parameter — it is always a live follow, and a
   * request for a finished session stays open regardless. What it does have is
   * `includeTailIndex`, which returns the index of the last stored event in a
   * header; so a bounded read is "stop when you reach the tail", and that is what
   * this implements. Verified against a running `eve dev`, which held a
   * `follow=0` request open for two minutes and would have held it forever.
   *
   * The header is always ASKED for — it costs a header and it is the only way
   * to tell a session that is quiet from one that is gone. This flag decides
   * only whether the read stops at it.
   */
  untilTail?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Two vocabularies, and they are one apart.
 *
 * This package's index is a COUNT — how many events have been read, which is
 * also the `startIndex` a resume asks for next. Eve's `x-eve-stream-tail-index`
 * is the 0-BASED INDEX of the last stored event, so a session holding thirty
 * events reports twenty-nine. Measured against a running `eve dev`, not assumed.
 *
 * Every comparison between the two has to carry the offset, and each one that
 * did not was a defect: the bounded read below dropped the last event, and the
 * gap detector could not see a session exactly one event behind.
 */

/** One event, with the index a resume would use to ask for the next one. */
export interface IndexedEvent {
  index: number;
  event: EveEnvelope;
}

/**
 * The runtime has no such session — or no longer has it.
 *
 * Thrown rather than returned because every caller already treats a stream that
 * ends as a stream that MIGHT come back, and this one will not. A reader that
 * swallowed it would sit on a session id nothing will ever answer for.
 */
export class SessionGoneError extends Error {
  readonly name = "SessionGoneError";

  constructor(
    readonly sessionId: string,
    readonly from: number,
  ) {
    super(
      `eve has no session ${sessionId}: a read resuming at ${from} found nothing stored`,
    );
  }
}

export function streamUrl(options: StreamOptions): string {
  const url = new URL(
    `/eve/v1/session/${encodeURIComponent(options.sessionId)}/stream`,
    options.host,
  );
  if (options.startIndex !== undefined)
    url.searchParams.set("startIndex", String(options.startIndex));
  // Always. A follow ignores the value; it still needs to be told when there is
  // nothing on the other end.
  url.searchParams.set("includeTailIndex", "1");
  return url.toString();
}

/**
 * Yield the session's events, oldest first, from the cursor onwards.
 *
 * A line that will not parse is skipped rather than thrown: one malformed event
 * must not end a transcript that is otherwise arriving fine.
 */
export async function* streamSession(
  options: StreamOptions,
): AsyncGenerator<IndexedEvent> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(streamUrl(options), {
    headers: { accept: "application/x-ndjson" },
    signal: options.signal,
  });

  if (!response.ok)
    throw new Error(
      `eve stream ${options.sessionId}: ${response.status} ${response.statusText}`,
    );
  if (!response.body) return;

  // `x-eve-stream-tail-index` names the last stored event. Only meaningful when
  // it was asked for; a header that is absent or unreadable means read on.
  const tailHeader = Number(response.headers.get("x-eve-stream-tail-index"));
  const stored = Number.isSafeInteger(tailHeader) ? tailHeader : undefined;
  const tail = options.untilTail ? stored : undefined;

  let index = options.startIndex ?? 0;

  /*
   * A session the runtime does not have looks exactly like one that is quiet.
   *
   * Eve answers 200 for an id it has never seen — an empty body, a tail of -1,
   * and a follow that stays open forever. Measured, not assumed. So a reader
   * resuming at an index the runtime cannot possibly reach is not waiting for
   * anything, and waiting is what it would otherwise do: no event arrives, so
   * no check runs, and the reader stays registered on a session that is gone.
   */
  if (stored !== undefined && index > 0 && stored < 0)
    throw new SessionGoneError(options.sessionId, index);
  // A read that resumed AT the tail has nothing to wait for, and the loop below
  // would wait anyway: no line ever arrives, so no check ever runs. The request
  // is a live follow, so waiting means forever.
  if (tail !== undefined && index > tail) return;
  const decoder = new TextDecoder();
  let buffered = "";

  // A fetch body is async-iterable in Node, which is where this runs.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });

    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line) continue;

      /*
       * The index moves for the LINE, not for the parse.
       *
       * One nonempty line is one stored event — checked against a live runtime,
       * thirty lines against a tail of twenty-nine — so a line this cannot read
       * is still an event Eve counted. Skipping the increment left the cursor
       * one behind for the rest of the session, and every resume from then on
       * replayed an event that had already been published.
       */
      index += 1;

      let event: EveEnvelope | undefined;
      try {
        event = JSON.parse(line) as EveEnvelope;
      } catch {
        // One malformed event must not end a transcript that is otherwise
        // arriving fine — but the tail check below still has to run, or a
        // session whose last line is unreadable never ends the read.
        event = undefined;
      }
      if (event && typeof event.type === "string") yield { index, event };

      // `index` counts events read; `tail` names the last one. They are equal
      // when the last event has just been read, so this stops AFTER it.
      if (tail !== undefined && index > tail) return;
    }
  }
}

/**
 * Where the session's stream actually is, without reading it.
 *
 * The endpoint names the last stored event in `x-eve-stream-tail-index` when
 * asked, so the tail is one request's headers: `startIndex` is set to what the
 * caller already has so the body it aborts is empty. Bounded and non-throwing
 * by the caller's choice — a runtime that cannot be reached has not told us
 * anything, which is not the same as a stream that moved on.
 */
export async function streamTailIndex(options: {
  host: string;
  sessionId: string;
  /** Where the asker already is, so the aborted body carries nothing. */
  from?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<number | undefined> {
  const doFetch = options.fetchImpl ?? fetch;
  const own = new AbortController();
  const signals = [own.signal, AbortSignal.timeout(options.timeoutMs ?? 5_000)];
  if (options.signal) signals.push(options.signal);
  const url = streamUrl({
    host: options.host,
    sessionId: options.sessionId,
    startIndex: options.from,
    untilTail: true,
  });
  try {
    const response = await doFetch(url, {
      headers: { accept: "application/x-ndjson" },
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) return undefined;
    const header = response.headers.get("x-eve-stream-tail-index");
    // `Number(null)` is 0, which would read as "the stream is empty".
    if (header === null) return undefined;
    const raw = Number(header);
    return Number.isSafeInteger(raw) ? raw : undefined;
  } finally {
    // The request is a live follow: left open it leaks a body per probe.
    own.abort();
  }
}
