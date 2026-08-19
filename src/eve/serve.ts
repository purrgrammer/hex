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
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface Conversation {
  /** Eve's session id for this correspondent. */
  sessionId: string;
  transcript: EveTranscript;
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

  private async turn(inbound: Inbound): Promise<void> {
    const peer = inbound.author;
    let conversation = this.conversations.get(peer) ?? this.resume(peer);

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
    let after: number;
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
      conversation = { sessionId, transcript };
      this.conversations.set(peer, conversation);
      this.options.transcript.store.rememberConversation(
        peer,
        sessionId,
        Math.floor(Date.now() / 1000),
      );
      this.log(`[hex] ${short(peer)} → eve session ${sessionId}`);
      after = -1;
    } else {
      /**
       * Where the stream stood BEFORE the message was sent.
       *
       * Without this, a follow-up ended instantly with no answer. Resuming from
       * the durable cursor replays the tail of the previous turn — including its
       * `session.waiting` — and the follow stopped on it, because a terminal
       * event from the turn before looks exactly like a terminal event for this
       * one. The transcript still reads from its own cursor, so nothing published
       * is skipped; only the answer is required to come from after the question.
       */
      after = await this.tailIndex(conversation.sessionId);
      await this.sendMessage(conversation.sessionId, inbound.text);
      this.log(
        `[hex] ${short(peer)} → continuing eve session ${conversation.sessionId}`,
      );
    }

    const answer = await this.follow(conversation, inbound, after);
    this.log(
      `[hex] ${short(peer)} ← ${sessionAddress(
        this.options.transcript.agentPubkey,
        conversation.transcript.nostrId,
      )}`,
    );

    if (this.options.reply === false) return;
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
    /** Ignore terminal events at or below this index: they are the last turn's. */
    after: number,
  ): Promise<string | undefined> {
    let answer: string | undefined;
    let failed: string | undefined;

    try {
      for await (const { index, event } of streamSession({
        host: this.options.host,
        sessionId: conversation.sessionId,
        startIndex: conversation.transcript.streamIndex,
        signal: this.options.signal,
        fetchImpl: this.options.fetchImpl,
      })) {
        await conversation.transcript.handle(event, index);

        if (index <= after) continue;

        const data = payload(event);
        if (event.type === "message.completed")
          answer = stringField(data, "message") ?? answer;
        if (event.type === "turn.failed" || event.type === "session.failed")
          failed = stringField(data, "message") ?? "the turn failed";

        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "session.waiting"
        )
          break;
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
    const conversation = {
      sessionId,
      transcript: new EveTranscript({ ...this.options.transcript }, sessionId),
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
  private async tailIndex(sessionId: string): Promise<number> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const url = new URL(
      `/eve/v1/session/${encodeURIComponent(sessionId)}/stream?includeTailIndex=1`,
      this.options.host,
    ).toString();
    const controller = new AbortController();
    try {
      const response = await doFetch(url, { signal: controller.signal });
      const tail = Number(response.headers.get("x-eve-stream-tail-index"));
      return Number.isSafeInteger(tail) ? tail : -1;
    } catch {
      // Unknown means "do not filter", which is the safe direction: an answer
      // repeated is better than an answer never sent.
      return -1;
    } finally {
      controller.abort();
    }
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
