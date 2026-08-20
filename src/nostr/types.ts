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

/**
 * Why a turn ended.
 *
 * `cancelled` is not the model's word for anything — no runtime reports it as a
 * finish reason, because the model did not finish, somebody stopped it. It is
 * here because `error` was standing in for it, and a run the operator stopped on
 * purpose reading as a run that broke is the difference between a decision and a
 * fault.
 */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "content_filter"
  | "cancelled"
  | "error";

export type DeltaKind = "text" | "reasoning" | "tool" | "heartbeat";

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

// ── Content parts (the JSON inside a turn) ──────────────────────────────────

export interface TextPart {
  type: "text";
  text: string;
  truncated?: Truncation;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  truncated?: Truncation;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  /** `null` when the call was too large to carry; the digest still names it. */
  arguments: Record<string, unknown> | null;
  arguments_digest?: string;
}

export interface ToolResultPart {
  type: "tool_result";
  id: string;
  name: string;
  ok: boolean;
  /** `null` when the output was too large to inline; see `ref`. */
  output: string | null;
  ref?: BlobRef;
  truncated?: Truncation;
}

/**
 * A question the run is blocked on, in the transcript that asked it.
 *
 * The history of being asked belongs in a turn; whether it is still open belongs
 * on the head, which names the open ids. Carried in full — prompt, options and
 * the tool it acts on — because a reader that cannot see the options cannot
 * answer, and a reader that cannot answer watches a session stay stuck.
 */
export interface InputRequestPart {
  type: "input_request";
  requestId: string;
  prompt: string;
  /** `tool-approval` | `question` | `session-limit`, per the runtime. */
  requestKind?: string;
  /** `confirmation` | `select` | `text` — how the asker meant it to look. */
  display?: string;
  /** Whether an answer may be typed rather than chosen. */
  allowFreeform?: boolean;
  options?: { id: string; label: string; description?: string; style?: string }[];
  /** The tool call being approved, when that is what this is. */
  tool?: { name: string; callId?: string };
}

/** What became of it, so a transcript read later is not left hanging. */
export interface InputResolvedPart {
  type: "input_resolved";
  requestId: string;
  /** `answered` | `approved` | `denied` | `ignored` | `invalid`. */
  outcome: string;
  /** What was chosen or typed, when the runtime reports it. */
  response?: { optionId?: string; text?: string };
}

export interface ImagePart {
  type: "image";
  url: string;
  mime: string;
  sha256?: string;
}

/** The part types this revision defines. */
export type ContentPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | InputRequestPart
  | InputResolvedPart
  | ImagePart;

/** A part whose `type` this build does not know. */
export interface UnknownPart {
  type: string;
  [key: string]: unknown;
}

/**
 * What a turn actually carries.
 *
 * The list is open on purpose: a turn holding a part from a later revision must
 * still render the parts around it, so an unrecognised one is kept and skipped
 * rather than making the whole turn unreadable.
 */
export type TurnPart = ContentPart | UnknownPart;

const KNOWN_PART_TYPES: ReadonlySet<string> = new Set([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "input_request",
  "input_resolved",
  "image",
]);

