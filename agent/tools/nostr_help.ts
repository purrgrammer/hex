import { defineTool } from "eve/tools";
import { z } from "zod";

import { callHex } from "../lib/hex";

/**
 * The protocol's documentation, fetched rather than recalled.
 *
 * A kind number or a NIP's actual wording is exactly the sort of detail a model
 * is confident and wrong about, and both are one lookup away.
 *
 * Named `nostr_help` because that is what it is. It was `grimoire_help` when
 * this agent served one application; the id still resolves on the Hex side, so
 * an already-published definition that names it keeps working.
 */
export default defineTool({
  description:
    "Look up a NIP's text or an event kind's definition, from the spec rather " +
    "than from memory.",
  inputSchema: z.object({
    nip: z.string().optional().describe('NIP id, e.g. "01" or "29".'),
    kind: z.number().optional().describe("Event kind number."),
  }),
  async execute(input, ctx) {
    return callHex(ctx.session.id, ctx.callId, "nostr.help", input);
  },
});
