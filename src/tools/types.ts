/**
 * What a runtime is allowed to DO, as opposed to what it returns.
 *
 * Delivery is a tool call. A runtime decides to speak by calling `chat.respond`;
 * this package binds that call to the room the message came from and hands it to
 * whichever transport owns that room. Neither side knows the other's protocol —
 * the runtime never sees a relay, and the transport never sees a model.
 *
 * Tools are named `<namespace>.<action>`, matching the in-app assistant's
 * registry: `grimoire.*` acts on the application and its docs, `nostr.*` on the
 * network, `chat.*` on the room this turn is in. The ids are a contract — a
 * published agent definition names tools by them — so renaming one breaks
 * anything that referred to it.
 *
 * The seam matters beyond tidiness: every call is attributable to a room and a
 * requesting pubkey, so a runtime driving these tools cannot act unattributably.
 */

import type { Room } from "../transports/types.js";

export type ToolNamespace = "chat" | "git" | "grimoire" | "nostr";

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
  /** What the caller is told came of it. Fed back as the tool's result. */
  output: string;
}

export interface ToolHost {
  /**
   * Who asked, and where.
   *
   * The room is absent for a run started over the control plane, which happens
   * in no room at all — its transcript IS the channel. A host with no room
   * offers no `chat.*`, so nothing that needs one can be called.
   */
  readonly room?: Room;
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
/**
 * Who is being spoken to, and where.
 *
 * A runtime is handed a message with no idea whose it is, so "check my recent
 * posts" sent it to fetch kind 1 from the whole network and summarise strangers.
 * The answer is one npub, which every other tool here already knows how to turn
 * into a person.
 */
export const WHO_TOOL = "chat.who";
/**
 * What was said before now.
 *
 * A runtime is handed one message. Everything the pair agreed three messages ago
 * is context it does not have and cannot ask for — so it either repeats itself
 * or invents what it was told.
 */
export const HISTORY_TOOL = "chat.history";
/**
 * NIPs and kinds, read rather than recalled.
 *
 * Named `nostr.help` because that is what it is: the protocol's own documents,
 * useful to any agent working on Nostr and not a feature of one client. It was
 * `grimoire.help` when this package was one application's assistant, and that
 * id still resolves so an existing grant and an already-published definition
 * keep meaning what they meant.
 */
export const HELP_TOOL = "nostr.help";
/** What `nostr.help` used to be called. Accepted, never offered. */
export const HELP_TOOL_LEGACY = "grimoire.help";
/** A REQ against relays. Read-only. */
export const REQ_TOOL = "nostr.req";
/** A bech32 entity turned into the person or event it names. */
export const RESOLVE_TOOL = "nostr.resolve";
/** Signing and publishing as the agent. Public, permanent, bounded. */
export const PUBLISH_TOOL = "nostr.publish";
export const SIGN_TOOL = "nostr.sign";
/** Putting a file somewhere a reader can fetch it. Off unless configured. */
export const UPLOAD_TOOL = "blossom.upload";
/**
 * A NIP-34 repository, as work rather than as events.
 *
 * Separate from `nostr.req` because three things have to be right at once and
 * none is guessable from a filter: which relays a repository's work is on, that
 * an issue's state is a SEPARATE event pointing back at it, and that only
 * maintainers and authors may set that state.
 */
export const GIT_ISSUES_TOOL = "git.issues";
export const GIT_PATCHES_TOOL = "git.patches";
/** Opening or closing one. A public, permanent, signed event. */
export const GIT_STATE_TOOL = "git.state";
/**
 * Every tool id that exists, so config can refuse one that does not.
 *
 * A grant naming `nostr.request` instead of `nostr.req` would parse, offer
 * nothing, and look like a model that would not use its tools — the same class
 * of silent misconfiguration `rejectUnknown` exists to catch.
 */
export const KNOWN_TOOLS: readonly string[] = [
  RESPOND_TOOL,
  REACT_TOOL,
  WHO_TOOL,
  HISTORY_TOOL,
  HELP_TOOL,
  REQ_TOOL,
  RESOLVE_TOOL,
  PUBLISH_TOOL,
  SIGN_TOOL,
  UPLOAD_TOOL,
  HELP_TOOL_LEGACY,
  GIT_ISSUES_TOOL,
  GIT_PATCHES_TOOL,
  GIT_STATE_TOOL,
];

/**
 * Does a grant pattern cover this tool id?
 *
 * Either an exact id or a whole namespace: `nostr.*`. No other wildcard, and
 * notably no bare `*` — a channel that can do everything should have to say
 * which everything, because the set grows.
 */
export function grantCovers(pattern: string, id: string): boolean {
  if (pattern === id) return true;
  if (!pattern.endsWith(".*")) return false;
  return id.startsWith(pattern.slice(0, -1));
}

/** The subset of `specs` a set of grants allows. */
export function filterTools(specs: ToolSpec[], grants: string[]): ToolSpec[] {
  return specs.filter((spec) =>
    grants.some((grant) => grantCovers(grant, spec.name)),
  );
}

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
