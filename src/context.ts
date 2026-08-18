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
import type { SessionTracker } from "./sessions.js";
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

/**
 * How many messages the by-id index holds, as a multiple of a room's window.
 *
 * Generous because a thread walk reaches past the window by design, and a kind 9
 * has no local mirror to fall back on — but bounded, because a long-running agent
 * in a busy room would otherwise keep every message it ever saw.
 */
const ID_INDEX_MULTIPLE = 20;

export interface ContextOptions {
  relays: HexRelays;
  /**
   * Sessions, when the agent keeps them.
   *
   * With one, the conversation is whatever the session holds — which survives a
   * restart and covers a follow-up that mentions Hex again instead of replying.
   * Without one, the thread walk and the room window are all there is.
   */
  sessions?: SessionTracker;
  /** Where to look up kind 0. Never a group relay: that is not its job. */
  lookupRelays: string[];
  /** How many messages of history a reply gets. */
  messages: number;
  lookupTimeoutMs?: number;
}

export class RoomContext {
  /** Room key -> messages, oldest first, capped at `messages`. */
  private readonly windows = new Map<string, Inbound[]>();
  /**
   * Every message seen or fetched, by id, so a thread can be walked.
   *
   * Wider than the windows on purpose: a parent that has aged out of a room's
   * recent window is still the turn a reply is answering.
   */
  private readonly messages = new Map<string, Inbound>();
  /** Rooms already seeded from the relay. */
  private readonly seeded = new Set<string>();
  /** pubkey -> display name, or null for "asked, and there is none". */
  private readonly names = new Map<string, string | null>();

  constructor(private readonly options: ContextOptions) {}

  /** Record a message the agent saw, whether or not it answers. */
  record(inbound: Inbound): void {
    const key = roomKey(inbound.room);
    const window = this.windows.get(key) ?? [];

    // The by-id index is kept even for a message already in the window, and
    // bounded separately: it is what a thread walk reads.
    this.messages.set(inbound.id, inbound);
    if (this.messages.size > this.maxMessages()) {
      const oldest = this.messages.keys().next();
      if (!oldest.done) this.messages.delete(oldest.value);
    }

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
   * A THREAD when there is one: a mention opens a conversation, Hex's answer
   * continues it, and a reply to that answer is the next turn of the same
   * exchange. Walking the `replyToId` chain is what keeps those turns together —
   * without it, an answer to Hex's answer arrives as an unrelated line in a room
   * and the model has to guess what it is about.
   *
   * The room's recent window is the fallback, for a message that starts a
   * conversation rather than continuing one. It is deliberately not both: mixing
   * a thread with whatever else the room said puts unrelated turns between a
   * question and its answer.
   */
  async history(
    transport: Transport,
    incoming: Inbound,
    sessionId?: string,
  ): Promise<ContextMessage[]> {
    const key = roomKey(incoming.room);

    // A session already knows what belongs together, including turns from before
    // the process started and follow-ups that never threaded.
    if (sessionId && this.options.sessions) {
      const stored = this.options.sessions.history(sessionId, incoming.id);
      if (stored.length > 0)
        return this.withNames(
          stored.map((message) => ({
            id: message.id,
            author: message.author,
            text: message.text,
            createdAt: message.at,
            room: incoming.room,
            addressesSelf: false,
            replyToId: message.replyToId,
            event: {
              id: message.id,
              pubkey: message.author,
              created_at: message.at,
              kind: 9,
              content: message.text,
              tags: [],
              sig: "",
            },
          })),
        );
    }

    if (incoming.replyToId) {
      const thread = await this.thread(transport, incoming);
      if (thread.length > 0) return this.withNames(thread);
    }

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
    return this.withNames(window);
  }

  /**
   * Walk `replyToId` back from `incoming`, oldest first.
   *
   * Bounded by `messages`, and by a `seen` set: a malformed chain that points at
   * itself, or a cycle between two events, would otherwise loop forever. Missing
   * parents are fetched once from the transport and then remembered, so a long
   * exchange costs one lookup per turn rather than one per message.
   */
  private async thread(
    transport: Transport,
    incoming: Inbound,
  ): Promise<Inbound[]> {
    const chain: Inbound[] = [];
    const seen = new Set<string>([incoming.id]);
    let cursor = incoming.replyToId;

    while (cursor && chain.length < this.options.messages) {
      if (seen.has(cursor)) break;
      seen.add(cursor);

      let parent = this.messages.get(cursor);
      if (!parent && transport.fetchById) {
        try {
          parent =
            (await transport.fetchById(incoming.room, cursor)) ?? undefined;
          if (parent) this.record(parent);
        } catch {
          // A parent that cannot be fetched ends the chain; a shorter
          // conversation beats no answer.
        }
      }
      if (!parent) break;

      // A thread stays inside its room: an `e` tag can point anywhere.
      if (roomKey(parent.room) !== roomKey(incoming.room)) break;

      chain.push(parent);
      cursor = parent.replyToId;
    }

    return chain.reverse();
  }

  private async withNames(messages: Inbound[]): Promise<ContextMessage[]> {
    const names = await this.resolveNames([
      ...new Set(messages.map((message) => message.author)),
    ]);
    return messages.map((message) => ({
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

  private maxMessages(): number {
    return this.options.messages * ID_INDEX_MULTIPLE;
  }

  /** How many messages are held for a room. For tests and logs. */
  size(room: Room): number {
    return (this.windows.get(roomKey(room)) ?? []).length;
  }
}
