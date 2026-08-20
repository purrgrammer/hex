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
import { asRecord, payload, stringField } from "./types.js";
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
    /**
     * A fresh host per turn, bound to the message being answered.
     *
     * Called with NOTHING for a run started over the control plane, which has
     * no room: the host it returns must offer the tools that act on the network
     * and none of the ones that act on a conversation.
     */
    host: (inbound?: Inbound) => ToolHost;
  };
  /**
   * What this agent is, for the per-session snapshot.
   *
   * A function rather than a value, because the answer is read from the runtime
   * when a session opens rather than known when the server is built.
   */
  describe?: () => Promise<
    | {
        name: string;
        about?: string;
        picture?: string;
        instructions?: string;
        tools?: { name: string; description?: string; parameters?: unknown }[];
      }
    | undefined
  >;
  /**
   * Who is asking and what about, resolved into context the runtime is given.
   *
   * Optional, and a run works without it — worse. Without the operator block a
   * runtime has no idea whose message it is holding, which is what `chat.who`
   * existed to answer and what made "my recent posts" a query about strangers;
   * without the subject blocks a run scoped to a repository is handed a
   * coordinate it cannot read.
   */
  ground?: (input: {
    operator?: string;
    subjects?: string[][];
  }) => Promise<string[]>;
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
 * How long past a failed turn to read for the session's own verdict.
 *
 * Eve follows a failed turn with `session.failed` or `session.waiting` almost
 * immediately, so a second is generous. It is a DEADLINE rather than a count of
 * events because the thing being waited on may simply never arrive: a stream
 * that stays open and says nothing would otherwise pin the follow open forever,
 * which is the failure this whole file is most careful about.
 */
const VERDICT_MS = 1_000;

/**
 * Where a turn begins: how far the stream was read, and what had already ended.
 *
 * The index alone was not enough — see `follow`.
 */
interface Boundary {
  last: number;
  finished: Set<string>;
}

/**
 * The pointers a message carried, minus the ones that mean something else.
 *
 * A `p` names a recipient and an `e` with a `trigger` marker names the message
 * itself; neither is a subject. What is left is what the sender said this is
 * about.
 */
function subjectsOf(inbound: Inbound): string[][] {
  const tags = (inbound.event as { tags?: string[][] } | undefined)?.tags ?? [];
  return tags.filter(
    (tag) => (tag[0] === "a" || tag[0] === "e") && !!tag[1] && !tag[3],
  );
}

/**
 * The room a message arrived in, written the way its protocol writes rooms.
 *
 * Two `nostr:` conversations with the same person are one channel; two groups
 * on different relays with the same id are two, which is exactly why NIP-29
 * puts the host in the identifier.
 */
