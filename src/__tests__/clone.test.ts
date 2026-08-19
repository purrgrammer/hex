/**
 * The checkout container mode uses, against a real git repository.
 *
 * Two assertions here carry the whole design and neither needs a container: that
 * the clone's `.git` is a DIRECTORY, which is why one bind mount is enough, and
 * that nothing in it shares an inode with the operator's repository, which is why
 * a command running as their uid cannot corrupt it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HexStore } from "../store.js";
import { CloneManager } from "../clone.js";
import { WorktreeManager, worktreeName } from "../worktree.js";

const run = promisify(execFile);

let root: string;
let repo: string;
let store: HexStore;
let clones: CloneManager;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hex-clone-"));
  repo = join(root, "origin");

  await run("git", ["init", "-q", "-b", "main", repo]);
  await run("git", ["config", "user.email", "hex@example.com"], { cwd: repo });
  await run("git", ["config", "user.name", "Hex"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "first"], { cwd: repo });
  // A second commit, so branching from a named SHA is distinguishable from HEAD.
  await writeFile(join(repo, "second.md"), "two\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "second"], { cwd: repo });

  store = HexStore.open(join(root, "data.db"));
  clones = new CloneManager({
    store,
    root: join(root, "clones"),
    repos: [{ name: "grimoire", path: repo }],
  });
});

afterAll(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("a clone for a container", () => {
  it("has a real .git directory, so one bind mount is enough", async () => {
    // A worktree's `.git` is a FILE pointing into the operator's repository, so a
    // container with only the worktree mounted gets a directory where every git
    // command fails. This is the assertion that says we did not do that.
    const record = await clones.ensure("room-a", "grimoire", ["grimoire"]);
    expect(statSync(join(record.path, ".git")).isDirectory()).toBe(true);

    const { stdout } = await run("git", ["log", "--oneline", "-1"], {
      cwd: record.path,
    });
    expect(stdout.trim()).toContain("second");
  }, 60_000);

  it("shares no inode with the operator's repository", async () => {
    // `git clone --local` hardlinks packfiles, and the container runs as the host
    // uid — writing through a shared inode would corrupt their repo.
    const record = await clones.ensure("room-b", "grimoire", ["grimoire"]);
    const { stdout } = await run("find", [
      join(record.path, ".git", "objects"),
      "-type",
      "f",
      "-links",
      "+1",
    ]);
    expect(stdout.trim()).toBe("");
  }, 60_000);

  it("is on its own branch, named from the room", async () => {
    const record = await clones.ensure("room-c", "grimoire", ["grimoire"]);
    expect(record.branch).toBe(`hex/${worktreeName("room-c")}`);
    const { stdout } = await run("git", ["branch", "--show-current"], {
      cwd: record.path,
    });
    expect(stdout.trim()).toBe(record.branch);
  }, 60_000);

  it("lives somewhere a worktree never would", async () => {
    // A Linux container leaves ELF `.node` binaries in node_modules that would
    // break the operator on macOS, so the two roots must never collide.
    const record = await clones.ensure("room-d", "grimoire", ["grimoire"]);
    expect(record.path).toContain("/clones/");
    expect(record.path).not.toContain("/worktrees/");
    expect(record.isolation).toBe("container");
  }, 60_000);

  it("brings committed work back to the operator's clone", async () => {
    // The branch would otherwise exist only inside the private clone, and the
    // operator expects to find it where every other Hex branch is.
    const record = await clones.ensure("room-e", "grimoire", ["grimoire"]);
    await writeFile(join(record.path, "from-hex.md"), "work\n");
    await run("git", ["add", "."], { cwd: record.path });
    await run("git", ["commit", "-qm", "work from hex"], { cwd: record.path });
    const { stdout: local } = await run("git", ["rev-parse", "HEAD"], {
      cwd: record.path,
    });

    // Through the interface the tool actually calls, not the method directly.
    await clones.afterCommand(record);

    const { stdout: back } = await run("git", ["rev-parse", record.branch], {
      cwd: repo,
    });
    expect(back.trim()).toBe(local.trim());
  }, 60_000);

  it("moves nothing when nothing new was committed", async () => {
    // This runs after every command, and most commands are a grep.
    const record = await clones.ensure("room-i", "grimoire", ["grimoire"]);
    await clones.afterCommand(record);
    const { stdout } = await run("git", ["branch", "--list", record.branch], {
      cwd: repo,
    });
    expect(stdout.trim()).toBe("");
  }, 60_000);

  it("rebuilds a clone someone deleted by hand", async () => {
    const first = await clones.ensure("room-f", "grimoire", ["grimoire"]);
    await rm(first.path, { recursive: true, force: true });
    const again = await clones.ensure("room-f", "grimoire", ["grimoire"]);
    expect(existsSync(again.path)).toBe(true);
  }, 60_000);

  it("refuses a repo the channel was not granted", async () => {
    await expect(clones.ensure("room-g", "grimoire", [])).rejects.toThrow(
      /may not work in/,
    );
    expect(store.worktreeFor("room-g", "grimoire")).toBeUndefined();
  });

  it("refuses to reuse a checkout the other backend made", async () => {
    // Silently handing this conversation a second, empty checkout would leave its
    // work somewhere it has no reason to look.
    const worktrees = new WorktreeManager({
      store,
      root: join(root, "worktrees"),
      repos: [{ name: "grimoire", path: repo }],
    });
    await worktrees.ensure("room-h", "grimoire", ["grimoire"]);

    await expect(
      clones.ensure("room-h", "grimoire", ["grimoire"]),
    ).rejects.toThrow(/made for host-worktree/);
  }, 60_000);
});
