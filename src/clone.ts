/**
 * A private clone per conversation, for work that runs in a container.
 *
 * Container mode cannot use `git worktree`, and this is the reason rather than a
 * preference. A worktree's `.git` is a FILE holding an absolute path into
 * `<main>/.git/worktrees/<name>`, so a container with only the worktree mounted
 * gets a directory where every git command fails — and mounting the main `.git`
 * writable would hand it `hooks/` and `config` in the operator's own clone, which
 * is host code execution the next time they run `git status`.
 *
 * `git clone` gives a real `.git` DIRECTORY instead: self-contained, one bind
 * mount, nothing of the operator's filesystem inside.
 *
 * `--no-hardlinks` is mandatory, not tidiness. A local clone hardlinks packfiles,
 * and the container runs as the host uid — so writing through a shared inode
 * corrupts the operator's repository. The copy costs a second or two per
 * conversation, once.
 *
 * Kept in a separate root from `worktrees/` because a Linux container leaves ELF
 * `.node` binaries in `node_modules` that would break the operator on macOS, and
 * because a conversation must never silently change which kind of checkout it has.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoConfig } from "./config.js";
import type { HexStore, StoredWorktree } from "./store.js";
import { fetchTarget, listRemotes, worktreeName } from "./worktree.js";

const run = promisify(execFile);

/** Cloning is local work, but a big repo is not instant. */
const GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * The shape both checkout managers satisfy.
 *
 * Structural rather than a base class: the two share a store row and a hash and
 * nothing else, and the differences (worktree versus clone, fetch-back versus
 * none) are the whole point of having two.
 */
export interface Checkout {
  ensure(
    workspace: string,
    repo: string,
    allowed: string[],
  ): Promise<StoredWorktree>;
  repo(name: string): RepoConfig | undefined;
  names(): string[];
  /**
   * Called after a command that may have committed something.
   *
   * A worktree has nothing to do — it already lives inside the operator's
   * repository — so this is optional rather than a no-op every backend must
   * implement.
   */
  afterCommand?(record: StoredWorktree): Promise<void>;
}

export interface CloneOptions {
  store: HexStore;
  /** `<home>/<pubkey>/clones`. */
  root: string;
  repos: RepoConfig[];
  log?: (line: string) => void;
  now?: () => number;
}

export class CloneManager implements Checkout {
  constructor(private readonly options: CloneOptions) {}

  repo(name: string): RepoConfig | undefined {
    return this.options.repos.find((repo) => repo.name === name);
  }

  names(): string[] {
    return this.options.repos.map((repo) => repo.name);
  }

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
    if (existing && existsSync(existing.path)) {
      // A conversation that changed isolation would otherwise get a second,
      // empty checkout and no explanation for where its work went.
      if (existing.isolation && existing.isolation !== "container")
        throw new Error(
          `this conversation's ${repoName} checkout was made for ${existing.isolation} (${existing.path}) but the toolset now says container — start a new conversation, or move the work; nothing was run`,
        );
      return existing;
    }

    const hash = worktreeName(workspace);
    const branch = `hex/${hash}`;
    const path = join(this.options.root, `${repoName}-${hash}`);

    if (!existsSync(path)) {
      await mkdir(this.options.root, { recursive: true });

      // Best effort, same as a worktree: a clone with no reachable remote still
      // gets its checkout, from whatever is on disk.
      try {
        const remotes = await listRemotes(repo.path);
        await run(
          "git",
          ["fetch", "--quiet", ...fetchTarget(repo.baseRef, remotes)],
          { cwd: repo.path, timeout: GIT_TIMEOUT_MS },
        );
      } catch (error) {
        this.options.log?.(
          `[hex] clone ${repoName}: could not fetch — branching from what is on disk (${message(error)})`,
        );
      }

      // Resolved on the host, to a SHA, before cloning: inside a clone of a
      // clone, `origin/main` means the SOURCE clone's local `main`, which is not
      // what `baseRef` was asked to mean.
      const base = repo.baseRef ?? "HEAD";
      const { stdout } = await run("git", ["rev-parse", base], {
        cwd: repo.path,
        timeout: GIT_TIMEOUT_MS,
      });
      const sha = stdout.trim();

      this.options.log?.(
        `[hex] clone ${repoName}: creating ${path} on ${branch} from ${base} (${sha.slice(0, 8)})`,
      );
      await run(
        "git",
        ["clone", "--no-hardlinks", "--quiet", repo.path, path],
        {
          timeout: GIT_TIMEOUT_MS,
        },
      );
      await run("git", ["checkout", "--quiet", "-b", branch, sha], {
        cwd: path,
        timeout: GIT_TIMEOUT_MS,
      });
    }

    const record: StoredWorktree = {
      workspace,
      repo: repoName,
      path,
      branch,
      createdAt: this.options.now?.() ?? Math.floor(Date.now() / 1000),
      isolation: "container",
    };
    this.options.store.recordWorktree(record);
    return record;
  }

  /**
   * Bring committed work back to the operator's clone.
   *
   * The container writes into its own clone, so `hex/<hash>` would otherwise only
   * exist inside it — and the operator expects to find the branch where every
   * other Hex branch is. Only committed work travels: uncommitted changes stay in
   * the clone, which is where the agent left them.
   *
   * Failing is survivable and is logged rather than thrown: the work is not lost,
   * it is one directory further away than usual.
   */
  async afterCommand(record: StoredWorktree): Promise<void> {
    return this.fetchBack(record);
  }

  async fetchBack(record: StoredWorktree): Promise<void> {
    const repo = this.repo(record.repo);
    if (!repo) return;
    try {
      const tip = await head(record.path, record.branch);
      if (!tip) return;
      const theirs = await head(repo.path, record.branch);
      // Already in step. Compared by tip rather than by "do they have this
      // commit": an amend or a reset leaves the operator holding a commit they
      // certainly have, on a branch pointing somewhere else, and the old check
      // read that as nothing to do.
      if (theirs === tip) return;
      // No branch of ours there yet, and they already have this commit: the
      // conversation has run commands but committed nothing. Without this every
      // grep would plant a branch in their repository for work that never
      // happened.
      if (!theirs && (await hasCommit(repo.path, tip))) return;
      await run(
        "git",
        [
          "fetch",
          "--quiet",
          record.path,
          // Forced, because the normal review loop rewrites history: Hex commits,
          // the peer asks for a change, Hex amends — and a fast-forward-only
          // fetch is refused from then on, leaving the operator a branch that
          // looks like Hex's work and is the superseded version. `hex/<hash>` is
          // Hex's own namespace; if the operator committed on it themselves the
          // reflog still holds it. Fetching into a branch they have checked out
          // is still refused by git, and still logged below.
          `+${record.branch}:${record.branch}`,
        ],
        { cwd: repo.path, timeout: GIT_TIMEOUT_MS },
      );
    } catch (error) {
      this.options.log?.(
        `[hex] clone ${record.repo}: could not bring ${record.branch} back — it is still in ${record.path} (${message(error)})`,
      );
    }
  }
}

/** Does this repository already have that commit? */
async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  try {
    await run("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** A branch's commit, or undefined if it does not exist there. */
async function head(cwd: string, branch: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", branch], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}
