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
  Rumor,
  SessionStatus,
  TurnPart,
  TurnRole,
  Usage,
} from "../nostr/types.js";
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
  /** Tool calls seen this step, so a result can name the tool it answers. */
  private readonly calls = new Map<string, string>();

  constructor(
    private readonly options: EveTranscriptOptions,
    /** Eve's session id. The wire's is derived once and kept. */
    readonly sessionId: string,
  ) {
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
    const data = payload(event);
    if (index !== undefined) this.record.streamIndex = index;

    switch (event.type) {
      case "session.started":
        await this.status("active");
        break;

      case "turn.started":
        this.record.turn += 1;
        this.coalescer.startTurn(this.record.turn);
        await this.status("active");
        break;

      case "message.received": {
        const text = stringField(data, "message") ?? "";
        if (!this.record.trigger)
          this.record.trigger = stringField(data, "turnId");
        await this.append("user", [{ type: "text", text }], {
          alt: text.slice(0, 200),
        });
        break;
      }

      case "reasoning.appended":
        this.push("reasoning", stringField(data, "reasoningDelta") ?? "");
        break;

      case "message.appended":
        this.push("text", stringField(data, "messageDelta") ?? "");
        break;

      case "reasoning.completed": {
        const text = stringField(data, "reasoning");
        if (text) this.pending.push({ type: "reasoning", text });
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
        if (cost !== undefined) this.record.cost = cost.toFixed(6);
        await this.flush("assistant", {
          stop: stopFor(stringField(data, "finishReason")),
          usage,
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
        this.options.store.saveTranscript(this.record);
        break;
    }
  }

  /** Close a session this process is done with, whatever Eve last said. */
  async close(status: SessionStatus = "done"): Promise<void> {
    await this.flush("assistant");
    // Let whatever is still queued go out before the head says the session is
    // over — a delta arriving after `done` describes work already reported.
    await this.deltaTail;
    if (this.deltaDropped > 0)
      this.log(
        `[hex] ${this.deltaDropped} delta(s) dropped keeping up with the stream; every one is repeated in its turn`,
      );
    await this.status(status);
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
    } = {},
  ): Promise<void> {
    if (this.pending.length === 0) return;
    const parts = this.pending.splice(0, this.pending.length);
    const said = parts
      .filter((part) => part.type === "text")
      .map((part) => String((part as { text?: unknown }).text ?? ""))
      .join(" ");
    await this.append(role, parts, {
      ...extra,
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
        model: role === "assistant" ? this.options.model : undefined,
        usage: extra.usage,
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
        model: this.options.model,
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
      return delivered.length > 0;
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
