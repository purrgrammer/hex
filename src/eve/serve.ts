/**
 * A private message in, an Eve session out, a transcript to read it by.
 *
 * This is the whole point of the two halves meeting: someone DMs Hex, Eve does
 * the work, and the transcript is published as it happens with the message that
 * caused it named on its head. The link runs that way round deliberately — the
 * SESSION points at the message, not the answer at the session — so a client
 * holding a conversation can ask "what did this message set running" and list the
 * runs underneath it, live, without the agent having to say anything at all.
 *
 * A text answer is therefore optional (`reply`), and off by default. The session
 * IS the response: it carries the answer as its last turn, along with everything
 * that produced it. The cost of leaving it off is real and worth naming — a client
 * that cannot read kind 31777 sees a message with no reply — so an operator
 * talking to plain clients turns it on.
 *
 * One Eve session per correspondent, remembered ON DISK. A follow-up continues it,
 * because that is what a conversation is, and because Eve's session IS the context
 * — reconstructing history to feed it would be reimplementing the thing this
 * package stopped doing. Held in memory it survived exactly as long as the process:
 * a restart opened a new session for the next message, leaving the old one idle
 * forever with nobody to close it and the reader looking at two unrelated runs for
 * one conversation.
 *
 * The stream is consumed HERE and fanned out: `EveTranscript` publishes, and a
 * small local reducer watches for the answer. Handing the transcript a callback
 * would make the publisher responsible for knowing when to speak, which is not
 * its job — it writes down what happened.
 */

import { streamSession } from "./stream.js";
import { EveTranscript, type EveTranscriptOptions } from "./transcript.js";
import { payload, stringField } from "./types.js";
import { sessionAddress } from "../nostr/encode.js";
import type { ToolBridge } from "./bridge.js";
import type { ToolHost } from "../tools/types.js";
import type { SessionControl } from "../nostr/decode-control.js";
import type { Inbound } from "../transports/types.js";

/** What this needs of a transport: answer a message, and acknowledge one. */
export interface ServeTransport {
  reply(to: Inbound, text: string, tags?: string[][]): Promise<string>;
  /**
   * Optional, because not every protocol has a reaction.
   *
   * A model takes seconds and a tool can take minutes; without this there is no
   * difference a reader can see between "working on it" and "ignored you".
   */
  react?(to: Inbound, emoji: string): Promise<string>;
}

export interface ServeOptions {
  /** e.g. `http://127.0.0.1:2000`. */
  host: string;
  transport: ServeTransport;
  /**
   * Also send the answer as an ordinary message. On unless told otherwise.
   *
   * The session carries the answer either way, and a client that renders sessions
   * shows it there — but a DM is a CONVERSATION, and one that goes quiet while
   * something invisible happens elsewhere reads as broken to everyone whose client
   * does not know about transcripts. So the reply is the default and the transcript
   * is what makes it checkable.
   */
  reply?: boolean;
  /** What to react with while working. Empty string for no reaction. */
  ackEmoji?: string;
  /** Everything a transcript needs except the session, which is per correspondent. */
  transcript: Omit<EveTranscriptOptions, "sink"> & {
    sink: EveTranscriptOptions["sink"];
  };
  /**
   * Hex's own tools, offered to the runtime through the loopback bridge.
   *
   * Optional: without it the agent has only whatever tools its runtime ships
   * with, and the answer is scraped from the last message of the turn. With it,
   * speaking is a tool call like any other — which is the only way an answer can
   * carry a room, a reply target and a transport the runtime has never heard of.
   */
  tools?: {
    bridge: ToolBridge;
    /** A fresh host per turn, bound to the message being answered. */
    host: (inbound: Inbound) => ToolHost;
  };
  /** How long the pre-message read waits for silence. Injected in tests. */
  drainQuietMs?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * How long a stored replay may pause before it counts as finished.
 *
 * Generous against a slow local read, and irrelevant to latency: this runs once
 * per follow-up, on a session that is waiting and therefore silent.
 */
const DEFAULT_DRAIN_QUIET_MS = 1_500;

/**
 * Where a turn begins: how far the stream was read, and what had already ended.
 *
 * The index alone was not enough — see `follow`.
 */
interface Boundary {
  last: number;
  finished: Set<string>;
}

interface Conversation {
  /** Eve's session id for this correspondent. */
  sessionId: string;
  transcript: EveTranscript;
  /** Turn ids known to have ended, so a replayed ending cannot end another turn. */
  finished: Set<string>;
}

/**
 * Follows one correspondent's session and answers their messages.
 *
 * Created per peer and kept, because the Eve session is kept: a second question
 * from the same person continues the same run.
 */
export class EveServer {
  private readonly conversations = new Map<string, Conversation>();
  /**
   * The turn in flight per correspondent, kept OUTSIDE the conversation.
   *
   * A first message has no conversation yet — it is what creates one — so a queue
   * hung off the conversation would leave the very first pair of messages racing,
   * which is the case a queue exists for.
   */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Control events already carried out, bounded and FIFO.
   *
   * Four relays hand over the same wrap four times, and every one of these does
   * something. Obeying a `cancel` twice stops a turn that had nothing to do with
   * it.
   */
  private readonly obeyed = seenOnce(500);

