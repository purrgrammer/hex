/**
 * Which toolset a message gets.
 *
 * Channels are not equal. A relay group is whoever the relay admits, and its
 * membership changes without Hex being told; a DM is one named person on an
 * allow-list. So "what may be asked for here" is a property of the channel, and
 * it is resolved per message rather than configured once for the process.
 *
 * Most specific wins: the person or the group, then the transport, then nothing.
 * "Nothing" means the tools composed in without a grant — the read tools — and
 * never the ones that run commands, which only exist for a channel that named a
 * toolset that asked for them.
 */

import type { HexConfig, ToolsetConfig } from "./config.js";
import type { Inbound } from "./transports/types.js";

/** The toolset for this message, or undefined for the unrestricted default. */
export function toolsetFor(
  config: HexConfig,
  inbound: Inbound,
): ToolsetConfig | undefined {
  const name = toolsetNameFor(config, inbound);
  return name ? config.toolsets.get(name) : undefined;
}

function toolsetNameFor(
  config: HexConfig,
  inbound: Inbound,
): string | undefined {
  for (const transport of config.transports) {
    if (transport.type === "nip-17" && inbound.room.transport === "nip-17") {
      const peer = transport.allow.find(
        (allowed) => allowed.pubkey === inbound.author,
      );
      // Someone not on the list should never have reached this far; if they
      // did, they get nothing rather than the transport's default.
      if (!peer) continue;
      return peer.toolset ?? transport.toolset;
    }

    if (transport.type === "nip-29" && inbound.room.transport === "nip-29") {
      const group = transport.groups.find(
        (candidate) =>
          candidate.id === inbound.room.id &&
          candidate.relay === inbound.room.relay,
      );
      if (!group) continue;
      return group.toolset ?? transport.toolset;
    }
  }
  return undefined;
}
