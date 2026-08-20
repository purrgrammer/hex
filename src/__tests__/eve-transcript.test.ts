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

function sink(options: { deliver?: () => boolean; slow?: boolean } = {}) {
  const sent: { rumor: Rumor; ephemeral: boolean }[] = [];
  /** How many publishes are in flight at once, and the worst it ever got. */
  let inFlight = 0;
  let peakInFlight = 0;
  const impl: RumorSink = {
    publishRumor: async (rumor, _recipients, opts) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // A macrotask, not a microtask: a publish that takes a real turn of the
      // loop is what lets a fire-and-forget caller pile up behind it.
      if (options.slow) await new Promise((resolve) => setTimeout(resolve, 0));
      else await Promise.resolve();
      inFlight -= 1;
      const delivered = options.deliver ? options.deliver() : true;
      sent.push({ rumor, ephemeral: opts?.ephemeral ?? false });
      return delivered
        ? { delivered: [OPERATOR], undeliverable: [] }
        : { delivered: [], undeliverable: [OPERATOR] };
    },
  };
  return { impl, sent, peak: () => peakInFlight };
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
  {
    type: "step.started",
    data: {
      // Eve names the model here and nowhere else, provider ahead of the slash.
      modelId: "anthropic/claude-opus-5",
      stepIndex: 0,
      turnId: "trn_1",
    },
  },
  {
    type: "reasoning.appended",
    data: {
      reasoningDelta: "NIP-66 monitors ",
      reasoningSoFar: "NIP-66 monitors ",
    },
  },
  {
    type: "reasoning.appended",
    data: {
      reasoningDelta: "publish 30166",
      reasoningSoFar: "NIP-66 monitors publish 30166",
    },
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
    data: {
      message: "41 relays advertise it.",
      finishReason: "stop",
      stepIndex: 1,
    },
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

  function publisher(
    store: HexStore,
    impl: RumorSink,
    sessionId = SESSION,
    extra: Partial<ConstructorParameters<typeof EveTranscript>[0]> = {},
  ) {
    return new EveTranscript(
      {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [OPERATOR],
        store,
        sink: impl,
        setTimer: () => 0,
        clearTimer: () => {},
        ...extra,
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
    // The model comes off the stream, split on the slash Eve puts it behind.
    expect(answer.tags.find((t) => t[0] === "model")).toEqual([
      "model",
      "claude-opus-5",
      "anthropic",
    ]);
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
    expect(head.tags.find((t) => t[0] === "model")).toEqual([
      "model",
      "claude-opus-5",
      "anthropic",
    ]);
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

  it("keeps the status Eve last reported when the follower just leaves", async () => {
    // A dropped connection is not a finished session. The endpoint is a live
    // follow with no end of its own, so the stream ending means the SOCKET ended
    // — and a head that claims `done` because undici raised `terminated` is a lie
    // no reader can detect.
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    await pub.handle({ type: "session.started", data: {} }, 1);
    await pub.handle({ type: "input.requested", data: {} }, 2);
    await pub.close();

    const head = sent.filter((s) => s.rumor.kind === 31777).at(-1)!.rumor;
    expect(tag(head, "status")).toBe("awaiting-input");

    store.close();
  });

  it("answers an approval once, whichever of Eve's two events lands first", async () => {
    /**
     * Eve emits `approval.settled` AND `input.resolved` for one approval, and
     * nothing in the protocol fixes their order. Publishing both put the same
     * decision in the chain twice — the duplication that a person reading their
     * own transcript notices immediately and no type can catch.
     */
    for (const order of [
      ["approval.settled", "input.resolved"],
      ["input.resolved", "approval.settled"],
    ]) {
      const store = HexStore.open(agentHome(home, AGENT).db);
      const { impl, sent } = sink();
      const pub = publisher(store, impl);

      await pub.handle({ type: "session.started", data: {} }, 1);
      await pub.handle(
        {
          type: "input.requested",
          data: {
            requests: [
              { requestId: "req_1", prompt: "Run it?", kind: "tool-approval" },
            ],
          },
        },
        2,
      );

      let index = 3;
      for (const type of order) {
        await pub.handle(
          type === "approval.settled"
            ? { type, data: { requestId: "req_1", outcome: "approved" } }
            : {
                type,
                data: {
                  resolutions: [{ requestId: "req_1", outcome: "answered" }],
                },
              },
          index++,
        );
      }

      const answers = sent
        .filter((s) => s.rumor.kind === 1777)
        .flatMap((s) => parts(s.rumor))
        .filter((part) => part.type === "input_resolved");
      expect(answers).toHaveLength(1);
      expect(answers[0]!.requestId).toBe("req_1");

      // And the head moved off the block, so the run is not left looking parked.
      expect(
        tag(sent.filter((s) => s.rumor.kind === 31777).at(-1)!.rumor, "status"),
      ).toBe("active");

      await pub.close();
      store.close();
    }
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
    const lastTurn = one.sent
      .filter((s) => s.rumor.kind === 1777)
      .at(-1)!.rumor;
    // The cursor keeps up with the STREAM, not with the publishes: most events
    // publish nothing, and a cursor that only moved on a publish fell hundreds of
    // events behind on a real turn.
    expect(before.streamIndex).toBe(4);
    first.close();

    const second = HexStore.open(agentHome(home, AGENT).db);
    const two = sink();
    const after = publisher(second, two.impl);
    // The cursor came off disk, so the stream is resumed rather than replayed.
    // On DISK it is where the last publish landed: the cursor is persisted in
    // batches, so a restart re-reads a few events that produced nothing. They are
    // deduped by their durable id if they publish, and were only ever in memory if
    // they do not.
    expect(after.streamIndex).toBe(3);

    for (const event of RUN.slice(4)) await after.handle(event, ++index);
    const resumed = two.sent.filter((s) => s.rumor.kind === 1777)[0]!.rumor;
    expect(tag(resumed, "seq")).toBe("2");
    expect(tag(resumed, "prev")).toBe(lastTurn.id);

    second.close();
  });

  it("attaches reasoning to the step that did it, not the one after", async () => {
    /**
     * Eve's REAL order for a step that calls a tool, read off a running
     * `eve dev`: the call, then the result, and only THEN `reasoning.completed`.
     * The assistant turn is flushed on the result, so waiting for the completed
     * event published the thinking one turn late — attached to the step after the
     * one that produced it, which is a transcript that lies about what the agent
     * was thinking when it acted.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    const REAL_ORDER: EveEnvelope[] = [
      { type: "session.started", data: {} },
      { type: "turn.started", data: { turnId: "turn_0" } },
      { type: "message.received", data: { message: "ls", turnId: "turn_0" } },
      {
        type: "step.started",
        data: {
          modelId: "ppq/moonshotai/kimi-k3",
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "reasoning.appended",
        data: {
          reasoningDelta: "Run a shell ",
          reasoningSoFar: "Run a shell ",
        },
      },
      {
        type: "reasoning.appended",
        data: {
          reasoningDelta: "command.",
          reasoningSoFar: "Run a shell command.",
        },
      },
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              kind: "tool-call",
              callId: "bash_0",
              toolName: "bash",
              input: { command: "ls -la" },
            },
          ],
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      {
        type: "action.result",
        data: {
          result: {
            kind: "tool-result",
            callId: "bash_0",
            toolName: "bash",
            output: { exitCode: 0 },
          },
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      // After the result, which is the whole point.
      {
        type: "reasoning.completed",
        data: { reasoning: "Run a shell command.", stepIndex: 0 },
      },
      {
        type: "step.completed",
        data: { finishReason: "tool-calls", stepIndex: 0, turnId: "turn_0" },
      },
    ];

    let index = 0;
    for (const event of REAL_ORDER) await pub.handle(event, ++index);
    await pub.close("done");

    const turns = sent.filter((s) => s.rumor.kind === 1777).map((s) => s.rumor);
    const step = turns.find((t) => tag(t, "role") === "assistant")!;
    expect(parts(step).map((p) => p.type)).toEqual(["reasoning", "tool_call"]);
    expect(parts(step)[0]).toMatchObject({ text: "Run a shell command." });

    // And exactly once: not repeated onto a later turn.
    const reasoningTurns = turns.filter((t) =>
      parts(t).some((p) => p.type === "reasoning"),
    );
    expect(reasoningTurns).toHaveLength(1);

    // The provider is the route, and the model keeps its own path.
    expect(step.tags.find((t) => t[0] === "model")).toEqual([
      "model",
      "moonshotai/kimi-k3",
      "ppq",
    ]);

    store.close();
  });

  it("sums a session's cost and puts each step's on its own turn", async () => {
    // The session cost was ASSIGNED per step, so a ten-step run reported the cost
    // of its last step — the smallest number in the run, presented as the total —
    // and the turn carried nothing, so nobody could see which step spent it.
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    const step = (index: number, costUsd: number): EveEnvelope[] => [
      {
        type: "step.started",
        data: { modelId: "anthropic/claude-opus-5", stepIndex: index },
      },
      {
        type: "message.completed",
        data: {
          message: `step ${index}`,
          finishReason: "stop",
          stepIndex: index,
        },
      },
      {
        type: "step.completed",
        data: {
          finishReason: "stop",
          stepIndex: index,
          turnId: "turn_0",
          usage: { inputTokens: 10, outputTokens: 1, costUsd },
        },
      },
    ];

    let index = 0;
    await pub.handle({ type: "session.started", data: {} }, ++index);
    for (const event of [...step(0, 0.25), ...step(1, 0.5)])
      await pub.handle(event, ++index);
    await pub.close("done");

    const turns = sent.filter((s) => s.rumor.kind === 1777).map((s) => s.rumor);
    expect(turns.map((t) => t.tags.find((x) => x[0] === "cost"))).toEqual([
      ["cost", "0.250000", "USD"],
      ["cost", "0.500000", "USD"],
    ]);

    const head = sent.filter((s) => s.rumor.kind === 31777).at(-1)!.rumor;
    expect(head.tags.find((t) => t[0] === "cost")).toEqual([
      "cost",
      "0.750000",
      "USD",
    ]);

    store.close();
  });

  it("stays awaiting-input when the turn epilogue says otherwise", async () => {
    /**
     * The load-bearing one.
     *
     * Eve parks a question with `input.requested`, then emits `turn.completed`
     * and `session.waiting` — and `session.waiting` is byte-identical whether a
     * turn finished or is blocked on a human. So `awaiting-input` lived for one
     * event and `idle` was written over it milliseconds later: a session waiting
     * on the operator, published as done, with the question never published at
     * all.
     *
     * The head's status is derived from the open requests, not from whichever
     * event arrived last.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);
    const statusOf = () =>
      sent
        .map((s) => s.rumor)
        .filter((r) => r.kind === 31777)
        .at(-1)!
        .tags.find((t) => t[0] === "status")?.[1];

    let index = 0;
    await pub.handle({ type: "session.started", data: {} }, ++index);
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      {
        type: "input.requested",
        data: {
          turnId: "turn_0",
          requests: [
            {
              requestId: "req_1",
              kind: "tool-approval",
              display: "confirmation",
              allowFreeform: false,
              prompt: "Approve tool call: bash",
              options: [
                { id: "approve", label: "Approve" },
                { id: "cancel", label: "Cancel" },
              ],
              action: {
                kind: "tool-call",
                callId: "call_1",
                toolName: "bash",
                input: {},
              },
            },
          ],
        },
      },
      ++index,
    );
    expect(statusOf()).toBe("awaiting-input");

    // Eve's own epilogue for a parked turn. It used to end the session.
    await pub.handle(
      { type: "turn.completed", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle({ type: "session.waiting", data: {} }, ++index);
    expect(statusOf()).toBe("awaiting-input");

    // The head names what is open, so a reader knows what to answer.
    const head = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 31777)
      .at(-1)!;
    expect(head.tags.filter((t) => t[0] === "input").map((t) => t[1])).toEqual([
      "req_1",
    ]);

    // And the question itself is in the transcript, with its options.
    const asked = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 1777)
      .flatMap((r) => JSON.parse(r.content) as { type: string }[])
      .find((part) => part.type === "input_request") as
      { prompt: string; options: { id: string }[] } | undefined;
    expect(asked?.prompt).toBe("Approve tool call: bash");
    expect(asked?.options.map((o) => o.id)).toEqual(["approve", "cancel"]);

    // Answered, and the run is live again.
    await pub.handle(
      {
        type: "input.resolved",
        data: {
          turnId: "turn_0",
          resolutions: [
            { requestId: "req_1", kind: "tool-approval", outcome: "approved" },
          ],
        },
      },
      ++index,
    );
    expect(statusOf()).toBe("active");
    store.close();
  });

  it("publishes the person's message once, however often it is announced", async () => {
    /**
     * Seen in the published transcripts: the same words twice, one `seq` apart.
     * A retried or resumed step re-emits `message.received` under a NEW event id
     * carrying the same `turnId`, and the runtime says outright that no field
     * records which attempt finished — so the id dedupe cannot see it.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    const said = {
      type: "message.received",
      data: { message: "do the thing", turnId: "turn_0" },
    };
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle({ ...said, meta: { id: "evt_first" } }, ++index);
    await pub.handle({ ...said, meta: { id: "evt_replay" } }, ++index);

    const users = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 1777)
      .filter((r) => r.tags.some((t) => t[0] === "role" && t[1] === "user"));
    expect(users).toHaveLength(1);

    // A genuinely new turn is not the same message.
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_1" } },
      ++index,
    );
    await pub.handle(
      {
        type: "message.received",
        data: { message: "and again", turnId: "turn_1" },
        meta: { id: "evt_second" },
      },
      ++index,
    );
    expect(
      sent
        .map((s) => s.rumor)
        .filter((r) => r.kind === 1777)
        .filter((r) => r.tags.some((t) => t[0] === "role" && t[1] === "user")),
    ).toHaveLength(2);
    store.close();
  });

  it("counts a step's tokens even when the step publishes nothing", async () => {
    /**
     * Seen live: a session reporting 0 in / 0 out and 0.200693 USD. `flush`
     * returns early when a step produced nothing publishable — its words went
     * out with an earlier turn — and the usage handed to it was discarded, while
     * the cost had already been added. Two numbers describing different things.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    // A step that says something, and a step that says nothing new.
    await pub.handle(
      { type: "message.completed", data: { message: "hello" } },
      ++index,
    );
    await pub.handle(
      {
        type: "step.completed",
        data: {
          finishReason: "stop",
          turnId: "turn_0",
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
        },
      },
      ++index,
    );
    await pub.handle(
      {
        type: "step.completed",
        data: {
          finishReason: "stop",
          turnId: "turn_0",
          usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 50 },
        },
      },
      ++index,
    );
    // The head republishes on a status change, so the totals reach a reader at
    // the turn boundary rather than after every step.
    await pub.handle(
      { type: "turn.completed", data: { turnId: "turn_0" } },
      ++index,
    );

    const head = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 31777)
      .at(-1)!;
    // Both steps counted, and counted once each.
    expect(head.tags.find((t) => t[0] === "usage")).toEqual([
      "usage",
      "300",
      "30",
      "50",
      "0",
    ]);
    store.close();
  });

  it("gives a compaction its own turn rather than folding it into a reply", async () => {
    // It is not something the agent said — it is something that happened to the
    // conversation, and a reader needs to see where it stopped remembering.
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle({ type: "compaction.completed", data: {} }, ++index);

    const turn = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 1777)
      .at(-1)!;
    expect(turn.tags.find((t) => t[0] === "role")?.[1]).toBe("tool");
    expect(turn.content).toContain("summarised to fit the context window");
    store.close();
  });

  it("records a cancelled turn as cancelled, even when it had said nothing", async () => {
    /**
     * The two halves of the same bug. A cancel used to flush with
     * `stop: "error"` — calling an operator's decision a fault — and to publish
     * nothing whatsoever when the turn was between steps, which is where a
     * cancel usually lands. The head said `aborted` and the transcript said
     * the run simply stopped mid-sentence.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      { type: "turn.cancelled", data: { turnId: "turn_0" } },
      ++index,
    );

    const silent = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 1777)
      .at(-1)!;
    expect(silent.content).toContain("stopped before it answered");

    // And with something buffered, the words it got out are the record — one
    // turn, not the flush plus a marker saying it never spoke.
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_1" } },
      ++index,
    );
    await pub.handle(
      {
        type: "message.completed",
        data: { turnId: "turn_1", message: "Halfway through I was" },
      },
      ++index,
    );
    await pub.handle(
      { type: "turn.cancelled", data: { turnId: "turn_1" } },
      ++index,
    );

    const spoke = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 1777)
      .at(-1)!;
    expect(spoke.content).toContain("Halfway through I was");
    expect(spoke.tags.find((t) => t[0] === "stop")?.[1]).toBe("cancelled");
    store.close();
  });

  it("publishes where to go when a run needs a sign-in", async () => {
    /**
     * `payment-required` told a reader the run was stuck and nothing about what
     * would unstick it: the URL, the device code and the deadline all arrive on
     * this event and were dropped. It is the one blocked state where the
     * transcript is the instruction.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      {
        type: "authorization.required",
        data: {
          turnId: "turn_0",
          name: "salesforce",
          authorization: {
            displayName: "Salesforce",
            url: "https://example.com/device",
            userCode: "WXYZ-1234",
          },
        },
      },
      ++index,
    );

    const turn = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 1777)
      .at(-1)!;
    expect(turn.content).toContain("https://example.com/device");
    expect(turn.content).toContain("WXYZ-1234");
    expect(turn.content).toContain("Salesforce");
    // And it is not a question: nobody answers this one, they go and do it.
    expect(turn.content).toContain("Nothing to reply to");

    const head = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 31777)
      .at(-1)!;
    expect(head.tags.find((t) => t[0] === "status")?.[1]).toBe(
      "payment-required",
    );
    store.close();
  });

  it("keeps what a run is about across every head it publishes", async () => {
    /**
     * The bug this fixes was invisible from the inside: subjects lived on the
     * transcript object, so the FIRST head carried them and none after did —
     * and a head is replaceable, so the only one a reader sees is the last.
     * Every "runs about this repository" list was empty while the data sat
     * there in the first version of each head.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);
    const repo = "30617:1a2b:grimoire";
    pub.subjects = [["a", repo]];

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      { type: "turn.completed", data: { turnId: "turn_0" } },
      ++index,
    );

    const heads = sent.map((s) => s.rumor).filter((r) => r.kind === 31777);
    expect(heads.length).toBeGreaterThan(1);
    for (const head of heads)
      expect(head.tags.find((t) => t[0] === "a")?.[1]).toBe(repo);

    // And a process that restarts and picks the session back up still knows.
    const resumed = publisher(store, impl);
    expect(resumed.subjects).toEqual([["a", repo]]);
    store.close();
  });

  it("files a group run in its group as well as wrapping it, as one event", async () => {
    /**
     * A gift wrap answers "who may read this" with a list of names, which is
     * right for a private message and wrong for a room of forty people: the
     * question was public and exactly one person could open the answer.
     *
     * The same rumor goes out both doors. A rumor is already hashed, so signing
     * adds a signature and nothing else — which is what lets a reader holding
     * both copies see one session rather than two.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const cleared: string[] = [];
    const pub = publisher(store, impl, SESSION, {
      group: {
        publish: async (rumor: { id: string }) => {
          cleared.push(rumor.id);
          return { delivered: ["wss://relay.example"], undeliverable: [] };
        },
      },
    });
    pub.carriage = "group";
    pub.group = "GROUPID";
    pub.groupRelay = "wss://groups.example";

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      {
        type: "message.completed",
        data: { turnId: "turn_0", message: "Here you go." },
      },
      ++index,
    );
    await pub.handle(
      { type: "turn.completed", data: { turnId: "turn_0" } },
      ++index,
    );

    const wrapped = sent.map((s) => s.rumor).filter((r) => r.kind === 1777);
    expect(wrapped.length).toBeGreaterThan(0);
    for (const rumor of wrapped) {
      // One event, two doors. The `h` tag is on the copy that gets WRAPPED as
      // well, which is what makes the ids match — tagging only the group copy
      // would put two events at one `seq`, the signature this NIP tells a
      // client to read as a forgery.
      expect(rumor.tags).toContainEqual(["h", "GROUPID"]);
      expect(cleared).toContain(rumor.id);
    }
    store.close();
  });

  it("keeps a wrapped run wrapped, whatever the group door offers", async () => {
    // The default, and the one that must not drift: a session opened in a
    // private conversation has no public reading, and a sink being present is
    // not a decision about this run.
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl } = sink();
    const cleared: string[] = [];
    const pub = publisher(store, impl, SESSION, {
      group: {
        publish: async (rumor: { id: string }) => {
          cleared.push(rumor.id);
          return { delivered: ["wss://relay.example"], undeliverable: [] };
        },
      },
    });

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      {
        type: "message.completed",
        data: { turnId: "turn_0", message: "Private." },
      },
      ++index,
    );
    await pub.handle(
      { type: "turn.completed", data: { turnId: "turn_0" } },
      ++index,
    );

    expect(cleared).toEqual([]);
    store.close();
  });

  it("stops a group copy at the first refusal rather than leaving a hole", async () => {
    /**
     * There is one chain and one `last-seq`. A public copy missing an event in
     * the middle is a gap a reader is required to render and can never fill; a
     * copy that visibly stops short simply reads as behind. And the operator's
     * wrap is never held hostage by a public relay being down.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const attempts: string[] = [];
    const pub = publisher(store, impl, SESSION, {
      group: {
        publish: async (rumor: { id: string }) => {
          attempts.push(rumor.id);
          return { delivered: [], undeliverable: ["wss://relay.example"] };
        },
      },
    });
    pub.carriage = "group";
    pub.group = "GROUPID";
    pub.groupRelay = "wss://groups.example";

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      {
        type: "message.completed",
        data: { turnId: "turn_0", message: "One." },
      },
      ++index,
    );
    await pub.handle(
      { type: "turn.completed", data: { turnId: "turn_0" } },
      ++index,
    );

    // Tried once, then stopped asking.
    expect(attempts).toHaveLength(1);
    // And the wrapped copy carried on regardless.
    expect(sent.some((s) => s.rumor.kind === 1777)).toBe(true);
    store.close();
  });

  it("keeps a turn's structured result rather than dropping it", async () => {
    /**
     * A run given an output schema answers with a `result` rather than with
     * prose, and the prose channel is then empty. Ignoring the event would
     * publish a turn that did its work and said nothing — the one failure that
     * looks exactly like an agent with nothing to add.
     *
     * Hex never ASKS for a schema; nothing here wants one. This is the read
     * side, so a runtime that was configured with one elsewhere still produces
     * a readable transcript.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      {
        type: "result.completed",
        data: { turnId: "turn_0", result: { verdict: "mergeable", tests: 29 } },
      },
      ++index,
    );
    await pub.handle(
      { type: "turn.completed", data: { turnId: "turn_0" } },
      ++index,
    );

    const turn = sent
      .map((s) => s.rumor)
      .filter((r) => r.kind === 1777)
      .at(-1)!;
    expect(turn.content).toContain("mergeable");
    store.close();
  });

  it("clears awaiting-authorisation when the sign-in resolves", async () => {
    /**
     * `authorization.required` put the head in `payment-required` and nothing
     * ever took it out, so a reader was told to go and authorise something that
     * had been authorised ten minutes earlier — for the life of the session.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);
    const statusOf = () => {
      const head = sent
        .map((s) => s.rumor)
        .filter((r) => r.kind === 31777)
        .at(-1)!;
      return head.tags.find((t) => t[0] === "status")?.[1];
    };

    let index = 0;
    await pub.handle({ type: "session.started", data: {} }, ++index);
    await pub.handle(
      { type: "turn.started", data: { turnId: "turn_0" } },
      ++index,
    );
    await pub.handle(
      {
        type: "authorization.required",
        data: { name: "github", authorization: { url: "https://example" } },
      },
      ++index,
    );
    expect(statusOf()).toBe("payment-required");

    await pub.handle(
      { type: "authorization.completed", data: { outcome: "authorized" } },
      ++index,
    );
    expect(statusOf()).toBe("active");
    store.close();
  });

  it("names the child session a subagent call started", async () => {
    /**
     * A subagent's work is a separate session — own head, own chain — so the
     * turn that spawned it can only point at it. Without the pointer the row is
     * a dead end, which is exactly where a reader most wants to follow.
     *
     * The ORDER here is the real one, read off a live run, and it is the whole
     * reason this was broken. The runtime announces the child AFTER the step
     * that requested it has completed: `actions.requested`, `step.completed` —
     * which flushes the turn carrying the `tool_call` — and only then
     * `subagent.called`. The previous version of this test put the
     * announcement first, which never happens, so the code and the test were
     * wrong together and the suite was green while no tag was ever published.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    await pub.handle({ type: "session.started", data: {} }, ++index);
    await pub.handle(
      {
        type: "step.started",
        data: { modelId: "anthropic/claude-opus-5", stepIndex: 0 },
      },
      ++index,
    );
    await pub.handle(
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              kind: "tool-call",
              callId: "call_sub",
              toolName: "agent",
              input: { prompt: "audit" },
            },
          ],
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      ++index,
    );
    // The call's turn is published HERE, before anyone has heard of a child.
    await pub.handle(
      {
        type: "step.completed",
        data: { finishReason: "tool-calls", stepIndex: 0, turnId: "turn_0" },
      },
      ++index,
    );
    await pub.handle(
      {
        type: "subagent.called",
        // `childSessionId` is Eve's own name for it. The test asserted
        // `sessionId` — the same wrong guess the code made — so both were wrong
        // together and the suite was green.
        // No name here: the runtime does not put one on the call.
        data: { callId: "call_sub", childSessionId: "wrun_CHILD" },
      },
      ++index,
    );
    /**
     * The NAME arrives with the completion, not with the call. The first tag
     * ever published live had a call id, a child session and no name — because
     * `subagent.called` carries no readable name at all.
     */
    await pub.handle(
      {
        type: "subagent.completed",
        data: { callId: "call_sub", subagentName: "auditor", output: "POTATO" },
      },
      ++index,
    );
    // And the result, which carries the same callId and is where the pointer
    // can still honestly go.
    await pub.handle(
      {
        type: "action.result",
        data: {
          result: { kind: "tool-result", callId: "call_sub", output: "POTATO" },
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
      ++index,
    );
    await pub.handle(
      {
        type: "step.completed",
        data: { finishReason: "stop", stepIndex: 1, turnId: "turn_0" },
      },
      ++index,
    );

    const turn = sent
      .filter((s) => s.rumor.kind === 1777)
      .map((s) => s.rumor)
      .find((t) => t.tags.some((x) => x[0] === "subagent"))!;
    expect(turn).toBeDefined();
    expect(turn.tags.find((t) => t[0] === "subagent")).toEqual([
      "subagent",
      "call_sub",
      "wrun_CHILD",
      "auditor",
    ]);

    store.close();
  });

  it("does not ship the same head twice", async () => {
    // Eve announces one state from more than one direction — `session.started`
    // then `turn.started`, `session.completed` then the close on the way out —
    // and a head is addressable, so a republished duplicate changes nothing a
    // reader can see and costs a seal and a wrap per recipient.
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    let index = 0;
    for (const event of RUN) await pub.handle(event, ++index);
    await pub.close("done");

    const heads = sent
      .filter((s) => s.rumor.kind === 31777)
      .map((s) => JSON.stringify(s.rumor.tags));
    expect(new Set(heads).size).toBe(heads.length);

    store.close();
  });

  it("leaves seq free when a turn reaches nobody, rather than a hole", async () => {
    // Burning a number on an event that exists nowhere is the one failure that
    // cannot be repaired: the next turn's `prev` names nothing, and every
    // conforming reader must read the chain as broken or forged.
    const store = HexStore.open(agentHome(home, AGENT).db);
    let deliver = false;
    const { impl, sent } = sink({ deliver: () => deliver });
    const pub = publisher(store, impl);

    let index = 0;
    for (const event of RUN.slice(0, 3)) await pub.handle(event, ++index);

    // The turn was built and offered, and reached nobody.
    expect(sent.some((s) => s.rumor.kind === 1777)).toBe(true);
    expect(store.transcriptFor(SESSION)?.seq ?? 0).toBe(0);

    // The next turn to land takes the number the failed one did not keep, so
    // the chain stays contiguous and `prev` names an event that exists.
    deliver = true;
    for (const event of RUN.slice(3)) await pub.handle(event, ++index);
    const turns = sent.filter((s) => s.rumor.kind === 1777).slice(1);
    const seqs = turns.map(
      (t) => t.rumor.tags.find((x) => x[0] === "seq")?.[1],
    );
    expect(seqs[0]).toBe("1");
    expect(new Set(seqs).size).toBe(seqs.length);

    store.close();
  });

  it("republishes a terminal head whose first attempt failed", async () => {
    // `session.completed` then the close on the way out fingerprint identically
    // within the same second, so suppressing before delivery threw away the one
    // retry the shutdown path structurally has — leaving a head that says
    // `active` forever.
    const store = HexStore.open(agentHome(home, AGENT).db);
    let deliver = false;
    const { impl, sent } = sink({ deliver: () => deliver });
    const pub = publisher(store, impl);

    await pub.handle({ type: "session.started", data: {} }, 1);
    await pub.handle({ type: "session.completed", data: {} }, 2);
    const failed = sent.filter((s) => s.rumor.kind === 31777).length;

    deliver = true;
    await pub.close("done");
    const heads = sent.filter((s) => s.rumor.kind === 31777);
    expect(heads.length).toBeGreaterThan(failed);
    expect(tag(heads.at(-1)!.rumor, "status")).toBe("done");

    store.close();
  });

  it("publishes deltas one at a time however fast they arrive", async () => {
    // The coalescer flushes synchronously on its byte threshold, so
    // fire-and-forget put dozens of publishes in flight at once — each a seal
    // through a signer that takes one call at a time, and its own socket.
    const store = HexStore.open(agentHome(home, AGENT).db);
    const s = sink({ slow: true });
    const pub = publisher(store, s.impl);

    let index = 0;
    await pub.handle({ type: "session.started", data: {} }, ++index);
    await pub.handle({ type: "turn.started", data: { turnId: "t" } }, ++index);
    for (let i = 0; i < 60; i++)
      await pub.handle(
        { type: "message.appended", data: { messageDelta: "x".repeat(200) } },
        ++index,
      );
    await pub.close("done");

    expect(s.peak()).toBe(1);

    store.close();
  });

  it("drops an event Eve replays, rather than publishing it twice", async () => {
    /**
     * Eve's stream replays. A real run emitted `reasoning.completed`,
     * `message.completed` and `step.completed` for one step twice under the SAME
     * `evt_` ids, and the transcript published the answer as two turns. Eve ships
     * `createEventDeduper` for this and keys it on the durable `meta.id`.
     */
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    const answer: EveEnvelope = {
      type: "message.completed",
      data: { message: "done", finishReason: "stop", stepIndex: 0 },
      meta: { id: "evt_01ANSWER" },
    };
    const closed: EveEnvelope = {
      type: "step.completed",
      data: { finishReason: "stop", stepIndex: 0, turnId: "turn_0" },
      meta: { id: "evt_01STEP" },
    };

    let index = 0;
    await pub.handle(
      { type: "session.started", data: {}, meta: { id: "evt_01START" } },
      ++index,
    );
    await pub.handle(answer, ++index);
    await pub.handle(closed, ++index);
    // The replay: same events, same ids, at the indices they arrive on again.
    await pub.handle(answer, index + 1);
    await pub.handle(closed, index + 2);
    await pub.close("done");

    const answers = sent
      .filter((s) => s.rumor.kind === 1777)
      .filter((s) => s.rumor.content.includes("done"));
    expect(answers).toHaveLength(1);

    store.close();
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
    // Nothing was published, and the cursor still moved: an event that produces
    // no event is one there is no reason to read twice.
    expect(pub.streamIndex).toBe(3);

    store.close();
  });
});
