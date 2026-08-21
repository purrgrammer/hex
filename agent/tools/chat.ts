import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { callHex, hexTools } from "../lib/hex";

/**
 * Speaking, reacting, and reading the thread — offered only where there is one.
 *
 * These were three static tools, and static was wrong: whether this agent has
 * anywhere to speak is a property of the RUN, not of the agent. A session
 * started over a gift wrap has no room, and a model handed `chat_respond`
 * anyway will use it — the call comes back "there is no room", the answer goes
 * nowhere, and the run reads as one that had nothing to say.
 *
 * Hex is asked which tools this session gets, because Hex is the only side that
 * knows how the request arrived. Resolved on `turn.started` rather than
 * `session.started`: the bridge binds a session's tools moments after the
 * session id exists, and a resolver racing that would decide "no room" for a
 * conversation that has one.
 *
 * Each `execute` is written inline. The bundler reconstructs them from stored
 * closure variables on replay rather than re-running this resolver, and it does
 * not detect a function passed by reference.
 */
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const offered = await hexTools(ctx.session.id);
      if (!offered.has("chat_respond")) return null;

      const tools: Record<string, ReturnType<typeof defineTool>> = {
        chat_respond: defineTool({
          description:
            "Say something in the room, as a reply to the message you were " +
            "given. This is the only way to be heard; anything you write " +
            "outside this tool is private thinking. PLAIN TEXT ONLY — no " +
            "markdown. A chat message is not a document: asterisks, backticks " +
            "and heading marks arrive as literal characters in most Nostr " +
            "clients.",
          inputSchema: z.object({
            text: z
              .string()
              .min(1)
              .describe(
                "What to say, as a chat message. Plain text: no markdown, no " +
                  "bold, no bullet characters, no code fences. Use line breaks " +
                  "and ordinary sentences, and `nostr:` bech32 entities to " +
                  "refer to people and events.",
              ),
            imeta: z
              .array(z.string())
              .optional()
              .describe(
                "The `imeta` array returned by blossom_upload, when your " +
                  "message links a file you uploaded. Pass it through " +
                  "unchanged. Without it an encrypted attachment is a link to " +
                  "bytes the reader cannot open.",
              ),
          }),
          async execute({ text, imeta }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "chat.respond", {
              text,
              ...(imeta ? { imeta } : {}),
            });
          },
        }),
      };

      if (offered.has("chat_react"))
        tools.chat_react = defineTool({
          description:
            "React to the message with a single emoji, instead of or before " +
            "replying. An acknowledgement, not an answer.",
          inputSchema: z.object({
            emoji: z.string().min(1).describe("One emoji."),
          }),
          async execute({ emoji }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "chat.react", {
              emoji,
            });
          },
        });

      if (offered.has("chat_history"))
        tools.chat_history = defineTool({
          description:
            "What was said in this conversation before now, oldest first, " +
            "including your own past replies. Read it before answering " +
            "anything that refers to earlier — you are given one message, not " +
            "the thread.",
          inputSchema: z.object({
            limit: z
              .number()
              .optional()
              .describe("How many messages back. Defaults to 20, bound 100."),
          }),
          async execute({ limit }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "chat.history", {
              ...(limit === undefined ? {} : { limit }),
            });
          },
        });

      return tools;
    },
  },
});