  constructor(private readonly options: ServeOptions) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  /**
   * Take one inbound message: run it, publish it, answer it.
   *
   * Serialised per correspondent. Two questions arriving together are two turns
   * of one session, not two sessions — and Eve would reject the second while the
   * first is still running anyway.
   */
  async handle(inbound: Inbound): Promise<void> {
    const peer = inbound.author;
    const previous = this.queues.get(peer);
    const run = (async () => {
      // Wait for this person's previous turn, and do not let its failure stop
      // this one.
      await previous?.catch(() => {});
      await this.turn(inbound);
    })();

    this.queues.set(peer, run);
    return run;
  }

  /**
   * Publish what happened while nobody was watching.
   *
   * A follower that stops mid-turn — a restart, a crash, a Ctrl-C — leaves the
   * head saying `active`, and it says that forever. The run itself carried on
   * and finished; only the reading of it stopped, and a reader has no way to
   * tell "this agent is working" from "nobody has looked since Tuesday".
   *
   * Every non-terminal transcript is therefore read from its cursor to silence
   * at startup. The turns nobody published get published, and the head lands on
   * whatever Eve last said — usually `idle`, because the run finished long ago.
   * A session that really is still running simply drains to its current lull and
   * stays `active`, which is then true.
   */
  async catchUp(): Promise<void> {
    const open = this.options.transcript.store.openTranscripts();
    if (open.length === 0) return;
    this.log(
      `[hex] catching up ${open.length} session(s) nobody was following`,
    );

    for (const record of open) {
      const conversation: Conversation = {
        sessionId: record.sessionId,
        transcript: new EveTranscript(
          { ...this.options.transcript },
          record.sessionId,
        ),
        finished: new Set(),
      };
      try {
        const boundary = await this.drain(conversation);
        this.log(
          `[hex] ${record.sessionId} caught up to ${boundary.last} (${conversation.transcript.headStatus})`,
        );
      } catch (error) {
        // One unreachable session must not stop the others, or a single dead
        // stream keeps every stale head stale.
        this.log(
          `[hex] could not catch up ${record.sessionId}: ${message(error)}`,
        );
      }
    }
  }

