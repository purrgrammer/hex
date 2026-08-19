/**
 * Running a command as the operator, in a worktree on their own machine.
 *
 * No isolation, deliberately and with the operator's agreement: this is fast,
 * shares their toolchain, and anything it runs can read the daemon's secrets off
 * disk. What it still does is bound each call — see `exec-backend.ts` — and put
 * the daemon's own node on the child's path, because under a supervisor there is
 * no login shell and no version manager.
 */

import { dirname } from "node:path";
import type { Isolation } from "../config.js";
import {
  spawnCollected,
  type CommandResult,
  type ExecBackend,
  type ExecRequest,
} from "./exec-backend.js";

/** Names whose values the daemon holds and a child has no business reading. */
const SECRET_ENV = /NSEC|API_KEY|SECRET|TOKEN|PASSWORD/i;

export function scrubEnv(
  env: NodeJS.ProcessEnv,
  /** Where the running node lives. Injected so the test does not need nvm. */
  nodeBin = dirname(process.execPath),
): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env))
    if (!SECRET_ENV.test(key)) copy[key] = value;

  /**
   * The toolchain Hex runs is the one Hex is running on.
   *
   * Under a supervisor there is no login shell and no version manager: launchd
   * hands the daemon a minimal PATH, `bash -lc` does not source the operator's
   * nvm setup, and every command Hex was asked to run died on
   * `npm: command not found` — a coding agent that cannot build or test. The
   * plist names an absolute node, so the directory beside it has npm and npx in
   * it; putting that on the path is both the fix and the honest answer to
   * "which node does the agent use".
   */
  const path = copy.PATH ?? "";
  if (!path.split(":").includes(nodeBin))
    copy.PATH = path ? `${nodeBin}:${path}` : nodeBin;
  return copy;
}

export class HostBackend implements ExecBackend {
  readonly isolation: Isolation = "host-worktree";

  /** Nothing to check: bash is the machine's, and it is already running Hex. */
  async preflight(): Promise<void> {}

  run(request: ExecRequest): Promise<CommandResult> {
    return spawnCollected("bash", ["-lc", request.command], {
      cwd: request.cwd,
      env: scrubEnv(process.env),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
  }
}
