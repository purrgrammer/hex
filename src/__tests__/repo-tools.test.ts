/**
 * Running commands, against a real git repository.
 *
 * Not mocked: the failure modes worth catching here are git's and the OS's — a
 * branch name git refuses, a worktree that cannot be created twice, a process
 * that ignores SIGTERM — and a fake `execFile` has none of them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HexStore } from "../store.js";
import { WorktreeManager, worktreeName } from "../worktree.js";
import { RepoTools, truncateOutput, scrubEnv } from "../tools/repo-tools.js";
import { EXEC_TOOL, WRITE_TOOL } from "../tools/types.js";

const run = promisify(execFile);

let root: string;
let repo: string;
let worktreeRoot: string;
let store: HexStore;
let manager: WorktreeManager;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hex-repo-"));
  repo = join(root, "origin");
  worktreeRoot = join(root, "worktrees");

  await run("git", ["init", "-q", "-b", "main", repo]);
  await run("git", ["config", "user.email", "hex@example.com"], { cwd: repo });
  await run("git", ["config", "user.name", "Hex"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "hello\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-qm", "first"], { cwd: repo });

  store = HexStore.open(join(root, "data.db"));
  manager = new WorktreeManager({
    store,
    root: worktreeRoot,
    repos: [{ name: "grimoire", path: repo }],
  });
});

afterAll(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

function tools(
  workspace: string,
  repos = ["grimoire"],
  timeoutMs?: number,
  dryRun = false,
) {
  return new RepoTools({
    worktrees: manager,
    repos,
    workspace,
    requestedBy: "f".repeat(64),
    timeoutMs,
    dryRun,
  });
}

describe("worktree naming", () => {
  it("survives a room key git would refuse as a branch", () => {
    // Room keys carry `|`, `'` and `#`; a branch may carry none of them.
    const name = worktreeName("nip-17|abc#0123456789abcdef");
    expect(name).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is stable, so a restart finds the same checkout", () => {
    expect(worktreeName("room-one")).toBe(worktreeName("room-one"));
    expect(worktreeName("room-one")).not.toBe(worktreeName("room-two"));
  });
});

describe("repo.exec", () => {
  it("runs in a worktree of its own, not in the repo", async () => {
    const result = await tools("s1").call(EXEC_TOOL, { command: "pwd" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(worktreeName("s1"));
    expect(result.output).not.toBe(repo);
  });

  it("keeps the same worktree across calls, and records it", async () => {
    await tools("s2").call(EXEC_TOOL, { command: "echo one > scratch.txt" });
    const second = await tools("s2").call(EXEC_TOOL, {
      command: "cat scratch.txt",
    });
    expect(second.output.trim()).toBe("one");

    const stored = store.worktreeFor("s2", "grimoire");
    expect(stored?.branch).toBe(`hex/${worktreeName("s2")}`);
    expect(existsSync(stored?.path ?? "")).toBe(true);
  });

  it("gives two conversations two checkouts", async () => {
    await tools("s3").call(EXEC_TOOL, { command: "echo three > who.txt" });
    const other = await tools("s4").call(EXEC_TOOL, {
      command: "cat who.txt 2>&1; true",
    });
    expect(other.output).not.toContain("three");
  });

  it("reports a non-zero exit as a failure, with the output", async () => {
    const result = await tools("s5").call(EXEC_TOOL, {
      command: "echo boom >&2; exit 3",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("exited 3");
    expect(result.output).toContain("boom");
  });

  it("kills a command that outlives its deadline", async () => {
    const result = await tools("s6", ["grimoire"], 300).call(EXEC_TOOL, {
      command: "sleep 30",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out");
  }, 20_000);

  it("refuses a repo this channel was not granted", async () => {
    const result = await tools("s7", []).call(EXEC_TOOL, {
      repo: "grimoire",
      command: "pwd",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/may not work in/);
    // And nothing was created for it.
    expect(store.worktreeFor("s7", "grimoire")).toBeUndefined();
  });

  it("does not hand the daemon's secrets to what it runs", async () => {
    process.env.HEX_NSEC = "nsec-should-not-leak";
    process.env.HEX_HARMLESS = "fine";
    try {
      const result = await tools("s8").call(EXEC_TOOL, {
        command: 'echo "[$HEX_NSEC][$HEX_HARMLESS]"',
      });
      expect(result.output).toContain("[][fine]");
    } finally {
      delete process.env.HEX_NSEC;
      delete process.env.HEX_HARMLESS;
    }
  });
});

describe("dry run", () => {
  /**
   * `--dry-run` means nothing is touched, and `ensure` touches plenty: it
   * fetches in the operator's live clone and registers a branch and a full
   * checkout. Trialling the feature safely is the first thing anyone does with
   * it, and it used to be the thing that modified their repository.
   */
  it("creates no worktree, no branch, and no row", async () => {
    const before = await run("git", ["branch", "--list", "hex/*"], {
      cwd: repo,
    });

    const exec = await tools("dry-1", ["grimoire"], undefined, true).call(
      EXEC_TOOL,
      { command: "echo should-not-run > proof.txt" },
    );
    expect(exec.ok).toBe(true);
    expect(exec.output).toMatch(/dry run/);

    const write = await tools("dry-1", ["grimoire"], undefined, true).call(
      WRITE_TOOL,
      { path: "proof.txt", content: "no" },
    );
    expect(write.output).toMatch(/dry run/);

    expect(store.worktreeFor("dry-1", "grimoire")).toBeUndefined();
    expect(
      existsSync(join(worktreeRoot, `grimoire-${worktreeName("dry-1")}`)),
    ).toBe(false);
    const after = await run("git", ["branch", "--list", "hex/*"], {
      cwd: repo,
    });
    expect(after.stdout).toBe(before.stdout);
  });
});

