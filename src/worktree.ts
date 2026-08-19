/**
 * A checkout per conversation.
 *
 * Work Hex is asked to do in a DM happens in a git worktree of the named repo,
 * not in the repo itself: the operator is probably using that clone right now,
 * and a bot running `git checkout` underneath them is a bad afternoon. One
 * worktree per (room, repo), created on the first command and reused for every
 * later one — including after a restart, because the mapping is a row in SQLite
 * rather than a guess about what is on disk.
 *
 * Keyed by ROOM and not by session, which turns over on a quiet half hour: a
 * peer who came back after a long build got a second empty checkout and no
 * memory of the work they were asking about.
 *
 * Branches are named `hex/<hash>`. Two reasons it is hashed rather than
 * slugified: a room key contains `|` and `'`, which git refuses in a ref, and a
 * branch can be checked out in exactly one worktree at a time — so
 * a collision is not a cosmetic problem, it is a worktree that cannot be
 * created. This repository already carries a dozen worktrees; the hash keeps
 * Hex's out of everyone's way.
 *
 * Nothing here deletes anything. A conversation that ended still has work in it
 * that only the operator can judge, and reclaiming disk is their call.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "./config.js";
import type { HexStore, StoredWorktree } from "./store.js";

const run = promisify(execFile);

/** Long enough that a collision is not a thing, short enough to read in a log. */
const HASH_CHARS = 12;

/** Creating a worktree is local git work; it should never take this long. */
const GIT_TIMEOUT_MS = 60_000;

export function worktreeName(workspace: string): string {
  return createHash("sha256")
    .update(workspace)
    .digest("hex")
    .slice(0, HASH_CHARS);
}

/**
 * Which remote to bring up to date before branching.
 *
 * `--all` fails as a whole if ANY remote fails, and a clone can easily carry one
 * that a supervised daemon cannot reach — this repository has both an SSH remote
 * (no agent under launchd) and a `nostr://` one needing a custom helper. So fetch
 * only the remote `baseRef` actually names.
 *
 * The remote has to be one that EXISTS, not merely the text before a slash: a
 * local branch called `feature/x` is not a remote called `feature`, and guessing
 * turned a fetch that would have worked into one that always fails and then
 * silently branches from a stale tree.
 */
export function fetchTarget(
  baseRef: string | undefined,
  remotes: string[],
): string[] {
  const candidate = baseRef?.includes("/") ? baseRef.split("/")[0] : undefined;
  return candidate && remotes.includes(candidate) ? [candidate] : ["--all"];
}

/** The clone's remotes, or none if git cannot say. */
export async function listRemotes(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["remote"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

export interface WorktreeOptions {
  store: HexStore;
  /** `<home>/<pubkey>/worktrees`. */
  root: string;
  repos: RepoConfig[];
  log?: (line: string) => void;
  now?: () => number;
}

export class WorktreeManager {
  constructor(private readonly options: WorktreeOptions) {}

  /** The repos this manager knows, by name. */
  repo(name: string): RepoConfig | undefined {
    return this.options.repos.find((repo) => repo.name === name);
  }

  names(): string[] {
    return this.options.repos.map((repo) => repo.name);
  }

  /**
   * The worktree this session works in, made if it does not exist yet.
   *
   * `allowed` is the caller's grant, checked here as well as at the tool: this
   * is the function that creates a directory and a branch, and it should not be
   * possible to reach it for a repo the channel was never given.
   */
  async ensure(
    workspace: string,
    repoName: string,
    allowed: string[],
  ): Promise<StoredWorktree> {
    if (!allowed.includes(repoName))
      throw new Error(
        `this conversation may not work in "${repoName}" (allowed: ${allowed.join(", ") || "none"})`,
      );
    const repo = this.repo(repoName);
    if (!repo)
      throw new Error(
        `no repo named "${repoName}" is configured (known: ${this.names().join(", ") || "none"})`,
      );

    const existing = this.options.store.worktreeFor(workspace, repoName);
    // A row whose directory is gone — someone tidied up, or a disk moved — is
    // stale, not authoritative. Rebuild at the same path and branch.
    if (existing && existsSync(existing.path)) return existing;

    const hash = worktreeName(workspace);
    const branch = `hex/${hash}`;
    const path = join(this.options.root, `${repoName}-${hash}`);

    if (!existsSync(path)) {
      // A clone the operator has not pulled in a week is what a new
      // conversation would otherwise branch from, and every task after that
      // reads and edits an old tree while reporting it as current. Best effort:
      // a repo with no remote, or no network, still gets its worktree.
      try {
        const remotes = await listRemotes(repo.path);
        await run(
          "git",
          ["fetch", "--quiet", ...fetchTarget(repo.baseRef, remotes)],
          { cwd: repo.path, timeout: GIT_TIMEOUT_MS },
        );
      } catch (error) {
        this.options.log?.(
          `[hex] worktree ${repoName}: could not fetch — branching from what is on disk (${
            error instanceof Error ? error.message.split("\n")[0] : error
          })`,
        );
      }

      // `baseRef` is where new work starts. Name a remote-tracking ref
      // (`origin/main`) to branch from what was just fetched; without one this
      // is the clone's current HEAD, whatever the operator left checked out.
      const base = repo.baseRef ?? "HEAD";
      this.options.log?.(
        `[hex] worktree ${repoName}: creating ${path} on ${branch} from ${base}`,
      );
      // `rm -rf` on a worktree directory — the obvious way to reclaim disk —
      // leaves git's registration behind, and every later command in that
      // conversation then dies on "missing but already registered worktree".
      // Pruning first costs nothing and is the difference between a tidy-up and
      // a permanently broken conversation.
      try {
        await run("git", ["worktree", "prune"], {
          cwd: repo.path,
          timeout: GIT_TIMEOUT_MS,
        });
      } catch {
        // Nothing to prune, or a git too old to care. Either way, carry on.
      }

      try {
        await run("git", ["worktree", "add", "-b", branch, path, base], {
          cwd: repo.path,
          timeout: GIT_TIMEOUT_MS,
        });
      } catch (error) {
        // The branch outlived its worktree — a conversation resumed after the
        // checkout was deleted. Reuse it rather than failing every command from
        // here on; the work that was committed to it is still there.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already exists")) throw error;
        await run("git", ["worktree", "add", path, branch], {
          cwd: repo.path,
          timeout: GIT_TIMEOUT_MS,
        });
      }
    }

    const record: StoredWorktree = {
      workspace,
      repo: repoName,
      path,
      branch,
      createdAt: this.options.now?.() ?? Math.floor(Date.now() / 1000),
    };
    this.options.store.recordWorktree(record);
    return record;
  }
}
