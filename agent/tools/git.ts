import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { callHex, hexTools } from "../lib/hex";

/**
 * NIP-34 repositories — offered only when Hex can actually serve them.
 *
 * `git_state` was the reason this stopped being three static files. Changing an
 * issue's state means publishing a signed status event, so Hex offers the tool
 * only when it has a signer and a key; declared statically here, the model was
 * shown it regardless and found out by calling it. A tool that is present and
 * refuses is worse than one that was never there: the model spends a turn on it
 * and then has to decide whether the refusal was about permissions or its
 * arguments.
 *
 * Whether a tool exists is Hex's answer, not this file's, for the same reason
 * the chat tools moved: this side cannot see the configuration that decides.
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

      if (offered.has("git_issues"))
        tools.git_issues = defineTool({
          description:
            "List a NIP-34 repository's issues with their real state. Finds " +
            "the repository's own relays first, then folds in the status " +
            "events that say whether each issue is open, closed, applied or " +
            "draft. Use this instead of a raw kind 1621 query: state is a " +
            "separate event pointing back at the issue, and the issues are " +
            "usually not on the relays you read by default.",
          inputSchema: z.object({
            repo: z
              .string()
              .min(1)
              .describe(
                'The repository address, "30617:<pubkey-hex>:<identifier>" — ' +
                  "what an `a` tag on the session carries.",
              ),
            state: z
              .enum(["open", "closed", "applied", "draft", "any"])
              .optional()
              .describe('Which issues to return. Defaults to "open".'),
            limit: z
              .number()
              .optional()
              .describe(
                "How many, newest first. Defaults to 20, hard bound 100.",
              ),
          }),
          async execute({ repo, state, limit }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "git.issues", {
              repo,
              ...(state ? { state } : {}),
              ...(limit === undefined ? {} : { limit }),
            });
          },
        });

      if (offered.has("git_patches"))
        tools.git_patches = defineTool({
          description:
            "List a NIP-34 repository's patches (kind 1617) and pull requests " +
            "(kind 1618) with their state folded in, on the repository's own " +
            "relays.",
          inputSchema: z.object({
            repo: z
              .string()
              .min(1)
              .describe(
                'The repository address, "30617:<pubkey-hex>:<identifier>".',
              ),
            state: z
              .enum(["open", "closed", "applied", "draft", "any"])
              .optional()
              .describe('Which to return. Defaults to "open".'),
            kind: z
              .enum(["patch", "pull-request", "any"])
              .optional()
              .describe('Defaults to "any", which returns both.'),
            limit: z
              .number()
              .optional()
              .describe(
                "How many, newest first. Defaults to 20, hard bound 100.",
              ),
          }),
          async execute({ repo, state, kind, limit }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "git.patches", {
              repo,
              ...(state ? { state } : {}),
              ...(kind ? { kind } : {}),
              ...(limit === undefined ? {} : { limit }),
            });
          },
        });

      if (offered.has("git_state"))
        tools.git_state = defineTool({
          description:
            "Open, close or resolve an issue, patch or pull request by " +
            "publishing a NIP-34 status event as this agent. PERMANENT and " +
            "public — a status event cannot be recalled, only superseded. Only " +
            "a repository's maintainers and a thread's own author are " +
            "authoritative, so check that you are one.",
          inputSchema: z.object({
            repo: z
              .string()
              .min(1)
              .describe(
                'The repository address, "30617:<pubkey-hex>:<identifier>".',
              ),
            id: z
              .string()
              .min(1)
              .describe(
                "The hex event id of the issue, patch or pull request. Not a " +
                  "nevent — decode it with `nostr_resolve` first.",
              ),
            state: z
              .enum(["open", "closed", "applied", "draft"])
              .describe("The state to set."),
            comment: z
              .string()
              .optional()
              .describe("Why, in a sentence. Published with the status."),
          }),
          async execute({ repo, id, state, comment }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "git.state", {
              repo,
              id,
              state,
              ...(comment ? { comment } : {}),
            });
          },
        });

      /**
       * The proposal side, backed by ngit against a checkout on Hex's machine.
       *
       * NOT the sandbox's copy of the repository. These read and merge what
       * OTHERS proposed; they cannot see work in progress here, which is why
       * there is no tool for turning the current diff into a patch.
       */
      if (offered.has("git_proposals"))
        tools.git_proposals = defineTool({
          description:
            "List the open proposals — patches and pull requests — on a " +
            "repository Hex has a checkout of. This is what a maintainer sees " +
            "before deciding what to look at.",
          inputSchema: z.object({
            repo: z
              .string()
              .min(1)
              .describe("Which checkout, by name, e.g. `hex` or `grimoire`."),
          }),
          async execute({ repo }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "git.proposals", {
              repo,
            });
          },
        });

      if (offered.has("git_proposal"))
        tools.git_proposal = defineTool({
          description:
            "Read one proposal in full: subject, author, branch, description, " +
            "and whether it still applies.",
          inputSchema: z.object({
            repo: z.string().min(1).describe("Which checkout, by name."),
            id: z
              .string()
              .min(6)
              .describe(
                "The proposal's event id, or a unique prefix — whatever " +
                  "`git_proposals` printed.",
              ),
          }),
          async execute({ repo, id }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "git.proposal", {
              repo,
              id,
            });
          },
        });

      if (offered.has("git_merge"))
        tools.git_merge = defineTool({
          description:
            "Merge an open proposal into the default branch. PUBLISHED IN THE " +
            "OPERATOR'S NAME, not yours, and permanent. Merge only what you " +
            "have actually read and verified: it applies to current main, and " +
            "the repository's own build and tests pass with it. If either " +
            "fails, say why instead of merging.",
          inputSchema: z.object({
            repo: z.string().min(1).describe("Which checkout, by name."),
            id: z.string().min(6).describe("The proposal's event id, or a prefix."),
          }),
          async execute({ repo, id }, toolCtx) {
            return callHex(toolCtx.session.id, toolCtx.callId, "git.merge", {
              repo,
              id,
            });
          },
        });

      return Object.keys(tools).length > 0 ? tools : null;
    },
  },
});
