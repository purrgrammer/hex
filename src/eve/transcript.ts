/**
 * An Eve session, published as events (NIP-xx: Agent Sessions).
 *
 * Eve's stream and this NIP describe the same object in the same shape — a turn
 * is a role and an ordered list of parts, each text, reasoning, a tool call or
 * its result — so this is a mapping and not a translation. What it adds is the
 * envelope: each turn is sealed to whoever is meant to read it and wrapped under
 * a throwaway key, and the head says where the session currently stands.
 *
 * Two cursors, both durable. Eve's `startIndex` says how far this consumer has
 * read; `seq`/`prev` are the chain on the wire. Losing the second is worse than
 * losing the first: a restart that resumed at `seq` 1 would publish a second
 * chain under one session id, and a conforming reader is required to read that as
 * a fork rather than a continuation.
 *
 * Nothing here throws into the stream. A relay that will not take a transcript
 * must not stop the agent it is watching.
 */

import { createHash, randomBytes } from "node:crypto";

import { DeltaCoalescer, type CoalescedDelta } from "../nostr/coalesce.js";
import { fitTurn } from "../nostr/blob.js";
import {
  buildAgentDefinition,
  buildDelta,
  buildSessionHead,
  buildTurn,
} from "../nostr/encode.js";
import type {
  AgentToolSpec,
  Cost,
  Rumor,
  SessionStatus,
  SubagentRef,
  TurnPart,
  TurnRole,
  Usage,
} from "../nostr/types.js";
import { isKnownPart } from "../nostr/types.js";
import type { HexStore, StoredTranscript } from "../store.js";
import {
  outputText,
  payload,
  stopFor,
  stringField,
  usageFor,
  type EveActionRequest,
  type EveActionResult,
  type EveEnvelope,
} from "./types.js";

/** What the publisher needs of a transport: one door for a rumor. */
export interface RumorSink {
  publishRumor(
    rumor: Rumor,
    recipients: string[],
    options?: { ephemeral?: boolean; selfCopy?: boolean },
  ): Promise<{ delivered: string[]; undeliverable: string[] }>;
}

export interface EveTranscriptOptions {
  agentPubkey: string;
  /** The `d` tag of the agent's definition. */
  slug: string;
  /** Who receives the transcript. The operator, usually exactly one. */
  recipients: string[];
  store: HexStore;
  sink: RumorSink;
  /** Off means nothing streams; the turns still arrive when they close. */
  deltas?: boolean;
  /** Overrides what the stream says. For a runtime that does not name one. */
  model?: { id: string; provider?: string };
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** How many coalesced deltas may wait behind the one being published. */
const MAX_QUEUED_DELTAS = 4;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * One Eve session, followed and published.
 *
 * Built per session because the cursor is per session. Feed it events in order —
 * from `streamSession`, or from an array in a test — and it publishes as it goes.
 */
export class EveTranscript {
  private record: StoredTranscript;
  private readonly coalescer: DeltaCoalescer;
  /** Parts of the step being assembled, flushed when the step completes. */
  private pending: TurnPart[] = [];
  /**
   * The model, as the stream last named it.
   *
   * Not persisted, and it does not need to be: a model tag belongs on an
   * assistant turn, an assistant turn is only published once a step has closed,
   * and a step always announces itself first. A head republished by a resumed
   * process before its first step is the one event that can lack it, and the next
   * head carries it.
   */
  private model?: { id: string; provider?: string };

  /**
   * Where the stream is now, and where it is safe to say it has been read to.
   *
   * These are deliberately two numbers. The durable one (`record.streamIndex`)
   * advances only when a publish LANDS, so a turn that reached nobody leaves the
   * cursor behind it and a restart replays the Eve events that produced it. An
   * event that publishes nothing — a reasoning fragment, a step announcing its
   * model — moves only the live one, so replaying it costs a rebuild of state
   * that was in memory anyway.
   *
   * Advancing the durable cursor per event was the hole in the retry story: the
   * next head to publish would carry the cursor past the turn that failed, and
   * the restart would skip it.
   */
  private atIndex = 0;

