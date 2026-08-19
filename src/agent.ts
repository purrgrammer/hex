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

/** A turn that is running right now, and the handle to stop it. */
interface TurnHandle {
  inbound: Inbound;
  controller: AbortController;
  /** Resolves once the turn's `finally` has run and the room is released. */
  done: Promise<void>;
  /** Live, so whoever cancels can say what was actually being attempted. */
  tools: RoomTools;
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
      await runTurn(inbound, transport, session);
      return;
    }

    // The one verdict that asks for action rather than silence.
    if (verdict.reason === "interrupt") {
      await interrupt(inbound, transport, session);
      return;
    }

    // Not noise worth a line at normal volume, except the ones that mean
    // something is wrong with the configuration rather than the message.
    if (verdict.reason === "rate-limited" || verdict.reason === "in-flight")
      log(`[hex] ${where}: skipped (${verdict.reason})`);
  };

  /**
   * Someone said "not that — this".
   *
   * Order matters and each step earns its place: the 🛑 goes out first because
   * its job is to cover the kill; the notice goes out only once the room is
   * genuinely free, so it can say truthfully what stopped; and the notice is
   * remembered and recorded before the steering turn starts, because that record
   * IS the steering context — the next turn reads it as its own prior message.
   */
  const interrupt = async (
    inbound: Inbound,
    transport: Transport,
    session: { id: string; isNew: boolean } | undefined,
  ) => {
    const where = roomKey(inbound.room);
    const live = turns.get(where);

    if (live) {
      log(
        `[hex] ${where}: interrupted by ${inbound.id.slice(0, 8)}… — stopping ${live.inbound.id.slice(0, 8)}…`,
      );
      live.controller.abort(new Error("interrupted"));

      if (!options.dryRun && transport.react)
        try {
          await transport.react(inbound, STOP_EMOJI);
        } catch (error) {
          log(`[hex] ${where}: could not acknowledge — ${describe(error)}`);
        }

      let slow = false;
      await Promise.race([
        live.done,
        new Promise<void>((wake) =>
          setTimeout(() => {
            slow = true;
            wake();
          }, SLOW_STOP_MS),
        ),
      ]);
      if (slow) {
        log(`[hex] ${where}: still stopping`);
        await live.done;
      }

      await announceStop(inbound, transport, session, live);
    }

    // Admitted without going back through `consider` — its id is in `seen` and
    // must stay there. If the room was claimed again while we stopped, the newest
    // instruction wins and this message becomes the interrupter.
    const admit = options.gate.steer(inbound);
    if (admit.reply) {
      await runTurn(inbound, transport, session, true);
      return;
    }
    await interrupt(inbound, transport, session);
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
    live: TurnHandle,
  ) => {
    const where = roomKey(inbound.room);
    const calls = live.tools.activity;
    const last = calls[calls.length - 1];
    const did = last
      ? `I got through ${calls.length} tool call${calls.length === 1 ? "" : "s"} — the last was \`${last.name}${last.detail ? `: ${last.detail}` : ""}\`, killed mid-run.`
      : "I had not run anything yet.";
    const text = `${STOP_EMOJI} Stopped. ${did} Anything already written or committed is still there — nothing was rolled back.`;

    if (options.dryRun) {
      log(`[hex] ${where}: would say: ${text}`);
      return;
    }

    try {
      const id = await transport.reply(live.inbound, text);
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
          replyToId: live.inbound.id,
        });
    } catch (error) {
      log(`[hex] ${where}: could not say it stopped — ${describe(error)}`);
    }
  };

  const runTurn = async (
    inbound: Inbound,
    transport: Transport,
    session: { id: string; isNew: boolean } | undefined,
    steered = false,
  ) => {
    const where = roomKey(inbound.room);
    options.gate.begin(inbound);
    let published = false;

    const controller = new AbortController();
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

    const turn = (async () => {
      try {
        log(
          `[hex] ${where}: ${steered ? "picking up" : "answering"} ${inbound.id.slice(0, 8)}…`,
        );

        // The ack goes out BEFORE the model is asked, because its whole job is
        // to cover the seconds the model takes. Skipped when steering: the 🛑
        // already went out, and two reactions on two messages is noise.
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
        turns.delete(where);
        // `published` false leaves the rate limit unspent, which is the point:
        // a turn that produced nothing did not use the room's budget.
        options.gate.end(inbound, published);
      }
    })();

    // Registered before the first await inside the turn, so an interrupt that
    // arrives while the ack is in flight still finds a handle to stop.
    turns.set(where, { inbound, controller, done: turn, tools });
    await turn;
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
