import { RESPOND_TOOL } from "../tools/types.js";
import type { Brain, BrainRequest, TurnOutcome } from "./types.js";

/**
 * Repeats what it was told, through the same tool a real brain uses.
 *
 * Exists so the transports can be exercised end to end — a real group, a real
 * mention, a real published reply — without a provider, a key, or a bill. Because
 * it delivers through `respond` like everything else, a working echo proves the
 * whole path, not a shortcut around it.
 */
export class EchoBrain implements Brain {
  readonly name = "echo";

  async turn(request: BrainRequest): Promise<TurnOutcome> {
    const result = await request.tools.call({
      name: RESPOND_TOOL,
      arguments: { text: `echo: ${request.incoming.text}` },
    });
    return { delivered: request.tools.delivered, note: result.output };
  }
}
