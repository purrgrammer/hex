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

  function publisher(store: HexStore, impl: RumorSink, sessionId = SESSION) {
    return new EveTranscript(
      {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [OPERATOR],
        store,
        sink: impl,
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
    // A subagent's work is a separate session — own head, own chain — so the turn
    // that spawned it can only point at it. Without the pointer the row is a dead
    // end, which is exactly where a reader most wants to follow.
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
    await pub.handle(
      {
        type: "subagent.called",
        // `childSessionId` is Eve's own name for it. The test asserted
        // `sessionId` — the same wrong guess the code made — so both were wrong
        // together and the suite was green.
        data: {
          callId: "call_sub",
          childSessionId: "wrun_CHILD",
          subagentName: "auditor",
        },
      },
      ++index,
    );
    await pub.handle(
      {
        type: "step.completed",
        data: { finishReason: "tool-calls", stepIndex: 0, turnId: "turn_0" },
      },
      index + 1,
    );

    const turn = sent
      .filter((s) => s.rumor.kind === 1777)
      .map((s) => s.rumor)
      .find((t) => t.tags.some((x) => x[0] === "subagent"))!;
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
