/**
 * Building agent-session events (NIP-xx: Agent Sessions).
 *
 * Every function returns an unsigned rumor with its id filled in. Nothing here
 * signs, encrypts, or publishes — a channel does that, and which envelope it
 * uses is the channel's business, not the encoding's.
 */

import { getEventHash } from "nostr-tools";

import {
  KIND_AGENT_DEFINITION,
  KIND_DELTA,
  KIND_SESSION_HEAD,
  KIND_TURN,
} from "./kinds.js";
import { isKnownPart } from "./types.js";
import type {
  AgentDefinitionInput,
  AgentToolSpec,
  AgentTurnInput,
  Cost,
  DeltaInput,
  Rumor,
  SessionHeadInput,
  SessionRef,
  UnsignedRumor,
  Usage,
} from "./types.js";

/** What revision of the definition's shape an event was written to. */
export const DEFINITION_VERSION = 1;

/**
 * `["tool", name, description, parameters]` — trailing elements are dropped when
 * absent, so a bare tool is a two-element tag and a fully described one is four.
 */
function toolTag(tool: AgentToolSpec): string[] {
  const tag = ["tool", tool.name];
  if (tool.parameters !== undefined)
    return [...tag, tool.description ?? "", JSON.stringify(tool.parameters)];
  if (tool.description) return [...tag, tool.description];
  return tag;
}

/** The address every event in a session points at. */
export function sessionAddress(agent: string, session: string): string {
  return `${KIND_SESSION_HEAD}:${agent}:${session}`;
}

/** The address of an agent's definition. */
export function definitionAddress(agent: string, slug: string): string {
  return `${KIND_AGENT_DEFINITION}:${agent}:${slug}`;
}

/** Parse `31777:<agent>:<session>` back. Returns null on anything else. */
export function parseSessionAddress(
  value: string,
): { kind: number; agent: string; session: string } | null {
  const parts = value.split(":");
  if (parts.length !== 3) return null;
  const kind = Number(parts[0]);
  const [, agent, session] = parts;
  if (!Number.isInteger(kind) || !agent || !session) return null;
  if (!/^[0-9a-f]{64}$/.test(agent)) return null;
  return { kind, agent, session };
}

function stamp(rumor: UnsignedRumor): Rumor {
  return {
    ...rumor,
    id: getEventHash(rumor as Parameters<typeof getEventHash>[0]),
  };
}

function now(override?: number): number {
  return override ?? Math.floor(Date.now() / 1000);
}

function usageTag(usage: Usage): string[] {
  return [
    "usage",
    String(usage.input),
    String(usage.output),
    String(usage.cacheRead),
    String(usage.cacheWrite),
  ];
}

function costTag(cost: Cost): string[] {
  return ["cost", cost.amount, cost.currency];
}

function sessionTag(session: SessionRef): string[] {
  const tag = ["a", sessionAddress(session.agent, session.session)];
  if (session.relay) tag.push(session.relay);
  return tag;
}

function cursorTags(seq: number, prev?: string): string[][] {
  const tags = [["seq", String(seq)]];
  if (seq > 1) {
    if (!prev)
      throw new Error(
        `agent-session: seq ${seq} needs a prev; only seq 1 may omit it`,
      );
    tags.push(["prev", prev]);
  }
  return tags;
}

// ── Turn ─────────────────────────────────────────────────────────────────────

export function buildTurn(
  agentPubkey: string,
  session: SessionRef,
  input: AgentTurnInput,
  cursor: { seq: number; prev?: string },
  operator: { pubkey: string; relay?: string },
): Rumor {
  const tools = new Set<string>();
  for (const part of input.parts) {
    if (!isKnownPart(part)) continue;
    if (part.type === "tool_call" || part.type === "tool_result")
      tools.add(part.name);
  }

  const tags: string[][] = [
    sessionTag(session),
    ...cursorTags(cursor.seq, cursor.prev),
    ["turn", String(input.turn)],
    ["role", input.role],
    ["p", operator.pubkey, operator.relay ?? "", "operator"],
  ];

  if (input.stop) tags.push(["stop", input.stop]);
  if (input.model)
    tags.push([
      "model",
      input.model.id,
      ...(input.model.provider ? [input.model.provider] : []),
    ]);
  if (input.usage) tags.push(usageTag(input.usage));
  if (input.cost) tags.push(costTag(input.cost));
  for (const tool of tools) tags.push(["tool", tool]);
  if (input.alt) tags.push(["alt", input.alt]);

  return stamp({
    kind: KIND_TURN,
    pubkey: agentPubkey,
    created_at: now(input.createdAt),
    tags,
    content: JSON.stringify(input.parts),
  });
}