  /**
   * Carry out an instruction from the operator.
   *
   * Every verb is a route Eve already exposes; nothing here invents a capability.
   * The two that matter are `respond` and `steer`, and their difference is the
   * reason this exists at all: a structured response resolves the request it
   * names and never steers, while a plain message steers — cancelling the
   * running turn — and does not resolve anything. With several requests open the
   * runtime refuses to guess which one a bare message addresses, so an answer has
   * to carry its own id, which is exactly what a chat reply cannot do.
   *
   * Already-obeyed commands are dropped rather than repeated: four relays deliver
   * the same wrap four times, and a `cancel` obeyed twice stops a turn that had
   * nothing to do with it.
   */
  async control(control: SessionControl): Promise<void> {
    if (!this.obeyed.admit(control.id)) return;

    const path = `/eve/v1/session/${encodeURIComponent(control.session)}`;
    const say = (what: string) =>
      this.log(`[hex] ${short(control.operator)} → ${what}`);

    try {
      switch (control.command) {
        case "respond": {
          if (!control.request) {
            this.log("[hex] a respond with no request id names nothing to answer");
            return;
          }
          await this.post(path, {
            inputResponses: [
              {
                requestId: control.request,
                ...(control.option ? { optionId: control.option } : {}),
                ...(control.text ? { text: control.text } : {}),
              },
            ],
          });
          say(`answered ${control.request}`);
          break;
        }

        case "steer": {
          if (!control.text) {
            this.log("[hex] a steer with no message would say nothing");
            return;
          }
          await this.post(path, { message: control.text });
          say("steered the run");
          break;
        }

        case "cancel":
          await this.post(`${path}/cancel`,
            control.turn ? { turnId: control.turn } : {});
          say("stopped the run");
          break;

        case "compact":
          await this.post(`${path}/compact`, {});
          say("compacted the context");
          break;

        case "clear":
          await this.post(`${path}/clear`, {});
          say("cleared the context");
          break;
      }
    } catch (error) {
      // Said out loud rather than thrown: one refused instruction must not take
      // down the reader that would carry the next one.
      this.log(
        `[hex] could not ${control.command} ${short(control.session)}: ${message(error)}`,
      );
    }
  }

  /**
   * Take a message that arrived while this correspondent's turn was running.
   *
   * A private message during a turn means "not that — this": there is nobody
   * else in the conversation and no other reason to type. So the running turn is
   * cancelled and this one takes over. Eve steers on its own when a message is
   * sent into an active turn, but the send cannot happen until the queue drains,
   * and the queue does not drain until the running turn ends — so the cancel is
   * asked for FIRST, out of band, and the ordinary path takes it from there.
   *
   * Fire and forget: Eve answers `accepted` or `no_active_turn`, both of which
   * mean "carry on", and a cancel that does not land leaves the message queued
   * rather than lost.
   */
  async interrupt(inbound: Inbound): Promise<void> {
    const conversation = this.conversations.get(inbound.author);
    if (conversation)
      await this.post(
        `/eve/v1/session/${encodeURIComponent(conversation.sessionId)}/cancel`,
        {},
      ).then(
        () =>
          this.log(
            `[hex] ${short(inbound.author)} interrupted their own turn`,
          ),
        (error: unknown) =>
          this.log(`[hex] could not cancel the running turn: ${message(error)}`),
      );
    return this.handle(inbound);
  }

