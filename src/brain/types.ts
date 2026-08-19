import type { Inbound } from "../transports/types.js";
import type { ToolHost } from "../tools/types.js";

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
   * What the brain can DO. Speaking is one of these — see `respond`.
   *
   * The host is bound to the room and the message, so the brain never addresses a
   * relay, a protocol, or a room other than the one it was given.
   */
  tools: ToolHost;
  /**
   * The turn was abandoned — stop asking the model and stop calling tools.
   *
   * What already reached the room is not undone, and neither is anything a
   * command already wrote to disk. Cancelling stops future work; it is not a
   * rollback, and nothing here pretends otherwise.
   */
  signal?: AbortSignal;
}

export interface TurnOutcome {
  /**
   * Whether anything reached the room. Read from the tool host rather than
   * claimed by the brain: what was delivered is a fact about the transport, not
   * an assertion by the model.
   */
  delivered: boolean;
  /** For the log. What the brain did, or why it did nothing. */
  note?: string;
}

export interface Brain {
  readonly name: string;
  /**
   * Take one turn.
   *
   * A turn may think, may call tools, and may decide to stay out of it — silence
   * is a legitimate outcome, not a failure. Nothing a brain RETURNS is published;
   * delivery only ever happens through `request.tools`.
   */
  turn(request: BrainRequest): Promise<TurnOutcome>;
}

export type {
  ToolHost,
  ToolSpec,
  ToolCall,
  ToolResult,
} from "../tools/types.js";
