/**
 * The tools for a turn with no room: `hex ask`.
 *
 * Delivery goes to stdout instead of a relay, through the same `respond` call a
 * group turn uses — so asking a question on the command line exercises the real
 * path, including whether the model remembers to call the tool at all. That is
 * the point of the command: to find out before a room does.
 */

import type { KnowledgeTools } from "./knowledge.js";
import type { RepoTools } from "./repo-tools.js";
import {
  canonicalId,
  RESPOND_TOOL,
  type ToolCall,
  type ToolHost,
  type ToolResult,
  type ToolSpec,
} from "./types.js";
import type { Room } from "../transports/types.js";

export class ConsoleTools implements ToolHost {
  private didDeliver = false;

  constructor(
    readonly room: Room,
    readonly requestedBy: string,
    private readonly write: (text: string) => void = (text) =>
      console.log(text),
    /** The same read tools a room turn gets, so `hex ask` exercises them too. */
    private readonly knowledge?: KnowledgeTools,
    /**
     * And the coding tools, when the caller asked to be treated as a channel
     * that has them. `hex ask --as <npub>` is the only way to drive the whole
     * loop without a second key to send the DM from.
     */
    private readonly repo?: RepoTools,
  ) {}

  get delivered() {
    return this.didDeliver;
  }

  list(): ToolSpec[] {
    return [
      {
        name: RESPOND_TOOL,
        description:
          "Say something to the person who asked. This is the only way to be heard; anything you write outside this tool is private thinking.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "What to say." },
          },
          required: ["text"],
          additionalProperties: false,
        },
        prompt:
          "`chat.respond` is how you speak: call it once with what you want to" +
          " say, and nothing else you write is heard.",
      },
      ...(this.knowledge?.list() ?? []),
      ...(this.repo?.list() ?? []),
    ];
  }

  async call(call: ToolCall): Promise<ToolResult> {
    const name = canonicalId(call.name, this.list());
    if (this.repo?.handles(name)) return this.repo.call(name, call.arguments);
    if (this.knowledge?.handles(name))
      return this.knowledge.call(name, call.arguments);

    if (name !== RESPOND_TOOL)
      return {
        ok: false,
        output: `there is no tool called "${call.name}" here; only ${RESPOND_TOOL}`,
      };

    const text =
      typeof call.arguments.text === "string" ? call.arguments.text.trim() : "";
    if (!text) return { ok: false, output: "respond needs a non-empty `text`" };

    // One answer per turn, same as a room: a model that calls respond twice has
    // misunderstood, and hearing it twice is worse than hearing the refusal.
    if (this.didDeliver)
      return {
        ok: false,
        output: "you have already answered; stop here",
      };

    this.write(`\n${text}`);
    this.didDeliver = true;
    return { ok: true, output: "delivered" };
  }
}
