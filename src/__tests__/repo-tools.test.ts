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

function tools(sessionId: string, repos = ["grimoire"], timeoutMs?: number) {
  return new RepoTools({
    worktrees: manager,
    repos,
    sessionId,
    requestedBy: "f".repeat(64),
    timeoutMs,
  });
}

describe("worktree naming", () => {
  it("survives a session id git would refuse as a branch", () => {
    // Session ids carry `#` and `:`; a branch may carry neither.
    const name = worktreeName("nip-17|abc#0123456789abcdef");
    expect(name).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is stable, so a restart finds the same checkout", () => {
    expect(worktreeName("session-one")).toBe(worktreeName("session-one"));
    expect(worktreeName("session-one")).not.toBe(worktreeName("session-two"));
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
