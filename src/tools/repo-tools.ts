/**
 * The tools that actually do work: run a command, write a file.
 *
 * Two tools rather than a drawer of them. A model that can run a shell can read,
 * search, build and test without being handed a tool for each, and every tool
 * that wraps a command is another thing to keep in step with the command. The
 * exception is writing a file, which exists because heredocs are a bad text
 * editor and a model that fumbles one corrupts the file it meant to fix.
 *
 * Everything here runs as the user who started the daemon. That is the operator's
 * explicit choice, and it means the only real boundaries are the ones above this
 * file: which channel gets these tools at all, and which repos it named. What
 * this file can still do is bound each call — a wall clock, an output ceiling,
 * a working directory that is never the caller's to choose — and be honest in
 * the log about what it ran.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ToolResult, ToolSpec } from "./types.js";
import { EXEC_TOOL, WRITE_TOOL } from "./types.js";
import type { Checkout } from "../clone.js";
import type { ExecBackend } from "./exec-backend.js";
import { truncateOutput } from "./exec-backend.js";

export { truncateOutput, MAX_OUTPUT_CHARS } from "./exec-backend.js";
export { scrubEnv } from "./exec-host.js";

/**
 * Default ceiling for one command.
 *
 * Generous on purpose: a fresh worktree has no `node_modules`, so the realistic
 * first command of any task is an install that takes minutes. A tight default
 * would fail every task at setup and look like a broken tool.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60_000;

export interface RepoToolsOptions {
  worktrees: Checkout;
  /**
   * Where commands run. Required, with no default.
   *
   * A default would make the safer backend opt-in, and an optional
   * security-relevant field is the shape of a silent downgrade — the compiler
   * enumerating every construction site is the point.
   */
  backend: ExecBackend;
  /** Repos this channel may touch. Empty means these tools do nothing. */
  repos: string[];
  /**
   * Which conversation the checkout belongs to — a ROOM, not a session.
   *
   * Sessions turn over: thirty quiet minutes without a threaded reply opens a
   * new one, and a coding task routinely takes longer than that. Keyed by
   * session, the peer who came back after a long build got a second full
   * checkout, empty of the work they were asking about, while the tool
   * description promised them state persists between messages. A room is the
   * stable thing — one conversation, one workspace.
   */
  workspace: string;
  /** Who asked, for the log. Every command is attributable. */
  requestedBy: string;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Log instead of running. */
  dryRun?: boolean;
}

export class RepoTools {
  constructor(private readonly options: RepoToolsOptions) {}

  private get workspace(): string {
    return this.options.workspace;
  }

  private repoEnum(): string[] {
    return this.options.repos;
  }

  list(): ToolSpec[] {
    if (this.options.repos.length === 0) return [];
    const repos = this.repoEnum();
    const only = repos.length === 1 ? repos[0] : undefined;
    const repoParam = {
      type: "string",
      enum: repos,
      description: only
        ? `Which repository. Only "${only}" is available.`
        : "Which repository to work in.",
    };

    return [
      {
        name: EXEC_TOOL,
        description:
          "Run a shell command in this conversation's own git worktree of the " +
          "repository. Use it to read files, search, edit, build and run tests. " +
          "The working directory is the worktree root and cannot be changed by " +
          "you; `cd` within the command is fine. State on disk persists between " +
          "calls and between messages, so an install done once stays done, but " +
          "PROCESSES do not: anything still running when the command returns is " +
          "killed, so a dev server or a watcher will not be there afterwards and " +
          "you should not tell anyone it is.",
        parameters: {
          type: "object",
          properties: {
            repo: repoParam,
            command: {
              type: "string",
              description:
                "The command line, run through bash. One command per call.",
            },
          },
          required: only ? ["command"] : ["repo", "command"],
          additionalProperties: false,
        },
        prompt:
          "`repo.exec` runs a shell command in a git worktree that belongs to" +
          " this conversation — read files, grep, edit, build, test. It is real:" +
          " what it changes stays changed. Commit your work on the worktree's" +
          " branch when a task is done, and never push.",
      },
      {
        name: WRITE_TOOL,
        description:
          "Write a whole file in the worktree, creating parent directories. " +
          "Prefer this over a heredoc for anything longer than a line.",
        parameters: {
          type: "object",
          properties: {
            repo: repoParam,
            path: {
              type: "string",
              description: "Path relative to the worktree root.",
            },
            content: {
              type: "string",
              description: "The file's complete new contents.",
            },
          },
          required: only ? ["path", "content"] : ["repo", "path", "content"],
          additionalProperties: false,
        },
        prompt:
          "`repo.write` replaces a file's entire contents — use it instead of" +
          " shell redirection whenever you are writing more than one line.",
      },
    ];
  }

