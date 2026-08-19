import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EveTranscript, type RumorSink } from "../eve/transcript.js";
import type { EveEnvelope } from "../eve/types.js";
import type { Rumor } from "../nostr/types.js";
import { HexStore, agentHome } from "../store.js";

const AGENT = "9".repeat(64);
const OPERATOR = "1".repeat(64);
const SESSION = "ses_01KYJBZA88B4M9XN3RTC5FDGHJ";

function sink() {
  const sent: { rumor: Rumor; ephemeral: boolean }[] = [];
  const impl: RumorSink = {
    publishRumor: async (rumor, _recipients, options) => {
      sent.push({ rumor, ephemeral: options?.ephemeral ?? false });
      return { delivered: [OPERATOR], undeliverable: [] };
    },
  };
  return { impl, sent };
}

const tag = (rumor: Rumor, name: string) =>
  rumor.tags.find((t) => t[0] === name)?.[1];
const parts = (rumor: Rumor) =>
  JSON.parse(rumor.content) as { type: string; [k: string]: unknown }[];

/**
 * One turn of a real Eve run, in the order Eve emits it: a prompt, some
 * reasoning, a tool call, its result, then the answer.
 *
 * The payload field names are Eve's own (`messageDelta`, `reasoningDelta`,
 * `finishReason`, `costUsd`) — taken from `eve@0.39`'s `protocol/message.d.ts`,
 * because a publisher that guesses them silently emits empty parts.
 */
const RUN: EveEnvelope[] = [
  { type: "session.started", data: {} },
  { type: "turn.started", data: { turnId: "trn_1", sequence: 1 } },
  {
    type: "message.received",
    data: { message: "which relays carry kind 30023?", turnId: "trn_1" },
  },
  { type: "step.started", data: { stepIndex: 0, turnId: "trn_1" } },
  {
    type: "reasoning.appended",
    data: { reasoningDelta: "NIP-66 monitors ", reasoningSoFar: "NIP-66 monitors " },
  },
  {
    type: "reasoning.appended",
    data: { reasoningDelta: "publish 30166", reasoningSoFar: "NIP-66 monitors publish 30166" },
  },
  {
    type: "reasoning.completed",
    data: { reasoning: "NIP-66 monitors publish 30166", stepIndex: 0 },
  },
  {
    type: "actions.requested",
    data: {
      actions: [
        {
          kind: "tool-call",
          callId: "call_1",
          toolName: "nostr_req",
          input: { kinds: [30166], limit: 50 },
        },
      ],
      stepIndex: 0,
      turnId: "trn_1",
    },
  },
  {
    type: "action.result",
    data: {
      result: {
        kind: "tool-result",
        callId: "call_1",
        toolName: "nostr_req",
        output: { relays: 41 },
      },
      stepIndex: 0,
      turnId: "trn_1",
    },
  },
  { type: "message.appended", data: { messageDelta: "41 relays " } },
  { type: "message.appended", data: { messageDelta: "advertise it." } },
  {
    type: "message.completed",
    data: { message: "41 relays advertise it.", finishReason: "stop", stepIndex: 1 },
  },
  {
    type: "step.completed",
    data: {
      finishReason: "stop",
      stepIndex: 1,
      turnId: "trn_1",
      usage: {
        inputTokens: 18432,
        outputTokens: 921,
        cacheReadTokens: 16000,
        cacheWriteTokens: 2432,
        costUsd: 0.0841,
      },
    },
  },
  { type: "turn.completed", data: { turnId: "trn_1" } },
  { type: "session.waiting", data: {} },
];

