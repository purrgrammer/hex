import type { Brain, BrainRequest } from "./types.js";

/**
 * Repeats what it was told.
 *
 * Exists so the transports can be exercised end to end — a real group, a real
 * mention, a real published reply — without a provider, a key, or a bill. It is
 * never a fallback: a config with no `brain` fails to start, and this one has to
 * be asked for by name.
 */
export class EchoBrain implements Brain {
  readonly name = "echo";

  async respond(request: BrainRequest): Promise<string | null> {
    return `echo: ${request.incoming.text}`;
  }
}
