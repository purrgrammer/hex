import type { Inbound } from "../transports/types.js";

export interface ContextMessage {
  author: string;
  name?: string;
  text: string;
  /** Unix seconds. */
  at: number;
}

export interface BrainRequest {
  instructions: string;
  /** Oldest first, already bounded by `context.messages`. */
  history: ContextMessage[];
  incoming: Inbound;
  /**
   * Tools Hex may call. Absent in every brain shipped so far — the seam for a
   * sandboxed coding agent, deliberately injected rather than ambient so a
   * brain with no host cannot act.
   */
  tools?: ToolHost;
}

/**
 * The execution boundary, when there is one.
 *
 * Nothing implements this yet, and the contract is written before the feature on
 * purpose: every call is attributable to a room and a requesting pubkey, and
 * bounded. Whatever runs the work must not be this process — the daemon holds a
 * signing key.
 */
export interface ToolHost {
  list(): Promise<ToolSpec[]>;
  call(request: ToolCall): Promise<ToolResult>;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Who asked, and where. An unattributable tool call is not authorized. */
  requestedBy: string;
  room: Inbound["room"];
  timeoutMs: number;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Brain {
  readonly name: string;
  /** `null` means stay silent — a first-class answer, not a failure. */
  respond(request: BrainRequest): Promise<string | null>;
}