describe("EveTranscript", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eve-transcript-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function publisher(store: HexStore, impl: RumorSink, sessionId = SESSION) {
    return new EveTranscript(
      {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [OPERATOR],
        store,
        sink: impl,
        model: { id: "test-model", provider: "test" },
        setTimer: () => 0,
        clearTimer: () => {},
      },
      sessionId,
    );
  }

  it("maps one Eve turn onto a chained transcript", async () => {
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    for (const event of RUN) await pub.handle(event, ++index);

    const turns = sent.filter((s) => s.rumor.kind === 1777).map((s) => s.rumor);

    // Prompt, then the assistant's step, then the tool result, then the answer.
    expect(turns.map((t) => tag(t, "role"))).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(turns.map((t) => tag(t, "seq"))).toEqual(["1", "2", "3", "4"]);
    expect(turns.slice(1).map((t) => tag(t, "prev"))).toEqual(
      turns.slice(0, -1).map((t) => t.id),
    );

    // Reasoning and the call it led to travel together, as one step.
    expect(parts(turns[1]!).map((p) => p.type)).toEqual([
      "reasoning",
      "tool_call",
    ]);
    expect(parts(turns[1]!)[1]).toMatchObject({
      name: "nostr_req",
      arguments: { kinds: [30166], limit: 50 },
    });

    // A JSON tool output becomes text, because a transcript is read.
    expect(parts(turns[2]!)[0]).toMatchObject({
      type: "tool_result",
      name: "nostr_req",
      ok: true,
      output: '{"relays":41}',
    });

    // Eve's finishReason and token fields, as this NIP names them.
    const answer = turns[3]!;
    expect(parts(answer)[0]).toMatchObject({
      type: "text",
      text: "41 relays advertise it.",
    });
    expect(tag(answer, "stop")).toBe("end_turn");
    expect(answer.tags.find((t) => t[0] === "usage")).toEqual([
      "usage",
      "18432",
      "921",
      "16000",
      "2432",
    ]);

    const head = sent.filter((s) => s.rumor.kind === 31777).at(-1)!.rumor;
    expect(tag(head, "status")).toBe("idle");
    expect(tag(head, "last-seq")).toBe("4");
    expect(head.tags.find((t) => t[0] === "cost")).toEqual([
      "cost",
      "0.084100",
      "USD",
    ]);

    store.close();
  });

  it("streams the deltas Eve gives it, on wraps a relay must not store", async () => {
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    for (const event of RUN) await pub.handle(event, ++index);

    const deltas = sent.filter((s) => s.rumor.kind === 21777);
    expect(deltas.every((d) => d.ephemeral)).toBe(true);
    expect(deltas.map((d) => tag(d.rumor, "delta"))).toContain("reasoning");
    expect(deltas.map((d) => tag(d.rumor, "delta"))).toContain("text");
    // Coalesced: two appends of one kind are one delta, not two.
    expect(
      deltas.find((d) => tag(d.rumor, "delta") === "reasoning")!.rumor.content,
    ).toBe("NIP-66 monitors publish 30166");

    store.close();
  });

  it("holds awaiting-input on the head, which no turn can say", async () => {
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    await pub.handle({ type: "session.started", data: {} }, 1);
    await pub.handle({ type: "input.requested", data: {} }, 2);
    expect(
      tag(sent.filter((s) => s.rumor.kind === 31777).at(-1)!.rumor, "status"),
    ).toBe("awaiting-input");

    await pub.handle({ type: "input.resolved", data: {} }, 3);
    expect(
      tag(sent.filter((s) => s.rumor.kind === 31777).at(-1)!.rumor, "status"),
    ).toBe("active");

    store.close();
  });

  it("resumes both cursors after a restart instead of forking the chain", async () => {
    const first = HexStore.open(agentHome(home, AGENT).db);
    const one = sink();
    const before = publisher(first, one.impl);
    let index = 0;
    for (const event of RUN.slice(0, 4)) await before.handle(event, ++index);
    const lastTurn = one.sent.filter((s) => s.rumor.kind === 1777).at(-1)!.rumor;
    expect(before.streamIndex).toBe(4);
    first.close();

    const second = HexStore.open(agentHome(home, AGENT).db);
    const two = sink();
    const after = publisher(second, two.impl);
    // The cursor came off disk, so the stream is resumed rather than replayed.
    expect(after.streamIndex).toBe(4);

    for (const event of RUN.slice(4)) await after.handle(event, ++index);
    const resumed = two.sent.filter((s) => s.rumor.kind === 1777)[0]!.rumor;
    expect(tag(resumed, "seq")).toBe("2");
    expect(tag(resumed, "prev")).toBe(lastTurn.id);

    second.close();
  });

  it("ignores an event type it has never heard of", async () => {
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    await pub.handle({ type: "session.started", data: {} }, 1);
    const before = sent.length;
    // A runtime is free to add events; stopping on one turns an upgrade into an
    // outage.
    await pub.handle({ type: "compaction.requested", data: {} }, 2);
    await pub.handle({ type: "something.invented.later", data: {} }, 3);

    expect(sent).toHaveLength(before);
    expect(pub.streamIndex).toBe(3);

    store.close();
  });
});
