/**
 * Writing to Nostr, as Hex.
 *
 * Every other tool in this package reads. These two do not: what they produce is
 * signed by the agent's own key, and a signed event cannot be recalled — a
 * deletion request is a request, and relays that already served the note are
 * under no obligation to forget it. So the shape here is deliberately narrow.
 *
 * **Signing and publishing are the same permission.** `nostr.sign` hands back an
 * event anyone who receives it can publish, so it is bounded exactly as
 * `nostr.publish` is. A tool that would sign what it refuses to publish is a
 * tool with a loophole in it.
 *
 * **Some kinds are refused unless the operator names them.** Not because the
 * model is untrusted in general, but because these particular kinds break the
 * agent in ways it cannot undo or even notice:
 *
 * - `0`, `3`, `10002`, `10050` are REPLACEABLE. Publishing one replaces what the
 *   agent already had — a new 10050 silently redirects every private message
 *   sent to it thereafter, and nothing in the transcript would say so.
 * - `5` asks relays to delete. Aimed at the wrong id it destroys someone's work,
 *   and the agent's own key is authority enough for its own notes.
 * - `4`, `13`, `1059`, `21059` are the encrypted and wrapping kinds. A generic
 *   signer must not mint them: the transports build those deliberately, with the
 *   right seal and the right throwaway key, and a hand-rolled one leaks exactly
 *   what the envelope exists to hide.
 *
 * An operator who wants any of them lists it in `tools.publish.kinds`, which is
 * an explicit, readable decision in a file rather than a model's improvisation.
 */

import { finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools";

import { publishTo, type HexRelays } from "../relays.js";
import {
  PUBLISH_TOOL,
  SIGN_TOOL,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

/** What this needs of a signer: the one method, however the key is held. */
export interface EventSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

/** Kinds refused unless the operator names them. See the note above. */
export const GUARDED_KINDS: readonly number[] = [
  0, 3, 4, 5, 13, 1059, 10002, 10050, 21059,
];

/** A sane ceiling, so a confused loop cannot spend the agent's reputation. */
const DEFAULT_PER_HOUR = 10;
/** Content this long is a document, not a note, and probably a mistake. */
const MAX_CONTENT = 64 * 1024;

export interface PublishToolsOptions {
  signer: EventSigner;
  pubkey: string;
  relays: HexRelays;
  /** Where an event goes when the model names no relay. */
  publishRelays: string[];
  /** Guarded kinds the operator has explicitly allowed. */
  allowKinds?: number[];
  perHour?: number;
  /** Log instead of publishing, so the whole path can be exercised safely. */
  dryRun?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export class PublishTools {
  /** Timestamps of what was published, for the hourly bound. */
  private readonly published: number[] = [];

  constructor(private readonly options: PublishToolsOptions) {}

  private get allowed(): Set<number> {
    return new Set(this.options.allowKinds ?? []);
  }

  list(): ToolSpec[] {
    const guarded = GUARDED_KINDS.filter((kind) => !this.allowed.has(kind));
    const refused = guarded.length
      ? ` Refuses kinds ${guarded.join(", ")} unless the operator allowed them.`
      : "";

    const parameters = {
      type: "object",
      properties: {
        kind: { type: "number", description: "Event kind." },
        content: { type: "string", description: "The event's content." },
        tags: {
          type: "array",
          description:
            'Tags, as arrays of strings: [["e","<hex>"],["p","<hex>"]]. ' +
            "Hex ids and pubkeys, never npub or note.",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["kind", "content"],
    };

    return [
      {
        name: PUBLISH_TOOL,
        description:
          `Sign an event with Hex's key and publish it. This is PUBLIC and ` +
          `permanent — a deletion request is a request, and relays are not ` +
          `obliged to honour it.${refused}`,
        parameters: {
          ...parameters,
          properties: {
            ...parameters.properties,
            relays: {
              type: "array",
              items: { type: "string" },
              description:
                "Leave this out unless the user named a relay. Hex publishes " +
                "to its own configured relays otherwise.",
            },
          },
        },
        prompt:
          "`nostr.publish` writes to the network as Hex, publicly and" +
          " permanently. Say what you are about to post and why before you" +
          " post it, and never post on a guess about what someone meant.",
      },
      {
        name: SIGN_TOOL,
        description:
          "Sign an event with Hex's key and return it WITHOUT publishing, for " +
          "someone else to inspect or relay." + refused,
        parameters,
        prompt:
          "`nostr.sign` returns a signed event without sending it — the same" +
          " bounds as publishing, because a signed event is one relay call away" +
          " from being published by whoever holds it.",
      },
    ];
  }

  handles(name: string): boolean {
    return name === PUBLISH_TOOL || name === SIGN_TOOL;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const template = this.templateFor(args);
    if ("error" in template) return { ok: false, output: template.error };

    if (name === SIGN_TOOL) {
      const event = await this.sign(template.value);
      return { ok: true, output: JSON.stringify({ signed: event }) };
    }

    const rate = this.withinRate();
    if (rate) return { ok: false, output: rate };

    const named = Array.isArray(args.relays)
      ? args.relays.filter(
          (url): url is string =>
            typeof url === "string" &&
            (url.startsWith("wss://") || url.startsWith("ws://")),
        )
      : [];
    const relays = named.length > 0 ? named : this.options.publishRelays;
    if (relays.length === 0)
      return { ok: false, output: "no relay to publish to" };

    const event = await this.sign(template.value);

    if (this.options.dryRun) {
      this.options.log?.(
        `[hex] would publish kind ${event.kind}: ${event.content.slice(0, 120)}`,
      );
      return {
        ok: true,
        output: JSON.stringify({
          id: event.id,
          dryRun: true,
          note: "nothing was published",
        }),
      };
    }

    const outcomes = await publishTo(this.options.relays, relays, event);
    const accepted = outcomes.filter((outcome) => outcome.ok);
    // Counted only when it landed: a publish nobody took has not spent the
    // agent's hourly budget, because it has not been seen.
    if (accepted.length > 0) this.published.push(this.now());

    return {
      // A relay that refused is not a tool that failed, but it is not a success
      // either — the caller is told the truth and decides.
      ok: accepted.length > 0,
      output: JSON.stringify({
        id: event.id,
        nevent: undefined,
        accepted: accepted.map((outcome) => outcome.relay),
        refused: outcomes
          .filter((outcome) => !outcome.ok)
          .map((outcome) => ({ relay: outcome.relay, why: outcome.message })),
      }),
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private withinRate(): string | undefined {
    const cap = this.options.perHour ?? DEFAULT_PER_HOUR;
    const hourAgo = this.now() - 60 * 60 * 1000;
    while (this.published.length && this.published[0]! < hourAgo)
      this.published.shift();
    return this.published.length >= cap
      ? `Hex has already published ${this.published.length} events this hour, which is its limit. Nothing was published.`
      : undefined;
  }

  private templateFor(
    args: Record<string, unknown>,
  ): { value: EventTemplate } | { error: string } {
    const kind = typeof args.kind === "number" ? Math.floor(args.kind) : NaN;
    if (!Number.isInteger(kind) || kind < 0 || kind > 65535)
      return { error: "an event needs a `kind` between 0 and 65535" };

    if (GUARDED_KINDS.includes(kind) && !this.allowed.has(kind))
      return {
        error:
          `kind ${kind} is not one this agent may write. Replaceable identity ` +
          `and relay-list kinds redirect the agent silently, deletion requests ` +
          `destroy what they name, and the encrypted kinds are built by the ` +
          `transports rather than by hand. Ask the operator to allow it in ` +
          `\`tools.publish.kinds\` if it is really wanted.`,
      };

    const content = typeof args.content === "string" ? args.content : undefined;
    if (content === undefined)
      return { error: "an event needs `content`, even if it is empty" };
    if (content.length > MAX_CONTENT)
      return {
        error: `that content is ${content.length} characters; the limit is ${MAX_CONTENT}`,
      };

    const tags: string[][] = [];
    if (args.tags !== undefined) {
      if (!Array.isArray(args.tags))
        return { error: "`tags` must be an array of arrays of strings" };
      for (const tag of args.tags) {
        if (
          !Array.isArray(tag) ||
          tag.length === 0 ||
          tag.some((value) => typeof value !== "string")
        )
          return {
            error: `every tag must be a non-empty array of strings; got ${JSON.stringify(tag)}`,
          };
        tags.push(tag as string[]);
      }
    }

    return {
      value: {
        kind,
        content,
        tags,
        // The agent's clock, never the model's: a `created_at` it could choose
        // is one it could backdate into somebody else's thread.
        created_at: Math.floor(this.now() / 1000),
      },
    };
  }

  private async sign(template: EventTemplate): Promise<NostrEvent> {
    return this.options.signer.signEvent(template);
  }
}

/** For a caller holding a raw secret key rather than a signer object. */
export function signerFromSecret(secret: Uint8Array): EventSigner {
  return {
    signEvent: async (template) => finalizeEvent(template, secret),
  };
}
