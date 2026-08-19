/**
 * Any chat-completions endpoint: OpenAI, a local llama.cpp, OpenRouter, Routstr.
 *
 * The turn is a tool-calling loop. The model may think, may call tools, and
 * speaks by calling `respond` — so a "thought" and an "answer" are different acts
 * rather than the same string interpreted differently. The loop runs until the
 * model stops calling tools or `maxSteps` is reached, whichever comes first.
 *
 * What matters here is that a misconfigured provider says so out loud: a bot whose
 * key is wrong must not look like a bot that had nothing to add, so an HTTP
 * failure throws. The API key is read from the environment by name, never logged,
 * never in an error message, never in the config file.
 */

import type {
  Brain,
  BrainRequest,
  ContextMessage,
  TurnOutcome,
} from "./types.js";
import { RESPOND_TOOL, wireName, type ToolSpec } from "../tools/types.js";
import { buildSystemPrompt } from "../prompt.js";

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
  /** Round trips per turn, including the one that answers. */
  maxSteps?: number;
  /**
   * `auto` lets the model choose between a tool call and prose; `required` makes
   * it call one.
   *
   * Not every endpoint accepts `required`, so `auto` is the compatible default —
   * but with `auto` a model that has not internalised the contract answers in
   * prose and lands in the fallback. `required` is what makes the tool path
   * actually happen, at the cost of a turn that can no longer say nothing.
   */
  toolChoice?: "auto" | "required";
  /**
   * Deliver a plain-text answer that never called `respond`.
   *
   * On by default and logged when it fires: a model that forgot the tool has
   * still produced an answer, and dropping it means silence in the room, which is
   * the worse failure. Turn it off to make the tool contract strict.
   */
  deliverPlainText?: boolean;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** A reply is a chat message, so a slow provider must not hold a room open. */
export const BRAIN_TIMEOUT_MS = 60_000;

/** Round trips per turn. Enough to think, act, and read the result. */
export const DEFAULT_MAX_STEPS = 4;

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

/**
 * One signal from two reasons to stop.
 *
 * `AbortSignal.any` is available from Node 20.3 and this package requires ≥24,
 * so no fallback — but it is wrapped rather than inlined because a request with
 * no turn signal must keep exactly its old behaviour.
 */
function withTurnSignal(timeout: AbortSignal, turn?: AbortSignal): AbortSignal {
  return turn ? AbortSignal.any([timeout, turn]) : timeout;
}

interface ToolCallWire {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role: "system" | "assistant" | "user" | "tool";
  content: string | null;
  tool_calls?: ToolCallWire[];
  tool_call_id?: string;
}

/** Tool specs in the wire's shape. */
export function toWireTools(specs: ToolSpec[]) {
  return specs.map((spec) => ({
    type: "function" as const,
    function: {
      // A dot is not a portable function name; the id keeps it, the wire does not.
      name: wireName(spec.name),
      description: spec.description,
      parameters: spec.parameters,
    },
  }));
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

  // One system message, built from the operator's instructions plus the
  // runtime's rules and the tool paragraph the registry generates.
  return [
    {
      role: "system",
      content: buildSystemPrompt(request.instructions, request.tools.list()),
    },
    ...history,
    {
      role: "user",
      content: `${request.incoming.author.slice(0, 8)}…: ${request.incoming.text}`,
    },
  ];
}

