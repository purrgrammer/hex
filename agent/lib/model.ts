/**
 * Which model this agent runs on, decided by configuration rather than by code.
 *
 * The provider used to be a literal in `agent.ts`, which made "try it on
 * something else" an edit, a review and a redeploy. It is a deployment
 * decision, not a design one — the same agent, the same tools, the same
 * instructions, a different engine — so it lives in the environment.
 *
 * Everything eve accepts is reachable from here, because eve accepts exactly
 * two things and this returns both:
 *
 * - a **bare model id**, which the AI SDK routes through the Vercel AI Gateway.
 *   This is the widest surface by far: every model the gateway lists, with no
 *   provider package installed and no key of your own, and eve looks the
 *   context window up in the gateway's catalogue so nothing has to state it.
 * - a **provider instance**, which talks to the provider directly with your own
 *   key. Nothing looks a direct provider up, so the context window has to be
 *   stated — being wrong there means compacting at the wrong point or not at
 *   all, so an unknown model with no stated window is refused rather than
 *   guessed at.
 *
 * ## Configuration
 *
 * | variable | meaning |
 * | --- | --- |
 * | `HEX_MODEL` | `anthropic/claude-sonnet-5` (gateway) · `anthropic:claude-sonnet-5` (direct) · `openai:gpt-5` · `openai-compatible:moonshotai/kimi-k3` |
 * | `HEX_MODEL_API_KEY` | the key, for a direct provider. Falls back to the provider's own variable |
 * | `HEX_MODEL_BASE_URL` | required by `openai-compatible:`, which is any OpenAI-shaped endpoint |
 * | `HEX_MODEL_CONTEXT` | context window in tokens. Required for a direct provider this file does not know |
 * | `HEX_MODEL_NAME` | what to call an `openai-compatible:` provider in traces. Cosmetic |
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Context windows for models this file can be sure of.
 *
 * Only consulted for a DIRECT provider, where nothing else knows. A gateway id
 * never reaches this — eve reads the catalogue, which is authoritative and
 * current in a way a table in a repository cannot be.
 *
 * Sonnet's million-token window is a separate beta tier and is deliberately not
 * claimed here; a deployment on it says so with `HEX_MODEL_CONTEXT`.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-5": 200_000,
  "claude-sonnet-5": 200_000,
  "claude-fable-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "moonshotai/kimi-k3": 1_048_576,
};

export interface ModelChoice {
  model: string | LanguageModel;
  /** Omitted for a gateway id, where eve's own lookup is better than a guess. */
  modelContextWindowTokens?: number;
}

/** What `HEX_MODEL` says, split into a provider and a model id. */
function split(spec: string): { provider?: string; id: string } {
  const at = spec.indexOf(":");
  // A colon, not a slash: `anthropic/claude-sonnet-5` IS a gateway id, and
  // splitting on the slash would turn every gateway id into a direct call.
  if (at === -1) return { id: spec };
  return { provider: spec.slice(0, at), id: spec.slice(at + 1) };
}

function contextWindow(id: string): number {
  const stated = Number(process.env.HEX_MODEL_CONTEXT);
  if (Number.isFinite(stated) && stated > 0) return stated;
  const known = CONTEXT_WINDOWS[id];
  if (known) return known;
  throw new Error(
    `HEX_MODEL names ${id} directly, and nothing here knows its context window. ` +
      `Set HEX_MODEL_CONTEXT to the number of tokens it takes — eve compacts ` +
      `against that figure, so a guess is worse than a refusal.`,
  );
}

export function chooseModel(): ModelChoice {
  const spec = process.env.HEX_MODEL?.trim();
  /**
   * No configuration is not an error.
   *
   * The account that has driven this agent from the start is an
   * OpenAI-compatible one, and a deployment that says nothing keeps running on
   * it — a config file that has to be complete before anything works is a config
   * file nobody can adopt incrementally.
   */
  if (!spec) return legacy();

  const { provider, id } = split(spec);
  const key = process.env.HEX_MODEL_API_KEY;

  switch (provider) {
    case undefined:
      // A bare id: the gateway resolves it, and eve reads the window from the
      // catalogue. Nothing for this file to state.
      return { model: id };

    case "anthropic":
      return {
        model: createAnthropic({
          apiKey: key ?? process.env.ANTHROPIC_API_KEY ?? "",
        })(id),
        modelContextWindowTokens: contextWindow(id),
      };

    case "openai":
      return {
        model: createOpenAI({
          apiKey: key ?? process.env.OPENAI_API_KEY ?? "",
        })(id),
        modelContextWindowTokens: contextWindow(id),
      };

    case "openai-compatible": {
      const baseURL = process.env.HEX_MODEL_BASE_URL;
      if (!baseURL)
        throw new Error(
          "HEX_MODEL asks for an openai-compatible provider without a " +
            "HEX_MODEL_BASE_URL. There is no default: a guessed endpoint is a " +
            "request sent somewhere nobody chose.",
        );
      return {
        model: createOpenAICompatible({
          name: process.env.HEX_MODEL_NAME ?? "openai-compatible",
          baseURL,
          apiKey: key ?? process.env.HEX_API_KEY ?? "",
        })(id),
        modelContextWindowTokens: contextWindow(id),
      };
    }

    default:
      throw new Error(
        `HEX_MODEL names a provider called "${provider}", which is not one of ` +
          `anthropic, openai or openai-compatible. A bare id with no colon — ` +
          `"anthropic/claude-sonnet-5" — goes through the AI Gateway instead, ` +
          `which reaches every model it lists.`,
      );
  }
}

/**
 * PPQ, as it was configured before any of this existed.
 *
 * Kept as the default so an environment that has not been told anything keeps
 * working exactly as it did. `PPQ_API_KEY` wins over `HEX_API_KEY` so the Nostr
 * agent's key and the runtime's can be separated without editing code.
 */
function legacy(): ModelChoice {
  return {
    model: createOpenAICompatible({
      name: "ppq",
      baseURL: "https://api.ppq.ai",
      apiKey: process.env.PPQ_API_KEY ?? process.env.HEX_API_KEY ?? "",
    })("moonshotai/kimi-k3"),
    modelContextWindowTokens: 1_048_576,
  };
}
