/**
 * The loop: a message arrives, the gate decides, the brain answers, the room
 * hears it.
 *
 * Everything that can go wrong here goes wrong quietly, so every branch is
 * logged: a refusal says which rule refused, a brain failure says so instead of
 * looking like a considered silence, and a reply that could not be published is
 * never counted against the rate limit.
 */

import { Subscription } from "rxjs";
import type { Brain } from "./brain/types.js";
import type { RoomContext } from "./context.js";
import { ReplyGate } from "./policy.js";
import { roomKey, type Inbound, type Transport } from "./transports/types.js";
import { RoomTools } from "./tools/room-tools.js";
import { EXEC_TOOL } from "./tools/types.js";
import type { KnowledgeTools } from "./tools/knowledge.js";
import type { RepoTools } from "./tools/repo-tools.js";
import type { SessionTracker } from "./sessions.js";

/** What Hex reacts with while it is working on an answer. */
export const ACK_EMOJI = "👀";

export interface AgentOptions {
  transports: Transport[];
  gate: ReplyGate;
  brain: Brain;
  context: RoomContext;
  instructions: string;
  /** Log the answer instead of publishing it. The ack is skipped too. */
  dryRun?: boolean;
  /** Cap on deliveries in one turn. */
  maxResponsesPerTurn?: number;
  /** The read tools — NIPs, kinds, REQs. Offered alongside speaking. */
  knowledge?: KnowledgeTools;
  /**
   * Conversations that outlive the process.
   *
   * Without it the agent works and forgets everything on restart; with it, a
   * follow-up lands in the exchange it belongs to.
   */
  sessions?: SessionTracker;
  /**
   * What this channel may do, decided per message.
   *
   * A function rather than a field because the answer differs by room and by
   * who is speaking: one DM gets the coding tools, a relay group gets the read
   * tools, and neither is a property of the process. Returning nothing is the
   * safe default — everything composed in, and no execution.
   */
  capabilities?: (
    inbound: Inbound,
    /** The room key: what a workspace is keyed by, and it outlives a session. */
    workspace: string,
  ) => { grants?: string[]; repo?: RepoTools };
  /** Emoji for the "working on it" reaction. Empty string disables the ack. */
  ackEmoji?: string;
  log?: (line: string) => void;
}

export interface RunningAgent {
  stop(): void;
  /** Resolves once every reply in flight has finished. For tests. */
  idle(): Promise<void>;
}

/** Whatever was thrown, as a line for the log. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whatever is happening in a room right now, and the handle to stop it.
 *
 * One per room at every instant — it may be a turn, or an interrupt that is
 * still stopping one. `tools` is absent for the second case, and that absence is
 * load-bearing: only an abandoned TURN gets a stop notice, so an interrupt that
 * replaced another interrupt does not report the same turn twice.
 */
interface TurnHandle {
  inbound: Inbound;
  controller: AbortController;
  /** Resolves once this occupant is finished and the room is free again. */
  done: Promise<void>;
  tools?: RoomTools;
}

/**
 * What a cancelled turn had got through, in words.
 *
 * Refusals are skipped. The activity log records every call including ones the
 * host turned down — a `respond` refused by the abort guard, for instance — and
 * saying "killed mid-run" about a call that never ran undermines the one claim
 * this notice exists to make.
 */
function describeWork(activity: { name: string; detail?: string }[]): string {
  const real = activity.filter((call) => !call.name.startsWith("chat."));
  const last = real[real.length - 1];
  if (!last) return "I had not started anything yet.";
  const what = `\`${last.name}${last.detail ? `: ${last.detail}` : ""}\``;
  const count = `${real.length} tool call${real.length === 1 ? "" : "s"}`;
  return last.name === EXEC_TOOL
    ? `I got through ${count} — the last was ${what}, killed mid-run.`
    : `I got through ${count} — the last was ${what}.`;
}

/** What Hex reacts with when someone stops it mid-task. */
export const STOP_EMOJI = "🛑";

/**
 * How long to wait quietly for a cancelled turn to let go of its room.
 *
 * Not a deadline — there is no give-up path, because giving up would leave the
 * interrupting message unanswered, which is the failure this whole mechanism
 * exists to prevent. It only decides when to say "still stopping".
 */
const SLOW_STOP_MS = 15_000;