export function isKnownPart(part: TurnPart): part is ContentPart {
  return KNOWN_PART_TYPES.has(part.type);
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
  /**
   * Worked out from token counts and a price list, not billed by the provider.
   *
   * Plenty of providers report no cost at all, and a transcript with usage and a
   * blank where the money goes is no use to anyone auditing spend. So it is
   * computed — and marked, because a figure presented as a bill when it is
   * arithmetic is worse than no figure. It cannot see cache discounts,
   * surcharges or promotions.
   */
  estimated?: boolean;
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

/**
 * A child session this turn set running.
 *
 * A subagent's work is a SEPARATE session: its own head, its own `seq` chain,
 * its own address. So a turn that spawned one cannot contain it — it can only
 * name it, and a reader follows the pointer if the child was published too.
 *
 * `session` is the runtime's own session id, not a Nostr address, because the
 * address depends on who followed the child and nobody may have. A reader that
 * holds the child's transcript can match on this; one that does not is told a
 * subagent ran and where to look, which is more than silence.
 */
export interface SubagentRef {
  /** The tool call that spawned it, which is also the row it belongs to. */
  callId: string;
  /** The runtime's session id for the child. */
  session: string;
  name?: string;
}

export interface AgentTurnInput {
  role: TurnRole;
  parts: TurnPart[];
  turn: number;
  stop?: StopReason;
  model?: { id: string; provider?: string };
  usage?: Usage;
  cost?: Cost;
  /** Child sessions this turn started, one tag each. */
  subagents?: SubagentRef[];
  /** Plain-text rendering for clients that cannot parse the parts. */
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

/**
 * What an operator can tell a running session to do.
 *
 * Every verb maps onto something the runtime already exposes; nothing here
 * invents a capability. There is deliberately no `pause`: a run parks only
 * because something asked for input, and a verb that cannot be honoured is worse
 * than one that does not exist.
 */
export type SessionCommand =
  | "start"
  | "respond"
  | "steer"
  | "cancel"
  | "compact"
  | "clear"
  | "reset";

export interface SessionControlInput {
  command: SessionCommand;
  /**
   * What this acts on, so a redelivered command cannot act twice.
   *
   * `respond` names the request it answers — the runtime refuses to guess when
   * several are open. `cancel` MAY name the turn it stops; without one it stops
   * whatever is running, which is only safe because a command whose target has
   * already settled is ignored.
   */
  request?: string;
  turn?: string;
  /** The chosen option's id, for a `respond` to a question with options. */
  option?: string;
  /** Free text: the answer for `respond`, the message for `steer` or `start`. */
  text?: string;
  /**
   * What a `steer` does to the turn already running: wait for it, or replace it.
   *
   * Defaults to `queue`, which is the opposite of what a chat message does. A
   * message typed into a room mid-turn means "not that — this", and the room
   * path cancels for that reason. An operator steering from a session view is
   * looking at the work in progress and adding to it; throwing that work away
   * because they had a second thought is the expensive reading of an ambiguous
   * act, and the cheap one is to let it finish.
   */
  policy?: "queue" | "steer";
  /**
   * What a `start` is about: `a` and `e` pointers, copied onto the new head.
   *
   * Only `start` carries these. Every other verb names a session that already
   * has them.
   */
  subjects?: string[][];
  alt?: string;
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
   * The highest `seq` so far. The head itself takes no sequence number.
   *
   * This counts EVENTS, not exchanges: one question that makes the agent call a
   * tool publishes four — the question, the call, the result, the answer. It is
   * the cursor a reader uses to spot a hole in the chain, and it was being
   * shown to people as "turns", which is a different and much smaller number.
   */
  lastSeq: number;
  /**
   * Exchanges: how many times somebody said something and the agent worked.
   *
   * The number a person means by "turns". Separate from `lastSeq` because they
   * answer different questions — "is anything missing" and "how much
   * conversation is this" — and conflating them made a two-message session
   * report four.
   */
  turns?: number;
  started: number;
  ended?: number;
  model?: { id: string; provider?: string };
  usage?: Usage;
  cost?: Cost;
  /**
   * Requests the run is blocked on, by id, newest state of affairs.
   *
   * On the head rather than only in a turn because "is this session waiting for
   * me" is current state, and a turn is history. Empty means nothing is open.
   */
  pending?: string[];
  /**
   * Relays this session's ephemeral deltas are published to.
   *
   * A reader cannot guess them. Deltas ride kind 21059, which a DM inbox relay
   * is perfectly entitled to refuse — and the ones in a real 10050 do — so live
   * progress goes somewhere both sides can reach, and the head is where that
   * somewhere is written down.
   */
  deltaRelays?: string[];
  /** The protocol and room this run is happening in. */
  channel?: { transport: string; id?: string };
  /**
   * What this run is ABOUT, as the pointers its opening message carried.
   *
   * `["a", "30617:…"]` for a repository, `["e", "<id>"]` for an event. Carried
   * onto the head so every run about a thing is findable by asking for the
   * pointer rather than by matching titles and hoping.
   */
  subjects?: string[][];
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
  /**
   * The model this ran on, and how much context it holds.
   *
   * On the definition rather than the head because it describes the SETUP, and
   * because the head is republished dozens of times a session while this is
   * written once. The window is the half a reader cannot derive: a session's
   * token count means one thing against 200k and something else entirely
   * against a million, and "how close is this to compacting" is the question a
   * long run is read for.
   */
  model?: { id: string; contextWindow?: number };
  /** Starter prompts a client offers before the first message. */
  suggestions?: string[];
  /** Checkouts this agent can read, and where they sit inside its sandbox. */
  repositories?: RepositorySpec[];
  /**
   * Who this is addressed to, when it travels privately.
   *
   * A definition sent over a wrapped channel needs the same `p` tags the rest
   * of that session's events carry, or the client that receives it cannot tell
   * it is one of the parties and drops it — which is exactly what happened:
   * every session's prompt and tool list was published, delivered, and thrown
   * away on arrival, so the viewer showed neither and looked as though hex had
   * never sent them. A definition published PUBLICLY needs none of this.
   */
  recipients?: string[];
  alt?: string;
  createdAt?: number;
}

/**
 * A repository an agent has on hand.
 *
 * The `path` is where it lives INSIDE the agent's sandbox, which is what makes
 * this worth publishing rather than inferring: a reader that wants a run scoped
 * to one checkout has to name a directory the agent will recognise, and
 * guessing at it produces a prompt the agent quietly ignores.
 */
export interface RepositorySpec {
  /** Short name, unique within an agent. */
  name: string;
  /** Where a person can read it — a clone URL or a web page. */
  url?: string;
  /** Its path in the sandbox, e.g. `/workspace/grimoire`. */
  path?: string;
  description?: string;
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
  parts: TurnPart[];
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
