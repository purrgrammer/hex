/**
 * The vocabulary hex publishes from — hex's own, not a runtime's.
 *
 * The publisher used to switch on Eve's event names directly, which made a
 * second backend impossible in a way no type could show you: `transcript.ts`
 * reads thirty-odd names and a hundred payload fields, all of them one
 * framework's spelling, none of them written down anywhere as a contract. An
 * ACP driver would have had to either rewrite the publisher or fake Eve's
 * stream, and both are worse than saying what the stream has to look like.
 *
 * So this file is the contract. A `Runtime` yields events named here, carrying
 * the fields named here, and the publisher reads nothing else. The names are
 * Eve's spelling because that is where they were derived from and renaming them
 * would be churn for its own sake — the point is not that they are new, it is
 * that they are OURS. Eve's driver passes them through; a driver for anything
 * else translates into them, and the translation is that driver's whole job.
 *
 * Unknown names are ignored rather than refused. A runtime that emits more than
 * this describes is a runtime this version does not fully understand, which is
 * not the same as a broken one.
 */

/**
 * What a turn's life looks like.
 *
 * `turn.started` opens one and exactly one of `turn.completed`, `turn.failed`
 * or `turn.cancelled` closes it — a cancelled turn is not a failed one, and a
 * publisher that folds them together loses the only part a reader is asking
 * about. `session.waiting` follows an ending turn and says nothing about
 * whether the session is finished or merely parked; see `input.requested`.
 *
 * Every one of these carries `turnId`.
 */
export const TURN_EVENTS = [
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
] as const;

/**
 * One step inside a turn: the model thinks, calls tools, and the results land.
 *
 * `step.completed` is what flushes a turn's parts, and it carries `usage` —
 * `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and
 * optionally `costUsd`. `inputTokens` INCLUDES the cached reads; a publisher
 * that adds them is billing the same tokens twice.
 */
export const STEP_EVENTS = [
  "step.started",
  "step.completed",
  "step.failed",
] as const;

/**
 * What was said, streamed and then whole.
 *
 * The `*.appended` pair carry the text SO FAR, not the fragment — which is what
 * makes partial output renderable before the completion arrives. `reasoning` is
 * the model's private thinking and is published as its own part type, never
 * folded into the answer.
 */
export const MESSAGE_EVENTS = [
  "message.received",
  "message.appended",
  "message.completed",
  "reasoning.appended",
  "reasoning.completed",
] as const;

/**
 * Tool calls and their results, plus the structured output of a whole turn.
 *
 * `actions.requested` carries the calls (`actions`, each with `callId`, `name`,
 * `input`); `action.result` carries one result by `callId`. `result.completed`
 * is a turn's `result` when the runtime was given an output schema.
 */
export const ACTION_EVENTS = [
  "actions.requested",
  "action.partial",
  "action.result",
  "result.completed",
] as const;

/**
 * The run stopped to ask, and later got an answer.
 *
 * The load-bearing pair. A runtime's end-of-turn signal cannot distinguish a
 * parked turn from a finished one — in the implementation this was written
 * from they are byte-identical — so the only thing that separates them is
 * whether a request opened by `input.requested` has been closed by an
 * `input.resolved` naming its `requestId`. A publisher MUST keep that set
 * durably; see the head's `input` tags in the NIP.
 *
 * `approval.*` is the same mechanism under another name, emitted alongside for
 * the approval flavour of a request.
 */
export const INPUT_EVENTS = [
  "input.requested",
  "input.resolved",
  "approval.candidate",
  "approval.settled",
] as const;

/**
 * Things that happen TO a conversation rather than in it.
 *
 * Each earns a turn of its own, because the turns after it cannot be read
 * correctly without it: an agent that has forgotten the first half of its own
 * transcript is not the agent the reader thinks they are watching.
 *
 * `compaction.requested` carries `usageInputTokens` — how full the window was —
 * and is the only place that number appears, so it is held until
 * `compaction.completed` rather than published on its own.
 */
export const CONTEXT_EVENTS = [
  "compaction.requested",
  "compaction.completed",
  "context.cleared",
] as const;

/**
 * A sign-in the agent cannot perform for itself.
 *
 * `authorization.required` carries an `authorization` challenge — `url`,
 * `userCode`, `expiresAt`, `instructions`, `displayName` — and a publisher
 * SHOULD carry all of it, because a person who cannot see where to go cannot
 * go there. Nobody answers this one through the control plane; the runtime
 * emits `authorization.completed` by itself once the human has done it.
 */
export const AUTHORIZATION_EVENTS = [
  "authorization.required",
  "authorization.completed",
] as const;

/** A child session this run started. Correlated to its call by `callId`. */
export const SUBAGENT_EVENTS = [
  "subagent.called",
  "subagent.started",
  "subagent.event",
  "subagent.completed",
] as const;

/** The session's own life. `session.waiting` is NOT a finish; see INPUT_EVENTS. */
export const SESSION_EVENTS = [
  "session.started",
  "session.waiting",
  "session.completed",
  "session.failed",
] as const;

/** Every name a driver may emit and this version knows what to do with. */
export const KNOWN_EVENTS = [
  ...SESSION_EVENTS,
  ...TURN_EVENTS,
  ...STEP_EVENTS,
  ...MESSAGE_EVENTS,
  ...ACTION_EVENTS,
  ...INPUT_EVENTS,
  ...CONTEXT_EVENTS,
  ...AUTHORIZATION_EVENTS,
  ...SUBAGENT_EVENTS,
] as const;

export type SessionEventName = (typeof KNOWN_EVENTS)[number];

const KNOWN = new Set<string>(KNOWN_EVENTS);

/**
 * Whether this version knows what to do with an event.
 *
 * For a driver deciding what to log, not for deciding what to forward — an
 * unknown event is passed on and ignored downstream, which is what lets a
 * runtime run ahead of this package without breaking it.
 */
export function isKnownEvent(type: string): type is SessionEventName {
  return KNOWN.has(type);
}