export function runAgent(options: AgentOptions): RunningAgent {
  const log = options.log ?? ((line: string) => console.log(line));
  const subscriptions = new Subscription();
  const inFlight = new Set<Promise<void>>();
  /** Room key -> the turn running in it. */
  const turns = new Map<string, TurnHandle>();

  const handle = async (inbound: Inbound, transport: Transport) => {
    const where = roomKey(inbound.room);
    // Recorded whatever the verdict: the next answer needs the conversation,
    // including the parts nobody addressed to Hex.
    options.context.record(inbound);

    // Resolved before the gate: which conversation this belongs to is answered
    // from the session store, and that survives a restart.
    const session = options.sessions?.resolve(inbound);
    if (session && options.sessions)
      options.sessions.record(session.id, {
        id: inbound.id,
        room: where,
        author: inbound.author,
        text: inbound.text,
        at: inbound.createdAt,
        replyToId: inbound.replyToId,
      });

    const verdict = options.gate.consider(inbound);
    if (verdict.reply) {
      await occupy(inbound, transport, session, undefined);
      return;
    }

    // The one verdict that asks for action rather than silence.
    if (verdict.reason === "interrupt") {
      await occupy(inbound, transport, session, turns.get(where));
      return;
    }

    // Not noise worth a line at normal volume, except the ones that mean
    // something is wrong with the configuration rather than the message.
    if (verdict.reason === "rate-limited" || verdict.reason === "in-flight")
      log(`[hex] ${where}: skipped (${verdict.reason})`);
  };

  /**
   * Take the room, and hold it until this message is finished with.
   *
   * One occupant per room at every instant, and the handover is synchronous:
   * the claim moves to the new message before anything is awaited. That is the
   * whole correctness argument. Waiting for the old turn first — as this used to
   * — released the claim while the stop notice was still publishing, and a
   * message arriving in that window got a turn of its own which the pending
   * interrupt then killed. The oldest instruction won and the newest was thrown
   * away, which is the failure this mechanism exists to prevent.
   *
   * `previous` is whatever was in the room. It may be a running turn, or it may
   * be another interrupt still stopping one — in which case the newest
   * instruction wins and the one it replaced is left in the conversation for the
   * turn that follows to read.
   */
  const occupy = async (
    inbound: Inbound,
    transport: Transport,
    session: { id: string; isNew: boolean } | undefined,
    previous: TurnHandle | undefined,
  ) => {
    const where = roomKey(inbound.room);
    const controller = new AbortController();
    const entry: TurnHandle = {
      inbound,
      controller,
      // Replaced immediately below; the field exists so the entry can be
      // registered before anything awaits it.
      done: Promise.resolve(),
    };

    // Synchronous, both of them, before any await: this is the handover.
    options.gate.begin(inbound);
    turns.set(where, entry);

    const work = (async () => {
      if (previous) {
        log(
          `[hex] ${where}: interrupted by ${inbound.id.slice(0, 8)}… — stopping ${previous.inbound.id.slice(0, 8)}…`,
        );
        previous.controller.abort(new Error("interrupted"));

        if (!options.dryRun && transport.react)
          try {
            await transport.react(inbound, STOP_EMOJI);
          } catch (error) {
            log(`[hex] ${where}: could not acknowledge — ${describe(error)}`);
          }

        let slow = false;
        await Promise.race([
          previous.done,
          new Promise<void>((wake) =>
            setTimeout(() => {
              slow = true;
              wake();
            }, SLOW_STOP_MS),
          ),
        ]);
        if (slow) {
          log(`[hex] ${where}: still stopping`);
          await previous.done;
        }

        // Only a real turn gets a notice. An interrupt that replaced another
        // interrupt has nothing of its own to report, and announcing per
        // interrupt rather than per abandoned turn is how the same turn came to
        // be reported twice.
        if (previous.tools)
          await announceStop(inbound, transport, session, previous);
      }

      // Superseded while we were stopping the last one: a newer message has
      // taken the room, and it is the instruction that should run.
      if (controller.signal.aborted) {
        log(`[hex] ${where}: superseded before it started`);
        return;
      }

      await runTurn(inbound, transport, session, entry, previous !== undefined);
    })();

    entry.done = work;
    try {
      await work;
    } finally {
      // Only the occupant releases the room, and only if it is still the
      // occupant — a turn that was taken over must not free its successor's
      // claim.
      if (turns.get(where) === entry) turns.delete(where);
    }
  };

  /**
   * Say what was abandoned, and that the work on disk survived.
   *
   * Assembled here rather than asked of the model: it is a promise about the
   * state of a git worktree, and a model that guessed wrong about that would be
   * lying about the one thing the person needs to trust.
   */
  const announceStop = async (
    inbound: Inbound,
    transport: Transport,
    session: { id: string; isNew: boolean } | undefined,
    previous: TurnHandle,
  ) => {
    const where = roomKey(inbound.room);
    const did = describeWork(previous.tools?.activity ?? []);
    const text = `${STOP_EMOJI} Stopped. ${did} Anything already written or committed is still there — nothing was rolled back.`;

    if (options.dryRun) {
      log(`[hex] ${where}: would say: ${text}`);
      return;
    }

    try {
      const id = await transport.reply(previous.inbound, text);
      // Remembered or Hex answers its own notice; recorded or the steering turn
      // has no idea what it abandoned.
      options.gate.remember(id);
      if (session && options.sessions)
        options.sessions.recordOwn(session.id, {
          id,
          room: where,
          author: "",
          text,
          at: Math.floor(Date.now() / 1000),
          replyToId: previous.inbound.id,
        });
    } catch (error) {
      log(`[hex] ${where}: could not say it stopped — ${describe(error)}`);
    }
  };

  const runTurn = async (
    inbound: Inbound,
    transport: Transport,
    session: { id: string; isNew: boolean } | undefined,
    entry: TurnHandle,
    steered: boolean,
  ) => {
    const where = roomKey(inbound.room);
    let published = false;
    const controller = entry.controller;

    try {
      log(
        `[hex] ${where}: ${steered ? "picking up" : "answering"} ${inbound.id.slice(0, 8)}…`,
      );

      // Built inside the try, so a throw here still releases the room. It used
      // to sit outside it, where a throw left the claim held by a turn that no
      // longer existed and every later message in that room deadlocked.
      const tools = new RoomTools({
        transport,
        incoming: inbound,
        dryRun: options.dryRun,
        log,
        maxResponses: options.maxResponsesPerTurn,
        knowledge: options.knowledge,
        signal: controller.signal,
        ...(options.capabilities?.(inbound, where) ?? {}),
      });
      // Visible to whoever cancels this turn, so the notice can say what was
      // actually being attempted.
      entry.tools = tools;

      // The ack goes out BEFORE the model is asked, because its whole job is to
      // cover the seconds the model takes. Skipped when steering: the 🛑 already
      // went out, and two reactions on two messages is noise.
      const ack = options.ackEmoji ?? ACK_EMOJI;
      if (!steered && !options.dryRun && ack && transport.react) {
        try {
          await transport.react(inbound, ack);
        } catch (error) {
          log(`[hex] ${where}: could not acknowledge — ${describe(error)}`);
        }
      }

      const history = await options.context.history(
        transport,
        inbound,
        session?.id,
      );

      const outcome = await options.brain.turn({
        instructions: options.instructions,
        history,
        incoming: inbound,
        tools,
        signal: controller.signal,
      });

      published = tools.delivered;
      for (const id of tools.deliveredIds) {
        // Published before the abort is still published: a real event, and it
        // must be remembered whether or not the turn was cut short.
        options.gate.remember(id);
        // And into the session, so a reply to it — today or after a restart —
        // continues this conversation instead of opening a new one.
        if (session && options.sessions)
          options.sessions.recordOwn(session.id, {
            id,
            room: where,
            author: "",
            text: tools.deliveredText.get(id) ?? "",
            at: Math.floor(Date.now() / 1000),
            replyToId: inbound.id,
          });
      }

      const note = outcome.note ? ` — ${outcome.note}` : "";
      log(
        controller.signal.aborted
          ? `[hex] ${where}: cancelled${note}`
          : published
            ? `[hex] ${where}: answered${note}`
            : `[hex] ${where}: said nothing${note}`,
      );
    } catch (error) {
      // A cancel is not a failure. Keeping them apart is what lets FAILED keep
      // meaning "something is actually wrong".
      log(
        controller.signal.aborted
          ? `[hex] ${where}: cancelled mid-flight`
          : `[hex] ${where}: FAILED — ${describe(error)}`,
      );
    } finally {
      // `published` false leaves the rate limit unspent, which is the point:
      // a turn that produced nothing did not use the room's budget.
      options.gate.end(inbound, published);
    }
  };

  for (const transport of options.transports) {
    subscriptions.add(
      transport.start().subscribe({
        next: (inbound) => {
          // Tracked so a caller can wait for quiet; the loop itself never awaits
          // one turn before starting the next, or a slow model would block every
          // other room.
          const task = handle(inbound, transport).finally(() => {
            inFlight.delete(task);
          });
          inFlight.add(task);
        },
        error: (error: unknown) =>
          log(
            `[hex] ${transport.name} stream error — ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      }),
    );
  }

  return {
    stop: () => {
      subscriptions.unsubscribe();
      for (const transport of options.transports) transport.stop();
    },
    idle: async () => {
      // Replies can queue more work, so drain until the set stays empty.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