  /**
   * What this step has thought so far, and whether it has been published.
   *
   * Kept separately from `pending` because the reasoning is complete long before
   * Eve says so: `reasoning.appended` carries `reasoningSoFar`, while
   * `reasoning.completed` arrives after the tool result on a real stream.
   */
  private stepReasoning?: string;
  private reasoningPublished = false;

  /**
   * Child sessions this step started, by the call that started them.
   *
   * Collected across `subagent.called` and `subagent.started`, which name the
   * session id and the subagent's name in either order, and drained onto the turn
   * the step flushes.
   */
  private subagents = new Map<string, SubagentRef>();

  /** Durable ids of events already handled, so a replay is not republished. */
  private readonly seen = new Set<string>();

  /** Tool calls seen this step, so a result can name the tool it answers. */
  private readonly calls = new Map<string, string>();

  constructor(
    private readonly options: EveTranscriptOptions,
    /** Eve's session id. The wire's is derived once and kept. */
    readonly sessionId: string,
  ) {
    // A configured model is the starting point; the stream overwrites it the
    // moment it names one of its own.
    this.model = options.model;
    this.record = options.store.transcriptFor(sessionId) ?? {
      sessionId,
      nostrId: randomBytes(32).toString("hex"),
      seq: 0,
      turn: 0,
      status: "active",
      streamIndex: 0,
      startedAt: Math.floor(Date.now() / 1000),
      inTokens: 0,
      outTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    this.coalescer = new DeltaCoalescer({
      emit: (delta) => {
        this.queueDelta(delta);
      },
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
  }

  /**
   * Deltas leave one at a time, and at most a few wait their turn.
   *
   * The coalescer flushes synchronously on its byte threshold, so a
   * fire-and-forget send put dozens of publishes in flight at once — each one a
   * seal through a signer that handles one call at a time, a kind-10050 lookup,
   * and its own socket. A delta is worth nothing once it is late, so the queue is
   * short and the overflow is DROPPED rather than buffered: everything a delta
   * carried is repeated in the turn that closes it.
   */
  private deltaTail: Promise<void> = Promise.resolve();
  private deltaQueued = 0;
  private deltaDropped = 0;

  private queueDelta(delta: CoalescedDelta): void {
    if (this.deltaQueued >= MAX_QUEUED_DELTAS) {
      this.deltaDropped += 1;
      return;
    }
    this.deltaQueued += 1;
    this.deltaTail = this.deltaTail.then(async () => {
      this.deltaQueued -= 1;
      await this.sendDelta(delta);
    });
  }

  /**
   * The event that set this session running, on the head as `["e", id, …, "trigger"]`.
   *
   * Set from OUTSIDE, because only the caller knows it: a Nostr event id is not
   * something the runtime has ever heard of. It used to be filled with Eve's
   * `turnId`, which put a string no relay has ever stored into a tag every reader
   * treats as an event id — a pointer at nothing, indistinguishable from a pointer
   * at something deleted.
   *
   * This is the link that makes a session findable from the message that caused
   * it: a client holding the message queries for heads tagging it and lists the
   * runs underneath, rather than the answer having to carry a pointer back.
   */
  set trigger(id: string | undefined) {
    this.record.trigger = id;
  }

  get trigger(): string | undefined {
    return this.record.trigger;
  }

  /**
   * The session's address on the wire.
   *
   * Kept apart from Eve's own session id, which is Eve's to shape and not
   * something to hand a relay. Exposed because a message that quotes this session
   * has to name it.
   */
  get nostrId(): string {
    return this.record.nostrId;
  }

  /** Where to resume Eve's stream. */
  get streamIndex(): number {
    return this.record.streamIndex;
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** Publish the agent's definition. Once per agent, not per session. */
  async announce(definition: {
    name: string;
    about?: string;
    picture?: string;
    instructions?: string;
    tools?: AgentToolSpec[];
    suggestions?: string[];
  }): Promise<void> {
    await this.send(
      buildAgentDefinition(this.options.agentPubkey, {
        slug: this.options.slug,
        ...definition,
        alt: `${definition.name} — an agent's definition`,
      }),
      "definition",
    );
  }

  /**
   * Take one event.
   *
   * Unknown types advance the cursor and do nothing else: a runtime is free to
   * emit events this consumer has never heard of, and stopping on one would turn
   * an upgrade into an outage.
   */
  async handle(event: EveEnvelope, index?: number): Promise<void> {
    if (index !== undefined) this.atIndex = index;

    /**
     * An event Eve has already given us is dropped, keyed on its durable id.
     *
     * Eve's stream replays: a real run emitted `reasoning.completed`,
     * `message.completed` and `step.completed` for one step TWICE, under the same
     * `evt_` ids, and the transcript published the answer twice as two turns. Eve
     * ships `createEventDeduper` for precisely this and documents why the window
     * is unbounded — a bounded one cannot survive a rewind past its capacity,
     * because evicting the oldest id re-admits it and the whole replay cascades
     * back in. A retried step is NOT a duplicate; it re-emits under new ids.
     *
     * Only ids are held, and only for one followed session, so the set is small
     * next to what a turn already costs.
     */
    const id = event.meta?.id;
    if (id !== undefined) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
    }

    const data = payload(event);

    switch (event.type) {
      case "session.started":
        await this.status("active");
        break;

      case "turn.started":
        this.record.turn += 1;
        this.coalescer.startTurn(this.record.turn);
        await this.status("active");
        break;

      /**
       * `step.started` is where Eve names the model, and the only place it does.
       *
       * Taken from the stream rather than from config: the config would be a
       * second copy of a fact the runtime owns, and the runtime is free to switch
       * model between steps — an agent that falls back to a cheaper one mid-turn
       * would otherwise publish a transcript claiming the model it was started
       * with. `modelId` carries the provider ahead of a slash when there is one.
       */
      case "step.started": {
        // A new model call: whatever the last one thought is no longer pending.
        this.stepReasoning = undefined;
        this.reasoningPublished = false;
        const id = stringField(data, "modelId");
        if (id) {
          const slash = id.indexOf("/");
          this.model =
            slash > 0
              ? { id: id.slice(slash + 1), provider: id.slice(0, slash) }
              : { id };
        }
        break;
      }

      /**
       * A subagent was set running, and its work is somewhere else.
       *
       * `subagent.called` is where Eve names the child's session id alongside the
       * tool call that spawned it. The child is a session of its own — own head,
       * own chain — so this turn can only point at it, and the pointer is Eve's
       * id rather than a Nostr address because the address depends on who
       * followed the child and nobody may have.
       */
      case "subagent.called":
      case "subagent.started": {
        const callId = stringField(data, "callId");
        const childSession = stringField(data, "sessionId");
        const name = stringField(data, "subagentName");
        if (callId && (childSession || name))
          this.subagents.set(callId, {
            callId,
            session: childSession ?? this.subagents.get(callId)?.session ?? "",
            name: name ?? this.subagents.get(callId)?.name,
          });
        break;
      }

      case "message.received": {
        const text = stringField(data, "message") ?? "";
        await this.append("user", [{ type: "text", text }], {
          alt: text.slice(0, 200),
        });
        break;
      }

      case "reasoning.appended": {
        const delta = stringField(data, "reasoningDelta") ?? "";
        // `reasoningSoFar` is the whole thing so far, which is what makes the
        // reasoning available before `reasoning.completed` arrives — and on a
        // real Eve stream that event comes AFTER the tool result.
        this.stepReasoning =
          stringField(data, "reasoningSoFar") ??
          (this.stepReasoning ?? "") + delta;
        this.push("reasoning", delta);
        break;
      }

      case "message.appended":
        this.push("text", stringField(data, "messageDelta") ?? "");
        break;

      case "reasoning.completed": {
        const text = stringField(data, "reasoning");
        if (text) this.stepReasoning = text;
        // Already published with this step's turn: saying it twice would put the
        // same thinking in two turns.
        if (text && !this.reasoningPublished)
          this.pending.unshift({ type: "reasoning", text });
        break;
      }

      case "message.completed": {
        const text = stringField(data, "message");
        if (text) this.pending.push({ type: "text", text });
        break;
      }

      case "actions.requested": {
        const actions = Array.isArray(data.actions)
          ? (data.actions as EveActionRequest[])
          : [];
        for (const action of actions) {
          const name =
            action.toolName ?? action.name ?? action.kind ?? "action";
          const id = action.callId ?? name;
          this.calls.set(id, name);
          this.pending.push({
            type: "tool_call",
            id,
            name,
            arguments:
              action.input && typeof action.input === "object"
                ? (action.input as Record<string, unknown>)
                : null,
          });
          this.push("tool", `${name}(…)`, id);
        }
        break;
      }

      case "action.result": {
        const result = (data.result ?? {}) as EveActionResult;
        const id = result.callId ?? "";
        const name = result.toolName ?? this.calls.get(id) ?? "action";
        // A result closes the assistant's step, so whatever it said goes first —
        // otherwise the transcript reads as the answer arriving after its tools.
        await this.flush("assistant");
        await this.append(
          "tool",
          [
            {
              type: "tool_result",
              id,
              name,
              ok: result.isError !== true,
              output: outputText(result.output),
            },
          ],
          { alt: `${name}: ${result.isError === true ? "failed" : "ok"}` },
        );
        break;
      }

      case "step.completed": {
        const usage = usageFor(data.usage);
        const cost =
          data.usage && typeof data.usage === "object"
            ? (data.usage as { costUsd?: number }).costUsd
            : undefined;
        /**
         * A step's cost goes on the step, and the session's is the SUM.
         *
         * It used to be assigned, so a ten-step session reported the cost of its
         * last step — the smallest number in the run, presented as the total. And
         * the turn carried nothing, so a reader auditing the spend could see what
         * a session cost and never which step spent it.
         *
         * Kept as a fixed-point string because that is what goes on the wire, and
         * parsing it back to add is exact at six decimal places for any bill a
         * session can run up.
         */
        if (cost !== undefined) {
          this.record.cost = (Number(this.record.cost ?? "0") + cost).toFixed(
            6,
          );
        }
        await this.flush("assistant", {
          stop: stopFor(stringField(data, "finishReason")),
          usage,
          cost:
            cost === undefined
              ? undefined
              : { amount: cost.toFixed(6), currency: "USD" },
        });
        break;
      }

      case "input.requested":
        // The run is blocked on a human, which is a state the head can hold and
        // a turn cannot: there is no message to attach it to yet.
        await this.status("awaiting-input");
        break;

      case "input.resolved":
        await this.status("active");
        break;

      case "authorization.required":
        await this.status("payment-required");
        break;

      case "turn.completed":
      case "session.waiting":
        await this.flush("assistant");
        await this.status("idle");
        break;

      case "turn.cancelled":
        await this.flush("assistant");
        await this.status("aborted");
        break;

      case "turn.failed":
      case "step.failed":
        // A failed step does not end a session — the next message continues it —
        // so the failure is on the turn and the head goes back to idle.
        await this.flush("assistant", { stop: "error" });
        await this.status("idle");
        break;

      case "session.failed":
        await this.status("error");
        break;

      case "session.completed":
        await this.status("done");
        break;

      default:
        break;
    }
  }

  /**
   * Stop following.
   *
   * With no status the head keeps whatever Eve last reported, which is what a
   * dropped connection means: the follower left, the session did not end.
   */
  async close(status?: SessionStatus): Promise<void> {
    await this.flush("assistant");
    // Let whatever is still queued go out before the head says the session is
    // over — a delta arriving after `done` describes work already reported.
    await this.deltaTail;
    if (this.deltaDropped > 0)
      this.log(
        `[hex] ${this.deltaDropped} delta(s) dropped keeping up with the stream; every one is repeated in its turn`,
      );
    await this.status(status ?? (this.record.status as SessionStatus));
  }

  private push(
    kind: "text" | "reasoning" | "tool",
    text: string,
    toolId?: string,
  ): void {
    if (this.options.deltas === false || !text) return;
    this.coalescer.push(kind, text, Date.now(), toolId);
  }

  /** Publish what the assistant has assembled, if anything. */
  private async flush(
    role: TurnRole,
    extra: {
      stop?:
        "end_turn" | "max_tokens" | "tool_use" | "content_filter" | "error";
      usage?: Usage;
      cost?: Cost;
      subagents?: SubagentRef[];
    } = {},
  ): Promise<void> {
    /**
     * The reasoning goes out with the step it belongs to, even if Eve has not
     * finished announcing it.
     *
     * On a real stream a step that calls a tool emits `actions.requested`, then
     * `action.result`, and only THEN `reasoning.completed` — and this turn is
     * flushed on the result, so waiting for the completed event published the
     * thinking one turn late, attached to the step after the one that did it. A
     * transcript that misattributes reasoning is worse than one that omits it.
     */
    if (role === "assistant" && !this.reasoningPublished) {
      const already = this.pending.some((part) => part.type === "reasoning");
      if (!already && this.stepReasoning)
        this.pending.unshift({ type: "reasoning", text: this.stepReasoning });
      // Published either way: a step's thinking belongs to one turn, and the
      // path where `reasoning.completed` arrived in time must mark it too.
      if (already || this.stepReasoning) this.reasoningPublished = true;
    }

    if (this.pending.length === 0) return;
    const parts = this.pending.splice(0, this.pending.length);
    const said = parts
      .filter((part) => part.type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join(" ");
    // Only the children this turn's own calls started: a pointer on a turn that
    // did not spawn it is a reader following a link to the wrong place.
    const called = new Set(
      parts
        .filter((part) => isKnownPart(part) && part.type === "tool_call")
        .map((part) => (part as { id: string }).id),
    );
    const children = [...this.subagents.values()].filter((child) =>
      called.has(child.callId),
    );
    for (const child of children) this.subagents.delete(child.callId);

    await this.append(role, parts, {
      ...extra,
      subagents: children.length > 0 ? children : undefined,
      alt: said.slice(0, 280) || undefined,
    });
  }

  private async append(
    role: TurnRole,
    parts: TurnPart[],
    extra: {
      stop?:
        "end_turn" | "max_tokens" | "tool_use" | "content_filter" | "error";
      usage?: Usage;
      cost?: Cost;
      subagents?: SubagentRef[];
      alt?: string;
    } = {},
  ): Promise<void> {
    this.coalescer.boundary();

    const { parts: fitted } = await fitTurn(parts, {
      digest: async (text) => sha256(text),
    });

    const next = this.record.seq + 1;
    const rumor = buildTurn(
      this.options.agentPubkey,
      { agent: this.options.agentPubkey, session: this.record.nostrId },
      {
        role,
        parts: fitted,
        turn: this.record.turn || 1,
        stop: extra.stop,
        model: role === "assistant" ? this.model : undefined,
        usage: extra.usage,
        cost: extra.cost,
        subagents: extra.subagents,
        alt: extra.alt,
      },
      { seq: next, prev: this.record.prev },
      { pubkey: this.options.recipients[0] ?? this.options.agentPubkey },
    );

    /**
     * The cursor commits only once the turn has reached somebody.
     *
     * Advancing first was wrong in the way that cannot be repaired: a relay down
     * for thirty seconds burned two numbers, the next turn's `prev` named an event
     * on no relay, and every conforming reader is required to read that as a
     * broken or forged chain — the same permanent hole `encode.ts` cites as the
     * reason a head and a delta take no `seq` at all.
     *
     * Nothing landed means the event exists nowhere, so the number is still free
     * and reusing it forges nothing. And because the stream cursor is not
     * persisted either, a restart re-reads the Eve event that produced this turn
     * and publishes it again — which is the retry, without a queue to keep
     * honest.
     */
    const landed = await this.send(rumor, `turn ${next}`);
    if (!landed) {
      this.log(
        `[hex] transcript turn ${next} reached nobody, so seq ${next} stays free — a restart republishes it`,
      );
      return;
    }

    this.record.seq = next;
    this.record.prev = rumor.id;
    if (extra.usage) {
      this.record.inTokens += extra.usage.input;
      this.record.outTokens += extra.usage.output;
      this.record.cacheRead += extra.usage.cacheRead;
      this.record.cacheWrite += extra.usage.cacheWrite;
    }
    this.options.store.saveTranscript(this.record);
  }

  private async status(status: SessionStatus): Promise<void> {
    const terminal =
      status === "done" || status === "error" || status === "aborted";
    this.record.status = status;
    this.record.endedAt = terminal ? Math.floor(Date.now() / 1000) : undefined;
    await this.head();
  }

  /**
   * The last head actually published, as its tags.
   *
   * A head is addressable, so republishing an identical one changes nothing a
   * reader can see and costs a seal, a wrap and a relay round trip per recipient.
   * Eve announces the same state from more than one direction — `session.started`
   * then `turn.started`, `session.completed` then a close on the way out — so
   * without this every session ships its head twice.
   */
  private lastHead?: string;

  private async head(title?: string): Promise<void> {
    this.options.store.saveTranscript(this.record);
    const usage: Usage = {
      input: this.record.inTokens,
      output: this.record.outTokens,
      cacheRead: this.record.cacheRead,
      cacheWrite: this.record.cacheWrite,
    };
    const rumor = buildSessionHead(
      this.options.agentPubkey,
      this.record.nostrId,
      {
        title: title ?? this.sessionId,
        status: this.record.status as SessionStatus,
        operator: {
          pubkey: this.options.recipients[0] ?? this.options.agentPubkey,
        },
        observers: this.options.recipients
          .slice(1)
          .map((pubkey) => ({ pubkey })),
        trigger: this.record.trigger ? { id: this.record.trigger } : undefined,
        lastSeq: this.record.seq,
        started: this.record.startedAt,
        ended: this.record.endedAt,
        model: this.model,
        usage,
        cost: this.record.cost
          ? { amount: this.record.cost, currency: "USD" }
          : undefined,
        definition: `31779:${this.options.agentPubkey}:${this.options.slug}`,
        alt: `Agent session: ${title ?? this.sessionId} (${this.record.status}, ${this.record.seq} turns)`,
      },
    );

    // Recorded AFTER the send, not before: a terminal head whose delivery failed
    // must not be suppressed on the one retry the shutdown path structurally has
    // — `session.completed` then `close()` within the same second fingerprint
    // identically, and a head that says `active` forever is a lie no reader can
    // detect.
    const fingerprint = JSON.stringify(rumor.tags);
    if (fingerprint === this.lastHead) return;
    if (await this.send(rumor, "head")) this.lastHead = fingerprint;
  }

  private async sendDelta(delta: {
    turn: number;
    part: number;
    delta: string;
    text: string;
    toolId?: string;
  }): Promise<void> {
    let rumor: Rumor;
    try {
      rumor = buildDelta(
        this.options.agentPubkey,
        { agent: this.options.agentPubkey, session: this.record.nostrId },
        {
          turn: delta.turn,
          part: delta.part,
          delta: delta.delta as "text" | "reasoning" | "tool" | "heartbeat",
          text: delta.text,
          toolId: delta.toolId,
        },
        { pubkey: this.options.recipients[0] ?? this.options.agentPubkey },
      );
    } catch (error) {
      // A delta that cannot be built is a bug in this mapping, and it must
      // surface as a line rather than as an unhandled rejection nobody reads.
      this.log(
        `[hex] transcript delta ${delta.turn}.${delta.part} not built: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    await this.send(rumor, `delta ${delta.turn}.${delta.part}`, true);
  }

  /** Send one rumor. Returns whether it reached at least one recipient. */
  private async send(
    rumor: Rumor,
    what: string,
    ephemeral = false,
  ): Promise<boolean> {
    if (this.options.recipients.length === 0) return false;
    try {
      const { delivered, undeliverable } = await this.options.sink.publishRumor(
        rumor,
        this.options.recipients,
        {
          ephemeral,
        },
      );
      if (undeliverable.length > 0)
        this.log(
          `[hex] transcript ${what} did not reach ${undeliverable.length} recipient(s)`,
        );
      if (delivered.length === 0) return false;
      // Read this far, and everything up to here is on a relay.
      this.record.streamIndex = this.atIndex;
      return true;
    } catch (error) {
      this.log(
        `[hex] transcript ${what} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
