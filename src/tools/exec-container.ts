/**
 * Running a command in a container, so the daemon's key is out of its reach.
 *
 * This is what makes unsandboxed execution unnecessary rather than merely
 * accepted. The boundary is structural, not a filter: `~/.hex` is not mounted, so
 * there is no nsec to read; the environment is built from a fixed list rather than
 * scrubbed of secrets, so there is no regex to get wrong; and the only writable
 * paths are the conversation's own checkout and its own cache directory.
 *
 * One container per command, with `--rm`. A long-lived one would weaken the
 * promise `repo.exec` already makes — that nothing survives the command — and
 * per-command makes the kernel enforce it instead of a process-group signal.
 * Everything that must persist between commands lives in the mounts: the checkout
 * itself, and the npm cache in the container's home.
 *
 * What it does NOT protect against is in the README beside the config, and it
 * matters: a container is not a VM, the whole committed history of the granted
 * repo is inside it, and on a cloud Linux host `network: "open"` reaches the
 * instance metadata endpoint.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { ContainerConfig, Isolation } from "../config.js";
import {
  spawnCollected,
  type CommandResult,
  type ExecBackend,
  type ExecRequest,
} from "./exec-backend.js";

const run = promisify(execFile);

/** Probing the runtime is local work; it should never take this long. */
const PROBE_TIMEOUT_MS = 30_000;

/** Removing a container the runtime already knows about. */
const REMOVE_TIMEOUT_MS = 30_000;

/** Default cap on processes, so a fork bomb hits a wall rather than the machine. */
const DEFAULT_PIDS_LIMIT = 512;

export interface ContainerBackendOptions {
  config: ContainerConfig;
  /** The conversation's checkout on the host. Mounted at `/work`. */
  mountFor: (request: ExecRequest) => string;
  /** A per-conversation directory mounted as the container's home. */
  homeFor: (request: ExecRequest) => string;
  /** Labelled with the agent's pubkey, so a sweep can find its leftovers. */
  agent: string;
  log?: (line: string) => void;
}

/** Where the checkout and the cache appear inside the container. */
export const WORK_DIR = "/work";
export const HOME_DIR = "/home/hex";

/**
 * The whole argv, as a pure function.
 *
 * Pure because this is where the boundary is actually decided, and a test with no
 * container runtime available must still be able to assert that nothing of the
 * operator's home is mounted and no secret is in the environment.
 */
