/**
 * Reading a control event, which is the one that makes the agent act.
 *
 * Everything else in this package is written by the agent and read by whoever it
 * is addressed to. This goes the other way: someone else's event, arriving over
 * the same private channel, telling a running session to answer, steer, stop or
 * forget. That inversion is the whole reason this file is careful.
 *
 * **Authorship is the only thing standing between a session and a stranger.** A
 * wrap is signed by a throwaway key by design, so the wrap proves nothing; the
 * SEAL proves who wrote the rumor, and the caller must have verified it before
 * anything gets here. What this checks is the next question — whether that
 * author is the one this session takes instructions from — and it is checked
 * here rather than at the call site so that no future call site can forget.
 *
 * A command whose target has already settled is not an error and not obeyed: a
 * relay hands the same wrap over four times, and a `cancel` redelivered an hour
 * later would otherwise stop a turn that had nothing to do with it.
 */

import { KIND_SESSION_CONTROL } from "./kinds.js";
import { parseSessionAddress } from "./encode.js";
import type { Rumor, SessionCommand } from "./types.js";

const COMMANDS: readonly SessionCommand[] = [
  "respond",
  "steer",
  "cancel",
  "compact",
  "clear",
];

export interface SessionControl {
  /** The event's own id, for dedupe. */
  id: string;
  /** Who sent it. Already checked against the operator. */
  operator: string;
  /** The agent and session it names. */
  agent: string;
  session: string;
  command: SessionCommand;
  request?: string;
  turn?: string;
  option?: string;
  text?: string;
}

function tag(rumor: Rumor, name: string): string | undefined {
  const found = rumor.tags.find((t) => t[0] === name && t[1]);
  return found?.[1];
}

/**
 * A control event, or nothing.
 *
 * Returns null rather than throwing for every ordinary reason — an inbox holds
 * events of every kind, and most of what arrives is not this. The one thing
 * worth distinguishing is refusal, which the caller may want to log: a control
 * event that is well-formed but from the wrong author is somebody trying.
 */
export function parseSessionControl(
  rumor: Rumor,
  expected: { agent: string; operator: string },
): { control: SessionControl } | { refused: string } | null {
  if (rumor.kind !== KIND_SESSION_CONTROL) return null;

  const address = tag(rumor, "a");
  if (!address) return null;
  const parsed = parseSessionAddress(address);
  if (!parsed) return null;

  // A control event for somebody else's agent is not ours to obey, and not ours
  // to complain about either.
  if (parsed.agent !== expected.agent) return null;

  if (rumor.pubkey !== expected.operator)
    return {
      refused: `${rumor.pubkey.slice(0, 8)}… is not this session's operator`,
    };

  const command = tag(rumor, "command");
  if (!command) return { refused: "a control event with no command" };
  if (!(COMMANDS as readonly string[]).includes(command))
    // Ignored rather than refused: an unknown verb is a newer client talking,
    // exactly as an unknown part type or status is elsewhere in this family.
    return null;

  return {
    control: {
      id: rumor.id,
      operator: rumor.pubkey,
      agent: parsed.agent,
      session: parsed.session,
      command: command as SessionCommand,
      request: tag(rumor, "request"),
      turn: tag(rumor, "turn"),
      option: tag(rumor, "option"),
      text: rumor.content || undefined,
    },
  };
}
