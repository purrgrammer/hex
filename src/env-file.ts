/**
 * Loading `.env` beside the config.
 *
 * The config names env vars rather than holding secrets, which leaves the
 * question of who sets them. A `.env` next to the config is where people
 * actually put them, so Hex reads one if it is there — and nothing else changes:
 * the config still names the variable, and a variable already set in the real
 * environment always wins over the file.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

export interface EnvFileResult {
  /** Absolute path of the file that was read, or null if there was none. */
  path: string | null;
  /** Names it defined that were applied. Never values — these are secrets. */
  applied: string[];
  /** Names it defined that the real environment already had, so were ignored. */
  skipped: string[];
}

/**
 * Apply `<baseDir>/.env` (or `explicitPath`) to `process.env`.
 *
 * A missing file is not an error unless it was asked for by name: `--env-file`
 * pointing at nothing is a typo, and silently continuing produces an agent that
 * cannot find its key for reasons nobody can see.
 */
export async function loadEnvFile(
  baseDir: string,
  explicitPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnvFileResult> {
  const path = explicitPath
    ? resolve(baseDir, explicitPath)
    : join(baseDir, ".env");

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!explicitPath) return { path: null, applied: [], skipped: [] };
    throw new Error(
      `--env-file could not be read (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const parsed = parseEnv(text) as Record<string, string>;
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [name, value] of Object.entries(parsed)) {
    // The ambient environment is the more explicit of the two: someone who
    // exported a key for one run should not be overridden by a stale file.
    if (env[name] !== undefined) {
      skipped.push(name);
      continue;
    }
    env[name] = value;
    applied.push(name);
  }

  return { path, applied, skipped };
}