  private async turn(inbound: Inbound): Promise<void> {
    const peer = inbound.author;
    /**
     * A reply continues the run; a fresh message starts a new one.
     *
     * One session per correspondent, forever, meant every question a person ever
     * asked landed in the same ever-growing context — a new subject inherited an
     * hour of unrelated work, and the reader was shown one endless transcript
     * instead of one run per thing asked for.
     *
     * The protocol already says which it is. A DM carrying an `e` tag is threaded
     * onto something, and that is the reader saying "about this"; a message with
     * no thread is a new subject. Hex does not have to guess, and does not get to.
     */
    let conversation = inbound.replyToId
      ? (this.conversations.get(peer) ?? this.resume(peer))
      : undefined;
    if (!conversation && inbound.replyToId)
      this.log(
        `[hex] ${short(peer)} replied to something with no session behind it — starting one`,
      );
    if (!inbound.replyToId) this.conversations.delete(peer);

    /**
     * Say "seen" before doing anything slow.
     *
     * Sent first and never awaited into the turn's critical path: a relay that
     * will not take a reaction must not stop the work. A failed ack is logged and
     * the turn goes on.
     */
    const emoji = this.options.ackEmoji ?? "👀";
    if (emoji && this.options.transport.react)
      void this.options.transport
        .react(inbound, emoji)
        .catch((error: unknown) =>
          this.log(
            `[hex] could not acknowledge ${short(peer)}: ${message(error)}`,
          ),
        );

    /**
     * The index a terminal event has to beat to end THIS turn.
     *
     * A new session has no history to replay, so nothing needs beating; a
     * follow-up does, and the value is where the stream stood before the message
     * went in.
     */
    /**
     * The tools for THIS message, bound for the length of the turn.
     *
     * Fresh per turn because every cap in a room's tools is per-turn — one
     * answer, nothing at all once cancelled — and because `respond` answers the
     * message it was built with. A stale host would answer the previous question.
     */
    const host = this.options.tools?.host(inbound);

    let boundary: Boundary;
    if (!conversation) {
      const sessionId = await this.createSession(inbound.text);
      const transcript = new EveTranscript(
        { ...this.options.transcript },
        sessionId,
      );
      /**
       * The message that started it, named on the head before anything publishes.
       *
       * Set here rather than discovered from the stream because a Nostr event id
       * is not something Eve has ever heard of — and set BEFORE the first head
       * goes out, since a head published without it would be replaced later and
       * every reader who saw the first one would have to notice the difference.
       */
      transcript.trigger = inbound.id;
      conversation = { sessionId, transcript, finished: new Set() };
      this.conversations.set(peer, conversation);
      this.options.transcript.store.rememberConversation(
        peer,
        sessionId,
        Math.floor(Date.now() / 1000),
      );
      this.log(`[hex] ${short(peer)} → eve session ${sessionId}`);
      boundary = { last: -1, finished: new Set() };
      // Bound as soon as the id exists. The runtime cannot call a tool before it
      // has thought, so a round trip's head start is enough — and a call that
      // does arrive first is refused politely rather than misrouted.
      if (host) this.options.tools?.bridge.bind(sessionId, host);
    } else {
      /**
       * What the stream had already said before the message went in.
       *
       * Both halves matter, and each closed a live failure: an index, because a
       * resumed follow replays the previous turn's tail; and the ids of the
       * turns already ended, because Eve replays that tail AGAIN once the new
       * message arrives, after the index boundary and before this turn starts.
       */
      boundary = await this.drain(conversation);
      if (host) this.options.tools?.bridge.bind(conversation.sessionId, host);
      await this.sendMessage(conversation.sessionId, inbound.text);
      this.log(
        `[hex] ${short(peer)} → continuing eve session ${conversation.sessionId}`,
      );
    }

    const answer = await this.follow(conversation, inbound, boundary);
    this.log(
      `[hex] ${short(peer)} ← ${sessionAddress(
        this.options.transcript.agentPubkey,
        conversation.transcript.nostrId,
      )}`,
    );

    if (this.options.reply === false) return;
    /**
     * The agent already spoke, so Hex does not speak for it.
     *
     * `chat.respond` is the answer when the runtime has it: it went out mid-turn,
     * in the room, threaded onto the message. Sending the scraped last message on
     * top of it says everything twice. The scrape stays as the fallback for a
     * model that never called the tool, which is the case the reply default was
     * turned on for.
     */
    if (host?.delivered) return;
    if (!answer) {
      this.log(`[hex] the turn for ${short(peer)} produced no answer to send`);
      return;
    }

    try {
      const id = await this.options.transport.reply(inbound, answer);
      this.log(`[hex] answered ${short(peer)} as ${id.slice(0, 12)}…`);
    } catch (error) {
      this.log(`[hex] could not answer ${short(peer)}: ${message(error)}`);
    }
  }