export function buildRunArgs(
  config: ContainerConfig,
  options: {
    name: string;
    work: string;
    home: string;
    agent: string;
    workspace: string;
    command: string;
    uid: number;
    gid: number;
  },
): string[] {
  return [
    "run",
    "--rm",
    // PID 1 that reaps zombies, so a command's orphans do not accumulate.
    "--init",
    "--name",
    options.name,
    "--label",
    `hex.agent=${options.agent}`,
    "--label",
    `hex.workspace=${options.workspace}`,
    // The host's uid, so files land owned by the operator rather than root —
    // without it they cannot edit what Hex wrote, and git refuses the checkout
    // as dubiously owned.
    "--user",
    `${options.uid}:${options.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(config.pidsLimit ?? DEFAULT_PIDS_LIMIT),
    ...(config.memory ? ["--memory", config.memory] : []),
    ...(config.cpus ? ["--cpus", config.cpus] : []),
    "--network",
    config.network === "none" ? "none" : "bridge",
    "-v",
    `${options.work}:${WORK_DIR}`,
    "-v",
    `${options.home}:${HOME_DIR}`,
    "-w",
    WORK_DIR,
    // Constructed, not inherited. A container has no `~/.gitconfig`, and without
    // an identity `git commit` fails on the last step of every task.
    "-e",
    `HOME=${HOME_DIR}`,
    "-e",
    "TERM=dumb",
    "-e",
    "LANG=C.UTF-8",
    "-e",
    "GIT_AUTHOR_NAME=Hex",
    "-e",
    "GIT_AUTHOR_EMAIL=hex@localhost",
    "-e",
    "GIT_COMMITTER_NAME=Hex",
    "-e",
    "GIT_COMMITTER_EMAIL=hex@localhost",
    // The mount's root arrives owned by root even when its contents are the
    // host uid, so git calls the checkout dubiously owned and refuses EVERY
    // command in it — which is most of a coding task. Passed as config through
    // the environment rather than written into the mounted home, so nothing has
    // to be seeded on disk for git to work.
    "-e",
    "GIT_CONFIG_COUNT=1",
    "-e",
    "GIT_CONFIG_KEY_0=safe.directory",
    "-e",
    `GIT_CONFIG_VALUE_0=${WORK_DIR}`,
    config.image,
    "bash",
    "-lc",
    options.command,
  ];
}

/**
 * A container name that is unique per call and legal for every runtime.
 *
 * The workspace part is a digest, not the id: a room key is
 * `nip-17|<64 hex>-<repo>`, so truncating the readable form to a legal length
 * dropped everything that distinguished one call from another — the repo name and
 * a `-probe` suffix both fell off the end, and two names came out byte-identical.
 * That matters because `onFinish` fires `rm -f <name>` without awaiting it: a name
 * shared with the next container is a `rm` racing a `run`, which kills a command
 * the operator asked for and looks like "the first command in a new DM sometimes
 * dies". The counter is what makes it per-call rather than per-workspace; nothing
 * depends on the name being stable, because `sweep()` matches on the label.
 */
export function containerName(id: string, nth: number, probe = false): string {
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `hex-${digest}-${nth}${probe ? "-probe" : ""}`;
}

export class ContainerBackend implements ExecBackend {
  readonly isolation: Isolation = "container";
  /** Workspaces whose mount has been shown to arrive. Checked once each. */
  private readonly mountChecked = new Set<string>();
  /** Bumped per container, so no two ever share a name. See `containerName`. */
  private calls = 0;

  constructor(private readonly options: ContainerBackendOptions) {}

  /**
   * Prove the checkout actually arrived inside the container.
   *
   * A bind mount of a path the runtime cannot share does not fail — it silently
   * presents an EMPTY directory. Every command then runs in nothing, and the
   * model is told "fatal: not a git repository" about a checkout that is sitting
   * on disk perfectly intact. On macOS this is real and easy to hit: Docker
   * Desktop does not propagate the per-user `/var/folders/…/T` that `tmpdir()`
   * returns, so the whole conversation silently does nothing.
   *
   * Checked once per workspace, and turned into an error that names the cause.
   */
  private async checkMount(request: ExecRequest, work: string): Promise<void> {
    if (this.mountChecked.has(request.id)) return;
    const probe = await this.run(
      { ...request, command: "test -e /work/.git && echo mounted" },
      { skipMountCheck: true },
    );
    if (!probe.output.includes("mounted"))
      throw new Error(
        `the checkout at ${work} is not visible inside the container — the runtime cannot share that path. Move the agent's home somewhere it can (a directory under $HOME), or add the path to the runtime's file sharing.`,
      );
    this.mountChecked.add(request.id);
  }

  /**
   * Refuse to start rather than fall back.
   *
   * There is no code path from here to `bash` on the host — that is the whole
   * guarantee — so a missing runtime or image has to be an error the operator
   * reads, not a quiet downgrade to running as themselves.
   */
  async preflight(): Promise<void> {
    const { runtime, image } = this.options.config;
    try {
      await run(runtime, ["version", "--format", "{{.Server.Version}}"], {
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(
        `container runtime ${runtime} is not usable: ${message(error)}`,
        { cause: error },
      );
    }
    try {
      await run(runtime, ["image", "inspect", image], {
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch {
      throw new Error(
        `container image ${image} is not present — pull it first: ${runtime} pull ${image}`,
      );
    }
  }

  async run(
    request: ExecRequest,
    options: { skipMountCheck?: boolean } = {},
  ): Promise<CommandResult> {
    const { config } = this.options;
    const work = this.options.mountFor(request);
    if (!options.skipMountCheck) await this.checkMount(request, work);

    // `-v` with a source that does not exist does not fail: the daemon CREATES
    // it, and on Linux it creates it as root — while the container runs as the
    // operator's uid, so `/home/hex` comes up unwritable and `npm install` dies
    // on EACCES against its own cache. Made here rather than by the caller so
    // the mount probe is covered by the same line.
    const home = this.options.homeFor(request);
    await mkdir(home, { recursive: true });

    const name = containerName(
      request.id,
      ++this.calls,
      options.skipMountCheck,
    );
    const args = buildRunArgs(config, {
      name,
      work,
      home,
      agent: this.options.agent,
      workspace: request.id,
      command: request.command,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });

    return spawnCollected(config.runtime, args, {
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      // Two kill targets, and this is the trap: SIGKILLing the client that
      // started the container only orphans it. `--rm` covers the happy path;
      // this covers every other one.
      onFinish: () => {
        void run(config.runtime, ["rm", "-f", name], {
          timeout: REMOVE_TIMEOUT_MS,
        }).catch(() => {
          // Already gone, which is what we wanted.
        });
      },
    });
  }

  /**
   * How many leftovers there are, without removing them.
   *
   * `hex check` reports; the daemon sweeps. A check that quietly killed a
   * container belonging to a conversation running in another process would be a
   * surprising thing for a command called "check" to do.
   */
  async leaked(): Promise<number> {
    const { runtime } = this.options.config;
    const { stdout } = await run(
      runtime,
      ["ps", "-aq", "--filter", `label=hex.agent=${this.options.agent}`],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return stdout.split("\n").filter((line) => line.trim() !== "").length;
  }

  /**
   * Remove containers a previous run left behind.
   *
   * A crash between starting a container and removing it leaves one running with
   * a mount into the operator's disk. Swept at startup and reported by
   * `hex check`, because a leaked container is the new leaked process.
   */
  async sweep(): Promise<number> {
    const { runtime } = this.options.config;
    try {
      const { stdout } = await run(
        runtime,
        ["ps", "-aq", "--filter", `label=hex.agent=${this.options.agent}`],
        { timeout: PROBE_TIMEOUT_MS },
      );
      const ids = stdout.split("\n").filter((line) => line.trim() !== "");
      if (ids.length === 0) return 0;
      await run(runtime, ["rm", "-f", ...ids], { timeout: REMOVE_TIMEOUT_MS });
      this.options.log?.(
        `[hex] container: removed ${ids.length} leftover container(s)`,
      );
      return ids.length;
    } catch (error) {
      this.options.log?.(
        `[hex] container: could not sweep — ${message(error)}`,
      );
      return 0;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}
