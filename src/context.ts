/**
 * What Hex knows about a room when it answers.
 *
 * A rolling window per room, seeded once from the relay and then kept warm from
 * the same stream the agent reads — so a reply that arrives thirty messages into
 * a conversation has the conversation, not just the mention.
 *
 * There is no local mirror for a NIP-29 message: a kind 9 lives in memory and
 * nowhere else. Everything here is bounded for that reason — the window by
 * count, the name cache by entries.
 */

import type { ContextMessage } from "./brain/types.js";
import type { HexRelays } from "./relays.js";
import { requestEvents } from "./relays.js";
import {
  roomKey,
  type Inbound,
  type Room,
  type Transport,
} from "./transports/types.js";

/** Upper bound on cached display names. */
const MAX_NAMES = 500;

export interface ContextOptions {
  relays: HexRelays;
  /** Where to look up kind 0. Never a group relay: that is not its job. */
  lookupRelays: string[];
  /** How many messages of history a reply gets. */
  messages: number;
  lookupTimeoutMs?: number;
}

export class RoomContext {
  /** Room key -> messages, oldest first, capped at `messages`. */
  private readonly windows = new Map<string, Inbound[]>();
  /** Rooms already seeded from the relay. */
  private readonly seeded = new Set<string>();
  /** pubkey -> display name, or null for "asked, and there is none". */
  private readonly names = new Map<string, string | null>();

  constructor(private readonly options: ContextOptions) {}

  /** Record a message the agent saw, whether or not it answers. */
  record(inbound: Inbound): void {
    const key = roomKey(inbound.room);
    const window = this.windows.get(key) ?? [];
    // Streams can deliver the same event twice; a duplicate in the window would
    // reach the model as a repeated turn.
    if (window.some((existing) => existing.id === inbound.id)) return;
    window.push(inbound);
    window.sort((a, b) => a.createdAt - b.createdAt);
    while (window.length > this.options.messages) window.shift();
    this.windows.set(key, window);
  }

  /**
   * The conversation leading up to `incoming`, excluding it.
   *
   * Seeds from the relay the first time a room is asked about, because a bot that
   * just started has seen only the message that woke it.
   */
  async history(
    transport: Transport,
    incoming: Inbound,
  ): Promise<ContextMessage[]> {
    const key = roomKey(incoming.room);

    if (!this.seeded.has(key)) {
      this.seeded.add(key);
      try {
        for (const message of await transport.history(
          incoming.room,
          this.options.messages,
        ))
          this.record(message);
      } catch (error) {
        // History is an improvement, not a requirement: answer with less rather
        // than not at all.
        console.warn(
          `[hex] could not load history for ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const window = (this.windows.get(key) ?? []).filter(
      (message) => message.id !== incoming.id,
    );
    const names = await this.resolveNames([
      ...new Set(window.map((message) => message.author)),
    ]);

    return window.map((message) => ({
      author: message.author,
      name: names.get(message.author) ?? undefined,
      text: message.text,
      at: message.createdAt,
    }));
  }

  /**
   * Display names for a set of pubkeys, from kind 0.
   *
   * One REQ for everyone unknown, and a null is cached too — a pubkey with no
   * profile must not be looked up again on every single message.
   */
  private async resolveNames(
    pubkeys: string[],
  ): Promise<Map<string, string | null>> {
    const unknown = pubkeys.filter((pubkey) => !this.names.has(pubkey));

    if (unknown.length > 0) {
      let events: Awaited<ReturnType<typeof requestEvents>> = [];
      try {
        events = await requestEvents(
          this.options.relays,
          this.options.lookupRelays,
          [{ kinds: [0], authors: unknown }],
          { timeoutMs: this.options.lookupTimeoutMs },
        );
      } catch {
        // A name is a nicety; the pubkey prefix is a fine fallback.
      }

      const newest = new Map<string, { at: number; name: string | null }>();
      for (const event of events) {
        const previous = newest.get(event.pubkey);
        if (previous && previous.at >= event.created_at) continue;
        let name: string | null = null;
        try {
          const parsed = JSON.parse(event.content) as {
            name?: unknown;
            display_name?: unknown;
          };
          const candidate =
            typeof parsed.display_name === "string" && parsed.display_name
              ? parsed.display_name
              : typeof parsed.name === "string" && parsed.name
                ? parsed.name
                : null;
          name = candidate;
        } catch {
          // A kind 0 with unparseable content is a kind 0 with no name.
        }
        newest.set(event.pubkey, { at: event.created_at, name });
      }

      for (const pubkey of unknown)
        this.remember(pubkey, newest.get(pubkey)?.name ?? null);
    }

    return new Map(
      pubkeys.map((pubkey) => [pubkey, this.names.get(pubkey) ?? null]),
    );
  }

  private remember(pubkey: string, name: string | null): void {
    this.names.set(pubkey, name);
    if (this.names.size > MAX_NAMES) {
      const oldest = this.names.keys().next();
      if (!oldest.done) this.names.delete(oldest.value);
    }
  }

  /** How many messages are held for a room. For tests and logs. */
  size(room: Room): number {
    return (this.windows.get(roomKey(room)) ?? []).length;
  }
}
