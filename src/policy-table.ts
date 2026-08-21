/**
 * What Hex responds to, as a table.
 *
 * The gate in `policy.ts` decides one question in code: answer this message or
 * not. That is not extensible — a second reason to speak, or a room with
 * different manners, means another branch in the same function. Here the
 * question is a rule list an agent can state instead: match the canonical
 * event, name a disposition, first match wins, no match means silence.
 *
 * Predicates read CANONICAL fields only, never a transport's payload. A rule
 * that can only be written for one transport is a rule the other transports
 * silently never obey.
 *
 * Nothing dispatches from this table yet. It is the vocabulary; the runner that
 * acts on it comes next.
 */

import type { HexEventType, CanonicalEvent, MessagePayload } from "./ingest.js";
import type { TransportName } from "./transports/types.js";

/**
 * What to do about an event.
 *
 * - `respond` — take a turn about it.
 * - `steer` — abandon what is running and do this instead (today's interrupt).
 * - `collect` — hold it, and give it to the running turn when it ends.
 * - `ignore` — nothing, on purpose.
 * - `wake` — start a session that nobody asked a question in (a greeting on
 *   joining a room, a timer firing). Defined and unused: the default table
 *   never wakes, because today's Hex only ever answers.
 */
export type Disposition = "respond" | "steer" | "collect" | "ignore" | "wake";

export const DISPOSITIONS: readonly Disposition[] = [
  "respond",
  "steer",
  "collect",
  "ignore",
  "wake",
];

/** Whether the lane is busy when the event arrives. Absent means "any". */
export type When = "idle" | "in-turn" | "any";

export const WHENS: readonly When[] = ["idle", "in-turn", "any"];

/** The peer placeholder that resolves to whoever the running turn answers. */
export const TURN_HOLDER = "$turn-holder";

/**
 * Where an event came from, as a match.
 *
 * Route only — no field here belongs to any one event type. That is deliberate:
 * capability has to follow the channel (positioning §5.3), so a later layer
 * resolving (room, requester) -> toolset matches on exactly this and must not
 * inherit anything message-shaped. `PolicyWhere` is where the message fields
 * get added, for rules that need them.
 */
export interface RoutePredicate {
  transport?: TransportName;
  room?: string;
  /** A pubkey, or `$turn-holder` for whoever the running turn is answering. */
  peer?: string;
}

export interface PolicyWhere extends RoutePredicate {
  /** `payload.addressesSelf`. An event without the field matches neither way. */
  addressed?: boolean;
  /** The event's thread is one the lane is already treating as live. */
  inActiveThread?: boolean;
}

export interface PolicyRule {
  types: HexEventType[];
  where?: PolicyWhere;
  when?: When;
  do: Disposition;
}

/**
 * What the lane looks like when the event is decided.
 *
 * `activeThreads` is empty for now — nothing tracks live threads until the
 * runner does — which is why the default table's thread rule changes no
 * behaviour today.
 */
export interface LaneState {
  /** A turn is running on this lane. */
  inTurn: boolean;
  /** Whose message that turn is answering, when one is. */
  turnHolder?: string;
  activeThreads?: readonly string[];
}

export const IDLE_LANE: LaneState = { inTurn: false };

/**
 * Today's behaviour, written down.
 *
 * Every line is a branch that exists in `ReplyGate.consider` and the daemon's
 * dispatch: a control is always carried out; a DM from the author of the
 * running turn steers it; a DM addresses Hex by arriving; a mention in a room
 * gets an answer when nothing is running; a reply inside a live exchange is the
 * next turn of it rather than room chatter.
 *
 * What is NOT here: own-message, duplicate, before-start and rate-limited. They
 * are guards, not dispositions — they answer "should this event have reached a
 * decision at all", and turning them into rules would let a config switch off
 * the check that stops Hex answering itself.
 */
export const DEFAULT_POLICY: readonly PolicyRule[] = [
  { types: ["control"], do: "respond" },
  {
    types: ["message"],
    where: { transport: "nip-17", peer: TURN_HOLDER },
    when: "in-turn",
    do: "steer",
  },
  {
    types: ["message"],
    where: { transport: "nip-17" },
    when: "idle",
    do: "respond",
  },
  {
    types: ["message"],
    where: { addressed: true },
    when: "idle",
    do: "respond",
  },
  {
    types: ["message"],
    where: { inActiveThread: true },
    when: "idle",
    do: "respond",
  },
];

function addressesSelf(event: CanonicalEvent): boolean | undefined {
  if (event.type !== "message") return undefined;
  const payload = event.payload as MessagePayload | undefined;
  return payload?.addressesSelf;
}

function matchesWhen(when: When | undefined, lane: LaneState): boolean {
  switch (when ?? "any") {
    case "idle":
      return !lane.inTurn;
    case "in-turn":
      return lane.inTurn;
    default:
      return true;
  }
}

/**
 * Does this event's route match?
 *
 * Exported because the toolset layer (positioning §5.3) has the same question
 * to ask and must import this rather than write a second answer to it.
 */
export function matchesRoute(
  predicate: RoutePredicate,
  route: CanonicalEvent["route"],
  lane: LaneState = IDLE_LANE,
): boolean {
  if (predicate.transport && predicate.transport !== route.transport)
    return false;
  if (predicate.room !== undefined && predicate.room !== route.room)
    return false;
  if (predicate.peer !== undefined) {
    const peer =
      predicate.peer === TURN_HOLDER ? lane.turnHolder : predicate.peer;
    // No holder means the placeholder names nobody, so it matches nobody.
    if (peer === undefined || peer !== route.peer) return false;
  }
  return true;
}

function matchesWhere(
  where: PolicyWhere | undefined,
  event: CanonicalEvent,
  lane: LaneState,
): boolean {
  if (!where) return true;
  if (!matchesRoute(where, event.route, lane)) return false;
  if (where.addressed !== undefined && where.addressed !== addressesSelf(event))
    return false;
  if (where.inActiveThread !== undefined) {
    const inThread =
      event.route.thread !== undefined &&
      (lane.activeThreads ?? []).includes(event.route.thread);
    if (where.inActiveThread !== inThread) return false;
  }
  return true;
}

/** Does this rule cover the event, in this lane? */
export function matchesRule(
  rule: PolicyRule,
  event: CanonicalEvent,
  lane: LaneState,
): boolean {
  if (!rule.types.includes(event.type)) return false;
  if (!matchesWhen(rule.when, lane)) return false;
  return matchesWhere(rule.where, event, lane);
}

/**
 * What to do about this event. First match wins; nothing matching is silence.
 *
 * Silence-by-default is the safe direction: a rule someone forgot to write
 * costs an answer, and the alternative costs money in a room nobody invited
 * Hex into.
 */
export function decide(
  event: CanonicalEvent,
  lane: LaneState = IDLE_LANE,
  table: readonly PolicyRule[] = DEFAULT_POLICY,
): Disposition {
  for (const rule of table) if (matchesRule(rule, event, lane)) return rule.do;
  return "ignore";
}
