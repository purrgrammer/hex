import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { callHex, hexTools } from "../lib/hex";

/**
 * The things Hex may not be configured to do.
 *
 * Publishing, signing and uploading all depend on a key and a set of relays the
 * operator either gave Hex or did not. Hex already refuses to offer them when it
 * has neither; declared statically here, the model was shown them anyway and
 * found out by calling one. That is a whole turn spent discovering a permission,
 * and the refusal is ambiguous besides — the model cannot tell "you may not"
 * from "your arguments were wrong".
 *
 * Same shape as the chat and git tools, and for the same reason: whether a tool
 * exists is Hex's answer, because this side cannot see the configuration that
 * decides it.
 *
 * Each `execute` is written inline — the bundler reconstructs them from stored
 * closure variables on replay rather than re-running this resolver, and it does
 * not detect a function passed by reference.
 */
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const offered = await hexTools(ctx.session.id);
      const tools: Record<string, ReturnType<typeof defineTool>> = {};

      /**
       * Writing to Nostr, publicly and permanently.
       *
       * A signed event cannot be recalled: a deletion request is a request, and
       * relays that already served the note are under no obligation to forget
       * it. Some kinds are refused outright unless the operator allowed them —
       * replaceable identity and relay lists redirect the agent silently,
       * deletions destroy what they name, and the encrypted kinds are built by
       * the transports rather than by hand.
       */
      if (offered.has("nostr_publish"))
        tools.nostr_publish = defineTool({
          description:
            "Sign an event with Hex's key and publish it. PUBLIC and " +
            "PERMANENT — a deletion request is only a request, and relays need " +
            "not honour it. Say what you are about to post and why before you " +
            "post it.",
          inputSchema: z.object({
            kind: z.number().int().describe("Event kind."),
            content: z.string().describe("The event's content."),
            tags: z
              .array(z.array(z.string()))
              .optional()
              .describe(
                'Tags as arrays of strings: [["e","<hex>"],["p","<hex>"]]. ' +
                  "Hex ids and pubkeys, never npub or note.",
              ),
            relays: z
              .array(z.string())
              .optional()
              .describe(
                "Leave this out unless the user named a relay. Hex publishes " +
                  "to its own configured relays otherwise.",
              ),
          }),
          async execute(input, toolCtx) {
            return callHex(
              toolCtx.session.id,
              toolCtx.callId,
              "nostr.publish",
              input,
            );
          },
        });

      /**
       * A signed event, handed back rather than sent.
       *
       * Bounded exactly as publishing is: a signed event is one relay call away
       * from being published by whoever holds it, so a tool that signs what it
       * would refuse to publish is a tool with a loophole in it.
       */
      if (offered.has("nostr_sign"))
        tools.nostr_sign = defineTool({
          description:
            "Sign an event with Hex's key and return it WITHOUT publishing, " +
            "for someone else to inspect or relay.",
          inputSchema: z.object({
            kind: z.number().int().describe("Event kind."),
            content: z.string().describe("The event's content."),
            tags: z
              .array(z.array(z.string()))
              .optional()
              .describe(
                'Tags as arrays of strings: [["e","<hex>"]]. Hex, never bech32.',
              ),
          }),
          async execute(input, toolCtx) {
            return callHex(
              toolCtx.session.id,
              toolCtx.callId,
              "nostr.sign",
              input,
            );
          },
        });

      /**
       * Sharing a file with the person you are talking to.
       *
       * The bytes travel as base64 in the call, which is expensive and
       * deliberate: this tool executes in Hex's process on the host, because
       * that is where the signing key is, while `bash` and `read_file` run in
       * THIS sandbox. A path argument would name a file on the wrong machine.
       *
       * Encryption is decided by the room, not by the model. A private
       * conversation encrypts, because a plain URL in a gift-wrapped message
       * undoes the envelope for the one part anybody looks at; a public group
       * does not, because encrypting it would hide the file from exactly the
       * people it was posted for.
       */
      if (offered.has("blossom_upload"))
        tools.blossom_upload = defineTool({
          description:
            "Upload a file and get a URL for it. Read the file yourself and " +
            "pass its bytes as base64 — this tool runs outside your sandbox " +
            "and cannot open a path. Returns the url and, when the file is " +
            "encrypted, an `imeta` tag that must go out with the message or " +
            "the recipient gets a link to bytes they cannot read. Keep files " +
            "small; a few hundred KB is the practical limit.",
          inputSchema: z.object({
            content: z
              .string()
              .describe(
                "The file's bytes, base64-encoded. Produce it with " +
                  "`base64 -i <path>` in bash and pass the output.",
              ),
            filename: z
              .string()
              .describe(
                "What to call it, e.g. `diagram.png`. The type is read from it.",
              ),
            mime: z
              .string()
              .optional()
              .describe("Override the type, e.g. `image/png`."),
            encrypted: z
              .boolean()
              .optional()
              .describe(
                "Leave this out. The room decides: private conversations " +
                  "encrypt, public rooms do not. Encrypting something posted " +
                  "publicly hides it from everyone there.",
              ),
          }),
          async execute(input, toolCtx) {
            return callHex(
              toolCtx.session.id,
              toolCtx.callId,
              "blossom.upload",
              input,
            );
          },
        });

      return Object.keys(tools).length > 0 ? tools : null;
    },
  },
});