// ── Delta ────────────────────────────────────────────────────────────────────

/** Ephemeral. Ordered by `part` within its turn — deltas never consume `seq`. */
export function buildDelta(
  agentPubkey: string,
  session: SessionRef,
  input: DeltaInput,
  operator: { pubkey: string; relay?: string },
): Rumor {
  if (input.delta === "tool" && !input.toolId)
    throw new Error("agent-session: a tool delta needs a tool-id");

  const tags: string[][] = [
    sessionTag(session),
    ["turn", String(input.turn)],
    ["part", String(input.part)],
    ["delta", input.delta],
    ["p", operator.pubkey, operator.relay ?? "", "operator"],
  ];
  if (input.toolId) tags.push(["tool-id", input.toolId]);

  return stamp({
    kind: KIND_DELTA,
    pubkey: agentPubkey,
    created_at: now(input.createdAt),
    tags,
    content: input.delta === "heartbeat" ? "" : input.text,
  });
}

// ── Session head ─────────────────────────────────────────────────────────────

/**
 * The head takes NO `seq` of its own.
 *
 * It is addressable, so a public relay deletes the version it supersedes. A
 * head that consumed a sequence number would leave that number nowhere on the
 * relay, and every later reader would see a permanent hole it is told to try to
 * fill and never can — the same reason deltas do not take one.
 */
export function buildSessionHead(
  agentPubkey: string,
  sessionId: string,
  input: SessionHeadInput,
): Rumor {
  const tags: string[][] = [
    ["d", sessionId],
    ["title", input.title],
    ["status", input.status],
    ["p", input.operator.pubkey, input.operator.relay ?? "", "operator"],
  ];

  for (const observer of input.observers ?? [])
    tags.push(["p", observer.pubkey, observer.relay ?? "", "observer"]);
  if (input.trigger)
    tags.push(["e", input.trigger.id, input.trigger.relay ?? "", "trigger"]);
  tags.push(["last-seq", String(input.lastSeq)]);
  tags.push(["started", String(input.started)]);
  if (input.ended !== undefined) tags.push(["ended", String(input.ended)]);
  if (input.model)
    tags.push([
      "model",
      input.model.id,
      ...(input.model.provider ? [input.model.provider] : []),
    ]);
  if (input.usage) tags.push(usageTag(input.usage));
  if (input.cost) tags.push(costTag(input.cost));
  if (input.definition) tags.push(["agent", input.definition]);
  if (input.alt) tags.push(["alt", input.alt]);

  return stamp({
    kind: KIND_SESSION_HEAD,
    pubkey: agentPubkey,
    created_at: now(input.createdAt),
    tags,
    content: "",
  });
}

// ── Agent definition ─────────────────────────────────────────────────────────

export function buildAgentDefinition(
  agentPubkey: string,
  input: AgentDefinitionInput,
): Rumor {
  const tags: string[][] = [
    ["d", input.slug],
    ["v", String(DEFINITION_VERSION)],
    ["name", input.name],
  ];
  if (input.picture) tags.push(["picture", input.picture]);
  if (input.about) tags.push(["about", input.about]);
  for (const tool of input.tools ?? []) tags.push(toolTag(tool));
  for (const suggestion of input.suggestions ?? [])
    tags.push(["try", suggestion]);
  if (input.alt) tags.push(["alt", input.alt]);

  // The content IS the system prompt. Nothing wraps it, so anyone reading the
  // raw event reads what the agent was told; a shape change is a `v` bump.
  return stamp({
    kind: KIND_AGENT_DEFINITION,
    pubkey: agentPubkey,
    created_at: now(input.createdAt),
    tags,
    content: input.instructions ?? "",
  });
}