  handles(name: string): boolean {
    return name === EXEC_TOOL || name === WRITE_TOOL;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      if (name === EXEC_TOOL) return await this.exec(args, signal);
      if (name === WRITE_TOOL) return await this.write(args, signal);
      return { ok: false, output: `repo tools do not handle ${name}` };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The repo named, or the only one available. */
  private repoName(args: Record<string, unknown>): string {
    const named = typeof args.repo === "string" ? args.repo : undefined;
    if (named) return named;
    if (this.options.repos.length === 1) return this.options.repos[0];
    throw new Error(
      `name a repo: one of ${this.options.repos.join(", ") || "none available"}`,
    );
  }

  private async exec(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return { ok: false, output: "exec needs a `command`" };

    const repo = this.repoName(args);
    this.options.log?.(
      `[hex] exec (${repo}, ${this.options.requestedBy.slice(0, 8)}…): ${command}`,
    );
    // Before the worktree, not after. `ensure` fetches in the operator's clone
    // and registers a branch and a checkout — everywhere else in this package
    // `--dry-run` means nothing is touched, and trialling this feature safely
    // is the first thing anyone will do with it.
    if (this.options.dryRun)
      return { ok: true, output: "dry run — nothing was executed" };

    const worktree = await this.options.worktrees.ensure(
      this.workspace,
      repo,
      this.options.repos,
    );

    const timeout = this.options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const result = await this.options.backend.run({
      command,
      cwd: worktree.path,
      timeoutMs: timeout,
      // Names the container, so a leftover can be found by the conversation it
      // belonged to rather than by luck.
      id: `${this.workspace}-${repo}`,
      signal,
    });

    // After every command rather than the ones that look like commits: a
    // container writes into its own clone, so without this the branch would only
    // ever exist in there and never where the operator looks for it.
    try {
      await this.options.worktrees.afterCommand?.(worktree);
    } catch {
      // Reported by the manager; the work is not lost, only further away.
    }

    const body = truncateOutput(result.output.trim());
    // Said differently from a timeout, because it means something different: the
    // person changed their mind, and whatever the command had already written to
    // the worktree is still there.
    if (result.aborted)
      return {
        ok: false,
        output: `cancelled — the command was killed. Anything it already wrote is still in the worktree. Output so far:\n${body}`,
      };
    if (result.timedOut)
      return {
        ok: false,
        output: `timed out after ${Math.round(timeout / 1000)}s and was killed. Output so far:\n${body}`,
      };
    return {
      ok: result.code === 0,
      output:
        result.code === 0
          ? body || "(no output)"
          : `exited ${result.code}\n${body}`,
    };
  }

  private async write(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // Refused before it starts, never interrupted midway: aborting a partial
    // file write is how you corrupt the file the model meant to fix.
    if (signal?.aborted)
      return { ok: false, output: "cancelled — nothing was written" };

    const relPath = typeof args.path === "string" ? args.path.trim() : "";
    const content = typeof args.content === "string" ? args.content : undefined;
    if (!relPath) return { ok: false, output: "write needs a `path`" };
    if (content === undefined)
      return { ok: false, output: "write needs `content`" };

    const repo = this.repoName(args);
    if (this.options.dryRun) {
      this.options.log?.(
        `[hex] write (${repo}, ${this.options.requestedBy.slice(0, 8)}…): ${relPath} (${content.length} chars)`,
      );
      return { ok: true, output: "dry run — nothing was written" };
    }

    const worktree = await this.options.worktrees.ensure(
      this.workspace,
      repo,
      this.options.repos,
    );

    // The worktree is the boundary the operator agreed to. A path that climbs
    // out of it is refused whether it meant to or not — `exec` can reach the
    // whole disk anyway, but a tool that silently writes outside the directory
    // it claims to write in is a tool nobody can reason about.
    const target = isAbsolute(relPath)
      ? resolve(relPath)
      : resolve(worktree.path, relPath);
    const inside = relative(worktree.path, target);
    if (inside.startsWith("..") || isAbsolute(inside))
      return {
        ok: false,
        output: `${relPath} is outside the worktree; write paths relative to its root`,
      };

    this.options.log?.(
      `[hex] write (${repo}, ${this.options.requestedBy.slice(0, 8)}…): ${inside} (${content.length} chars)`,
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return { ok: true, output: `wrote ${inside} (${content.length} chars)` };
  }
}
