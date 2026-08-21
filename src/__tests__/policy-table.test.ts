import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import { ReplyGate, type Verdict } from "../policy.js";
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

function stopControl(session: string): SessionControl {
  return {
    id: `ctl-${session}`,
    operator: OTHER,
    agent: "hex",
    session,
    command: "stop",
  };
}

function gate() {
  return new ReplyGate({
    selfPubkey: SELF,
    mentions: ["hex"],
    startedAt: 900,
    repliesPerRoomPerHour: 2,
    now: () => 1000,
  });
}

/**
 * The four reasons that are GUARDS, not dispositions.
 *
 * Own-message and duplicate never reach a decision at all — the first is Hex
 * hearing itself, the second is the queue's identity index — and before-start
 * and rate-limited are the runner's own bounds. A config that could switch them
 * off in a rule is a config that can make Hex answer itself in a loop.
 */
const GUARDS = ["own-message", "duplicate", "before-start", "rate-limited"];

/**
 * Every ReplyGate case, and the disposition the default table gives it.
 *
 * This is the invariant Phase C is for: with no policy section, the table says
 * exactly what the gate says. `run` drives the real gate so the two are
 * compared on one state rather than on a hand-built copy of it.
 */
const CASES: Array<{
  name: string;
  run: () => { gate: ReplyGate; message: Inbound };
  verdict: Verdict;
  expect: Disposition | "guard";
}> = [
  {
    name: "a fresh addressed room message",
    run: () => {
      const g = gate();
      return { gate: g, message: inbound() };
    },
    verdict: { reply: true },
    expect: "respond",
  },
  {
    name: "a room message that does not address Hex",
    run: () => ({ gate: gate(), message: inbound({ addressesSelf: false }) }),
    verdict: { reply: false, reason: "not-addressed" },
    expect: "ignore",
  },
  {
    name: "a message inside the startup grace window",
    run: () => ({ gate: gate(), message: inbound({ createdAt: 880 }) }),
    verdict: { reply: true },
    expect: "respond",
  },
  {
    name: "a private message with nothing running",
    run: () => ({ gate: gate(), message: inbound({ room: DM }) }),
    verdict: { reply: true },
    expect: "respond",
  },
  {
    name: "a room mention while a turn is running",
    run: () => {
      const g = gate();
      const first = inbound();
      g.consider(first);
      g.begin(first);
      return { gate: g, message: inbound() };
    },
    verdict: { reply: false, reason: "in-flight" },
    expect: "ignore",
  },
  {
    name: "a message in another room while one is busy",
    run: () => {
      const g = gate();
      const first = inbound();
      g.consider(first);
      g.begin(first);
      return {
        gate: g,
        message: inbound({
          room: { transport: "nip-29", id: "other", relay: ROOM.relay },
        }),
      };
    },
    verdict: { reply: true },
    expect: "respond",
  },
  {
    name: "the turn holder writing again in a private message",
    run: () => {
      const g = gate();
      const first = inbound({ room: DM });
      g.consider(first);
      g.begin(first);
      return { gate: g, message: inbound({ room: DM }) };
    },
    verdict: { reply: false, reason: "interrupt" },
    expect: "steer",
  },
  {
    name: "someone else writing into a busy private conversation",
    run: () => {
      const g = gate();
      const first = inbound({ room: DM, author: OTHER });
      g.consider(first);
      g.begin(first);
      return { gate: g, message: inbound({ room: DM, author: THIRD }) };
    },
    verdict: { reply: false, reason: "in-flight" },
    expect: "ignore",
  },
  {
    name: "Hex hearing its own reply",
    run: () => ({ gate: gate(), message: inbound({ author: SELF }) }),
    verdict: { reply: false, reason: "own-message" },
    expect: "guard",
  },
  {
    name: "backfill from before startup",
    run: () => ({ gate: gate(), message: inbound({ createdAt: 500 }) }),
    verdict: { reply: false, reason: "before-start" },
    expect: "guard",
  },
  {
    name: "a second copy of one message",
    run: () => {
      const g = gate();
      const message = inbound();
      g.consider(message);
      return { gate: g, message };
    },
    verdict: { reply: false, reason: "duplicate" },
    expect: "guard",
  },
  {
    name: "the hourly cap",
    run: () => {
      const g = gate();
      for (let i = 0; i < 2; i += 1) {
        const message = inbound();
        g.consider(message);
        g.begin(message);
        g.end(message, true);
      }
      return { gate: g, message: inbound() };
    },
    verdict: { reply: false, reason: "rate-limited" },
    expect: "guard",
  },
];

describe("the default table says what the gate says", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const { gate: g, message } = testCase.run();
      const lane = g.laneFor(message);
      // The gate's verdict is read first: it is what the daemon does today,
      // and a case whose gate behaviour drifted must fail here, not silently
      // compare the table against a rule nobody exercises.
      expect(g.consider(message)).toEqual(testCase.verdict);
      const disposition = decide(messageEvent(message), lane);
      if (testCase.expect === "guard") {
        expect(
          testCase.verdict.reply === false &&
            GUARDS.includes(testCase.verdict.reason),
        ).toBe(true);
        return;
      }
      expect(disposition).toBe(testCase.expect);
    });
  }
});

describe("decide", () => {
  it("carries out a control whatever the lane is doing", () => {
    const control = controlEvent(stopControl("session-1"));
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
    const control = controlEvent(stopControl("s"));
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
