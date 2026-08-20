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
  definitionAddress,
  buildDelta,
  buildSessionHead,
  buildTurn,
} from "../nostr/encode.js";
import type {
  AgentToolSpec,
  RepositorySpec,
  Cost,
  Rumor,
  SessionStatus,
  SubagentRef,
  TurnPart,
  TurnRole,
  Usage,
} from "../nostr/types.js";
import { isKnownPart, TERMINAL_STATUSES } from "../nostr/types.js";
import type { Prices } from "./pricing.js";
import type { HexStore, StoredTranscript } from "../store.js";
import {
  outputText,
  payload,
  stopFor,
  asRecord,
  numberField,
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
  /**
   * A price list, for a provider that reports no cost.
   *
   * Optional, and its absence is the old behaviour: usage published with a blank
   * where the money goes. What it produces is marked `estimated` on the wire.
   */
  prices?: Prices;
  /**
   * Where deltas land besides the reader's own inbox, named on the head.
   *
   * A reader cannot guess this and must not have to: kind 21059 is exactly what
   * a DM inbox relay is entitled to refuse, and the ones in a real 10050 do.
   */
  deltaRelays?: string[];
  /** Overrides what the stream says. For a runtime that does not name one. */
  model?: { id: string; provider?: string };
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** How many coalesced deltas may wait behind the one being published. */
const MAX_QUEUED_DELTAS = 4;

/**
 * How many events may pass before the cursor is written down.
 *
 * A crash loses at most this many events' worth of position, and re-reading them
 * costs nothing: the ones that publish are deduped by their durable id, and the
 * ones that do not were never anywhere but memory.
 */
const SAVE_EVERY = 25;

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
  /** Set when a publish reached nobody, which stops the durable cursor. */
  private frozen = false;
  /** The cursor value last written to disk, so a batch knows when it is due. */
  private savedIndex = 0;

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

  /**
   * Requests the run is blocked on.
   *
   * Seeded from the stored record, because a blocked session outlives the
   * process watching it: held only in memory, a restart caught the session up,
   * read the turn epilogue, and republished a run waiting on a person as done.
   */
  private readonly openRequests: Set<string>;

  /** Tool calls seen this step, so a result can name the tool it answers. */
  private readonly calls = new Map<string, string>();

  /**
   * Where this run is happening. Set by whoever started it, once.
   *
   * `hex eve` following a session by id has no room at all, and says so by
   * leaving this unset rather than by guessing at one.
   */
  channel?: { transport: string; id?: string };

  /**
   * What this run is about, from the message that opened it.
   *
   * Set once by whoever started the run; the head repeats it on every publish
   * so a reader can find every session about a thing without reading titles.
   */
  subjects?: string[][];

  /** How full the window was when compaction was asked for, until it completes. */
  private compactingAt?: number;

  /** Children already mentioned in the log, so each is mentioned once. */
  private readonly watchedChildren = new Set<string>();

  /** Event types already reported as unmapped, so each is reported once. */
  private readonly unknownTypes = new Set<string>();

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
    this.savedIndex = this.record.streamIndex;
    this.openRequests = new Set(this.record.pending ?? []);
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

  /** What the head currently says, for a caller reporting on a catch-up. */
  get headStatus(): string {
    return this.record.status;
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /**
   * Publish what this run was set up with: the prompt, and the tools on offer.
   *
   * Addressed by SESSION rather than by agent slug, and that is the whole point.
   * A standing definition says what the agent is in general and goes stale the
   * moment its config changes; this says what applied to this run, so a
   * transcript read next month still shows the prompt that produced it.
   *
   * On its own event rather than on the head, because the head is republished on
   * every status change and every turn — dozens of times in a long session,
   * sealed and wrapped once per recipient each time. A prompt plus tool schemas
   * is kilobytes. The head points at this instead, through the `agent` tag it
   * already carried.
   *
   * Published once and forgotten: a snapshot that kept up with its subject would
   * not be one.
   */
  async snapshot(info: {
    name: string;
    about?: string;
    picture?: string;
    instructions?: string;
    tools?: AgentToolSpec[];
    repositories?: RepositorySpec[];
  }): Promise<void> {
    if (this.snapshotted) return;
    this.snapshotted = true;
    await this.send(
      buildAgentDefinition(this.options.agentPubkey, {
        slug: this.record.nostrId,
        ...info,
        alt: `${info.name} — how this session was set up`,
      }),
      "session definition",
    );
  }

  private snapshotted = false;

  /**
   * A snapshot is coming, so point at it now.
   *
   * `describe()` is deliberately fire-and-forget — a run must not refuse to
   * start because it could not describe itself — which means the FIRST head
   * goes out before the snapshot exists. With the address chosen from
   * `snapshotted` alone, that head pointed at the agent's standing definition
   * instead, an event this agent has never published: readers followed it,
   * found nothing, and showed no prompt and no tools for the session.
   *
   * A pointer at the snapshot that is a second early is a pointer that resolves
   * a second later. A pointer at something that will never exist never does.
   */
  expectSnapshot(): void {
    this.snapshotting = true;
  }

  private snapshotting = false;

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
        /**
         * `childSessionId` is what Eve calls it.
         *
         * This read `sessionId`, which is never there, so every subagent tag
         * named a call and pointed at nothing — the one piece of information
         * that makes a child transcript findable. Both spellings are read
         * because being wrong about this is silent: a tag with an empty session
         * looks exactly like a subagent that had not started yet.
         */
        const childSession =
          stringField(data, "childSessionId") ?? stringField(data, "sessionId");
        const name = stringField(data, "subagentName");
        if (callId && (childSession || name))
          this.subagents.set(callId, {
            callId,
            session: childSession ?? this.subagents.get(callId)?.session ?? "",
            name: name ?? this.subagents.get(callId)?.name,
          });
        break;
      }

      /**
       * What the person said, published once however many times it is announced.
       *
       * The `meta.id` dedupe cannot catch this one: a retried or resumed step is
       * re-emitted under a NEW id carrying the same `turnId`, and the runtime
       * says outright that no field records which attempt finished. So a steered
       * turn republished the person's message as a second user turn one `seq`
       * later — the same words twice in a transcript, from a reader's point of
       * view for no reason at all.
       *
       * Keyed on the turn, and remembered durably, because the second copy
       * frequently arrives in a different process from the first.
       */
      case "message.received": {
        const turnId =
          stringField(data, "turnId") ?? `turn-${this.record.turn}`;
        if (this.record.saidTurn === turnId) break;
        this.record.saidTurn = turnId;
        const text = stringField(data, "message") ?? "";
        /**
         * The first thing asked is what this run is called.
         *
         * Until now the head's title was the runtime's own session id, which
         * says nothing a person can use — a client listing twenty sessions
         * showed twenty `wrun_…` strings and no way to tell which was which.
         * Only the FIRST message titles the run: a later one steers the same
         * conversation, and renaming a session mid-flight moves it under
         * whoever is reading the list.
         */
        if (!this.record.title && text.trim())
          this.record.title = summarise(text);
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
        const reported =
          data.usage && typeof data.usage === "object"
            ? (data.usage as { costUsd?: number }).costUsd
            : undefined;
        /**
         * A billed figure when there is one, arithmetic when there is not.
         *
         * PPQ and plenty of others report token counts and no cost at all, which
         * left every transcript published through them carrying usage and a blank
         * where the money goes — the one number a reader auditing spend actually
         * wants. The estimate is marked as one on the wire.
         */
        const estimate =
          reported === undefined && usage
            ? this.options.prices?.estimate(this.model?.id, usage)
            : undefined;
        const cost = reported;
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
        /**
         * The session's totals belong to the STEP, not to the turn that carries
         * them.
         *
         * `flush` returns early when a step produced nothing publishable — its
         * words already went out with an earlier turn — and the usage handed to
         * it went in the bin, while the cost a few lines above had already been
         * added. So a session could report two hundred milli-dollars against
         * zero tokens, which is not a rounding error but two numbers describing
         * different things.
         */
        if (usage) {
          this.record.inTokens += usage.input;
          this.record.outTokens += usage.output;
          this.record.cacheRead += usage.cacheRead;
          this.record.cacheWrite += usage.cacheWrite;
        }

        const spent = cost ?? (estimate ? Number(estimate.amount) : undefined);
        if (spent !== undefined) {
          this.record.cost = (Number(this.record.cost ?? "0") + spent).toFixed(
            6,
          );
          // Once any step was estimated the total is, and the head must not
          // present a mixed sum as a bill.
          if (cost === undefined) this.record.costEstimated = true;
        }
        await this.flush("assistant", {
          stop: stopFor(stringField(data, "finishReason")),
          usage,
          cost:
            cost !== undefined
              ? { amount: cost.toFixed(6), currency: "USD" }
              : estimate
                ? { ...estimate, estimated: true }
                : undefined,
        });
        break;
      }

      /**
       * The run is blocked on a person, and says what it is blocked on.
       *
       * Both halves matter. The QUESTION goes in a turn, because being asked is
       * something that happened and history is what turns are for. Which
       * questions are still OPEN goes on the head, because that is current state
       * — and because the epilogue that follows a parked turn is byte-identical
       * to the one that follows a finished turn, so nothing else can tell a
       * reader that this session is waiting rather than done.
       */
      case "input.requested": {
        const requests = Array.isArray(data.requests) ? data.requests : [];
        const parts: TurnPart[] = [];
        for (const raw of requests) {
          const request = asRecord(raw);
          const requestId = request && stringField(request, "requestId");
          if (!request || !requestId) continue;
          this.openRequests.add(requestId);
          const action = asRecord(request.action);
          parts.push({
            type: "input_request",
            requestId,
            prompt: stringField(request, "prompt") ?? "",
            requestKind: stringField(request, "kind"),
            display: stringField(request, "display"),
            allowFreeform: request.allowFreeform === true,
            options: optionsOf(request.options),
            tool: action
              ? {
                  name: stringField(action, "toolName") ?? "",
                  callId: stringField(action, "callId"),
                }
              : undefined,
          });
        }
        if (parts.length > 0)
          await this.append("assistant", parts, {
            alt: `Waiting on you: ${
              parts[0] && "prompt" in parts[0]
                ? String(parts[0].prompt)
                : "a question"
            }`,
          });
        await this.status("awaiting-input");
        break;
      }

      case "input.resolved": {
        const resolutions = Array.isArray(data.resolutions)
          ? data.resolutions
          : [];
        const parts: TurnPart[] = [];
        for (const raw of resolutions) {
          const resolution = asRecord(raw);
          const requestId = resolution && stringField(resolution, "requestId");
          if (!resolution || !requestId) continue;
          /**
           * Whichever twin arrives first wins.
           *
           * Eve emits `approval.settled` and `input.resolved` for one approval
           * and nothing fixes their order, so publishing both unconditionally
           * put the same answer in the chain twice. Gated on the request still
           * being open, ordering stops mattering: the second one finds nothing
           * to close and says nothing.
           */
          if (!this.openRequests.has(requestId)) continue;
          this.openRequests.delete(requestId);
          const response = asRecord(resolution.response);
          parts.push({
            type: "input_resolved",
            requestId,
            outcome: stringField(resolution, "outcome") ?? "answered",
            response: response
              ? {
                  optionId: stringField(response, "optionId"),
                  text: stringField(response, "text"),
                }
              : undefined,
          });
        }
        if (parts.length > 0)
          await this.append("user", parts, { alt: "Answered." });
        await this.status("active");
        break;
      }

      /**
       * A structured result, which is the turn's actual answer when a schema
       * asked for one. Carried as text because the transcript's parts are prose
       * and JSON, and a reader that wants the object parses it back.
       */
      case "result.completed": {
        const result = data.result;
        if (result !== undefined)
          this.pending.push({
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result),
          });
        break;
      }

      /**
       * A subagent finished. Correlated by `callId`, because the event carries
       * no child session id — and recorded rather than dropped so a reader can
       * see that a delegated piece of work came back at all.
       */
      case "subagent.completed": {
        const callId = stringField(data, "callId");
        const output = stringField(data, "output");
        if (callId && output)
          this.pending.push({
            type: "tool_result",
            id: callId,
            name: stringField(data, "subagentName") ?? "agent",
            ok: true,
            output,
          });
        break;
      }

      /**
       * The context was summarised out from under the run.
       *
       * Its own turn rather than a line folded into the next assistant message,
       * because it is not something the agent said — it is something that
       * happened TO the conversation, and a reader scrolling a long transcript
       * needs to see where the agent stopped being able to remember what came
       * before. Folded in, it read as the model narrating its own amnesia.
       */
      /**
       * Compaction is about to happen, and this is the only event that says how
       * full the window was when it did. Held rather than published: the pair
       * describes one occurrence, and two turns for it would read as the
       * context having been summarised twice.
       */
      case "compaction.requested":
        this.compactingAt = numberField(data, "usageInputTokens") ?? undefined;
        break;

      case "compaction.completed": {
        const at = this.compactingAt;
        this.compactingAt = undefined;
        await this.append(
          "tool",
          [
            {
              type: "text",
              text: at
                ? `The conversation so far was summarised to fit the context window, at ${at} input tokens.`
                : "The conversation so far was summarised to fit the context window.",
            },
          ],
          { alt: "Context compacted." },
        );
        break;
      }

      /**
       * The context was thrown away rather than summarised.
       *
       * Its own turn for the same reason compaction gets one, and a distinct
       * sentence because the difference matters to anyone reading upwards: a
       * compacted conversation still knows what it decided, a cleared one does
       * not.
       */
      case "context.cleared":
        await this.append(
          "tool",
          [
            {
              type: "text",
              text: "The conversation so far was cleared. Nothing above this point is still in the agent's context.",
            },
          ],
          { alt: "Context cleared." },
        );
        break;

      /**
       * An approval reached its verdict.
       *
       * Eve emits this alongside `input.resolved` for the approval flavour of a
       * request, so the two describe one decision and publishing both would put
       * the same answer in the transcript twice. `input.resolved` is the richer
       * of the pair — it carries the option that was picked and any free text —
       * so this one only closes the request when it arrives without its twin,
       * which is what happens when an approval settles through a channel that
       * never opened an input request here.
       */
      case "approval.settled": {
        const requestId = stringField(data, "requestId");
        if (!requestId || !this.openRequests.has(requestId)) break;
        this.openRequests.delete(requestId);
        await this.append(
          "user",
          [
            {
              type: "input_resolved",
              requestId,
              /**
               * The outcome, and no `response`. Eve's word here is `approved`
               * or `cancelled`, while the option the person clicked was
               * `approve` or `cancel` — close enough to look right in a log and
               * wrong enough that a reader correlating it against the published
               * options matches neither.
               */
              outcome:
                stringField(data, "outcome") === "approved"
                  ? "answered"
                  : "cancelled",
            },
          ],
          { alt: "Answered." },
        );
        await this.status("active");
        break;
      }

      /**
       * One approver's vote, before the votes are counted.
       *
       * Deliberately dropped. It exists for policies that need several
       * principals to agree, and until one is configured every candidate is
       * immediately followed by the `approval.settled` that repeats it. A
       * transcript that published both would show a decision being made twice.
       */
      case "approval.candidate":
        break;

      /**
       * A tool's output so far, mid-execution.
       *
       * Deliberately dropped. `action.result` carries the whole output a moment
       * later and is what the turn publishes; a partial is the same bytes
       * again, and appending both would double every long tool result in the
       * record. The live view of a running tool is the delta stream's job, not
       * the chain's.
       */
      case "action.partial":
        break;

      /**
       * The child's entire stream, wrapped one event at a time.
       *
       * An inline subagent does not run somewhere else — every event it emits
       * arrives here under `data.event`, tagged with the `callId` that spawned
       * it. So following children needs no second connection to anything; it
       * needs a second transcript, its own chain and head, and a parent tag
       * pointing at the child's WIRE id rather than Eve's. That is the
       * follow-children feature, and it is not this.
       *
       * Until then the delegated work is still in the record: `subagent.called`
       * names the child on the turn that spawned it and `subagent.completed`
       * lands what it came back with. What is missing is watching it work.
       *
       * Logged once per child, not once per event: this fires for every token
       * the child reasons.
       */
      case "subagent.event": {
        const callId = stringField(data, "callId");
        if (callId && !this.watchedChildren.has(callId)) {
          this.watchedChildren.add(callId);
          this.options.log?.(
            `[hex] ${stringField(data, "subagentName") ?? "a subagent"} is streaming into this session; its own transcript is not published`,
          );
        }
        break;
      }

      case "authorization.required":
        await this.status("payment-required");
        break;

      /**
       * The sign-in resolved, whichever way it went.
       *
       * Without this the head stayed `payment-required` for the life of the
       * session — a reader told to go and authorise something that was
       * authorised ten minutes ago, and no event would ever have corrected it.
       * The turn is still running either way; a declined one fails next and
       * that failure is what settles the head.
       */
      case "authorization.completed":
        await this.status("active");
        break;

      case "turn.completed":
      case "session.waiting":
        await this.flush("assistant");
        await this.status("idle");
        break;

      /**
       * A stopped turn is not a stopped session.
       *
       * This set `aborted`, which is TERMINAL — and the `session.waiting` that
       * always follows then set `idle` over the top, so the terminal flag was
       * written and unwritten within a millisecond. Had the order ever differed,
       * stopping one turn would have marked a perfectly usable session as ended
       * for good.
       *
       * The runtime is explicit that cancelling is not a failure and the session
       * accepts the next message normally, so the turn is closed and the status
       * is left to the boundary event that follows. `aborted` is for a run
       * nobody is coming back to.
       */
      case "turn.cancelled":
        await this.flush("assistant", { stop: "error" });
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

      /**
       * An event this version of hex has never heard of.
       *
       * Said once per type, because a new Eve emits thousands of a new event
       * per turn and a line each would bury the stream. Said at all because the
       * alternative is a runtime upgrade quietly dropping something the
       * transcript should have carried, which is exactly how `subagent.started`
       * went unmapped — absent from Eve's own docs table, present in its types.
       */
      default: {
        const unknown = event.type;
        if (typeof unknown === "string" && !this.unknownTypes.has(unknown)) {
          this.unknownTypes.add(unknown);
          this.options.log?.(
            `[hex] eve sent \`${unknown}\`, which this version does not map`,
          );
        }
        break;
      }
    }

    /**
     * The cursor keeps up with the stream, except when something is unpublished.
     *
     * It used to advance ONLY on a successful publish, which was right about
     * failures and catastrophic about volume: most events publish nothing — a
     * reasoning fragment, a step announcing its model, every delta — so on a
     * real turn the cursor fell nine hundred events behind the stream. A restart
     * then re-read all of them and republished the turns they had already
     * produced, and a follow-up spent minutes grinding through history before it
     * could hear the answer.
     *
     * So: forward on every event, frozen the moment a publish reaches nobody, and
     * thawed by the next one that lands. Persisted in batches, because a row
     * written nine hundred times is nine hundred writes for one fact.
     */
    if (!this.frozen && this.atIndex > this.record.streamIndex) {
      this.record.streamIndex = this.atIndex;
      if (this.atIndex - this.savedIndex >= SAVE_EVERY) {
        this.savedIndex = this.atIndex;
        this.options.store.saveTranscript(this.record);
      }
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
    // Whatever the batch had not written yet.
    this.options.store.saveTranscript(this.record);
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
    // Session totals are accumulated at the step that reported them; a turn
    // carries its own `usage` tag and adds nothing here, or every step that
    // published something would be counted twice.
    this.options.store.saveTranscript(this.record);
  }

  private async status(status: SessionStatus): Promise<void> {
    /**
     * An open question outranks the epilogue that follows it.
     *
     * Eve parks a request with `input.requested`, then emits `turn.completed`
     * and `session.waiting` — the same pair a finished turn emits, with the same
     * payload. Taking the last event at its word wrote `idle` over
     * `awaiting-input` milliseconds after it was set, and published a session
     * waiting on its operator as done. Only the open-request set knows better,
     * so it decides, and a terminal status still wins: a run that ended cannot
     * be waiting for anybody.
     */
    const asked =
      this.openRequests.size > 0 && !isTerminal(status)
        ? "awaiting-input"
        : status;
    const terminal = isTerminal(asked);
    this.record.status = asked;
    this.record.endedAt = terminal ? Math.floor(Date.now() / 1000) : undefined;
    this.record.pending = this.openRequests.size
      ? [...this.openRequests]
      : undefined;
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
        title: title ?? this.record.title ?? this.sessionId,
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
        pending: this.record.pending,
        usage,
        cost: this.record.cost
          ? {
              amount: this.record.cost,
              currency: "USD",
              estimated: this.record.costEstimated || undefined,
            }
          : undefined,
        deltaRelays:
          this.options.deltas === false ? undefined : this.options.deltaRelays,
        channel: this.channel,
        subjects: this.subjects,
        /**
         * Whichever definition describes this run.
         *
         * The per-session snapshot when one was published, the standing
         * definition otherwise — a reader follows one pointer either way, and
         * the address itself says which it got.
         */
        definition: definitionAddress(
          this.options.agentPubkey,
          this.snapshotted || this.snapshotting
            ? this.record.nostrId
            : this.options.slug,
        ),
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
      if (delivered.length === 0) {
        /**
         * Freeze the cursor: something this stream produced is not on any relay.
         *
         * From here the durable cursor stops moving, so a restart re-reads the
         * events that produced the lost turn and publishes it again. It thaws on
         * the next successful publish, because by then the chain has moved on and
         * replaying further back would duplicate what did land.
         */
        this.frozen = true;
        return false;
      }
      this.frozen = false;
      // Read this far, and everything up to here is on a relay.
      this.record.streamIndex = this.atIndex;
      this.options.store.saveTranscript(this.record);
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

/** A run that ended is not waiting for anybody. */
/**
 * A message reduced to a line that can head a list.
 *
 * First line only, and short: a prompt can be a page, and a title that wraps is
 * a title that pushes everything else off the row. Cut on a word boundary where
 * there is one, because a title severed mid-word reads as corruption rather
 * than as an abbreviation.
 */
function summarise(text: string, limit = 72): string {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > limit / 2 ? cut.slice(0, space) : cut}…`;
}

function isTerminal(status: SessionStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}


/** The choices offered, keeping only what a reader can actually render. */
function optionsOf(
  value: unknown,
):
  | { id: string; label: string; description?: string; style?: string }[]
  | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .map((raw) => asRecord(raw))
    .filter((option): option is Record<string, unknown> => !!option)
    .map((option) => ({
      id: stringField(option, "id") ?? "",
      label: stringField(option, "label") ?? "",
      description: stringField(option, "description"),
      style: stringField(option, "style"),
    }))
    .filter((option) => option.id);
  return options.length ? options : undefined;
}
