/**
 * Where a command actually runs, as an interface with two implementations.
 *
 * The collecting and killing is shared rather than reimplemented per backend,
 * because every guarantee `repo.exec` makes lives in it: output bounded in memory
 * and truncated at both ends, a wall clock that kills the process group, nothing
 * left running when the command returns, and `exit` rather than `close` so a
 * backgrounded grandchild cannot hold the turn open. A second copy of that would
 * drift, and the drift would be silent.
 */

import { spawn } from "node:child_process";
import type { Isolation } from "../config.js";

export interface ExecRequest {
  command: string;
  /** The host directory the command works in. */
  cwd: string;
  timeoutMs: number;
  /** Distinguishes concurrent commands. Used to name a container. */
  id: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  code: number;
  output: string;
  timedOut: boolean;
  /** Killed because the caller withdrew the request, not because it hung. */
  aborted?: boolean;
}

export interface ExecBackend {
  readonly isolation: Isolation;
  /**
   * Fail now, with the runtime's own words, if this backend cannot run.
   *
   * Called at startup and by `hex check`, because a daemon that boots and then
   * fails every command is indistinguishable from a broken bot.
   */
  preflight(): Promise<void>;
  run(request: ExecRequest): Promise<CommandResult>;
}

/** What comes back to the model. Beyond this the middle is dropped, and said so. */
export const MAX_OUTPUT_CHARS = 50_000;

/**
 * How long to keep reading output after the command itself has exited.
 *
 * A shell that backgrounds something exits immediately while its child holds the
 * inherited pipe open, so waiting for `close` waits for the background job, which
 * is forever. Waiting for `exit` instead can clip the last chunk, so the pipes get
 * this long to drain and no longer.
 */
const FLUSH_GRACE_MS = 250;

/** Keep the head and the tail: a failure's cause is at one end or the other. */
export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n\n… ${dropped} characters omitted …\n\n${text.slice(-half)}`;
}

export interface SpawnedOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Killed on the way out, whatever the reason.
   *
   * The host backend has nothing to add; the container backend has to remove the
   * container, because SIGKILLing the client that started it only orphans it.
   */
  onFinish?: () => void;
}

/**
 * Run one process and collect what it said.
 *
 * stdout and stderr are interleaved into one stream because that is how a person
 * reads a build log, and separating them loses which warning belonged to which
 * step.
 */
export function spawnCollected(
  file: string,
  args: string[],
  options: SpawnedOptions,
): Promise<CommandResult> {
  // Nothing is spawned for a request that was already withdrawn.
  if (options.signal?.aborted)
    return Promise.resolve({
      code: -1,
      output: "",
      timedOut: false,
      aborted: true,
    });

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      // Its own process group, so one signal reaches everything the command
      // started rather than only the shell that started it.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (chunk: Buffer) => {
      output += chunk.toString();
      // Bounded in memory too, not just on the way out: a runaway loop printing
      // for fifteen minutes should not grow the daemon's heap without limit.
      if (output.length > MAX_OUTPUT_CHARS * 4)
        output = output.slice(-MAX_OUTPUT_CHARS * 2);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the outcome we wanted anyway.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);

    // Without this a fifteen-minute ceiling makes cancelling cosmetic: the room
    // would be released while the command carried on.
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The signal outlives the command by design; a listener left on it leaks.
      options.signal?.removeEventListener("abort", onAbort);
      killGroup();
      options.onFinish?.();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, output, timedOut, aborted });
    };

    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(-1);
    });
    // `exit`, not `close`: close waits for every holder of the pipe, and a
    // backgrounded grandchild is one.
    child.on("exit", (code) => {
      setTimeout(() => finish(code ?? -1), FLUSH_GRACE_MS);
    });
  });
}
