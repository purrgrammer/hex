/**
 * The proposal side of NIP-34, driven through `ngit`.
 *
 * `git.issues` and `git.patches` build their answers from raw events. These do
 * not: `ngit` already knows how to find a proposal's branch, reconcile it with
 * what a relay published, and merge it as a no-fast-forward commit. Rebuilding
 * that from kind numbers would be a second implementation of a thing that
 * exists, and a worse one.
 *
 * Two constraints shape everything here.
 *
 * **They run on the host, against a checkout named in config.** An agent's own
 * edits live in a sandbox this process cannot see — `ls /Users/...` from a tool
 * call comes back "No such file or directory" — so there is no way to build a
 * patch from the work in progress. What crosses that boundary is a ref, once
 * something has pushed it somewhere both sides can fetch.
 *
 * **Merging signs as the OPERATOR.** `ngit` reads `nostr.nsec` from the
 * checkout's git config, so a merge published by this tool is published in a
 * human's name. That is a real grant of authority and it is gated on
 * `tools.git.write`, separately from reading.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import {
  GIT_MERGE_TOOL,
  GIT_PROPOSAL_TOOL,
  GIT_PROPOSALS_TOOL,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

export interface NgitToolsOptions {
  /**
   * Repository name to checkout path, on THIS machine.
   *
   * Named rather than discovered: a tool that went looking for git directories
   * would find every repository the operator has, and act on the ones it was
   * never pointed at.
   */
  checkouts: Record<string, string>;
  /** Merging publishes in the operator's name, so it is its own permission. */
  write?: boolean;
  /** Long enough for a fetch over the network, short enough to not hang a turn. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 90_000;
/** Enough to read a proposal; short of drowning the model in a whole diff. */
const MAX_OUTPUT = 12_000;

export class NgitTools {
  constructor(private readonly options: NgitToolsOptions) {}

  handles(name: string): boolean {
    return (
      name === GIT_PROPOSALS_TOOL ||
      name === GIT_PROPOSAL_TOOL ||
      name === GIT_MERGE_TOOL
    );
  }

  private get repositories(): string[] {
    return Object.keys(this.options.checkouts);
  }

  list(): ToolSpec[] {
    if (this.repositories.length === 0) return [];
    const repo = {
      type: "string",
      description: `Which checkout to act in. One of: ${this.repositories.join(", ")}.`,
      enum: this.repositories,
    };

    const specs: ToolSpec[] = [
      {
        name: GIT_PROPOSALS_TOOL,
        description:
          "List the open proposals — patches and pull requests — on a " +
          "repository this agent has a checkout of. This is what a maintainer " +
          "sees before deciding what to look at.",
        parameters: {
          type: "object",
          properties: { repo },
          required: ["repo"],
        },
        prompt:
          "`git.proposals` lists open proposals on a repository checked out here.",
      },
      {
        name: GIT_PROPOSAL_TOOL,
        description:
          "Read one proposal: its subject, author, branch and description, and " +
          "whether it still applies. Give the id `git.proposals` printed — a " +
          "prefix is enough.",
        parameters: {
          type: "object",
          properties: {
            repo,
            id: {
              type: "string",
              description: "The proposal's event id, or a unique prefix of it.",
            },
          },
          required: ["repo", "id"],
        },
        prompt: "`git.proposal` reads one proposal in full.",
      },
    ];

    /**
     * Merging is not reading, and it is not this agent's signature either.
     *
     * `ngit` signs with the operator's key from the checkout's git config, so
     * every merge this publishes says a human did it. Offered only when the
     * operator turned writing on.
     */
    if (this.options.write)
      specs.push({
        name: GIT_MERGE_TOOL,
        description:
          "Merge an open proposal into the default branch as a no-fast-forward " +
          "commit. PUBLISHED IN THE OPERATOR'S NAME, not this agent's, and it " +
          "does not push — someone still has to. Merge only what you have read " +
          "and verified: it applies to current main, and the repository's own " +
          "build and tests pass with it.",
        parameters: {
          type: "object",
          properties: {
            repo,
            id: {
              type: "string",
              description: "The proposal's event id, or a unique prefix.",
            },
          },
          required: ["repo", "id"],
        },
        prompt:
          "`git.merge` merges a proposal you have verified, in the operator's name.",
      });

    return specs;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    /**
     * Permission before anything else it could refuse on.
     *
     * Telling a caller its path does not exist, when it was never allowed to
     * merge in the first place, answers a question nobody asked and hides the
     * one that matters.
     */
    if (name === GIT_MERGE_TOOL && !this.options.write)
      return {
        ok: false,
        output:
          "merging is off. It publishes in the operator's name, so it is a " +
          "separate permission — `tools.git.write` turns it on.",
      };

    const repo = typeof args.repo === "string" ? args.repo : "";
    const cwd = this.options.checkouts[repo];
    if (!cwd)
      return {
        ok: false,
        output:
          `there is no checkout called ${JSON.stringify(repo)} here. ` +
          `Available: ${this.repositories.join(", ") || "none"}.`,
      };
    if (!existsSync(cwd))
      return {
        ok: false,
        output: `the checkout for ${repo} is configured as ${cwd}, and that path does not exist`,
      };

    if (name === GIT_PROPOSALS_TOOL) return this.run(cwd, ["pr", "list"]);

    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id)
      return {
        ok: false,
        output: "name the proposal by its id, or a prefix of it",
      };
    /**
     * An id is hex and nothing else.
     *
     * These become process arguments. `execFile` runs no shell, so this is not
     * the last line of defence — but a proposal id that is not an id is a
     * mistake worth naming rather than passing on to be rejected obscurely.
     */
    if (!/^[0-9a-f]{6,64}$/.test(id))
      return {
        ok: false,
        output: `${JSON.stringify(id)} is not an event id — those are hex, at least six characters`,
      };

    if (name === GIT_PROPOSAL_TOOL) return this.run(cwd, ["pr", "view", id]);
    if (name === GIT_MERGE_TOOL) return this.run(cwd, ["merge", id]);
    return {
      ok: false,
      output: `there is no tool called ${JSON.stringify(name)}`,
    };
  }

  /**
   * One `ngit` invocation, with no shell between here and it.
   *
   * `ngit` reports plenty on a success and exits non-zero on a refusal, and the
   * refusal text is the useful part — "the branch has diverged from the
   * published proposal", "does not match the published PR tip". So both streams
   * come back either way, and a non-zero exit is a tool result rather than a
   * thrown error: the model can act on being told why.
   */
  private run(cwd: string, args: string[]): Promise<ToolResult> {
    return new Promise((resolve) => {
      execFile(
        "ngit",
        args,
        { cwd, timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        (error, stdout, stderr) => {
          const said = [stdout, stderr].filter(Boolean).join("\n").trim();
          const clipped =
            said.length > MAX_OUTPUT
              ? `${said.slice(0, MAX_OUTPUT)}\n…[truncated at ${MAX_OUTPUT} characters]`
              : said;
          this.options.log?.(`[hex] ngit ${args.join(" ")} in ${cwd}`);
          if (error && !said)
            return resolve({
              ok: false,
              output:
                "ngit could not be run. It has to be on this machine's PATH " +
                `for these tools to work: ${error.message}`,
            });
          resolve({ ok: !error, output: clipped || "ngit said nothing" });
        },
      );
    });
  }
}