  /**
   * Read the session's stream to the end of this turn.
   *
   * Every event goes to the transcript first and is then read for the answer, so
   * a published transcript never lags the message that quotes it. The turn is
   * over on `turn.completed`, `turn.failed` or `session.waiting` — Eve emits the
   * last of those when it has nothing left to do, which is the only signal that
   * arrives whether the turn succeeded or not.
   */
  private async follow(
    conversation: Conversation,
    inbound: Inbound,
    /** Where the pre-message read got to, and which turns had already ended. */
    boundary: Boundary,
  ): Promise<string | undefined> {
    let answer: string | undefined;
    let failed: string | undefined;
    const finished = new Set(boundary.finished);
    /** The turn this message started, once it has announced itself. */
    let ours: string | undefined;

    try {
      for await (const { index, event } of streamSession({
        host: this.options.host,
        sessionId: conversation.sessionId,
        startIndex: conversation.transcript.streamIndex,
        signal: this.options.signal,
        fetchImpl: this.options.fetchImpl,
      })) {
        await conversation.transcript.handle(event, index);

        if (index <= boundary.last) continue;

        const data = payload(event);
        const turnId = stringField(data, "turnId");

        /**
         * A turn ends once. Eve says so twice.
         *
         * Resuming a session replays the previous turn's ending — a fresh
         * `turn.completed` and `session.waiting`, new event ids, slightly
         * different text, arriving AFTER this message was sent and BEFORE this
         * turn starts. No position can separate those from this turn's ending,
         * because they genuinely come later. Only the `turnId` can, so that is
         * what decides: a turn already known to have ended cannot end again.
         */
        if (turnId && finished.has(turnId)) continue;

        if (event.type === "turn.started" && turnId) ours = turnId;

        if (event.type === "message.completed")
          answer = stringField(data, "message") ?? answer;
        if (event.type === "turn.failed" || event.type === "session.failed")
          failed = stringField(data, "message") ?? "the turn failed";

        if (event.type === "turn.completed" || event.type === "turn.failed") {
          if (turnId) finished.add(turnId);
          // A turn ending is only OUR turn ending when it is our turn. Before
          // this message's turn has announced itself, an ending belongs to
          // whatever came before it.
          if (!turnId || turnId === ours) break;
          continue;
        }

        // `session.waiting` and `session.failed` name no turn, so they are read
        // as this turn's only once this turn exists. A session waiting before
        // ours began is the one it was already waiting in.
        if (event.type === "session.waiting" || event.type === "session.failed") {
          if (ours) break;
          continue;
        }
      }
    } catch (error) {
      // A dropped stream is not a failed turn, but it does mean this process
      // cannot report on one — so it is said out loud and the answer, if any
      // arrived before the drop, is still sent.
      this.log(
        `[hex] the stream for ${short(inbound.author)} ended early: ${message(error)}`,
      );
    }

    if (failed && !answer) return `That did not work: ${failed}`;
    return answer;
  }

  /**
   * Pick up a conversation a previous process was having.
   *
   * The transcript is rebuilt from its own row, so the `seq` chain continues where
   * it left off rather than forking, and the trigger it already published stays
   * the message that opened the run.
   */
  private resume(peer: string): Conversation | undefined {
    const sessionId = this.options.transcript.store.conversationFor(peer);
    if (!sessionId) return undefined;
    const conversation: Conversation = {
      sessionId,
      transcript: new EveTranscript({ ...this.options.transcript }, sessionId),
      /**
       * Nothing is known to have ended, because this process did not watch it.
       *
       * The pre-message read fills this in: it passes the previous turn's ending
       * on its way to the boundary, which is exactly where that knowledge comes
       * from after a restart.
       */
      finished: new Set(),
    };
    this.conversations.set(peer, conversation);
    this.log(`[hex] ${short(peer)} → resumed eve session ${sessionId}`);
    return conversation;
  }

  private async createSession(text: string): Promise<string> {
    const response = await this.post("/eve/v1/session", { message: text });
    const id =
      typeof response.sessionId === "string" ? response.sessionId : undefined;
    if (!id) throw new Error("eve accepted the message but named no session");
    return id;
  }

