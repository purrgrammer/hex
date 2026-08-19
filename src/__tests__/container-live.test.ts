/**
 * The container backend against a real container runtime.
 *
 * Skipped entirely where none is installed — a suite that fails on a machine
 * without Docker is not acceptable — but where one exists these are the only
 * assertions that actually prove the boundary rather than describing it. The
 * argv tests in `exec-container.test.ts` check what we asked for; these check
 * what the kernel gave us.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HexStore } from "../store.js";
import { CloneManager } from "../clone.js";
import { ContainerBackend } from "../tools/exec-container.js";
import { RepoTools } from "../tools/repo-tools.js";
import { EXEC_TOOL } from "../tools/types.js";
import type { ContainerConfig } from "../config.js";

const run = promisify(execFile);

const IMAGE = "node:26-bookworm";

/** Is there a runtime, with the image already pulled? */
function ready(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CONFIG: ContainerConfig = {
  runtime: "docker",
  image: IMAGE,
  network: "none",
};

const AGENT = "d".repeat(64);

let root: string;
let repo: string;
let store: HexStore;
let clones: CloneManager;
let tools: RepoTools;

describe.skipIf(!ready())("a command in a real container", () => {
  beforeAll(async () => {
    /**
     * Under $HOME, not `tmpdir()`.
     *
     * A bind mount of a path the runtime cannot share comes up EMPTY rather than
     * failing, and Docker Desktop on macOS does not propagate the per-user
     * `/var/folders/…/T` that `tmpdir()` returns — so a test there would exercise
     * an empty directory and prove nothing. Production keeps its checkouts under
     * `~/.hex`, which is shared, so this matches it.
     */
    root = await mkdtemp(join(homedir(), ".hex-live-test-"));
    repo = join(root, "origin");
    await run("git", ["init", "-q", "-b", "main", repo]);
    await run("git", ["config", "user.email", "op@example.com"], { cwd: repo });
    await run("git", ["config", "user.name", "Operator"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "hello\n");
    await run("git", ["add", "."], { cwd: repo });
    await run("git", ["commit", "-qm", "first"], { cwd: repo });

    // A secret in the agent's home, exactly where the real one lives, so
    // "unreachable" is tested rather than asserted.
    await writeFile(
      join(root, ".env"),
      "HEX_NSEC=nsec1-must-not-be-readable\n",
    );

    store = HexStore.open(join(root, "data.db"));
    clones = new CloneManager({
      store,
      root: join(root, "clones"),
      repos: [{ name: "grimoire", path: repo }],
    });
    const caches = join(root, "caches");
    tools = new RepoTools({
      worktrees: clones,
      backend: new ContainerBackend({
        config: CONFIG,
        agent: AGENT,
        mountFor: (request) => request.cwd,
        homeFor: (request) => join(caches, request.id, "home"),
      }),
      repos: ["grimoire"],
      workspace: "nip-17|live",
      requestedBy: "e".repeat(64),
      timeoutMs: 120_000,
    });
  }, 120_000);

  afterAll(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("cannot read the agent's home, or anything outside the checkout", async () => {
    const result = await tools.call(EXEC_TOOL, {
      command: `cat ${join(root, ".env")} 2>&1; ls ${root} 2>&1; true`,
    });
    expect(result.output).not.toContain("nsec1-must-not-be-readable");
    expect(result.output).toMatch(/No such file|not found|cannot access/i);
  }, 120_000);

  it("has no environment variable that could hold a secret", async () => {
    const result = await tools.call(EXEC_TOOL, { command: "env | sort" });
    expect(result.output).not.toMatch(/NSEC|API_KEY|SECRET|TOKEN|PASSWORD/i);
    expect(result.output).toContain("HOME=/home/hex");
  }, 120_000);

  it("works as a git repository, and can commit", async () => {
    // The whole point of cloning rather than mounting a worktree: a worktree's
    // `.git` is a file pointing at a path that does not exist in here.
    const result = await tools.call(EXEC_TOOL, {
      command:
        "git log --oneline -1 && echo hi > from-container.txt && git add . && git commit -qm 'from the container' && git rev-parse --short HEAD",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("first");
  }, 120_000);

  it("brings that commit back to the operator's clone", async () => {
    const { stdout } = await run(
      "git",
      ["log", "--oneline", "-1", `hex/${"x"}`.replace(`hex/x`, "hex/")],
      { cwd: repo },
    ).catch(() => ({ stdout: "" }));
    void stdout;
    const record = store.worktreeFor("nip-17|live", "grimoire");
    expect(record).toBeDefined();
    const { stdout: back } = await run(
      "git",
      ["log", "--oneline", "-1", record!.branch],
      {
        cwd: repo,
      },
    );
    expect(back).toContain("from the container");
  }, 120_000);

  it("writes files the operator owns, not root", async () => {
    const record = store.worktreeFor("nip-17|live", "grimoire");
    const { stdout } = await run("stat", [
      "-f",
      "%u",
      join(record!.path, "from-container.txt"),
    ]);
    expect(Number(stdout.trim())).toBe(process.getuid?.());
  }, 120_000);

  it("keeps node_modules between commands", async () => {
    await tools.call(EXEC_TOOL, {
      command: "mkdir -p node_modules/marker && echo 1 > node_modules/marker/x",
    });
    const second = await tools.call(EXEC_TOOL, {
      command: "cat node_modules/marker/x",
    });
    expect(second.output.trim()).toBe("1");
  }, 120_000);

  it("has no network when told it has none", async () => {
    const result = await tools.call(EXEC_TOOL, {
      command: "getent hosts registry.npmjs.org 2>&1; true",
    });
    // Nothing resolved. An empty result comes back as the literal "(no output)",
    // which is the tool being explicit rather than handing the model a blank.
    expect(result.output).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  }, 120_000);

  it("leaves no container behind, even when killed by its deadline", async () => {
    const brief = new RepoTools({
      worktrees: clones,
      backend: new ContainerBackend({
        config: CONFIG,
        agent: AGENT,
        mountFor: (request) => request.cwd,
        homeFor: (request) => join(root, "caches", request.id, "home"),
      }),
      repos: ["grimoire"],
      workspace: "nip-17|live",
      requestedBy: "e".repeat(64),
      timeoutMs: 3_000,
    });
    const result = await brief.call(EXEC_TOOL, { command: "sleep 120" });
    expect(result.ok).toBe(false);

    // `--rm` covers a clean exit; SIGKILLing the client only orphans the
    // container, so this is the assertion that the second kill target works.
    await new Promise((done) => setTimeout(done, 2_000));
    const { stdout } = await run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=hex.agent=${AGENT}`,
    ]);
    expect(stdout.trim()).toBe("");
  }, 180_000);

  it("still has the checkout on the host afterwards", () => {
    const record = store.worktreeFor("nip-17|live", "grimoire");
    expect(existsSync(join(record!.path, "from-container.txt"))).toBe(true);
  });
});
