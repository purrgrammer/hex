/**
 * What a brain is allowed to DO, as opposed to what it returns.
 *
 * Delivery is a tool call. The brain decides to speak by calling `chat.respond`;
 * the runtime binds that call to the room the message came from and hands it to
 * whichever transport owns that room. Neither side knows the other's protocol —
 * the brain never sees a relay, and the transport never sees a model.
 *
 * Tools are named `<namespace>.<action>`, matching the in-app assistant's
 * registry: `grimoire.*` acts on the application and its docs, `nostr.*` on the
 * network, `chat.*` on the room this turn is in. The ids are a contract — a
 * published agent definition names tools by them — so renaming one breaks
 * anything that referred to it.
 *
 * The seam matters beyond tidiness: it is how a sandboxed coding agent will get
 * to run anything later, so every call is attributable to a room and a requesting
 * pubkey, and bounded, from the start.
 */

import type { Room } from "../transports/types.js";

export type ToolNamespace = "chat" | "grimoire" | "nostr";

export interface ToolSpec {
  /** Canonical id, `<namespace>.<action>`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  /** One line for the system prompt, telling the model when to reach for it. */
  prompt: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** What the brain is told came of it. Fed back as the tool's result. */
  output: string;
}

export interface ToolHost {
  /** Who asked, and where. An unattributable call is not authorized. */
  readonly room: Room;
  readonly requestedBy: string;
  list(): ToolSpec[];
  call(call: ToolCall): Promise<ToolResult>;
  /** Whether anything was actually delivered to the room this turn. */
  readonly delivered: boolean;
}

/** The tool every transport provides, because a turn that says nothing is moot. */
export const RESPOND_TOOL = "chat.respond";
/** Optional: a transport with no reactions simply does not offer it. */
export const REACT_TOOL = "chat.react";
/** NIPs, kinds — grimoire's own documentation, fetched rather than recalled. */
export const HELP_TOOL = "grimoire.help";
/** A REQ against relays. Read-only. */
export const REQ_TOOL = "nostr.req";
/** A bech32 entity turned into the person or event it names. */
export const RESOLVE_TOOL = "nostr.resolve";

/**
 * The name a provider sees.
 *
 * A dot is not portable: OpenAI-shaped function names are
 * `^[a-zA-Z0-9_-]{1,64}$`, so the namespace travels as an underscore while the
 * canonical id — what the prompt says and what a published agent would name —
 * keeps its dot.
 */
export function wireName(id: string): string {
  return id.replace(".", "_");
}

/** The canonical id for whatever a model called, wire name or id already. */
export function canonicalId(name: string, specs: ToolSpec[]): string {
  const byWire = specs.find((spec) => wireName(spec.name) === name);
  return byWire?.name ?? name;
}

/** The tool paragraph of the system prompt, so prose cannot drift from schema. */
export function describeTools(specs: ToolSpec[]): string {
  return specs.map((spec) => spec.prompt).join(" ");
}