function channelOf(inbound: Inbound): { transport: string; id?: string } {
  const room = inbound.room;
  if (room.transport === "nip-29" && room.relay) {
    const host = room.relay.replace(/^wss?:\/\//, "").replace(/\/$/, "");
    return { transport: room.transport, id: `${host}'${room.id}` };
  }
  return { transport: room.transport, id: room.id };
}

/** A question a run stopped on, reduced to what a chat message needs. */
interface Asked {
  requestId: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowFreeform: boolean;
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
   * Publish the prompt and tools this run had, if anyone can tell us.
   *
   * The runtime is the source, not this package's config: the config is a
   * request and the runtime is the answer, and publishing the request as if it
   * were the answer is how a transcript comes to describe an agent that never
   * ran.
   */
  /**
   * Publish what this run was set up with.
   *
   * `roomless` is not decoration: the runtime's own `/info` lists every tool
   * the bridge can offer, which for a run with no room includes `chat.*` it was
   * never given. A snapshot that claims a speaking tool the session did not
   * have describes a different agent from the one that ran.
   */
  private async describe(
    transcript: EveTranscript,
    roomless = false,
  ): Promise<void> {
    const describe = this.options.describe;
    if (!describe) return;
    // Said before the first head goes out, so it points at the snapshot this is
    // about to publish rather than at a standing definition nobody wrote.
    transcript.expectSnapshot();
    try {
      const info = await describe();
      if (info)
        await transcript.snapshot(
          roomless
            ? {
                ...info,
                tools: (info.tools ?? []).filter(
                  (tool) => !/^chat[._]/.test(tool.name),
                ),
              }
            : info,
        );
    } catch (error) {
      this.log(`[hex] could not describe the session: ${message(error)}`);
    }
  }

  /**
   * Who is asking and what about, or nothing at all.
   *
   * Never fatal: a relay that will not answer costs the model a fact, and a run
   * refused because a profile could not be fetched costs it the whole job.
   */
  private async grounding(
    operator: string,
    subjects: string[][],
  ): Promise<string[] | undefined> {
    if (!this.options.ground) return undefined;
    try {
      const blocks = await this.options.ground({ operator, subjects });
      return blocks.length > 0 ? blocks : undefined;
    } catch (error) {
      this.log(`[hex] could not ground the session: ${message(error)}`);
      return undefined;
    }
  }

  /**
   * Begin a run nobody said anything to start.
   *
   * The control plane's reason to exist. Everything else here answers a message
   * — a DM arrives, a session opens under it, the reply goes back into the
   * room — and that binds having an agent to having a conversation with it. A
   * client that renders sessions does not want a chat transcript alongside;
   * it wants to ask for work and watch it happen.
   *
   * The session's PUBLISHED name comes from the client, which is the whole
   * point: it can subscribe to the address before the first head exists,
   * instead of polling for a run whose name it learns only once the work is
   * under way. That makes the id a claim, so it is checked — 32 hex bytes, and
   * refused if this agent already published a session by that name, which is
   * also what makes a wrap redelivered by four relays, or replayed out of the
   * two-day backlog after a restart, harmless.
   *
   * No room is bound. A run started this way has nowhere to speak and no
   * business trying: its transcript IS the channel, and the tool catalogue it
   * is offered says so by leaving `chat.*` out.
   */
  private async start(control: SessionControl): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(control.session)) {
      this.log(`[hex] a start named ${control.session}, which is not a session id`);
      return;
    }
    if (this.options.transcript.store.transcriptForNostrId(control.session)) {
      this.log(`[hex] a start for a session that already exists — ignored`);
      return;
    }
    if (!control.text) {
      this.log("[hex] a start with no message would have nothing to do");
      return;
    }

    const peer = control.operator;
    let conversation: Conversation;
    try {
      const sessionId = await this.createSession(
        control.text,
        await this.grounding(peer, control.subjects ?? []),
      );
      const transcript = new EveTranscript(
        { ...this.options.transcript },
        sessionId,
        control.session,
      );
      /**
       * The control event is what started this, so it is the trigger.
       *
       * Same relationship a DM has to the run it opened — a reader holding the
       * request can find the work — and it is what lets a client that sent a
       * start recognise the head as the answer to it.
       */
      transcript.trigger = control.id;
      /**
       * Not a room: the wrap itself.
       *
       * A run started over the control plane happens nowhere a client could
       * open. Naming the envelope rather than a chat protocol is the honest
       * answer, and it is the one a reader needs — `nip-59` says "this was
       * asked for privately and answered in the transcript", which is exactly
       * what a client must not go looking for a room for.
       */
      transcript.channel = { transport: "nip-59", id: peer };
      transcript.subjects = control.subjects ?? [];
      conversation = { sessionId, transcript, finished: new Set() };
      this.options.transcript.store.rememberConversation(
        peer,
        sessionId,
        Math.floor(Date.now() / 1000),
      );
      this.log(
        `[hex] ${short(peer)} → eve session ${sessionId} (started over the control plane)`,
      );
      void this.describe(transcript, true);
      /**
       * Tools, but no room.
       *
       * The bridge still has to be bound or the runtime has no `nostr.*` at
       * all; what it gets is a host with nothing to speak into, which drops
       * `chat.*` from the catalogue rather than offering calls that can only
       * fail.
       */
      if (this.options.tools)
        this.options.tools.bridge.bind(sessionId, this.options.tools.host());
    } catch (error) {
      this.log(`[hex] could not start a session: ${message(error)}`);
      return;
    }

    /**
     * Followed to the end, and nothing said at the end of it.
     *
     * There is no room to answer in, so the transcript is the answer: the last
     * turn carries what the run concluded, exactly as it does when `--no-reply`
     * is set. A question the run stops on is published on the head as a pending
     * request, which the client that started it is already watching for.
     */
    const asked: Asked[] = [];
    await this.follow(conversation, peer, { last: -1, finished: new Set() }, asked);
    this.log(
      `[hex] ${short(peer)} ← ${sessionAddress(
        this.options.transcript.agentPubkey,
        conversation.transcript.nostrId,
      )}`,
    );
  }

  /** Close a head the runtime will never speak for again. */
  private async retire(sessionId: string): Promise<void> {
    const conversation = [...this.conversations.values()].find(
      (candidate) => candidate.sessionId === sessionId,
    );
    const transcript =
      conversation?.transcript ??
      new EveTranscript({ ...this.options.transcript }, sessionId);
    // `aborted`, not `done`: a session retired by its operator did not finish
    // what it was doing, and a reader deserves the difference.
    await transcript.close("aborted");
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

    // The one verb with no session behind it yet — it is how one begins.
    if (control.command === "start") return await this.start(control);

    /**
     * The address names the session on the WIRE; the runtime knows its own id.
     *
     * Two ids for one session, deliberately: the published one is 32 random
     * bytes so a runtime's id never becomes a public name. A reader can only
     * know the published one, so the translation belongs here — and a control
     * event for a session this process has never published is not ours to act
     * on, which is also how a stale instruction for a forgotten run is refused.
     */
    const record = this.options.transcript.store.transcriptForNostrId(
      control.session,
    );
    if (!record) {
      this.log(
        `[hex] a ${control.command} names a session this agent did not publish`,
      );
      return;
    }

    const path = `/eve/v1/session/${encodeURIComponent(record.sessionId)}`;
    const say = (what: string) =>
      this.log(`[hex] ${short(control.operator)} → ${what}`);

    /**
     * Give the turn a room before starting it.
     *
     * A steer runs a real turn, with tools — and the tool host is bound in the
     * DM path only, so a steered turn had none: every `chat_respond` came back
     * "this session has no room bound to it", and the agent worked, reasoned,
     * built its answer and could not say it. Silent, and indistinguishable from
     * an agent that had nothing to add.
     *
     * The room is rebuilt from the conversation this session belongs to. Its
     * `id` is the message that opened the run, so a reply threads onto the
     * conversation rather than onto nothing.
     */
    this.bindRoomFor(
      record.sessionId,
      control.operator,
      record.trigger,
      record.channel,
    );

    /**
     * Somebody has to WATCH the turn a command starts.
     *
     * `respond` and `steer` both run a real turn, and nothing here was reading
     * the stream while it ran — so the model thought, called tools, answered,
     * and none of it was published. From the operator's side the instruction
     * vanished: the session sat at the status it already had until some later
     * catch-up noticed. A command that starts work and then looks away is
     * indistinguishable from one that was never delivered.
     *
     * The boundary is taken BEFORE the instruction goes in, exactly as the
     * message path does. Draining afterwards would wait out the very turn the
     * instruction started and then follow a stream with nothing left in it.
     */
    const runs = control.command === "respond" || control.command === "steer";
    let conversation: Conversation | undefined;
    let boundary: Boundary | undefined;
    if (runs) {
      conversation = {
        sessionId: record.sessionId,
        transcript: new EveTranscript(
          { ...this.options.transcript },
          record.sessionId,
        ),
        finished: new Set(),
      };
      try {
        boundary = await this.drain(conversation);
      } catch (error) {
        this.log(
          `[hex] could not read ${record.sessionId} before a ${control.command}: ${message(error)}`,
        );
        conversation = undefined;
      }
    }

    try {
      switch (control.command) {
        case "respond": {
          if (!control.request) {
            this.log(
              "[hex] a respond with no request id names nothing to answer",
            );
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
          /**
           * Queue behind the running turn unless told otherwise.
           *
           * Eve's default is the other one: a message sent into an active turn
           * cancels it and starts again. That is right for a room, where a
           * message mid-turn means "not that — this", and it is wrong here. An
           * operator steering from a session view is watching the work happen
           * and adding to it; throwing away a turn that is minutes into a build
           * because they had a second thought is the expensive reading of an
           * ambiguous act. A client that means "stop and do this instead" says
           * so with `policy=steer`, or cancels first.
           */
          await this.post(path, {
            message: control.text,
            turnPolicy: control.policy ?? "queue",
          });
          say(
            control.policy === "steer"
              ? "steered the run, cancelling what it was doing"
              : "queued a message behind the running turn",
          );
          break;
        }

        case "cancel":
          await this.post(
            `${path}/cancel`,
            control.turn ? { turnId: control.turn } : {},
          );
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

        /**
         * Retire the session for good.
         *
         * Terminal in the runtime's own terms — the id never becomes a session
         * again — and it emits NOTHING on the stream, so unlike every other
         * verb the head has to be closed here. A reader watching the address
         * would otherwise see a run that simply stopped mid-sentence.
         */
        case "reset":
          await this.post(
            `${path}/reset`,
            control.text ? { reason: control.text } : {},
          );
          await this.retire(record.sessionId);
          say("retired the session");
          break;
      }
    } catch (error) {
      // Said out loud rather than thrown: one refused instruction must not take
      // down the reader that would carry the next one.
      this.log(
        `[hex] could not ${control.command} ${record.sessionId}: ${message(error)}`,
      );
      return;
    }

    if (!conversation || !boundary) return;
    /**
     * Follow it to the end, and say nothing at the end of it.
     *
     * The transcript is the answer — this instruction arrived over the control
     * plane, not in a room, and a run steered from a session view is read in
     * that same view. A question the turn stops on lands on the head as a
     * pending request, which the client that sent this is already watching.
     */
    const asked: Asked[] = [];
    await this.follow(conversation, control.operator, boundary, asked);
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
          this.log(`[hex] ${short(inbound.author)} interrupted their own turn`),
        (error: unknown) =>
          this.log(
            `[hex] could not cancel the running turn: ${message(error)}`,
          ),
      );
    return this.handle(inbound);
  }

  private async turn(inbound: Inbound): Promise<void> {
    const peer = inbound.author;

    /**
     * A reply to a question Hex asked is an ANSWER, not a new instruction.
     *
     * Eve draws the line: `inputResponses` resolves a request and never steers,
     * a plain `message` steers and never resolves — and with several requests
     * open it refuses to guess which one bare text meant. So a reply typed into
     * the room, which is the obvious thing to do when a chat message asks you
     * something, would start a fresh turn and leave the question standing. The
     * agent would ask again. Handled here, before any of the session
     * bookkeeping below, because answering is not a turn of conversation.
     */
    if (inbound.replyToId) {
      const answering = this.options.transcript.store.questionAsked(
        inbound.replyToId,
      );
      if (answering) {
        await this.answerQuestion(inbound, answering);
        return;
      }
    }
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
      const sessionId = await this.createSession(
        inbound.text,
        await this.grounding(peer, subjectsOf(inbound)),
      );
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
      /**
       * And where it is happening, in the protocol's own notation.
       *
       * A NIP-29 group is named `<relay-host>'<group-id>` by NIP-29 itself, so
       * that is what goes on the wire rather than a shape invented here — a
       * reader that wants to open the room can hand it straight to a client.
       * A NIP-17 conversation is named by the person on the other end.
       */
      transcript.channel = channelOf(inbound);
      /**
       * What the run is about, lifted off the message that started it.
       *
       * A client scoping a run to a repository sends an `a`; an event gets an
       * `e`. Both are copied onto the head, and both are what the runtime is
       * grounded in below — the alternative was the client writing "work on X"
       * into the operator's own words, which titled every run after the
       * boilerplate and attributed the instruction to them.
       */
      transcript.subjects = subjectsOf(inbound);
      conversation = { sessionId, transcript, finished: new Set() };
      this.conversations.set(peer, conversation);
      this.options.transcript.store.rememberConversation(
        peer,
        sessionId,
        Math.floor(Date.now() / 1000),
      );
      this.log(`[hex] ${short(peer)} → eve session ${sessionId}`);
      boundary = { last: -1, finished: new Set() };

      /**
       * What this run was set up with, published once, before anything it did.
       *
       * Fire and forget: a reader who cannot see the prompt still gets the
       * transcript, and a run that refused to start because it could not
       * describe itself would be a far worse trade.
       */
      void this.describe(conversation.transcript);
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

    const asked: Asked[] = [];
    const answer = await this.follow(conversation, peer, boundary, asked);
    this.log(
      `[hex] ${short(peer)} ← ${sessionAddress(
        this.options.transcript.agentPubkey,
        conversation.transcript.nostrId,
      )}`,
    );

    /**
     * A question goes to the room whatever the reply setting says.
     *
     * `--no-reply` means "the client renders sessions, so do not narrate the
     * answer in chat". It cannot mean "do not tell them you are stuck": a run
     * blocked in silence is not a quieter transcript, it is a conversation that
     * ended without saying so.
     */
    if (asked.length > 0) {
      await this.ask(conversation, inbound, asked);
      return;
    }

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
  /**
   * Send a room reply back as the answer to the request it replies to.
   *
   * Matched against the options by label as well as by id, because a person
   * reading "- Approve" in a chat message types `Approve`, not `approve_0`.
   * Nothing matching is not an error: free text is a legitimate answer to a
   * question that allowed it, and Eve is the one that decides whether this
   * request will take one.
   */
  /**
   * Bind a tool host to a session that no inbound message is driving.
   *
   * Enough of an `Inbound` to answer with: who, where, and what to thread
   * onto. The text is empty because nothing was said — this is a turn the
   * operator started, not a message anybody sent.
   */
  private bindRoomFor(
    sessionId: string,
    operator: string,
    trigger?: string,
    /** Where the run lives, so a roomless one is not handed a room. */
    channel?: { transport: string; id?: string },
  ): void {
    const tools = this.options.tools;
    if (!tools) {
      this.log("[hex] no tool bridge, so a turn started here cannot speak");
      return;
    }

    /**
     * A run with no room does not acquire one by being steered.
     *
     * `nip-59` says the request arrived as a gift wrap and the transcript is
     * how it is read. Manufacturing a DM room for it would hand the model
     * speaking tools it should not have and put its answer in a conversation
     * nobody opened — the operator asked in a session view and would be replied
     * to somewhere else entirely.
     */
    if (channel && channel.transport === "nip-59") {
      tools.bridge.bind(sessionId, tools.host());
      return;
    }
    /**
     * The operator, with the conversation table as a hint only.
     *
     * `conversations` holds ONE row per correspondent — their CURRENT session —
     * so a lookup by session fails for every run that is not the latest, which
     * is most of them. The turn then bound no room and the agent went mute,
     * which is exactly what happened the first time this was fixed.
     *
     * Whoever sent the control is who to answer, and a control is obeyed only
     * from the pubkey the head names as operator, so the two agree by
     * construction.
     */
    const peer =
      this.options.transcript.store.peerForSession(sessionId) ?? operator;

    this.log(`[hex] bound a room on ${sessionId} for ${short(peer)}`);
    tools.bridge.bind(
      sessionId,
      tools.host({
        id: trigger ?? sessionId,
        author: peer,
        text: "",
        createdAt: Math.floor(Date.now() / 1000),
        room: { transport: "nip-17", id: peer },
        addressesSelf: true,
        event: {
          id: trigger ?? sessionId,
          pubkey: peer,
          created_at: Math.floor(Date.now() / 1000),
          kind: 14,
          tags: [],
          content: "",
          sig: "",
        },
      } as unknown as Inbound),
    );
  }

  private async answerQuestion(
    inbound: Inbound,
    answering: { sessionId: string; requestId: string },
  ): Promise<void> {
    const path = `/eve/v1/session/${encodeURIComponent(answering.sessionId)}`;

    /**
     * Read the stream to its current lull BEFORE the answer goes in, exactly as
     * a continuing message does. Draining afterwards would wait out the very
     * turn the answer starts, and then follow a stream with nothing left in it —
     * every turn the answer unblocked published by nobody.
     */
    const conversation =
      this.conversations.get(inbound.author) ?? this.resume(inbound.author);
    const boundary = conversation ? await this.drain(conversation) : undefined;

    try {
      await this.post(path, {
        inputResponses: [
          { requestId: answering.requestId, text: inbound.text.trim() },
        ],
      });
      this.log(
        `[hex] ${short(inbound.author)} answered ${answering.requestId} in the room`,
      );
      /**
       * Forgotten once used. A request resolves once, and a second reply to the
       * same message would otherwise be posted as another answer to a question
       * Eve has already closed.
       */
      this.options.transcript.store.forgetQuestions(answering.sessionId);
    } catch (error) {
      this.log(
        `[hex] could not answer ${answering.requestId}: ${message(error)}`,
      );
      return;
    }

    if (!conversation || !boundary) return;
    const asked: Asked[] = [];
    const answer = await this.follow(
      conversation,
      inbound.author,
      boundary,
      asked,
    );
    if (asked.length > 0) {
      await this.ask(conversation, inbound, asked);
      return;
    }
    if (this.options.reply === false || !answer) return;
    try {
      await this.options.transport.reply(inbound, answer);
    } catch (error) {
      this.log(
        `[hex] could not answer ${short(inbound.author)}: ${message(error)}`,
      );
    }
  }

  /**
   * Post a parked run's question into the room it came from.
   *
   * Plain text, and the options spelled out as words rather than a list of
   * ids, because whoever reads this is reading a chat message and not a form.
   * The pointer at the end is the session's own address: a client that renders
   * transcripts opens it and shows the same question with buttons, which is the
   * better way to answer and the reason the address is there at all.
   *
   * Each posted message is remembered against the request it asked, so a reply
   * to it resolves that request rather than steering the run. Without that the
   * obvious thing to do — reply in the room — is the one thing that does not
   * work: Eve treats a bare message as a new instruction and leaves the
   * question open.
   */
  private async ask(
    conversation: Conversation,
    inbound: Inbound,
    asked: Asked[],
  ): Promise<void> {
    const address = sessionAddress(
      this.options.transcript.agentPubkey,
      conversation.transcript.nostrId,
    );

    for (const question of asked) {
      const lines = [question.prompt || "I need an answer before I can go on."];
      if (question.options.length > 0)
        lines.push(
          "",
          ...question.options.map((option) => `- ${option.label}`),
          "",
          "Reply with one of those, or open the session to answer there:",
        );
      else lines.push("", "Reply here, or open the session to answer there:");
      lines.push(address);

      try {
        const id = await this.options.transport.reply(
          inbound,
          lines.join("\n"),
        );
        this.options.transcript.store.rememberQuestion(
          id,
          conversation.sessionId,
          question.requestId,
          Math.floor(Date.now() / 1000),
        );
        this.log(
          `[hex] asked ${short(inbound.author)} ${question.requestId} as ${id.slice(0, 12)}…`,
        );
      } catch (error) {
        // The run stays parked either way; what is lost is the person knowing.
        this.log(
          `[hex] could not put ${question.requestId} to ${short(inbound.author)}: ${message(error)}`,
        );
      }
    }
  }

  private async follow(
    conversation: Conversation,
    /** Whose run this is, for the log. Nothing else is read off the message. */
    who: string,
    /** Where the pre-message read got to, and which turns had already ended. */
    boundary: Boundary,
    /** Filled with anything the run stopped to ask, in the order it asked. */
    asked: Asked[],
  ): Promise<string | undefined> {
    let answer: string | undefined;
    let failed: string | undefined;
    const finished = new Set(boundary.finished);
    /** The turn this message started, once it has announced itself. */
    let ours: string | undefined;
    /**
     * Cuts the stream off if the verdict on a failed turn never comes.
     *
     * Aborting the read is the only thing that unblocks an `await` on a stream
     * that has gone quiet, and a stream cut short here is already handled: the
     * catch below treats it as "this process cannot report further", which is
     * exactly what it is.
     */
    const verdict = new AbortController();
    let verdictTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, verdict.signal])
      : verdict.signal;

    try {
      for await (const { index, event } of streamSession({
        host: this.options.host,
        sessionId: conversation.sessionId,
        startIndex: conversation.transcript.streamIndex,
        signal,
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

        /**
         * The run stopped to ask something, and nobody in the room knows.
         *
         * A parked turn ends exactly like a finished one, so without this the
         * conversation simply goes quiet: the agent is waiting, indefinitely,
         * on a person who was never told they were asked. Collected here and
         * posted after the follow, because the post is a relay round trip and
         * this loop is reading a live stream.
         */
        if (event.type === "input.requested")
          for (const raw of Array.isArray(data.requests) ? data.requests : []) {
            const request = asRecord(raw);
            const requestId = request && stringField(request, "requestId");
            if (!request || !requestId) continue;
            asked.push({
              requestId,
              prompt: stringField(request, "prompt") ?? "",
              options: (Array.isArray(request.options) ? request.options : [])
                .map((option) => asRecord(option))
                .filter((option): option is Record<string, unknown> => !!option)
                .map((option) => ({
                  id: stringField(option, "id") ?? "",
                  label: stringField(option, "label") ?? "",
                }))
                .filter((option) => option.id && option.label),
              allowFreeform: request.allowFreeform === true,
            });
          }
        if (event.type === "turn.failed" || event.type === "session.failed")
          failed = stringField(data, "message") ?? "the turn failed";

        if (event.type === "turn.completed" || event.type === "turn.failed") {
          if (turnId) finished.add(turnId);
          // A turn ending is only OUR turn ending when it is our turn. Before
          // this message's turn has announced itself, an ending belongs to
          // whatever came before it.
          if (!turnId || turnId === ours) {
            /**
             * A FAILED turn is not the end of the story, and stopping here lost
             * the rest of it.
             *
             * Eve says a turn failed, and then says whether the SESSION failed
             * with it — `session.failed` for a run that is over, or
             * `session.waiting` for one that will take the next message
             * normally. Breaking on the turn meant the second event was never
             * read, so the transcript kept what a failed turn writes, `idle`,
             * and a session that had died of an exhausted balance was published
             * as one sitting quietly waiting for you.
             *
             * So a failure reads on, briefly, for the verdict. The bound is
             * there because "read until something arrives" is how a follow
             * hangs forever on a stream that has stopped talking.
             */
            if (event.type === "turn.completed") break;
            verdictTimer ??= setTimeout(() => verdict.abort(), VERDICT_MS);
            continue;
          }
          continue;
        }

        // `session.waiting` and `session.failed` name no turn, so they are read
        // as this turn's only once this turn exists. A session waiting before
        // ours began is the one it was already waiting in.
        if (
          event.type === "session.waiting" ||
          event.type === "session.failed"
        ) {
          if (ours) break;
          continue;
        }

      }
    } catch (error) {
      // A dropped stream is not a failed turn, but it does mean this process
      // cannot report on one — so it is said out loud and the answer, if any
      // arrived before the drop, is still sent.
      // An abort this method armed itself is the deadline doing its job, not a
      // stream that broke.
      if (!verdict.signal.aborted)
        this.log(
          `[hex] the stream for ${short(who)} ended early: ${message(error)}`,
        );
    } finally {
      if (verdictTimer) clearTimeout(verdictTimer);
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

  /**
   * Open a session, with whatever the runtime should know before it reads the
   * message.
   *
   * `clientContext` is Eve's own door for this: entries arrive as context
   * messages ahead of the user's, which is where "who is talking to you" and
   * "here is the thing they pointed at" belong. Not the system prompt — that
   * lives on the Eve side and is not hex's to write — and deliberately not
   * prepended to the message itself, which titled every run after the
   * boilerplate and put words in the operator's mouth.
   */
  private async createSession(
    text: string,
    clientContext?: string[],
  ): Promise<string> {
    const response = await this.post("/eve/v1/session", {
      message: text,
      ...(clientContext?.length ? { clientContext } : {}),
    });
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