/** Arguments arrive as a JSON string, and a model can get that wrong. */
function parseArguments(raw: string | undefined): {
  args: Record<string, unknown>;
  error?: string;
} {
  if (!raw || raw.trim() === "") return { args: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { args: {}, error: "arguments must be a JSON object" };
    return { args: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      args: {},
      error: `arguments were not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Tell a listener something, and never let it break the turn.
 *
 * An observer is a bystander: a transcript publisher, a log. If one throws, the
 * work it was watching must still finish.
 */
function safely(report: () => void): void {
  try {
    report();
  } catch {
    // A listener's problem is not the turn's problem.
  }
}

export class OpenAICompatibleBrain implements Brain {
  readonly name = "openai-compatible";

  constructor(
    private readonly options: OpenAICompatibleOptions,
    private readonly selfPubkey?: string,
  ) {}

  async turn(request: BrainRequest): Promise<TurnOutcome> {
    const log = this.options.log ?? (() => {});
    const messages = buildMessages(request, this.selfPubkey);
    const tools = toWireTools(request.tools.list());
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;

    /** Abandoned mid-turn. Reported as an outcome, never as a failure. */
    const cancelled = (): TurnOutcome => ({
      delivered: request.tools.delivered,
      note: "cancelled",
    });

    for (let step = 0; step < maxSteps; step += 1) {
      if (request.signal?.aborted) return cancelled();

      let choice: ChatMessage;
      try {
        choice = await this.complete(messages, tools, request.signal);
      } catch (error) {
        // An aborted fetch is not a broken provider. Distinguishing them keeps
        // the agent's FAILED line meaning "something is wrong".
        if (request.signal?.aborted) return cancelled();
        throw error;
      }
      const calls = choice.tool_calls ?? [];

      // Whatever prose this step produced is the model reasoning, not what it
      // says to the room — that only ever happens through a tool.
      const prose = (choice.content ?? "").trim();
      if (prose) safely(() => request.observer?.thinking?.(prose));

      if (calls.length === 0) {
        const text = (choice.content ?? "").trim();
        if (!text)
          // Nothing said and nothing done: the model stayed out of it.
          return { delivered: request.tools.delivered, note: "stayed quiet" };

        if (request.tools.delivered)
          // It already spoke through the tool; trailing prose is thinking.
          return { delivered: true, note: "answered, then thought aloud" };

        if (this.options.deliverPlainText === false)
          return {
            delivered: false,
            note: "produced text but never called respond",
          };

        log(
          "[hex] the model answered without calling respond — delivering its text anyway",
        );
        safely(() =>
          request.observer?.toolCall?.({
            id: RESPOND_TOOL,
            name: RESPOND_TOOL,
            arguments: { text },
          }),
        );
        const result = await request.tools.call({
          name: RESPOND_TOOL,
          arguments: { text },
        });
        return {
          delivered: request.tools.delivered,
          note: `plain-text fallback: ${result.output}`,
        };
      }

      // Record the assistant's own turn before its results, or the next request
      // is a conversation where tool results answer nothing.
      messages.push({
        role: "assistant",
        content: choice.content ?? null,
        tool_calls: calls,
      });

      for (const call of calls) {
        const name = call.function?.name ?? "";
        const id = call.id ?? name;
        const { args, error } = parseArguments(call.function?.arguments);
        safely(() =>
          request.observer?.toolCall?.({ id, name, arguments: args ?? null }),
        );
        const result = error
          ? { ok: false, output: error }
          : await request.tools.call({ name, arguments: args });
        safely(() =>
          request.observer?.toolResult?.({
            id,
            name,
            ok: result.ok,
            output: result.output,
          }),
        );

        // One line per call, so "did it look anything up?" is answerable from the
        // log rather than by inference from the answer's quality.
        log(
          `[hex] tool ${name} ${result.ok ? "ok" : "refused"} — ${result.output.slice(0, 120)}`,
        );

        messages.push({
          role: "tool",
          tool_call_id: call.id ?? name,
          content: result.output,
        });

        // A model that asked for three things in one step must not get the last
        // two run after someone said stop.
        if (request.signal?.aborted) break;
      }

      if (request.signal?.aborted) return cancelled();

      // Answering is terminal. Continuing after a delivered reply spends round
      // trips to produce, at best, prose nobody will read — and at worst a second
      // message in the room.
      if (request.tools.delivered)
        return { delivered: true, note: `answered in ${step + 1} step(s)` };
    }

    return {
      delivered: request.tools.delivered,
      note: request.tools.delivered
        ? `stopped after ${maxSteps} steps`
        : `gave up after ${maxSteps} steps without answering`,
    };
  }

  /** One round trip. Returns the assistant's message. */
  private async complete(
    messages: ChatMessage[],
    tools: ReturnType<typeof toWireTools>,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
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
          messages,
          ...(tools.length > 0
            ? { tools, tool_choice: this.options.toolChoice ?? "auto" }
            : {}),
          ...(this.options.maxTokens !== undefined
            ? { max_tokens: this.options.maxTokens }
            : {}),
          ...(this.options.temperature !== undefined
            ? { temperature: this.options.temperature }
            : {}),
        }),
        // The timeout bounds a slow provider; the turn's signal bounds someone
        // who changed their mind. Either one ends this request.
        signal: withTurnSignal(
          AbortSignal.timeout(this.options.timeoutMs ?? BRAIN_TIMEOUT_MS),
          signal,
        ),
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
      choices?: { message?: ChatMessage }[];
    };
    const message = payload.choices?.[0]?.message;
    return message ?? { role: "assistant", content: null };
  }
}
