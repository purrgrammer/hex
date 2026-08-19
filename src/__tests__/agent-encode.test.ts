import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAgentDefinition,
  buildDelta,
  buildSessionHead,
  buildTurn,
  parseSessionAddress,
  sessionAddress,
} from "../nostr/encode.js";
import type { SessionRef } from "../nostr/types.js";

const AGENT = "9".repeat(64);
const OPERATOR = "1".repeat(64);
const SESSION = "3a7c".padEnd(64, "0");
const ref: SessionRef = { agent: AGENT, session: SESSION };
const AT = 1_755_500_000;

/**
 * The golden vectors are the only thing keeping `packages/hex`'s copy of this
 * encoder honest — it may not import from `src/`, so the two are kept identical
 * by producing the same ids from the same inputs.
 */
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "nostr", "__fixtures__", "agent-vectors.json"), "utf8"),
) as {
  definition: string;
  head: string;
  turn: string;
  delta: string;
};

describe("golden vectors", () => {
  it("reproduces the fixture ids", () => {
    const definition = buildAgentDefinition(AGENT, {
      slug: "hex",
      name: "Hex",
      about: "Answers questions about Nostr REQs.",
      instructions: "You are Hex.",
      tools: [
        {
          name: "nostr.req",
          description: "Query relays",
          parameters: {
            type: "object",
            properties: { kinds: { type: "array" } },
          },
        },
      ],
      suggestions: ["what kinds does this relay serve?"],
      createdAt: AT,
    });
    const head = buildSessionHead(AGENT, SESSION, {
      title: "relay-subscription refactor",
      status: "active",
      operator: { pubkey: OPERATOR },
      lastSeq: 2,
      started: AT - 100,
      definition: `31779:${AGENT}:hex`,
      createdAt: AT,
    });
    const turn = buildTurn(
      AGENT,
      ref,
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "the caller never unsubscribes" },
          { type: "text", text: "Found it." },
          {
            type: "tool_call",
            id: "tc_01",
            name: "Bash",
            arguments: { command: "npm test" },
          },
        ],
        turn: 1,
        stop: "tool_use",
        model: { id: "claude-opus-5", provider: "anthropic" },
        usage: {
          input: 18432,
          output: 921,
          cacheRead: 16000,
          cacheWrite: 2432,
        },
        cost: { amount: "0.084", currency: "USD" },
        alt: "Assistant: found it.",
        createdAt: AT,
      },
      { seq: 1 },
      { pubkey: OPERATOR },
    );
    const delta = buildDelta(
      AGENT,
      ref,
      { turn: 1, part: 1, delta: "text", text: "Found", createdAt: AT },
      { pubkey: OPERATOR },
    );

    expect({
      definition: definition.id,
      head: head.id,
      turn: turn.id,
      delta: delta.id,
    }).toEqual(vectors);
  });
});

describe("encode", () => {
  it("round-trips a session address", () => {
    expect(parseSessionAddress(sessionAddress(AGENT, SESSION))).toEqual({
      kind: 31777,
      agent: AGENT,
      session: SESSION,
    });
    expect(parseSessionAddress("31777:not-hex:x")).toBeNull();
    expect(parseSessionAddress("nonsense")).toBeNull();
  });

  it("refuses a sequenced event above 1 with no prev", () => {
    expect(() =>
      buildTurn(
        AGENT,
        ref,
        { role: "user", parts: [], turn: 1, createdAt: AT },
        { seq: 2 },
        { pubkey: OPERATOR },
      ),
    ).toThrow(/needs a prev/);
  });

  it("indexes every tool a turn touched", () => {
    const turn = buildTurn(
      AGENT,
      ref,
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "a", name: "Bash", arguments: {} },
          { type: "tool_call", id: "b", name: "Read", arguments: {} },
          { type: "tool_call", id: "c", name: "Bash", arguments: {} },
        ],
        turn: 1,
        createdAt: AT,
      },
      { seq: 1 },
      { pubkey: OPERATOR },
    );

    expect(turn.tags.filter((t) => t[0] === "tool").map((t) => t[1])).toEqual([
      "Bash",
      "Read",
    ]);
  });

  it("empties a heartbeat's content", () => {
    const delta = buildDelta(
      AGENT,
      ref,
      { turn: 1, part: 9, delta: "heartbeat", text: "ignored", createdAt: AT },
      { pubkey: OPERATOR },
    );

    expect(delta.content).toBe("");
  });
});
