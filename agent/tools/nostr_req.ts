import { defineTool } from "eve/tools";
import { z } from "zod";

import { callHex } from "../lib/hex";

/**
 * A REQ against the relays Hex is configured for. Read-only.
 *
 * The filter is NIP-01's, whole: narrowing the query is the point, and a model
 * that fetches kind 1 and sorts it in its head has spent a context window on
 * work a relay does in an index.
 */
export default defineTool({
  description:
    "Run a REQ against relays and read what comes back. Read-only. Takes a " +
    "NIP-01 filter and returns the events, with long content truncated.",
  inputSchema: z.object({
    ids: z.array(z.string()).optional().describe("Hex event ids, not note1 or nevent."),
    authors: z.array(z.string()).optional().describe("Hex pubkeys, not npubs."),
    kinds: z.array(z.number()).optional().describe("Event kinds to request."),
    since: z.number().optional().describe("Unix seconds; only events at or after this time."),
    until: z.number().optional().describe("Unix seconds; only events at or before this time."),
    /**
     * Named, not a free-form map.
     *
     * This was `z.record(z.string(), z.array(z.string()))`, which compiles to a
     * JSON Schema object with `additionalProperties` and NO `properties` — and
     * an OpenAI-shaped provider cannot express that, so the model emitted `{}`
     * every single time. The tool then ran the query with no tag at all: the
     * whole relay instead of the one thread asked for, answered confidently
     * from a hundred unrelated events, with the model reporting only that "the
     * tag filter didn't go through (empty object)".
     *
     * One field per tag anyone actually filters by. A schema a provider can
     * write is worth more than one that covers every letter and never arrives.
     */
    e: z
      .array(z.string())
      .optional()
      .describe(
        "Event ids, hex — replies to, or references of, those events.",
      ),
    p: z
      .array(z.string())
      .optional()
      .describe("Pubkeys, hex — events that mention those people."),
    a: z
      .array(z.string())
      .optional()
      .describe(
        'Addressable coordinates, "<kind>:<pubkey>:<d>" — issues and patches ' +
          "against a repository, comments on an article. nostr_resolve returns " +
          "this ready-made as its `tag`; use that rather than building one.",
      ),
    t: z.array(z.string()).optional().describe("Hashtags, without the #."),
    d: z
      .array(z.string())
      .optional()
      .describe("Identifiers of addressable events."),
    k: z
      .array(z.string())
      .optional()
      .describe("Kind numbers AS STRINGS, for events that tag a kind."),
    limit: z.number().optional().describe("How many events you want. Defaults to 5, hard bound 100."),
    relays: z
      .array(z.string())
      .optional()
      .describe(
        "Leave this out unless the user named a relay. Hex reads from its own configured relays otherwise.",
      ),
  }),
  async execute(input, ctx) {
    return callHex(ctx.session.id, ctx.callId, "nostr.req", input);
  },
});
