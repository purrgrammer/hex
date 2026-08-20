/**
 * What the runtime actually is, right now.
 *
 * A session's transcript records what an agent DID; this is what it was set up
 * to do — the prompt in force and the tools on offer at the moment the run
 * started. Read from the runtime rather than from this package's own config,
 * because the config is a request and the runtime is the answer: an instructions
 * file that failed to load, a tool that was replaced, a framework tool nobody
 * here has heard of. Publishing the request as if it were the answer is how a
 * transcript comes to describe an agent that never ran.
 *
 * Read once per session and never again. It is a snapshot on purpose: the point
 * is what applied to THIS run, so a later change to the prompt must not
 * retroactively rewrite what an earlier session was told.
 */

export interface AgentInfo {
  /** The system prompt, every static source concatenated in order. */
  instructions?: string;
  /**
   * The model in force, and how much it can hold.
   *
   * The window is worth publishing because a reader cannot derive it: a
   * session's token counts mean one thing against 200k and something else
   * entirely against a million, and "how close is this to compacting" is the
   * question a long run is actually read for.
   */
  model?: { id: string; contextWindow?: number };
  tools: {
    name: string;
    description?: string;
    /** JSON Schema, as the runtime reports it. */
    parameters?: unknown;
  }[];
}

interface InfoOptions {
  host: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Fetch it, or return nothing.
 *
 * A failure is not fatal and not even loud: the session still publishes, it
 * simply publishes no snapshot. An agent that refused to run because it could
 * not describe itself would be a worse trade than a transcript with one section
 * missing.
 */
export async function readAgentInfo(
  options: InfoOptions,
): Promise<AgentInfo | undefined> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(
      new URL("/eve/v1/info", options.host).toString(),
      { signal: options.signal },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      agent?: {
        model?: { id?: unknown; contextWindowTokens?: unknown };
      };
      instructions?: { static?: { content?: unknown }[] };
      tools?: { available?: Record<string, unknown>[] };
    };

    const instructions = (body.instructions?.static ?? [])
      .map((source) => str(source.content))
      .filter((content): content is string => !!content)
      .join("\n\n");

    const tools = (body.tools?.available ?? [])
      .map((tool) => ({
        name: str(tool.name) ?? "",
        description: str(tool.description),
        parameters: tool.inputSchema,
      }))
      .filter((tool) => tool.name);

    const id = str(body.agent?.model?.id);
    const window = body.agent?.model?.contextWindowTokens;

    return {
      instructions: instructions || undefined,
      tools,
      ...(id
        ? {
            model: {
              id,
              ...(typeof window === "number" && window > 0
                ? { contextWindow: window }
                : {}),
            },
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}