describe("what a command leaves behind", () => {
  it("does not wait on a job the command backgrounded", async () => {
    // The shell exits at once while its child holds the inherited pipe. Waiting
    // for `close` waits for the child, which pinned the whole turn — and the
    // room's in-flight gate with it — for the full timeout.
    const started = Date.now();
    const result = await tools("bg-1", ["grimoire"], 10_000).call(EXEC_TOOL, {
      command: "sleep 30 & echo started",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("started");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("reaps it rather than leaving it running", async () => {
    // A dev server left bound to a port with ppid 1, outliving the daemon, is
    // what "ok" used to mean here.
    const marker = join(root, "survivor.txt");
    await tools("bg-2").call(EXEC_TOOL, {
      command: `(sleep 1; echo alive > ${marker}) & echo backgrounded`,
    });
    await new Promise((done) => setTimeout(done, 2_000));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);
});

describe("a worktree deleted by hand", () => {
  it("is rebuilt instead of bricking the conversation", async () => {
    // `rm -rf` is the obvious way to reclaim the disk, and it leaves git's
    // registration behind. Without a prune, every later command in that
    // conversation dies on "missing but already registered worktree".
    await tools("gone-1").call(EXEC_TOOL, { command: "true" });
    const stored = store.worktreeFor("gone-1", "grimoire");
    expect(stored).toBeDefined();
    await rm(stored!.path, { recursive: true, force: true });

    const result = await tools("gone-1").call(EXEC_TOOL, { command: "pwd" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(worktreeName("gone-1"));
  }, 30_000);
});

describe("repo.write", () => {
  it("writes a whole file, creating directories", async () => {
    const result = await tools("s9").call(WRITE_TOOL, {
      path: "src/deep/new.ts",
      content: "export const x = 1;\n",
    });
    expect(result.ok).toBe(true);
    const stored = store.worktreeFor("s9", "grimoire");
    const text = await readFile(join(stored!.path, "src/deep/new.ts"), "utf8");
    expect(text).toBe("export const x = 1;\n");
  });

  it("refuses to climb out of the worktree", async () => {
    const result = await tools("s10").call(WRITE_TOOL, {
      path: "../../escaped.txt",
      content: "no",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/outside the worktree/);
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
  });

  it("refuses an absolute path too", async () => {
    const result = await tools("s11").call(WRITE_TOOL, {
      path: join(root, "absolute.txt"),
      content: "no",
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, "absolute.txt"))).toBe(false);
  });
});

describe("output handling", () => {
  it("keeps both ends of a long output, and says what it dropped", () => {
    const text = "a".repeat(10) + "b".repeat(200_000) + "z".repeat(10);
    const cut = truncateOutput(text);
    expect(cut.startsWith("aaaaaaaaaa")).toBe(true);
    expect(cut.endsWith("zzzzzzzzzz")).toBe(true);
    expect(cut).toContain("characters omitted");
    expect(cut.length).toBeLessThan(text.length);
  });

  it("leaves a short output alone", () => {
    expect(truncateOutput("fine")).toBe("fine");
  });

  it("scrubs anything that looks like a secret", () => {
    const scrubbed = scrubEnv({
      HEX_NSEC: "x",
      OPENAI_API_KEY: "x",
      GITHUB_TOKEN: "x",
      MY_SECRET: "x",
      PASSWORD: "x",
      PATH: "/usr/bin",
    });
    expect(Object.keys(scrubbed)).toEqual(["PATH"]);
  });
});
