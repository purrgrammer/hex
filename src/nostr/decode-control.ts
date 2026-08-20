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

/**
 * What a run can be ABOUT, in NIP-22's own scope vocabulary.
 *
 * An event (`e`), an addressable one (`a`), a person (`p`), a page (`r`), or
 * something outside Nostr entirely (`i`, NIP-73) — a GitHub issue, a package, a
 * paper. Reusing the set a comment already uses means a client that can say
 * "about this" has nothing new to learn.
 */
const SUBJECT_TAGS = new Set(["a", "e", "p", "r", "i"]);

const COMMANDS: readonly SessionCommand[] = [
  "start",
  "respond",
  "steer",
  "cancel",
  "compact",
  "clear",
  "reset",
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
  /** `steer` only: wait for the running turn, or replace it. Default `queue`. */
  policy?: "queue" | "steer";
  /**
   * `start` only: what the run is about.
   *
   * The address that names the session is an `a` tag too, so it is excluded by
   * kind rather than by position — a client is free to put the subjects first.
   */
  subjects?: string[][];
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

  const policy = tag(rumor, "policy");

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
      policy: policy === "steer" || policy === "queue" ? policy : undefined,
      subjects: rumor.tags.filter(
        (t) =>
          SUBJECT_TAGS.has(t[0] ?? "") &&
          !!t[1] &&
          // The session's own address is an `a` tag; it is what this command
          // acts on, not what the run is about.
          t[1] !== address &&
          // And its `p` names the agent that must act, not somebody to go and
          // read about.
          !(t[0] === "p" && t[1] === expected.agent),
      ),
      text: rumor.content || undefined,
    },
  };
}
