import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import {
  DEFAULT_POLICY,
  decide,
  matchesRoute,
  TURN_HOLDER,
  type Disposition,
  type LaneState,
  type PolicyRule,
} from "../policy-table.js";
import { controlEvent, messageEvent } from "../ingest.js";
import type { SessionControl } from "../nostr/decode-control.js";
import type { Inbound, Room } from "../transports/types.js";

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);
const THIRD = "c".repeat(64);
const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://groups.example/",
};
const DM: Room = { transport: "nip-17", id: OTHER };

let counter = 0;

function inbound(overrides: Partial<Inbound> = {}): Inbound {
  counter += 1;
  const text = overrides.text ?? "hex, are you there?";
  const author = overrides.author ?? OTHER;
  const event: NostrEvent = {
    id: overrides.id ?? `id${counter}`,
    pubkey: author,
    created_at: overrides.createdAt ?? 1000,
    kind: 9,
    content: text,
    tags: [],
    sig: "",
  };
  return {
    id: event.id,
    author,
    text,
    createdAt: event.created_at,
    room: overrides.room ?? ROOM,
    addressesSelf: overrides.addressesSelf ?? true,
    event,
    ...overrides,
  };
}

function cancelControl(session: string): SessionControl {
  return {
    id: `ctl-${session}`,
    operator: OTHER,
    agent: "hex",
    session,
    command: "cancel",
  };
}

/**
 * The four reasons that are GUARDS, not dispositions.
 *
 * Own-message and duplicate never reach a decision at all — the first is Hex
 * hearing itself, the second is the queue's identity index — and before-start
 * and rate-limited are the runner's own bounds, tested in runner.test.ts. A
 * config that could switch them off in a rule is a config that can make Hex
 * answer itself in a loop.
 */
const GUARDS = ["own-message", "duplicate", "before-start", "rate-limited"];

/** A lane with a turn running for `peer`. */
function busy(peer: string): LaneState {
  return { inTurn: true, turnHolder: peer };
}

/**
 * Every situation the old reply gate decided, and what the table says now.
 *
 * The lane is built here rather than read off a live gate: the gate no longer
 * knows who is busy — the runner's lane does — so this is the state the runner
 * reports, in the shape `decide` takes.
 */
const CASES: Array<{
  name: string;
  message: Inbound;
  lane?: LaneState;
  /** The guard the runner applies instead, when there is no disposition. */
  guard?: string;
  expect: Disposition;
}> = [
  {
    name: "a fresh addressed room message",
    message: inbound(),
    expect: "respond",
  },
  {
    name: "a room message that does not address Hex",
    message: inbound({ addressesSelf: false }),
    expect: "ignore",
  },
  {
    name: "a message inside the startup grace window",
    message: inbound({ createdAt: 880 }),
    expect: "respond",
  },
  {
    name: "a private message with nothing running",
    message: inbound({ room: DM }),
    expect: "respond",
  },
  {
    /**
     * The one behaviour this changed, and it was approved.
     *
     * A mention that arrived mid-turn used to be dropped in silence. It is now
     * a followup: the runner holds it and answers it when the turn ends.
     */
    name: "a room mention while a turn is running",
    message: inbound(),
    lane: busy(OTHER),
    expect: "respond",
  },
  {
    name: "a message in another room while one is busy",
    message: inbound({
      room: { transport: "nip-29", id: "other", relay: ROOM.relay },
    }),
    // A different room is a different lane, so its state is idle.
    expect: "respond",
  },
  {
    name: "the turn holder writing again in a private message",
    message: inbound({ room: DM }),
    lane: busy(OTHER),
    expect: "steer",
  },
  {
    // Also the approved change: a followup rather than nothing at all. It is
    // not a steer — only the turn holder gets to abandon their own turn.
    name: "someone else writing into a busy private conversation",
    message: inbound({ room: DM, author: THIRD }),
    lane: busy(OTHER),
    expect: "respond",
  },
  {
    name: "Hex hearing its own reply",
    message: inbound({ author: SELF }),
    guard: "own-message",
    expect: "respond",
  },
  {
    name: "backfill from before startup",
    message: inbound({ createdAt: 500 }),
    guard: "before-start",
    expect: "respond",
  },
  {
    name: "a second copy of one message",
    message: inbound(),
    guard: "duplicate",
    expect: "respond",
  },
  {
    name: "the hourly cap",
    message: inbound(),
    guard: "rate-limited",
    expect: "respond",
  },
];

