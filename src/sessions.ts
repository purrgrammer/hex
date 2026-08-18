/**
 * Sessions: which messages belong to the same conversation.
 *
 * A thread is not the whole story. People address a bot again a minute later
 * without replying to it — "hex, what about X" after it just answered — and a
 * strict reply-chain treats that as a stranger's first sentence, so the agent
 * answers the same question twice with no memory of having answered it.
 *
 * A session groups by three rules, in order:
 *
 * 1. A reply to any message in a session continues that session, however old.
 *    Threading is explicit intent and outranks time.
 * 2. Otherwise, a message from someone already in a session in that room
 *    continues it, if the session was active recently.
 * 3. Otherwise it opens a new one.
 *
 * The rules are here; the rows are in SQLite, so a restart resumes conversations
 * and two processes can hold the same agent's memory without one erasing the
 * other.
 */

import type { HexStore, StoredMessage } from "./store.js";
import { roomKey, type Inbound } from "./transports/types.js";

/** How long a session stays open to a follow-up that is not a reply. */
export const DEFAULT_SESSION_IDLE_SECS = 30 * 60;

export interface SessionOptions {
  store: HexStore;
  /** Unix seconds. */
  now?: () => number;
  idleSecs?: number;
  /** Cap on the turns one session hands to the brain. */
  maxMessages: number;
}

export class SessionTracker {
  constructor(private readonly options: SessionOptions) {}

  private now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private idle(): number {
    return this.options.idleSecs ?? DEFAULT_SESSION_IDLE_SECS;
  }

  /** Did Hex publish this? */
  isOwn(id: string): boolean {
    return this.options.store.isOwn(id);
  }

  /** Record something Hex said, as part of a session. */
  recordOwn(sessionId: string, message: Omit<StoredMessage, "own">): void {
    this.options.store.record(sessionId, { ...message, own: true });
  }

  /** Record any message into a session. */
  record(sessionId: string, message: StoredMessage): void {
    this.options.store.record(sessionId, message);
  }

  /**
   * Which session this message belongs to, naming a new one if it opens a
   * conversation.
   */
  resolve(inbound: Inbound): { id: string; isNew: boolean } {
    const room = roomKey(inbound.room);

    // 1. An explicit reply, at any age.
    if (inbound.replyToId) {
      const existing = this.options.store.sessionForReply(
        room,
        inbound.replyToId,
      );
      if (existing) return { id: existing, isNew: false };
    }

    // 2. The same person, still within the idle window.
    const recent = this.options.store.recentSessionFor(
      room,
      inbound.author,
      this.now() - this.idle(),
    );
    if (recent) return { id: recent, isNew: false };

    // 3. A new conversation, named after the message that opened it.
    return { id: `${room}#${inbound.id.slice(0, 16)}`, isNew: true };
  }

  /**
   * The session's turns before `exclude`, oldest first.
   *
   * Bounded to the newest `maxMessages`: a long conversation should cost a fixed
   * amount of context, and the recent turns are the ones that matter.
   */
  history(sessionId: string, excludeId?: string): StoredMessage[] {
    return this.options.store.history(
      sessionId,
      this.options.maxMessages,
      excludeId,
    );
  }
}
