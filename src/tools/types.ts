/**
 * What a brain is allowed to DO, as opposed to what it returns.
 *
 * Delivery is a tool call. The brain decides to speak by calling `respond`; the
 * runtime binds that call to the room the message came from and hands it to
 * whichever transport owns that room. Neither side knows the other's protocol —
 * the brain never sees a relay, and the transport never sees a model.
 *
 * The seam matters beyond tidiness: the same interface is how a sandboxed coding
 * agent will get to run anything later, so every call is attributable to a room
 * and a requesting pubkey, and bounded, from the start.
 */

import type { Room } from "../transports/types.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
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
export const RESPOND_TOOL = "respond";
/** Optional: a transport with no reactions simply does not offer it. */
export const REACT_TOOL = "react";
