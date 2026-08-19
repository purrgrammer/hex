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
 */

import type { EveEnvelope } from "./types.js";

export interface StreamOptions {
  /** e.g. `http://127.0.0.1:2000`. */
  host: string;
  sessionId: string;
  /** Resume here. Omit to read from the beginning. */
  startIndex?: number;
  /** Keep the connection open for events that have not happened yet. */
  follow?: boolean;
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
  if (options.follow === false) url.searchParams.set("follow", "0");
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
    }
  }
}
