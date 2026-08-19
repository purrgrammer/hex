/**
 * The part of Eve's session stream this package reads.
 *
 * Structural, and deliberately not imported from `eve`: the stream is a
 * documented NDJSON protocol surface, so a publisher that speaks it works
 * against any Eve host without taking a framework as a dependency. The shapes
 * below are copied from `eve@0.39`'s own `protocol/message.d.ts`; anything this
 * file does not name is ignored rather than rejected, because a runtime is free
 * to emit events a consumer has never heard of.
 */

/** Every event carries this envelope. `meta.id` is an `evt_`-prefixed ULID. */
export interface EveEnvelope {
  type: string;
  data?: unknown;
  meta?: { id?: string; at?: string };
}

/** Eve's own finish reasons, from `AssistantStepFinishReason`. */
export type EveFinishReason =
  | "content-filter"
  | "error"
  | "length"
  | "other"
  | "stop"
  | "tool-calls";

export interface EveUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** One action Eve asked for. Only `tool-call` becomes a tool part. */
export interface EveActionRequest {
  kind?: string;
  callId?: string;
  toolName?: string;
  name?: string;
  input?: unknown;
}

export interface EveActionResult {
  kind?: string;
  callId?: string;
  toolName?: string;
  output?: unknown;
  isError?: boolean;
}

/** A reader for the fields this publisher needs, tolerant of what it does not. */
export function payload(event: EveEnvelope): Record<string, unknown> {
  return event.data && typeof event.data === "object"
    ? (event.data as Record<string, unknown>)
    : {};
}

export function stringField(
  data: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = data[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Eve's finish reason, as this NIP's `stop`.
 *
 * `other` has no honest equivalent, so it is omitted rather than guessed at —
 * a turn with no `stop` says nothing about why it ended, which is true.
 */
export function stopFor(
  reason: string | undefined,
):
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "content_filter"
  | "error"
  | undefined {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
      return "content_filter";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

/** Eve counts tokens in its own fields; the NIP wants four numbers in order. */
export function usageFor(
  raw: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as EveUsage;
  const numbers = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ];
  if (numbers.every((value) => value === undefined)) return undefined;
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  };
}

/** Tool output is JSON; a transcript shows text. */
export function outputText(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
