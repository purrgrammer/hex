/**
 * Config → brain.
 *
 * The one place a `brain` block becomes something that can answer. It resolves
 * the API key from the environment HERE, at startup, so a missing key is a
 * startup failure with the variable's name in it rather than a room where Hex
 * silently never replies.
 */

import type { BrainConfig } from "../config.js";
import type { Brain } from "./types.js";
import { EchoBrain } from "./echo.js";
import { OpenAICompatibleBrain } from "./openai-compatible.js";

export interface CreateBrainOptions {
  /** Hex's own pubkey, so its prior lines are labelled as its own. */
  selfPubkey?: string;
  /** Where the brain's own notes go — the plain-text fallback announces itself. */
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Force the echo brain — `--brain echo`, for smoke tests. */
  override?: "echo";
}

export function createBrain(
  config: BrainConfig,
  options: CreateBrainOptions = {},
): Brain {
  const env = options.env ?? process.env;

  if (options.override === "echo" || config.type === "echo")
    return new EchoBrain();

  const headers: Record<string, string> = {};
  for (const [header, envName] of Object.entries(config.headerEnv ?? {})) {
    const value = env[envName];
    if (!value)
      throw new Error(
        `brain.headerEnv.${header} names $${envName}, which is unset`,
      );
    headers[header] = value;
  }

  let apiKey: string | undefined;
  if (config.apiKeyEnv) {
    apiKey = env[config.apiKeyEnv];
    if (!apiKey)
      throw new Error(
        `brain.apiKeyEnv names $${config.apiKeyEnv}, which is unset or empty`,
      );
  }

  return new OpenAICompatibleBrain(
    {
      // Both are required by the parser for this brain type.
      baseUrl: config.baseUrl!,
      model: config.model!,
      apiKey,
      headers,
      maxTokens: config.maxTokens,
      maxSteps: config.maxSteps,
      toolChoice: config.toolChoice,
      temperature: config.temperature,
      log: options.log,
    },
    options.selfPubkey,
  );
}
