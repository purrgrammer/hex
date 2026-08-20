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
  KIND_SESSION_CONTROL,
  KIND_SESSION_HEAD,
  KIND_TURN,
} from "./kinds.js";
import { isKnownPart } from "./types.js";
import type {
  RepositorySpec,
  AgentDefinitionInput,
  AgentToolSpec,
  AgentTurnInput,
  Cost,
  DeltaInput,
  Rumor,
  SessionControlInput,
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
  // A fourth element, so a reader that only looks at [1] and [2] is unaffected
  // and one that cares can tell a bill from arithmetic.
  return cost.estimated
    ? ["cost", cost.amount, cost.currency, "estimated"]
    : ["cost", cost.amount, cost.currency];
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
  for (const child of input.subagents ?? [])
    tags.push([
      "subagent",
      child.callId,
      child.session,
      ...(child.name ? [child.name] : []),
    ]);
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

// ── Session control ─────────────────────────────────────────────────────────

/**
 * An instruction to a running session, authored by its operator.
 *
 * The `a` tag is the session it acts on and the `p` tag is the agent that must
 * act — both, because the agent finds it by `p` and files it by `a`. Authorship
 * is the whole security story: a reader MUST check this event's author against
 * the `operator` on the session's own head before honouring a word of it.
 */
export function buildSessionControl(
  operatorPubkey: string,
  session: SessionRef,
  input: SessionControlInput,
): Rumor {
  const tags: string[][] = [
    sessionTag(session),
    ["p", session.agent],
    ["command", input.command],
  ];

  if (input.request) tags.push(["request", input.request]);
  if (input.turn) tags.push(["turn", input.turn]);
  if (input.option) tags.push(["option", input.option]);
  if (input.policy) tags.push(["policy", input.policy]);
  /**
   * What a `start` is about, after the address that says which session it IS.
   *
   * Same shape as on a head, so a reader that already knows how to render a
   * run's subjects renders the request for one without learning anything new.
   */
  for (const subject of input.subjects ?? [])
    if (subject[0] && subject[1]) tags.push(subject);
  tags.push(["alt", input.alt ?? `Session control: ${input.command}`]);

  return stamp({
    kind: KIND_SESSION_CONTROL,
    pubkey: operatorPubkey,
    created_at: now(input.createdAt),
    tags,
    // Free text belongs in content rather than a tag: a steer is a message, and
    // a message is the one thing this family always puts in content.
    content: input.text ?? "",
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
  // Exchanges, which is what a person means by "turns" — `last-seq` counts
  // events, and one question with a tool call is four of those.
  if (input.turns !== undefined) tags.push(["turns", String(input.turns)]);
  tags.push(["started", String(input.started)]);
  if (input.ended !== undefined) tags.push(["ended", String(input.ended)]);
  if (input.model)
    tags.push([
      "model",
      input.model.id,
      ...(input.model.provider ? [input.model.provider] : []),
    ]);
  /**
   * Where this run is happening, in two parts.
   *
   * `transport` is the protocol — a reader that knows what a NIP-29 group is
   * can offer to open one, and a reader that does not can at least say what it
   * cannot show. `channel` is the room within it, in that protocol's own
   * notation: a pubkey for a NIP-17 conversation, `<relay>'<group-id>` for a
   * NIP-29 group, exactly as NIP-29 writes a group identifier.
   *
   * Unindexed. A single-letter tag would let a relay group every session an
   * agent ran in one room, which is a social graph the gift wrap exists to
   * withhold — and no reader needs to query by it, since a reader holding the
   * head already holds the session.
   */
  if (input.channel) {
    tags.push(["transport", input.channel.transport]);
    if (input.channel.id) tags.push(["channel", input.channel.id]);
  }
  /**
   * What the run is about, copied from the message that started it.
   *
   * The pointer, not a paraphrase: a reader asking "which runs touched this
   * repository" wants an `a` to match on, and a title is not one.
   */
  for (const subject of input.subjects ?? [])
    if (subject[0] && subject[1]) tags.push([subject[0], subject[1]]);
  if (input.usage) tags.push(usageTag(input.usage));
  if (input.cost) tags.push(costTag(input.cost));
  // What the run is blocked on. Indexable would leak to a relay that a session
  // is stuck and when, which the wrap exists to hide; unindexed is enough,
  // because a reader holding the head already holds the session.
  for (const requestId of input.pending ?? []) tags.push(["input", requestId]);
  for (const url of input.deltaRelays ?? []) tags.push(["delta-relay", url]);
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
  /**
   * What the agent has checked out, and where.
   *
   * `["repo", name, url, path, description]`, positional, with empty strings
   * for what is not known — a reader indexing by position must not have a
   * missing url shift the path into its place.
   *
   * The PATH is the part worth carrying. A client offering "start a run on
   * grimoire" has to name a directory the agent will recognise, and one it
   * guessed at produces a prompt the agent quietly ignores.
   */
  for (const repo of input.repositories ?? [])
    tags.push([
      "repo",
      repo.name,
      repo.url ?? "",
      repo.path ?? "",
      repo.description ?? "",
    ]);
  if (input.model)
    tags.push([
      "model",
      input.model.id,
      // Positional, with an empty string rather than a gap, so a reader
      // indexing by position cannot mistake a missing window for one.
      input.model.contextWindow ? String(input.model.contextWindow) : "",
    ]);
  for (const recipient of input.recipients ?? []) tags.push(["p", recipient]);
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
