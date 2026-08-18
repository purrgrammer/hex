/**
 * Any chat-completions endpoint: OpenAI, a local llama.cpp, OpenRouter, Routstr.
 *
 * Deliberately the smallest possible client — one POST, no streaming, no tool
 * calls yet. What matters here is that a misconfigured provider says so out
 * loud: a bot whose key is wrong must not look like a bot that had nothing to
 * add, so an HTTP failure throws rather than returning `null` (which means
 * "stay silent" and is a legitimate answer).
 *
 * The API key is read from the environment by name. It is never logged, never
 * put in an error message, and never written into the config file.
 */

import type { Brain, BrainRequest, ContextMessage } from "./types.js";

export interface OpenAICompatibleOptions {
  /** e.g. `https://api.openai.com/v1` — with or without a trailing slash. */
  baseUrl: string;
  model: string;
  /** Sent as `Authorization: Bearer …`. Omitted entirely when absent. */
  apiKey?: string;
  /** Extra headers, already resolved from the environment. */
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** A reply is a chat message, so a slow provider must not hold a room open. */
export const BRAIN_TIMEOUT_MS = 60_000;

/** How much of a failed response body to quote back. */
const ERROR_BODY_LIMIT = 400;

/**
 * `new URL("chat/completions", base)` drops the last path segment unless the
 * base ends in a slash, which silently turns `…/v1` into `…/chat/completions`
 * and produces a 404 that looks like a broken provider.
 */
export function completionsUrl(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", base).toString();
}

interface ChatMessage {
  role: "system" | "assistant" | "user";
  content: string;
}

/**
 * Turn a room into a conversation.
 *
 * Every prior message becomes a `user` turn labelled with its author, including
 * Hex's own: a group is not a two-party chat, and collapsing five people into an
 * unlabelled `user` role loses who asked what. Hex's own lines are labelled
 * `assistant` so it can tell what it already said.
 */
export function buildMessages(
  request: BrainRequest,
  selfPubkey?: string,
): ChatMessage[] {
  const label = (message: ContextMessage) =>
    message.name ?? `${message.author.slice(0, 8)}…`;

  const history: ChatMessage[] = request.history.map((message) =>
    selfPubkey && message.author === selfPubkey
      ? { role: "assistant", content: message.text }
      : { role: "user", content: `${label(message)}: ${message.text}` },
  );

  const incoming = request.incoming;
  return [
    { role: "system", content: request.instructions },
    ...history,
    {
      role: "user",
      content: `${incoming.author.slice(0, 8)}…: ${incoming.text}`,
    },
  ];
}

export class OpenAICompatibleBrain implements Brain {
  readonly name = "openai-compatible";

  constructor(
    private readonly options: OpenAICompatibleOptions,
    private readonly selfPubkey?: string,
  ) {}

  async respond(request: BrainRequest): Promise<string | null> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = completionsUrl(this.options.baseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.options.headers,
    };
    if (this.options.apiKey)
      headers.Authorization = `Bearer ${this.options.apiKey}`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: buildMessages(request, this.selfPubkey),
          ...(this.options.maxTokens !== undefined
            ? { max_tokens: this.options.maxTokens }
            : {}),
          ...(this.options.temperature !== undefined
            ? { temperature: this.options.temperature }
            : {}),
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? BRAIN_TIMEOUT_MS),
      });
    } catch (error) {
      // The URL is in the message; the key never is.
      throw new Error(
        `brain request to ${url} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(
        0,
        ERROR_BODY_LIMIT,
      );
      throw new Error(
        `brain request to ${url} returned ${response.status} ${response.statusText}${
          body ? `: ${body}` : ""
        }`,
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const trimmed = content.trim();
    // An empty completion is silence, not an empty chat message.
    return trimmed === "" ? null : trimmed;
  }
}
