/**
 * The tee: everything the publisher sends, also written down here.
 *
 * `EveTranscript` has exactly one door out — `RumorSink.publishRumor` — which is
 * why this is a wrapper around that door and not a second call site inside the
 * publisher. A transcript that reached the relay and not the local record, or
 * the other way round, would be two accounts of one run that can disagree; there
 * is one place where the event exists, and it passes through here.
 *
 * Ordering matters and is the opposite of the obvious one: the rumor is recorded
 * BEFORE it is handed on. A publish that takes four seconds against a slow relay
 * would otherwise leave the operator's own screen blank for those four seconds
 * while the agent had already said the thing.
 *
 * Deltas are emitted and not stored — see `LiveBus`. Nothing else is filtered:
 * an event this agent published is an event this agent published, whatever kind
 * it turns out to be.
 */

import type { RumorSink } from "../eve/transcript.js";
import type { Rumor } from "../nostr/types.js";
import { parseSessionAddress } from "../nostr/encode.js";
import { KIND_SESSION_HEAD } from "../nostr/kinds.js";
import type { HexStore } from "../store.js";
import type { LiveBus, LiveEvent } from "./bus.js";

/**
 * Which run an event belongs to, as the WIRE names it.
 *
 * The head carries the session in its `d` tag, because it is addressable and
 * that is its identity. Everything else points at the head with an `a` tag. Eve's
 * own id is deliberately not used here: a browser can only ever learn the
 * published one, and keying the local record by the same id is what lets the
 * local and remote UIs be one renderer instead of two.
 */
export function sessionOf(rumor: Rumor): string | undefined {
  if (rumor.kind === KIND_SESSION_HEAD)
    return rumor.tags.find((tag) => tag[0] === "d")?.[1];
  for (const tag of rumor.tags) {
    if (tag[0] !== "a" || !tag[1]) continue;
    const address = parseSessionAddress(tag[1]);
    if (address?.kind === KIND_SESSION_HEAD) return address.session;
  }
  return undefined;
}

function seqOf(rumor: Rumor): number | undefined {
  const raw = rumor.tags.find((tag) => tag[0] === "seq")?.[1];
  if (!raw) return undefined;
  const seq = Number(raw);
  return Number.isInteger(seq) ? seq : undefined;
}

export function flatten(rumor: Rumor): LiveEvent {
  return {
    id: rumor.id,
    kind: rumor.kind,
    pubkey: rumor.pubkey,
    createdAt: rumor.created_at,
    content: rumor.content,
    tags: rumor.tags,
    sessionId: sessionOf(rumor),
    seq: seqOf(rumor),
  };
}

/**
 * Wrap a sink so the machine that publishes also remembers.
 *
 * Recording is best-effort by construction: a write that fails must never turn
 * into a transcript that was not published. The failure is reported on the bus,
 * where an operator can see it, rather than swallowed.
 */
export function recording(
  sink: RumorSink,
  store: HexStore,
  bus: LiveBus,
): RumorSink {
  return {
    async publishRumor(rumor, recipients, options) {
      const event = flatten(rumor);
      const ephemeral = options?.ephemeral === true;
      try {
        if (!ephemeral) store.recordEvent(event);
      } catch (error) {
        bus.log(
          `[hex] the local record refused an event: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      bus.emit({ type: ephemeral ? "delta" : "event", event });
      return sink.publishRumor(rumor, recipients, options);
    },
  };
}
