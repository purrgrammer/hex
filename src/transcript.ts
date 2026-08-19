/**
 * Publishing what Hex did, as events (NIP-xx: Agent Sessions).
 *
 * A turn's structure — what the model thought, which tool it called with which
 * arguments, what came back — exists only while the turn runs. `store.ts` keeps
 * one row of plain text per delivered reply, so nothing here can be
 * reconstructed afterwards: the publisher is tapped where the structure is still
 * alive, and it publishes as the turn happens.
 *
 * The cursor is durable. A restart that resumed at `seq` 1 would publish a second
 * chain under the same session id, and a conforming reader is required to read
 * that as a FORK rather than a continuation — so `seq` and the id it chains from
 * live in SQLite, written after every publish.
 *
 * Nothing here throws into the agent loop. A transcript is a record of work, not
 * the work: a relay that will not take it must not stop Hex answering.
 */

import { createHash, randomBytes } from "node:crypto";

import { DeltaCoalescer } from "./nostr/coalesce.js";
import {
  buildAgentDefinition,
  buildDelta,
  buildSessionHead,
  buildTurn,
} from "./nostr/encode.js";
import { fitTurn } from "./nostr/blob.js";
import type {
  AgentToolSpec,
  Rumor,
  SessionStatus,
  TurnBlock,
  TurnRole,
  Usage,
} from "./nostr/types.js";
import type { TurnObserver } from "./brain/types.js";
import type { HexStore, StoredTranscript } from "./store.js";
import { RESPOND_TOOL } from "./tools/types.js";
import type { Room } from "./transports/types.js";
import { roomKey } from "./transports/types.js";

/** What the publisher needs of a transport: one door for a rumor. */
export interface RumorSink {
  publishRumor(
    rumor: Rumor,
    recipients: string[],
    options?: { ephemeral?: boolean; selfCopy?: boolean },
  ): Promise<{ delivered: string[]; undeliverable: string[] }>;
}

