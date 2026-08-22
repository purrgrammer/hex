/**
 * The Eve runtime, behind the port.
 *
 * Every `/eve/v1/…` string in this package used to be somewhere else — spread
 * through the publisher, which therefore knew the shape of one backend's HTTP
 * API as well as it knew Nostr. They are all here now, and this is the only file
 * that has to change when Eve's routes do.
 *
 * Nothing clever: each method is the route it names. The value is the boundary,
 * not the code inside it.
 */

import { streamSession, streamTailIndex } from "../eve/stream.js";
import { readAgentInfo } from "../eve/info.js";
import {
  RuntimeHttpError,
  RuntimeTimeoutError,
  RuntimeUnreachableError,
  neverLanded,
} from "./errors.js";
import type {
  IndexedRuntimeEvent,
  InputResponse,
  Runtime,
  RuntimeDescription,
} from "./types.js";

export interface EveRuntimeOptions {
  /** e.g. `http://127.0.0.1:2000`. */
  host: string;
  fetchImpl?: typeof fetch;
  /** Shuts down every in-flight read and post at once. */
  signal?: AbortSignal;
  /**
   * How long a POST may go unanswered. Never applied to the stream, which is a
   * live follow and is supposed to stay quiet.
   */
  postTimeoutMs?: number;
  /** How many times a POST that never landed is repeated, the first included. */
  attempts?: number;
  /** The wait before the second attempt; each one after that doubles it. */
  retryDelayMs?: number;
  /** Test seam for that wait. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Long enough that a slow model call is not mistaken for a wedge, short enough
 * that a wedge does not hold a lane for the rest of the day.
 */
const POST_TIMEOUT_MS = 30_000;

/**
 * Four attempts over roughly seven seconds, which covers an `eve dev` rebuild.
 * Past that the message is better refused loudly than held.
 */
const ATTEMPTS = 4;
const RETRY_DELAY_MS = 500;

export class EveRuntime implements Runtime {
  readonly name = "eve";

  constructor(private readonly options: EveRuntimeOptions) {}

  /** Where this runtime lives, for the one caller that builds its own URL. */
  get host(): string {
    return this.options.host;
  }

  async open(input: { message: string; context?: string[] }): Promise<string> {
    const response = await this.post("/eve/v1/session", {
      message: input.message,
      ...(input.context?.length ? { clientContext: input.context } : {}),
    });
    const id =
      typeof response.sessionId === "string" ? response.sessionId : undefined;
    if (!id) throw new Error("eve accepted the message but named no session");
    return id;
  }

  async send(
    session: string,
    message: string,
    options?: { policy?: "queue" | "steer" },
  ): Promise<void> {
    await this.post(this.path(session), {
      message,
      // Passed on rather than left to the runtime: Eve's own default is to
      // cancel the running turn, and hex's is to queue behind it.
      ...(options?.policy ? { turnPolicy: options.policy } : {}),
    });
  }

  async respond(session: string, responses: InputResponse[]): Promise<void> {
    await this.post(this.path(session), {
      inputResponses: responses.map((response) => ({
        requestId: response.requestId,
        ...(response.optionId ? { optionId: response.optionId } : {}),
        ...(response.text ? { text: response.text } : {}),
      })),
    });
  }

  async cancel(session: string, turn?: string): Promise<void> {
    await this.post(
      `${this.path(session)}/cancel`,
      turn ? { turnId: turn } : {},
    );
  }

  async compact(session: string): Promise<void> {
    await this.post(`${this.path(session)}/compact`, {});
  }

  async clear(session: string): Promise<void> {
    await this.post(`${this.path(session)}/clear`, {});
  }

  async reset(session: string, reason?: string): Promise<void> {
    await this.post(`${this.path(session)}/reset`, reason ? { reason } : {});
  }

  async describe(): Promise<RuntimeDescription | undefined> {
    return await readAgentInfo({
      host: this.options.host,
      fetchImpl: this.options.fetchImpl,
      signal: this.options.signal,
    });
  }

  /**
   * Eve's stream, in hex's vocabulary.
   *
   * A pass-through, and the fact that it is one is the point: the names in
   * `runtime/events.ts` were derived from Eve's, so this driver has nothing to
   * translate. A driver for anything else translates here instead, and that
   * translation is the whole of its work — which is only possible because the
   * contract is written down somewhere other than inside the publisher.
   */
  follow(
    session: string,
    options: { startIndex?: number; signal?: AbortSignal },
  ): AsyncIterable<IndexedRuntimeEvent> {
    return streamSession({
      host: this.options.host,
      sessionId: session,
      startIndex: options.startIndex,
      signal: options.signal,
      fetchImpl: this.options.fetchImpl,
    });
  }

  async tailIndex(session: string, from?: number): Promise<number | undefined> {
    return await streamTailIndex({
      host: this.options.host,
      sessionId: session,
      from,
      signal: this.options.signal,
      fetchImpl: this.options.fetchImpl,
    });
  }

  private path(session: string): string {
    return `/eve/v1/session/${encodeURIComponent(session)}`;
  }

  /**
   * One POST, with a deadline, and repeated only when it cannot have happened.
   *
   * Three outcomes and they are not interchangeable. A status is the runtime's
   * own answer and is handed back as one. A refused connection means nothing
   * received the request, so it is safe to repeat — and worth repeating,
   * because the runtime restarts itself whenever `agent/` changes and every
   * message that arrives in that window would otherwise be lost: the queue row
   * is settled the moment a turn is dispatched, so there is nothing left to
   * retry it. A deadline that expires is NOT repeated, because a request that
   * went unanswered may still have landed, and a second `send` on a session
   * that already took the message is a turn the room reads twice.
   */
  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const attempts = Math.max(1, this.options.attempts ?? ATTEMPTS);
    const base = this.options.retryDelayMs ?? RETRY_DELAY_MS;
    const wait =
      this.options.wait ??
      ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(path, body);
      } catch (error) {
        // A shutdown is not an outage to wait out: once the caller has aborted,
        // there is nobody left to hand the answer to.
        const again =
          attempt < attempts &&
          neverLanded(error) &&
          this.options.signal?.aborted !== true;
        if (!again) throw error;
        await wait(base * 2 ** (attempt - 1));
      }
    }
  }

  private async attempt(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.postTimeoutMs ?? POST_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, deadline])
      : deadline;

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await doFetch(new URL(path, this.options.host).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // The caller's own shutdown is not a runtime failure; the deadline is.
      if (deadline.aborted && !this.options.signal?.aborted)
        throw new RuntimeTimeoutError(path, timeoutMs);
      throw neverLanded(error)
        ? new RuntimeUnreachableError(path, error)
        : error;
    }

    if (!response.ok) {
      // What the runtime SAID, not just what it returned. A 409 whose body
      // names the session is the difference between a diagnosis and a guess.
      const detail = await response
        .text()
        .then((text) => text.trim().slice(0, 300) || response.statusText)
        .catch(() => response.statusText);
      throw new RuntimeHttpError(response.status, path, detail);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