  private async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.post(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
      message: text,
    });
  }

  /**
   * How far the stream has got, from the header Eve returns for it.
   *
   * A GET that is abandoned immediately: the connection is a live follow with no
   * end, and all this wants is `x-eve-stream-tail-index`.
   */
  /**
   * Read whatever is already stored, and report where that leaves the stream.
   *
   * This is where the turn boundary comes from, and it is measured in the same
   * counter the follow uses — because it is the same read. It used to come from
   * Eve's `x-eve-stream-tail-index`, which is a DIFFERENT number: two smaller,
   * live, than the events the consumer had counted. The previous turn's
   * `turn.completed` therefore landed one past the boundary and ended this turn
   * before it had begun. A question was asked, a session ran, and nobody was
   * answered.
   *
   * The header is not consulted at all now, not even to stop: an end-of-stored
   * marker that is off by two is worse than no marker, because it looks right.
   * What ends the drain is SILENCE — the session is waiting for the message that
   * has not been sent yet, so it has nothing to say, and a stored replay arrives
   * far faster than the quiet window.
   *
   * The events are handed to the transcript on the way past rather than skipped:
   * a resumed conversation has a tail nobody published yet, and this is the only
   * pass that will ever see it.
   */
  private async drain(conversation: Conversation): Promise<Boundary> {
    const quiet = this.options.drainQuietMs ?? DEFAULT_DRAIN_QUIET_MS;
    const controller = new AbortController();
    const stop = () => {
      controller.abort();
    };
    this.options.signal?.addEventListener("abort", stop);
    let timer = setTimeout(stop, quiet);

    let last = conversation.transcript.streamIndex;
    const finished = new Set(conversation.finished);
    try {
      for await (const { index, event } of streamSession({
        host: this.options.host,
        sessionId: conversation.sessionId,
        startIndex: last,
        signal: controller.signal,
        fetchImpl: this.options.fetchImpl,
      })) {
        /**
         * The window measures waiting, not working.
         *
         * `handle` publishes: seals, wraps, a relay round trip per recipient,
         * seconds at a time. Re-arming the timer BEFORE that meant a slow
         * publish ran the window out and aborted its own read — a catch-up
         * stopped two events into a twenty-eight event tail and left the head
         * saying `active`, which is the exact lie it was called to fix.
         */
        clearTimeout(timer);
        await conversation.transcript.handle(event, index);
        last = index;
        if (controller.signal.aborted) break;
        timer = setTimeout(stop, quiet);
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          const turnId = stringField(payload(event), "turnId");
          if (turnId) finished.add(turnId);
        }
      }
    } catch {
      // The abort is how this ends. Anything else that goes wrong leaves the
      // boundary where the reading got to, which filters less rather than more:
      // an answer repeated is better than an answer never sent.
    } finally {
      clearTimeout(timer);
      this.options.signal?.removeEventListener("abort", stop);
    }
    conversation.finished = finished;
    return { last, finished };
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(
      new URL(path, this.options.host).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: this.options.signal,
      },
    );
    if (!response.ok)
      throw new Error(`eve ${path}: ${response.status} ${response.statusText}`);
    return (await response.json()) as Record<string, unknown>;
  }

  /** Close every session this server was following. */
  async close(): Promise<void> {
    for (const conversation of this.conversations.values())
      await conversation.transcript.close();
  }
}

const short = (pubkey: string) => `${pubkey.slice(0, 8)}…`;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A bounded memory of ids, oldest forgotten first. */
function seenOnce(limit: number) {
  const ids = new Set<string>();
  const order: string[] = [];
  return {
    admit(id: string): boolean {
      if (ids.has(id)) return false;
      ids.add(id);
      order.push(id);
      if (order.length > limit) {
        const oldest = order.shift();
        if (oldest) ids.delete(oldest);
      }
      return true;
    },
  };
}
