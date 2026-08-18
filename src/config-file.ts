/** Config IO, kept out of `config.ts` so the parser tests need no disk. */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ConfigError, parseConfigText, type HexConfig } from "./config.js";

export interface LoadedConfig {
  config: HexConfig;
  /** Absolute path of the config file. */
  path: string;
  /** Its directory — every relative path in the config resolves against this. */
  baseDir: string;
  /** `instructions` file contents, or "" when none was configured. */
  instructions: string;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const full = resolve(path);
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch (error) {
    throw new ConfigError(
      `cannot read ${full}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const config = parseConfigText(text);
  const baseDir = dirname(full);

  let instructions = "";
  if (config.instructions) {
    const instructionsPath = resolve(baseDir, config.instructions);
    try {
      instructions = await readFile(instructionsPath, "utf8");
    } catch (error) {
      throw new ConfigError(
        `instructions file cannot be read (${instructionsPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { config, path: full, baseDir, instructions };
}
