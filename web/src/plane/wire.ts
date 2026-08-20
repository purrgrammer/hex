/**
 * Reading the wire, once, for both planes.
 *
 * Local rows arrive already summarised by the daemon and remote ones arrive as
 * heads that have to be read tag by tag — and if those two readings disagree
 * about what `status` or `cost` means, the same session looks like two different
 * runs depending on which door you came in by. So the head reader lives here,
 * and the local plane's rows are shaped to match it rather than the other way
 * round.
 */

import type { SessionSummary, WireEvent } from "./types.ts";

export const KIND_AGENT_DEFINITION = 31779;
export const KIND_SESSION_HEAD = 31777;
export const KIND_TURN = 1777;
export const KIND_DELTA = 21777;
export const KIND_SESSION_CONTROL = 1779;

export function tag(event: WireEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

export function tags(event: WireEvent, name: string): string[][] {
  return event.tags.filter((t) => t[0] === name);
}

function int(value: string | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `[usage, input, output, cacheRead, cacheWrite]`, all optional in practice. */
export function usageOf(event: WireEvent): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const usage = event.tags.find((t) => t[0] === "usage");
  return {
    input: int(usage?.[1]),
    output: int(usage?.[2]),
    cacheRead: int(usage?.[3]),
    cacheWrite: int(usage?.[4]),
  };
}

/** `["cost", amount, currency, "estimated"?]` — the fourth element matters. */
export function costOf(
  event: WireEvent,
): { amount: string; currency: string; estimated: boolean } | undefined {
  const cost = event.tags.find((t) => t[0] === "cost");
  if (!cost?.[1]) return undefined;
  return {
    amount: cost[1],
    currency: cost[2] ?? "USD",
    estimated: cost[3] === "estimated",
  };
}

/** The subject pointers a run carries — what it is about. */
export function subjectsOf(event: WireEvent): string[][] {
  return event.tags.filter(
    (t) =>
      (t[0] === "a" || t[0] === "e" || t[0] === "r" || t[0] === "i") &&
      // The `a` that names the session itself is not a subject.
      !(t[0] === "a" && t[1]?.startsWith(`${KIND_SESSION_HEAD}:`)) &&
      // Neither is the `e` that names the message which triggered the run.
      !(t[0] === "e" && t[3] === "trigger"),
  );
}

/** A head, read as the row a list wants. */
export function sessionFromHead(head: WireEvent): SessionSummary {
  const cost = costOf(head);
  const usage = usageOf(head);
  const channelId = tag(head, "channel");
  const transport = tag(head, "transport");
  return {
    id: tag(head, "d") ?? head.id,
    title: tag(head, "title"),
    status: tag(head, "status") ?? "unknown",
    turn: int(tag(head, "turns")),
    seq: int(tag(head, "last-seq")),
    startedAt: int(tag(head, "started"), head.createdAt),
    endedAt: tag(head, "ended") ? int(tag(head, "ended")) : undefined,
    inTokens: usage.input,
    outTokens: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: cost ? `${cost.amount} ${cost.currency}` : undefined,
    pending: tags(head, "input")
      .map((t) => t[1])
      .filter((id): id is string => !!id),
    channel: transport ? { transport, id: channelId } : undefined,
    subjects: subjectsOf(head),
    model: tag(head, "model"),
  };
}

/**
 * Which run an event belongs to, as the wire names it.
 *
 * The same rule the daemon files by: a head IS its `d`, everything else points
 * at one with an `a`.
 */
export function sessionOf(event: WireEvent): string | undefined {
  if (event.sessionId) return event.sessionId;
  if (event.kind === KIND_SESSION_HEAD) return tag(event, "d");
  for (const t of event.tags) {
    if (t[0] !== "a" || !t[1]) continue;
    const [kind, , session] = t[1].split(":");
    if (Number(kind) === KIND_SESSION_HEAD && session) return session;
  }
  return undefined;
}

export function kindName(kind: number): string {
  switch (kind) {
    case KIND_AGENT_DEFINITION:
      return "definition";
    case KIND_SESSION_HEAD:
      return "head";
    case KIND_TURN:
      return "turn";
    case KIND_DELTA:
      return "delta";
    case KIND_SESSION_CONTROL:
      return "control";
    default:
      return `kind ${kind}`;
  }
}

// ── Turn content ────────────────────────────────────────────────────────────

export interface TextPart {
  type: "text";
  text: string;
}
export interface ReasoningPart {
  type: "reasoning";
  text: string;
}
export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown> | null;
  arguments_digest?: string;
}
export interface ToolResultPart {
  type: "tool_result";
  id: string;
  name: string;
  ok: boolean;
  output: string | null;
}
export interface InputRequestPart {
  type: "input_request";
  requestId: string;
  prompt: string;
  requestKind?: string;
  display?: string;
  allowFreeform?: boolean;
  options?: { id: string; label: string; description?: string; style?: string }[];
  tool?: { name: string; callId?: string };
}
export interface InputResolvedPart {
  type: "input_resolved";
  requestId: string;
  outcome: string;
  response?: { optionId?: string; text?: string };
}
export interface ImagePart {
  type: "image";
  url: string;
  mime: string;
}
export type TurnPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | InputRequestPart
  | InputResolvedPart
  | ImagePart
  | { type: string; [key: string]: unknown };

/**
 * A turn's parts.
 *
 * The list is open by protocol: a part from a later revision must not stop the
 * parts around it from rendering, so anything unreadable comes back as an empty
 * turn rather than as an exception that blanks the page.
 */
export function partsOf(event: WireEvent): TurnPart[] {
  if (!event.content) return [];
  try {
    const parsed: unknown = JSON.parse(event.content);
    return Array.isArray(parsed) ? (parsed as TurnPart[]) : [];
  } catch {
    return [];
  }
}

export function roleOf(event: WireEvent): "user" | "assistant" | "tool" {
  const role = tag(event, "role");
  return role === "user" || role === "tool" ? role : "assistant";
}
