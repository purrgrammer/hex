/**
 * The tools a room offers, bound to one inbound message.
 *
 * Built fresh per turn, because every call is scoped to the message that
 * prompted it: `respond` answers THAT message, in THAT room, via the transport
 * that delivered it. A runtime holding a stale host cannot reach a different room.
 *
 * `dryRun` swaps the delivery for a log line and nothing else changes — the caller
 * still calls the same tool and still learns whether it "worked", so a dry run
 * exercises the real path.
 */

import type { Inbound, Transport } from "../transports/types.js";
import type { KnowledgeTools } from "./knowledge.js";
import {
  canonicalId,
  filterTools,
  REACT_TOOL,
  RESPOND_TOOL,
  type ToolCall,
  type ToolHost,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

/**
 * All a room's tools need of a transport: speak, and maybe react.
 *
 * Narrower than `Transport` on purpose. The bridge binds these tools to whatever
 * is answering a message — a full transport under `serve`, a two-method shim in a
 * test — and requiring `start`/`history`/`stop` here would mean a runtime seam
 * that only one implementation can pass through.
 */
export type RoomToolsTransport = Pick<Transport, "reply"> & {
  react?: Transport["react"];
};

export interface RoomToolsOptions {
  transport: RoomToolsTransport;
  incoming: Inbound;
  /** Log instead of publishing. */
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Cap on deliveries in one turn, so a confused model cannot flood a room. */
  maxResponses?: number;
  /**
   * The read tools — NIPs, kinds, REQs, bech32.
   *
   * Composed in rather than built here: they belong to no room. Optional, so a
   * room can be served without them.
   */
  knowledge?: KnowledgeTools;
  /**
   * Which tools this channel gets, as ids or `namespace.*`.
   *
   * `chat.*` is exempt — a channel Hex listens to must be one it can answer in.
   * Undefined means everything composed in is offered, which is what a channel
   * that names no grants gets.
   */
  grants?: string[];
  /**
   * The turn was abandoned.
   *
   * Speaking is refused once it fires: a reply that lands after the cancel
   * notice answers a question the person already withdrew.
   */
  signal?: AbortSignal;
}

/**
 * One answer per turn by default.
 *
 * A model that calls `respond` three times has misunderstood, and a room is worse
 * off for hearing all three. The cap is refused loudly so the caller can read the
 * refusal and stop rather than retry.
 */
const DEFAULT_MAX_RESPONSES = 1;

/** The one detail worth keeping per call, for the cancel notice. */
function describeCall(args: Record<string, unknown>): string | undefined {
  const field = args.command ?? args.path;
  if (typeof field !== "string") return undefined;
  return field.length > 120 ? `${field.slice(0, 120)}…` : field;
}

export class RoomTools implements ToolHost {
  private responses = 0;
  private didDeliver = false;
  /** Ids of what actually landed, so the caller can recognise its own events. */
  readonly deliveredIds: string[] = [];
  /** What was said under each id, for the conversation record. */
  readonly deliveredText = new Map<string, string>();
  /**
   * What this turn tried, in order.
   *
   * Read by whoever cancels the turn, so the notice can say what was actually
   * happening rather than asking a model to remember.
   */
  readonly activity: { name: string; detail?: string }[] = [];

  constructor(private readonly options: RoomToolsOptions) {}

  get room() {
    return this.options.incoming.room;
  }

  get requestedBy() {
    return this.options.incoming.author;
  }

  get delivered() {
    return this.didDeliver;
  }

  list(): ToolSpec[] {
    const specs: ToolSpec[] = [
      {
        name: RESPOND_TOOL,
        description:
          "Say something in the room, as a reply to the message you were given. This is the only way to be heard; anything you write outside this tool is private thinking.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "What to say. Plain text, as a chat message.",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
        prompt:
          "`chat.respond` is how you speak: call it once with what you want to" +
          " say, and nothing else you write is heard.",
      },
    ];

    // Only offered when the transport can actually do it.
    if (this.options.transport.react)
      specs.push({
        name: REACT_TOOL,
        description:
          "React to the message with a single emoji, instead of or before replying.",
        parameters: {
          type: "object",
          properties: {
            emoji: { type: "string", description: "One emoji." },
          },
          required: ["emoji"],
          additionalProperties: false,
        },
        prompt:
          "`chat.react` puts a single emoji on the message — an acknowledgement," +
          " not an answer.",
      });

    // Whatever else the runtime can do, offered alongside speaking — and only
    // what this channel was granted. Speaking itself is never filtered.
    const optional: ToolSpec[] = [];
    if (this.options.knowledge) optional.push(...this.options.knowledge.list());

    specs.push(
      ...(this.options.grants
        ? filterTools(optional, this.options.grants)
        : optional),
    );

    return specs;
  }

  async call(call: ToolCall): Promise<ToolResult> {
    // A model may call by wire name (`chat_respond`) or by canonical id; the
    // prompt says the id, and losing a round trip to punctuation is silly.
    const offered = this.list();
    const name = canonicalId(call.name, offered);

    // Offered and callable are the same set. `list()` is what a well-behaved
    // model reads, but a call is what actually happens, and a model that names
    // a tool it was never shown must not reach the thing behind it.
    if (!offered.some((spec) => spec.name === name))
      return {
        ok: false,
        output: `there is no tool called "${call.name}". Available: ${offered
          .map((spec) => spec.name)
          .join(", ")}`,
      };

    this.activity.push({ name, detail: describeCall(call.arguments) });

    if (this.options.knowledge?.handles(name))
      return this.options.knowledge.call(name, call.arguments);

    switch (name) {
      case RESPOND_TOOL:
        return this.respond(call.arguments);
      case REACT_TOOL:
        return this.react(call.arguments);
      default:
        // Named back, because a model that guessed a tool name can correct itself.
        return {
          ok: false,
          output: `there is no tool called "${call.name}". Available: ${this.list()
            .map((spec) => spec.name)
            .join(", ")}`,
        };
    }
  }

  private async respond(args: Record<string, unknown>): Promise<ToolResult> {
    // Checked before the transport, not after: a reply that lands once the
    // cancel notice has gone out answers a question already withdrawn.
    if (this.options.signal?.aborted)
      return { ok: false, output: "cancelled — nothing was sent" };

    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text)
      return {
        ok: false,
        output: "respond needs a non-empty `text`; nothing was sent",
      };

    const cap = this.options.maxResponses ?? DEFAULT_MAX_RESPONSES;
    if (this.responses >= cap)
      return {
        ok: false,
        output: `you have already answered this message ${this.responses} time(s); stop here`,
      };

    if (this.options.dryRun) {
      this.responses += 1;
      this.didDeliver = true;
      this.options.log?.(`[hex] would say: ${text}`);
      return {
        ok: true,
        output: "delivered (dry run — nothing was published)",
      };
    }

    try {
      const id = await this.options.transport.reply(
        this.options.incoming,
        text,
      );
      this.responses += 1;
      this.didDeliver = true;
      this.deliveredIds.push(id);
      this.deliveredText.set(id, text);
      return { ok: true, output: `delivered as ${id}` };
    } catch (error) {
      // The caller is told the truth: it was not heard. Whether it tries again is
      // its business, and the per-turn cap bounds that either way.
      return {
        ok: false,
        output: `not delivered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private async react(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.options.signal?.aborted)
      return { ok: false, output: "cancelled — nothing was sent" };

    const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
    if (!emoji) return { ok: false, output: "react needs a non-empty `emoji`" };
    if (!this.options.transport.react)
      return { ok: false, output: "this room has no reactions" };

    if (this.options.dryRun) {
      this.options.log?.(`[hex] would react: ${emoji}`);
      return { ok: true, output: "reacted (dry run — nothing was published)" };
    }

    try {
      const id = await this.options.transport.react(
        this.options.incoming,
        emoji,
      );
      // A reaction is not an answer: it does not count as having spoken, and does
      // not spend the room's reply budget.
      return { ok: true, output: `reacted as ${id}` };
    } catch (error) {
      return {
        ok: false,
        output: `not reacted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}
