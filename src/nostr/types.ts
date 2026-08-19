/**
 * Agent-session types (NIP-xx: Agent Sessions).
 *
 * Deliberately free of repo imports: `packages/hex` may not import from `src/`,
 * so this file and its siblings are copied there verbatim and kept honest by
 * shared golden vectors. Nothing here may reach for `@/types/ai` — the shapes
 * are structurally compatible with it, and that is the whole contract.
 */

// ── Wire primitives ──────────────────────────────────────────────────────────

/** An event before it is signed. On a private stream it stays this way. */
export interface UnsignedRumor {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/** A rumor with its id filled in (NIP-59 leaves rumors unsigned but hashed). */
export interface Rumor extends UnsignedRumor {
  id: string;
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type TurnRole = "user" | "assistant" | "tool";

export type StopReason =
  "end_turn" | "max_tokens" | "tool_use" | "content_filter" | "error";

export type DeltaKind = "text" | "thinking" | "tool" | "heartbeat";

/**
 * `awaiting-input` and `payment-required` are NIP-90's kind-7000 vocabulary,
 * verbatim. They live here rather than on a progress event of their own, which
 * costs the HISTORY of a blocked state — the head is replaceable, so asking
 * twice and being ignored twice looks the same as asking once.
 */
export type SessionStatus =
  | "active"
  | "idle"
  | "awaiting-input"
  | "payment-required"
  | "done"
  | "error"
  | "aborted";

export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "done",
  "error",
  "aborted",
];

// ── Content blocks (the JSON inside a turn) ──────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
  truncated?: Truncation;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  truncated?: Truncation;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  /** `null` when the call was too large to carry; the digest still names it. */
  arguments: Record<string, unknown> | null;
  arguments_digest?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  id: string;
  name: string;
  ok: boolean;
  /** `null` when the output was too large to inline; see `ref`. */
  output: string | null;
  ref?: BlobRef;
  truncated?: Truncation;
}

export interface ImageBlock {
  type: "image";
  url: string;
  mime: string;
  sha256?: string;
}

/** The block types this revision defines. */
export type ContentBlock =
  TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | ImageBlock;

/** A block whose `type` this build does not know. */
export interface UnknownBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * What a turn actually carries.
 *
 * The list is open on purpose: a turn holding a block from a later revision must
 * still render the blocks around it, so an unrecognised one is kept and skipped
 * rather than making the whole turn unreadable.
 */
export type TurnBlock = ContentBlock | UnknownBlock;

const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "thinking",
  "tool_call",
  "tool_result",
  "image",
]);

export function isKnownBlock(block: TurnBlock): block is ContentBlock {
  return KNOWN_BLOCK_TYPES.has(block.type);
}

export interface Truncation {
  /** Length of the original, in bytes. */
  bytes: number;
  /** Digest of the original, so a fuller copy can be proven to match. */
  sha256: string;
}

export interface BlobRef {
  sha256: string;
  url: string;
  size: number;
  mime: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Cost {
  amount: string;
  currency: string;
}

// ── Session addressing ───────────────────────────────────────────────────────

/** The `a` tag of every event in a session: `31777:<agent>:<session>`. */
export interface SessionRef {
  agent: string;
  session: string;
  relay?: string;
}

/** Where a stream's counter currently stands. Encoders take it, never keep it. */
export interface StreamCursor {
  seq: number;
  /** Id of the event at `seq - 1`. Absent only when `seq` is 1. */
  prev?: string;
}

// ── Inputs (what a publisher hands the encoder) ──────────────────────────────

export interface AgentTurnInput {
  role: TurnRole;
  blocks: TurnBlock[];
  turn: number;
  stop?: StopReason;
  model?: { id: string; provider?: string };
  usage?: Usage;
  cost?: Cost;
  /** Plain-text rendering for clients that cannot parse the blocks. */
  alt?: string;
  createdAt?: number;
}

export interface DeltaInput {
  turn: number;
  /** Counter local to the turn, reset at turn start. Deltas never take `seq`. */
  part: number;
  delta: DeltaKind;
  text: string;
  toolId?: string;
  createdAt?: number;
}

export interface SessionHeadInput {
  title: string;
  status: SessionStatus;
  operator: { pubkey: string; relay?: string };
  observers?: { pubkey: string; relay?: string }[];
  /** The message that started this run, when one did. */
  trigger?: { id: string; relay?: string };
  /**
   * The highest turn `seq` so far, which is also the turn count. The head
   * itself takes no sequence number.
   */
  lastSeq: number;
  started: number;
  ended?: number;
  model?: { id: string; provider?: string };
  usage?: Usage;
  cost?: Cost;
  /** `31779:<agent>:<slug>` — what this agent is, as opposed to what it is doing. */
  definition?: string;
  alt?: string;
  createdAt?: number;
}

export interface AgentToolSpec {
  name: string;
  description?: string;
  /**
   * The tool's parameter schema, usually JSON Schema.
   *
   * Carried as a JSON string in the tag's fourth element. That is not pretty,
   * but the event's content is the system prompt, so a document cannot hold it —
   * and without it a definition can say a tool exists and not how to call it.
   */
  parameters?: unknown;
}

export interface AgentDefinitionInput {
  slug: string;
  name: string;
  picture?: string;
  about?: string;
  /** The system prompt, verbatim — it becomes the event's `content`. */
  instructions?: string;
  tools?: AgentToolSpec[];
  /** Starter prompts a client offers before the first message. */
  suggestions?: string[];
  alt?: string;
  createdAt?: number;
}

// ── Decoded events (what a reader gets back) ─────────────────────────────────

export interface DecodedBase {
  id: string;
  pubkey: string;
  created_at: number;
  session: SessionRef;
  alt?: string;
}

export interface DecodedTurn extends DecodedBase {
  type: "turn";
  seq: number;
  prev?: string;
  turn: number;
  role: TurnRole;
  blocks: TurnBlock[];
  stop?: StopReason;
  model?: { id: string; provider?: string };
  usage?: Usage;
  cost?: Cost;
}

export interface DecodedDelta extends DecodedBase {
  type: "delta";
  turn: number;
  part: number;
  delta: DeltaKind;
  text: string;
  toolId?: string;
}

export interface DecodedHead extends DecodedBase {
  type: "head";
  title: string;
  status: SessionStatus;
  operator: { pubkey: string; relay?: string };
  observers: { pubkey: string; relay?: string }[];
  trigger?: { id: string; relay?: string };
  lastSeq: number;
  started: number;
  ended?: number;
  model?: { id: string; provider?: string };
  usage?: Usage;
  cost?: Cost;
  definition?: string;
}

export interface DecodedDefinition {
  type: "definition";
  id: string;
  pubkey: string;
  created_at: number;
  slug: string;
  /** The `v` tag: which revision of this shape the agent wrote. */
  version: number;
  name: string;
  picture?: string;
  about?: string;
  instructions?: string;
  tools: AgentToolSpec[];
  suggestions: string[];
  alt?: string;
}

export type AgentSessionEvent =
  DecodedTurn | DecodedDelta | DecodedHead | DecodedDefinition;
