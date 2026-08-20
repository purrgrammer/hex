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
import type { PublishTools } from "./publish.js";
import type { BlossomTools } from "./blossom-tools.js";
import type { GitTools } from "./git-tools.js";
import { nip19 } from "nostr-tools";

import {
  canonicalId,
  filterTools,
  HISTORY_TOOL,
  REACT_TOOL,
  RESPOND_TOOL,
  WHO_TOOL,
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
  history?: Transport["history"];
};

/**
 * What a chat tool says when there is no conversation behind it.
 *
 * A run started over the control plane has no room, so these tools are not
 * offered; this is the answer if one is somehow reached anyway.
 */
/**
 * The tools that exist only where there is somewhere to speak.
 *
 * Named as a set so a call to one of them without a room can be answered with
 * the reason rather than with "no such tool".
 */
const KNOWN_ROOM_TOOLS = new Set([
  RESPOND_TOOL,
  REACT_TOOL,
  WHO_TOOL,
  HISTORY_TOOL,
]);

const NO_ROOM =
  "this session has no room — it was started over the control plane, and its " +
  "transcript is how it is read. There is nobody to reply to. Say what you " +
  "would have said as your answer; it is already being published. Do not " +
  "repeat work you have finished in order to find another way to report it.";

export interface RoomToolsOptions {
  transport: RoomToolsTransport;
  /**
   * The message being answered, when one is.
   *
   * Absent for a run the control plane started: there is no room, nobody said
   * anything, and there is nothing to reply to. The tool catalogue is built
   * from this — with no message, `chat.*` is not offered at all, because a
   * `chat.respond` with nowhere to go is a tool whose every call fails.
   */
  incoming?: Inbound;
  /** Log instead of publishing. */
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Cap on deliveries in one turn, so a confused model cannot flood a room. */
  maxResponses?: number;
  /** Who the run is for, when no message names them. Control-plane runs only. */
  requestedBy?: string;
  /**
   * Hex's own pubkey, so history can say which half it wrote.
   *
   * Optional: a host built without it still reads the thread, and simply does
   * not label the sides.
   */
  selfPubkey?: string;
  /**
   * The read tools — NIPs, kinds, REQs, bech32.
   *
   * Composed in rather than built here: they belong to no room. Optional, so a
   * room can be served without them.
   */
  knowledge?: KnowledgeTools;
  /**
   * The write tools — signing and publishing as the agent.
   *
   * Absent by default and absent for good: an agent that can only read cannot
   * embarrass its operator in public. Composed in exactly like the read tools,
   * and subject to the same grants.
   */
  publish?: PublishTools;
  /**
   * Uploading a file. Off unless the operator configured a host.
   *
   * Built per-message rather than shared, because whether to encrypt is a
   * property of the ROOM: a DM's attachment is encrypted so the sealed
   * conversation stays sealed, and a public group's is not, because encrypting
   * it hides the picture from everyone it was posted for.
   */
  blossom?: BlossomTools;
  /**
   * A NIP-34 repository's issues and patches. Off unless configured.
   *
   * Shared rather than per-message: what it reads is a public repository, and
   * which room asked has no bearing on the answer.
   */
  git?: GitTools;
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

/** How far back the conversation is read when the model names no number. */
const DEFAULT_HISTORY = 20;
/** Hard bound: the result is fed back as JSON and has to fit in a context. */
const MAX_HISTORY = 100;
/** Per message, so one essay cannot crowd out the shape of the exchange. */
const MAX_HISTORY_CHARS = 1_000;

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
    return this.options.incoming?.room;
  }

  get requestedBy() {
    return this.options.incoming?.author ?? this.options.requestedBy ?? "";
  }

  get delivered() {
    return this.didDeliver;
  }

  /**
   * The message a chat tool acts on, or the reason there is none.
   *
   * Unreachable in practice — `call()` refuses anything `list()` did not offer,
   * and with no message `list()` offers no `chat.*` at all. It exists so the
   * absence is handled in one place rather than asserted away at five call
   * sites, and so a future caller that binds the tools differently gets a
   * sentence instead of a crash.
   */
  private get conversation(): Inbound | undefined {
    return this.options.incoming;
  }

  list(): ToolSpec[] {
    /**
     * The catalogue depends on the channel, not on what this class can do.
     *
     * With no message there is no room, no thread and nobody to answer, so
     * every `chat.*` tool is a call that can only come back "this session has
     * no room bound to it". Offering it anyway spends a round trip teaching the
     * model that, and a model that has been handed a speaking tool will use
     * it — the answer then goes nowhere and the run looks like it said nothing.
     */
    const specs: ToolSpec[] = this.options.incoming ? this.chatTools() : [];

    // Whatever else the runtime can do — the same set either way, because
    // reading relays and publishing do not need a room.
    const optional: ToolSpec[] = [];
    if (this.options.knowledge) optional.push(...this.options.knowledge.list());
    if (this.options.publish) optional.push(...this.options.publish.list());
    if (this.options.blossom) optional.push(...this.options.blossom.list());
    if (this.options.git) optional.push(...this.options.git.list());

    specs.push(
      ...(this.options.grants
        ? filterTools(optional, this.options.grants)
        : optional),
    );

    return specs;
  }

  /** Speaking, reacting, and reading the thread. Only with a room to do it in. */
  private chatTools(): ToolSpec[] {
    const specs: ToolSpec[] = [
      {
        name: RESPOND_TOOL,
        description:
          "Say something in the room, as a reply to the message you were given. " +
          "This is the only way to be heard; anything you write outside this tool " +
          "is private thinking. PLAIN TEXT ONLY — no markdown. A chat message is " +
          "not a document: asterisks, backticks and heading marks arrive as " +
          "literal characters in most Nostr clients.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "What to say, as a chat message. Plain text: no markdown, no " +
                "bold, no bullet characters, no code fences. Use line breaks " +
                "and ordinary sentences, and `nostr:` bech32 entities to refer " +
                "to people and events.",
            },
            imeta: {
              type: "array",
              items: { type: "string" },
              description:
                "The `imeta` tag from blossom.upload, when your message links " +
                "an uploaded file. Without it an encrypted attachment is a " +
                "link to bytes the reader cannot open.",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
        prompt:
          "`chat.respond` is how you speak: call it once with what you want to" +
          " say, in PLAIN TEXT with no markdown, and nothing else you write is" +
          " heard.",
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

    /**
     * `chat.who` is gone, and the answer is in the prompt instead.
     *
     * A runtime handed a bare message has no idea whose it is, which sent it
     * hunting kind 1 across the whole network for "my recent posts". A tool was
     * the wrong shape of fix: it cost a round trip, the model had to know to
     * reach for it, and it did not reach for it. Who is asking is CONTEXT — it
     * is true before the first token — so it is a block in the prompt now,
     * alongside the agent's own identity and what the run is about. The id
     * stays in `KNOWN_TOOLS` so a config that still grants it parses.
     */

    // Only when the transport can actually read back. A protocol with no
    // history simply does not offer one, rather than offering an empty list a
    // model would read as "nothing was said".
    if (this.options.transport.history)
      specs.push({
        name: HISTORY_TOOL,
        description:
          "What was said in this conversation before now, oldest first, " +
          "including your own past replies. Read it before answering anything " +
          "that refers to earlier — you are given one message, not the thread.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: `How many messages back. Defaults to ${DEFAULT_HISTORY}, hard bound ${MAX_HISTORY}.`,
            },
          },
          additionalProperties: false,
        },
        prompt:
          "`chat.history` is the conversation so far, your own replies" +
          ' included. Anything that refers to earlier — "as I said", "that' +
          ' one", a pronoun with no antecedent — is a reason to read it rather' +
          " than to guess.",
      });

    /**
     * Granted or not, but never filtered away entirely.
     *
     * Speaking is what a room is FOR: a channel whose grants forgot
     * `chat.respond` would run turns nobody could hear.
     */
    return this.options.grants
      ? [
          ...specs.filter((spec) => spec.name === RESPOND_TOOL),
          ...filterTools(
            specs.filter((spec) => spec.name !== RESPOND_TOOL),
            this.options.grants,
          ),
        ]
      : specs;
  }

  async call(call: ToolCall): Promise<ToolResult> {
    // A model may call by wire name (`chat_respond`) or by canonical id; the
    // prompt says the id, and losing a round trip to punctuation is silly.
    const offered = this.list();
    const name = canonicalId(call.name, offered);

    // Offered and callable are the same set. `list()` is what a well-behaved
    // model reads, but a call is what actually happens, and a model that names
    // a tool it was never shown must not reach the thing behind it.
    if (!offered.some((spec) => spec.name === name)) {
      /**
       * A chat tool that is missing because there is no room says WHY.
       *
       * "There is no tool called chat_respond" reads to a model like a typo,
       * and a model that has just finished a long piece of work and cannot
       * report it does the work again looking for another way out. Seen live:
       * the same patch published twice, ninety-nine seconds apart, with two of
       * these refusals in between.
       *
       * The honest answer is not that the tool does not exist. It is that this
       * run has nowhere to speak and does not need one.
       */
      if (!this.conversation && KNOWN_ROOM_TOOLS.has(name))
        return { ok: false, output: NO_ROOM };
      return {
        ok: false,
        output: `there is no tool called "${call.name}". Available: ${offered
          .map((spec) => spec.name)
          .join(", ")}`,
      };
    }

    this.activity.push({ name, detail: describeCall(call.arguments) });

    if (this.options.knowledge?.handles(name))
      return this.options.knowledge.call(name, call.arguments);
    if (this.options.publish?.handles(name))
      return this.options.publish.call(name, call.arguments);
    if (this.options.blossom?.handles(name))
      return this.options.blossom.call({ name, arguments: call.arguments });
    if (this.options.git?.handles(name))
      return this.options.git.call(name, call.arguments);

    switch (name) {
      case RESPOND_TOOL:
        return this.respond(call.arguments);
      case REACT_TOOL:
        return this.react(call.arguments);
      case WHO_TOOL:
        return this.who();
      case HISTORY_TOOL:
        return this.history(call.arguments);
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
    const incoming = this.conversation;
    if (!incoming) return { ok: false, output: NO_ROOM };
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
      /**
       * An `imeta` from `blossom.upload`, passed straight through.
       *
       * Validated only for shape — it is the tool's own output coming back, so
       * the risk is a model mangling it rather than inventing one, and a
       * malformed tag published as-is renders as nothing with no explanation.
       */
      const imeta = Array.isArray(args.imeta)
        ? args.imeta.filter((part): part is string => typeof part === "string")
        : undefined;
      const tags =
        imeta && imeta[0] === "imeta" && imeta.length > 1 ? [imeta] : [];

      const id = await this.options.transport.reply(incoming, text, tags);
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

  /**
   * The correspondent, from the message rather than from the model.
   *
   * `requestedBy` is set by the transport that delivered the message and cannot
   * be influenced by anything the model says — which is the point. An identity
   * the model could assert is an identity it could get wrong, or be talked into.
   */
  private who(): ToolResult {
    const pubkey = this.requestedBy;
    const room = this.room;
    if (!room) return { ok: false, output: NO_ROOM };
    return {
      ok: true,
      output: JSON.stringify({
        pubkey,
        npub: nip19.npubEncode(pubkey),
        room: {
          transport: room.transport,
          id: room.id,
          ...(room.relay ? { relay: room.relay } : {}),
          ...(room.label ? { label: room.label } : {}),
        },
        note: "Resolve the npub for their profile; use the hex pubkey as an author in a filter.",
      }),
    };
  }

  /**
   * The conversation so far, oldest first.
   *
   * Trimmed per message rather than truncated as a whole: a reader needs the
   * SHAPE of the exchange more than it needs every word of one long message, and
   * dropping the recent end to fit an old essay is the opposite of useful.
   */
  private async history(args: Record<string, unknown>): Promise<ToolResult> {
    const transport = this.options.transport;
    if (!transport.history)
      return { ok: false, output: "this room cannot be read back" };

    const asked =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_HISTORY;
    const limit = Math.min(asked, MAX_HISTORY);

    try {
      /**
       * Called ON the transport, not lifted off it.
       *
       * `const read = transport.history` then `read(…)` detaches the method
       * from its object, so `this` inside `Nip17Transport.history` is undefined
       * and the first line of it dies reading `this.options`. Every call
       * refused with an error nobody could act on.
       */
      const room = this.room;
      if (!room) return { ok: false, output: NO_ROOM };
      const messages = await transport.history(room, limit, {
        includeOwn: true,
      });
      return {
        ok: true,
        output: JSON.stringify({
          count: messages.length,
          messages: messages.map((message) => ({
            id: message.id,
            author: message.author,
            // Said plainly, so the model does not have to compare pubkeys to
            // work out which half of the conversation it wrote.
            mine:
              this.options.selfPubkey !== undefined &&
              message.author === this.options.selfPubkey,
            at: message.createdAt,
            text:
              message.text.length > MAX_HISTORY_CHARS
                ? `${message.text.slice(0, MAX_HISTORY_CHARS)}…[truncated]`
                : message.text,
            ...(message.replyToId ? { replyTo: message.replyToId } : {}),
          })),
        }),
      };
    } catch (error) {
      return {
        ok: false,
        output: `could not read the conversation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  private async react(args: Record<string, unknown>): Promise<ToolResult> {
    const incoming = this.conversation;
    if (!incoming) return { ok: false, output: NO_ROOM };
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
      const id = await this.options.transport.react(incoming, emoji);
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
