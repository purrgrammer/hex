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
   */
  untilTail?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** One event, with the index a resume would use to ask for the next one. */
export interface IndexedEvent {
  index: number;
  event: EveEnvelope;
}

export function streamUrl(options: StreamOptions): string {
  const url = new URL(
    `/eve/v1/session/${encodeURIComponent(options.sessionId)}/stream`,
    options.host,
  );
  if (options.startIndex !== undefined)
    url.searchParams.set("startIndex", String(options.startIndex));
  if (options.untilTail) url.searchParams.set("includeTailIndex", "1");
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
  const tailHeader = options.untilTail
    ? Number(response.headers.get("x-eve-stream-tail-index"))
    : Number.NaN;
  const tail = Number.isSafeInteger(tailHeader) ? tailHeader : undefined;

  let index = options.startIndex ?? 0;
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

      let event: EveEnvelope;
      try {
        event = JSON.parse(line) as EveEnvelope;
      } catch {
        continue;
      }
      index += 1;
      if (typeof event.type === "string") yield { index, event };
      if (tail !== undefined && index >= tail) return;
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