export interface TranscriptOptions {
  agentPubkey: string;
  /** The `d` tag of the agent's definition. */
  slug: string;
  /** Who receives the transcript. The operator, usually exactly one. */
  recipients: string[];
  store: HexStore;
  sink: RumorSink;
  /** Off means milestones only in the sense that nothing streams. */
  deltas?: boolean;
  model?: { id: string; provider?: string };
  log?: (line: string) => void;
  /** Injected so a test can drive the coalescer's clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What the model put in `chat.respond` — the only thing it says out loud. */
function respondText(args: unknown): string {
  if (args && typeof args === "object" && "text" in args) {
    const text = (args as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * One live session's publishing state.
 *
 * `nostrId` is the 32 random bytes the wire calls a session; Hex's own session id
 * is room-scoped and human-shaped, and is never handed to a relay.
 */
interface Live {
  record: StoredTranscript;
  coalescer: DeltaCoalescer;
}

export class TranscriptPublisher {
  private readonly live = new Map<string, Live>();

  constructor(private readonly options: TranscriptOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** Publish the agent's definition. Once at startup; harmless to repeat. */
  async announce(definition: {
    name: string;
    about?: string;
    picture?: string;
    instructions?: string;
    tools?: AgentToolSpec[];
    suggestions?: string[];
  }): Promise<void> {
    const rumor = buildAgentDefinition(this.options.agentPubkey, {
      slug: this.options.slug,
      ...definition,
      alt: `${definition.name} — an agent's definition`,
    });
    await this.send(rumor, "definition");
  }

  /**
   * Begin, or resume, publishing a session.
   *
   * Resuming is the normal case after a restart: the cursor comes back from the
   * store and the chain continues where it stopped.
   */
  async open(
    hexSessionId: string,
    room: Room,
    title: string,
    trigger?: { id: string },
  ): Promise<void> {
    if (this.live.has(hexSessionId)) return;

    const held = this.options.store.transcriptFor(hexSessionId);
    const record: StoredTranscript = held ?? {
      sessionId: hexSessionId,
      room: roomKey(room),
      nostrId: randomBytes(32).toString("hex"),
      seq: 0,
      turn: 0,
      status: "active",
      startedAt: Math.floor(Date.now() / 1000),
      inTokens: 0,
      outTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    record.status = "active";
    record.endedAt = undefined;
    if (!record.trigger && trigger) record.trigger = trigger.id;

    // Persisted BEFORE the head goes out. The head claims the session is
    // running, so a crash between the two would leave that claim on a relay with
    // nothing on disk to close it — and a head that says `active` forever is a
    // lie a reader cannot detect.
    this.options.store.saveTranscript(record);

    this.live.set(hexSessionId, {
      record,
      coalescer: new DeltaCoalescer({
        emit: (delta) => {
          void this.sendDelta(hexSessionId, delta);
        },
        setTimer: this.options.setTimer,
        clearTimer: this.options.clearTimer,
      }),
    });

    await this.head(hexSessionId, title);
  }

  /** A new turn: the delta counter restarts inside it. */
  startTurn(hexSessionId: string): void {
    const live = this.live.get(hexSessionId);
    if (!live) return;
    live.record.turn += 1;
    live.coalescer.startTurn(live.record.turn);
  }

  /** A fragment of the model's output, as it arrives. */
  push(
    hexSessionId: string,
    kind: "text" | "thinking" | "tool",
    text: string,
  ): void {
    if (this.options.deltas === false) return;
    this.live.get(hexSessionId)?.coalescer.push(kind, text, Date.now());
  }

  /** Any boundary flushes what is buffered: a tool call, an answer, a failure. */
  boundary(hexSessionId: string): void {
    this.live.get(hexSessionId)?.coalescer.boundary();
  }

  /** One message of the conversation, structured. */
  async append(
    hexSessionId: string,
    role: TurnRole,
    blocks: TurnBlock[],
    extra: {
      stop?: "end_turn" | "max_tokens" | "tool_use" | "content_filter" | "error";
      usage?: Usage;
      alt?: string;
    } = {},
  ): Promise<void> {
    const live = this.live.get(hexSessionId);
    if (!live) return;
    live.coalescer.boundary();

    const { blocks: fitted } = await fitTurn(blocks, {
      digest: async (text) => sha256(text),
    });

    const next = live.record.seq + 1;
    const rumor = buildTurn(
      this.options.agentPubkey,
      { agent: this.options.agentPubkey, session: live.record.nostrId },
      {
        role,
        blocks: fitted,
        turn: live.record.turn || 1,
        stop: extra.stop,
        model: role === "assistant" ? this.options.model : undefined,
        usage: extra.usage,
        alt: extra.alt,
      },
      { seq: next, prev: live.record.prev },
      { pubkey: this.options.recipients[0] ?? this.options.agentPubkey },
    );

    // The cursor advances only once the event exists. A publish that fails still
    // advances it: the event was built and may have reached one relay of several,
    // and reusing the number would publish two events at one `seq`, which reads
    // as a forgery rather than a retry.
    live.record.seq = next;
    live.record.prev = rumor.id;
    if (extra.usage) {
      live.record.inTokens += extra.usage.input;
      live.record.outTokens += extra.usage.output;
      live.record.cacheRead += extra.usage.cacheRead;
      live.record.cacheWrite += extra.usage.cacheWrite;
    }
    this.options.store.saveTranscript(live.record);

    await this.send(rumor, `turn ${next}`);
  }

  /**
   * Move the session's status, and say when it ended if it did.
   *
   * `idle` between turns and `active` during one is what makes a watcher able to
   * tell working from finished. A failed turn does NOT end a session — the next
   * message continues it — so the failure is recorded on the turn's `stop` and
   * the head goes back to idle. `error` is for a session abandoned.
   */
  async status(
    hexSessionId: string,
    status: SessionStatus,
    title?: string,
  ): Promise<void> {
    const live = this.live.get(hexSessionId);
    if (!live) return;
    const terminal =
      status === "done" || status === "error" || status === "aborted";
    live.record.status = status;
    live.record.endedAt = terminal
      ? Math.floor(Date.now() / 1000)
      : undefined;
    this.options.store.saveTranscript(live.record);
    await this.head(hexSessionId, title);
    if (terminal) {
      live.coalescer.boundary();
      this.live.delete(hexSessionId);
    }
  }

  /**
   * Close every session this process left open.
   *
   * A head that says `active` forever is a lie a reader cannot detect, and only
   * the publisher knows the difference between still working and gone.
   */
  async closeAll(status: SessionStatus = "done"): Promise<void> {
    for (const id of [...this.live.keys()]) await this.status(id, status);

    // Sessions a previous process left open: their cursor is on disk and their
    // head still claims to be running.
    for (const held of this.options.store.openTranscripts()) {
      if (this.live.has(held.sessionId)) continue;
      held.status = status;
      held.endedAt = Math.floor(Date.now() / 1000);
      this.options.store.saveTranscript(held);
      await this.send(this.headRumor(held), `head ${held.nostrId.slice(0, 8)}`);
    }
  }

  private headRumor(record: StoredTranscript, title?: string): Rumor {
    const usage: Usage = {
      input: record.inTokens,
      output: record.outTokens,
      cacheRead: record.cacheRead,
      cacheWrite: record.cacheWrite,
    };
    return buildSessionHead(this.options.agentPubkey, record.nostrId, {
      title: title ?? record.room,
      status: record.status as SessionStatus,
      operator: {
        pubkey: this.options.recipients[0] ?? this.options.agentPubkey,
      },
      observers: this.options.recipients
        .slice(1)
        .map((pubkey) => ({ pubkey })),
      trigger: record.trigger ? { id: record.trigger } : undefined,
      lastSeq: record.seq,
      started: record.startedAt,
      ended: record.endedAt,
      model: this.options.model,
      usage,
      definition: `31779:${this.options.agentPubkey}:${this.options.slug}`,
      alt: `Agent session: ${title ?? record.room} (${record.status}, ${record.seq} turns)`,
    });
  }

  private async head(hexSessionId: string, title?: string): Promise<void> {
    const live = this.live.get(hexSessionId);
    if (!live) return;
    await this.send(this.headRumor(live.record, title), "head");
  }

  private async sendDelta(
    hexSessionId: string,
    delta: { turn: number; part: number; delta: string; text: string },
  ): Promise<void> {
    const live = this.live.get(hexSessionId);
    if (!live) return;
    const rumor = buildDelta(
      this.options.agentPubkey,
      { agent: this.options.agentPubkey, session: live.record.nostrId },
      {
        turn: delta.turn,
        part: delta.part,
        delta: delta.delta as "text" | "thinking" | "tool" | "heartbeat",
        text: delta.text,
      },
      { pubkey: this.options.recipients[0] ?? this.options.agentPubkey },
    );
    await this.send(rumor, `delta ${delta.turn}.${delta.part}`, true);
  }

  /**
   * The bridge from a turn's own vocabulary to the transcript's.
   *
   * `chat.respond` is the one call that is not a tool call in a transcript: it is
   * the assistant speaking, so it becomes a text block. Everything else is a
   * tool, and its result is the turn that follows.
   */
  observer(hexSessionId: string): TurnObserver {
    const said: TurnBlock[] = [];
    const flushSaid = () => {
      if (said.length === 0) return;
      const blocks = said.splice(0, said.length);
      void this.append(hexSessionId, "assistant", blocks, {
        stop: "end_turn",
        alt: blocks
          .map((b) => (b.type === "text" ? String(b.text) : ""))
          .join(" ")
          .slice(0, 280),
      });
    };

    return {
      thinking: (text) => {
        said.push({ type: "thinking", text });
        this.push(hexSessionId, "thinking", text);
      },
      toolCall: (call) => {
        if (call.name === RESPOND_TOOL) {
          const text = respondText(call.arguments);
          said.push({ type: "text", text });
          this.push(hexSessionId, "text", text);
          flushSaid();
          return;
        }
        said.push({
          type: "tool_call",
          id: call.id,
          name: call.name,
          arguments:
            call.arguments && typeof call.arguments === "object"
              ? (call.arguments as Record<string, unknown>)
              : null,
        });
        this.push(hexSessionId, "tool", `${call.name}(…)`);
        flushSaid();
      },
      toolResult: (result) => {
        if (result.name === RESPOND_TOOL) return;
        void this.append(
          hexSessionId,
          "tool",
          [
            {
              type: "tool_result",
              id: result.id,
              name: result.name,
              ok: result.ok,
              output: result.output,
            },
          ],
          { alt: `${result.name}: ${result.ok ? "ok" : "refused"}` },
        );
      },
    };
  }

  private async send(
    rumor: Rumor,
    what: string,
    ephemeral = false,
  ): Promise<void> {
    if (this.options.recipients.length === 0) return;
    try {
      const { undeliverable } = await this.options.sink.publishRumor(
        rumor,
        this.options.recipients,
        { ephemeral },
      );
      if (undeliverable.length > 0)
        this.log(
          `[hex] transcript ${what} did not reach ${undeliverable.length} recipient(s)`,
        );
    } catch (error) {
      // Never into the agent loop: a transcript is a record of the work, not it.
      this.log(
        `[hex] transcript ${what} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
