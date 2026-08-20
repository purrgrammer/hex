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

import { streamSession } from "../eve/stream.js";
import { readAgentInfo } from "../eve/info.js";
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
}

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

  private path(session: string): string {
    return `/eve/v1/session/${encodeURIComponent(session)}`;
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(
      new URL(path, this.options.host).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: this.options.signal,
      },
    );
    if (!response.ok)
      throw new Error(`eve ${path}: ${response.status} ${response.statusText}`);
    return (await response.json()) as Record<string, unknown>;
  }
}
