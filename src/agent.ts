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
    sessionId: string,
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

export function runAgent(options: AgentOptions): RunningAgent {
  const log = options.log ?? ((line: string) => console.log(line));
  const subscriptions = new Subscription();
  const inFlight = new Set<Promise<void>>();

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
    if (!verdict.reply) {
      // Not noise worth a line at normal volume, except the ones that mean
      // something is wrong with the configuration rather than the message.
      if (verdict.reason === "rate-limited" || verdict.reason === "in-flight")
        log(`[hex] ${where}: skipped (${verdict.reason})`);
      return;
    }

    options.gate.begin(inbound);
    let published = false;

    try {
      log(`[hex] ${where}: answering ${inbound.id.slice(0, 8)}…`);

      // The ack goes out BEFORE the model is asked, because its whole job is to
      // cover the seconds the model takes. A failed ack is not a failed answer.
      const ack = options.ackEmoji ?? ACK_EMOJI;
      if (!options.dryRun && ack && transport.react) {
        try {
          await transport.react(inbound, ack);
        } catch (error) {
          log(
            `[hex] ${where}: could not acknowledge — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const history = await options.context.history(
        transport,
        inbound,
        session?.id,
      );

      // Decided per message: a channel granted nothing gets the read tools and
      // nothing that runs.
      const granted = options.capabilities?.(inbound, session?.id ?? where);

      // The brain's only way to be heard. Bound to this message, in this room,
      // on the transport that delivered it — so nothing the model returns is
      // published, and what IS published is a fact about the transport rather
      // than a claim by the model.
      const tools = new RoomTools({
        transport,
        incoming: inbound,
        dryRun: options.dryRun,
        log,
        maxResponses: options.maxResponsesPerTurn,
        knowledge: options.knowledge,
        repo: granted?.repo,
        grants: granted?.grants,
      });

      const outcome = await options.brain.turn({
        instructions: options.instructions,
        history,
        incoming: inbound,
        tools,
      });

      published = tools.delivered;
      for (const id of tools.deliveredIds) {
        // Hex's own message comes straight back through the same subscription.
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

      log(
        published
          ? `[hex] ${where}: answered${outcome.note ? ` — ${outcome.note}` : ""}`
          : `[hex] ${where}: said nothing${outcome.note ? ` — ${outcome.note}` : ""}`,
      );
    } catch (error) {
      // Loud, and specifically not silence: a broken key or a refusing relay
      // must not look like a bot with nothing to add.
      log(
        `[hex] ${where}: FAILED — ${
          error instanceof Error ? error.message : String(error)
        }`,
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
