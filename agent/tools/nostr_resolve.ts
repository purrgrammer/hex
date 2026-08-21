import { defineTool } from "eve/tools";
import { z } from "zod";

import { callHex } from "../lib/hex";

export default defineTool({
  description:
    "Turn a bech32 entity into what it names: a profile for an npub or " +
    "nprofile, the event itself for a note, nevent or naddr.",
  inputSchema: z.object({
    entity: z
      .string()
      .min(1)
      .describe("An npub, nprofile, note, nevent or naddr, with or without the `nostr:` prefix."),
  }),
  async execute({ entity }, ctx) {
    return callHex(ctx.session.id, ctx.callId, "nostr.resolve", { entity });
  },
});