describe("the default table decides what the gate used to decide", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      if (testCase.guard) {
        // A guarded case still has a disposition — the guard is what stops it
        // reaching the runner's dispatch, not what the table says about it.
        expect(GUARDS).toContain(testCase.guard);
      }
      expect(decide(messageEvent(testCase.message), testCase.lane)).toBe(
        testCase.expect,
      );
    });
  }
});

describe("decide", () => {
  it("carries out a control whatever the lane is doing", () => {
    const control = controlEvent(cancelControl("session-1"));
    expect(decide(control)).toBe("respond");
    expect(decide(control, { inTurn: true, turnHolder: OTHER })).toBe(
      "respond",
    );
  });

  it("ignores an event no rule names", () => {
    // Reactions, joins and timers have no default rule: silence, not a guess.
    const reaction = { ...messageEvent(inbound()), type: "reaction" as const };
    expect(decide(reaction)).toBe("ignore");
  });

  it("treats an absent `when` as any lane state", () => {
    const table: PolicyRule[] = [{ types: ["message"], do: "collect" }];
    expect(decide(messageEvent(inbound()), { inTurn: false }, table)).toBe(
      "collect",
    );
    expect(decide(messageEvent(inbound()), { inTurn: true }, table)).toBe(
      "collect",
    );
  });

  it("takes the first matching rule", () => {
    const table: PolicyRule[] = [
      { types: ["message"], do: "wake" },
      { types: ["message"], do: "respond" },
    ];
    expect(decide(messageEvent(inbound()), { inTurn: false }, table)).toBe(
      "wake",
    );
  });

  it("matches `addressed` against the payload, and never on a control", () => {
    const table: PolicyRule[] = [
      {
        types: ["message", "control"],
        where: { addressed: false },
        do: "wake",
      },
    ];
    expect(
      decide(messageEvent(inbound({ addressesSelf: false })), undefined, table),
    ).toBe("wake");
    const control = controlEvent(cancelControl("s"));
    // A control has no `addressesSelf`, so it matches neither true nor false.
    expect(decide(control, undefined, table)).toBe("ignore");
  });

  it("resolves $turn-holder against the lane, and matches nobody when idle", () => {
    const table: PolicyRule[] = [
      { types: ["message"], where: { peer: TURN_HOLDER }, do: "steer" },
    ];
    const message = messageEvent(inbound({ room: DM }));
    expect(decide(message, { inTurn: true, turnHolder: OTHER }, table)).toBe(
      "steer",
    );
    expect(decide(message, { inTurn: true, turnHolder: THIRD }, table)).toBe(
      "ignore",
    );
    expect(decide(message, { inTurn: false }, table)).toBe("ignore");
  });

  it("matches a thread the lane calls live", () => {
    // Nothing populates `activeThreads` until the runner does, which is why
    // the default table's thread rule changes no behaviour today.
    const message = messageEvent(inbound({ replyToId: "root" }));
    const lane: LaneState = { inTurn: false, activeThreads: ["root"] };
    expect(decide(message, lane)).toBe("respond");
    expect(decide(messageEvent(inbound({ addressesSelf: false })), lane)).toBe(
      "ignore",
    );
  });

  it("keeps the default table's rules in the order the daemon relies on", () => {
    // The steer rule must sit above the respond rules, or the turn holder's
    // "not that — this" becomes a second turn instead of taking over.
    expect(DEFAULT_POLICY[0]?.types).toEqual(["control"]);
    expect(DEFAULT_POLICY[1]?.do).toBe("steer");
  });
});

describe("matchesRoute", () => {
  it("matches on route fields alone, so a toolset layer can reuse it", () => {
    const route = messageEvent(inbound({ room: DM })).route;
    expect(matchesRoute({ transport: "nip-17" }, route)).toBe(true);
    expect(matchesRoute({ transport: "nip-29" }, route)).toBe(false);
    expect(matchesRoute({ room: OTHER, peer: OTHER }, route)).toBe(true);
    expect(matchesRoute({ room: "elsewhere" }, route)).toBe(false);
    expect(matchesRoute({}, route)).toBe(true);
  });
});
