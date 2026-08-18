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

      const history = await options.context.history(transport, inbound);
      const answer = await options.brain.respond({
        instructions: options.instructions,
        history,
        incoming: inbound,
      });

      if (answer === null) {
        // A real answer: the brain chose to stay out of it.
        log(`[hex] ${where}: stayed quiet`);
        return;
      }

      if (options.dryRun) {
        log(`[hex] ${where}: would reply — ${answer}`);
        return;
      }

      const id = await transport.reply(inbound, answer);
      // Hex's own message comes straight back through the same subscription.
      options.gate.remember(id);
      published = true;
      log(`[hex] ${where}: replied ${id.slice(0, 8)}…`);
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
