import { describe, expect, it } from "vitest";

import { buildSessionControl } from "../nostr/encode.js";
import { parseSessionControl } from "../nostr/decode-control.js";
import { KIND_SESSION_CONTROL } from "../nostr/kinds.js";

const AGENT = "a".repeat(64);
const OPERATOR = "b".repeat(64);
const STRANGER = "c".repeat(64);
const SESSION = "d".repeat(64);

const expected = { agent: AGENT, operator: OPERATOR };

function control(
  input: Parameters<typeof buildSessionControl>[2],
  pubkey = OPERATOR,
) {
  return buildSessionControl(pubkey, { agent: AGENT, session: SESSION }, input);
}

describe("session control", () => {
  it("carries the command, its target and its text", () => {
    const rumor = control({
      command: "respond",
      request: "req_1",
      option: "approve",
    });

    expect(rumor.kind).toBe(KIND_SESSION_CONTROL);
    expect(rumor.tags).toContainEqual(["a", `31777:${AGENT}:${SESSION}`]);
    // The agent finds it by `p` and files it by `a`, so it needs both.
    expect(rumor.tags).toContainEqual(["p", AGENT]);

    const read = parseSessionControl(rumor, expected);
    expect(read && "control" in read && read.control).toMatchObject({
      command: "respond",
      request: "req_1",
      option: "approve",
      session: SESSION,
    });
  });

  it("refuses a command from anyone but the operator", () => {
    /**
     * The only event in this family that makes the agent ACT. The seal proves
     * who wrote it; this is the next question — whether that author is the one
     * this session takes instructions from — and it is answered here so that no
     * call site can forget to ask.
     */
    const rumor = control({ command: "cancel" }, STRANGER);
    const read = parseSessionControl(rumor, expected);
    expect(read && "refused" in read).toBe(true);
  });

  it("ignores a command for a different agent without complaining", () => {
    // Somebody else's agent is not ours to obey and not ours to object to.
    const rumor = control({ command: "cancel" });
    const read = parseSessionControl(rumor, {
      agent: STRANGER,
      operator: OPERATOR,
    });
    expect(read).toBeNull();
  });

  it("ignores a verb it has never heard of", () => {
    // A newer client talking, exactly as an unknown part type or status is
    // treated everywhere else in this family.
    const rumor = control({ command: "teleport" as never });
    expect(parseSessionControl(rumor, expected)).toBeNull();
  });

  it("puts a steer's message in content, where a message belongs", () => {
    const rumor = control({
      command: "steer",
      text: "actually, do the other one",
    });
    expect(rumor.content).toBe("actually, do the other one");
    const read = parseSessionControl(rumor, expected);
    expect(read && "control" in read && read.control.text).toBe(
      "actually, do the other one",
    );
  });
});
