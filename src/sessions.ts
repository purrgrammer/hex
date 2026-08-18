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
 * Sessions live in the state file, so a restart resumes conversations rather
 * than meeting everyone again.
 */

import type { StateStore, StoredMessage, StoredSession } from "./state.js";
import { roomKey, type Inbound } from "./transports/types.js";

/** How long a session stays open to a follow-up that is not a reply. */
export const DEFAULT_SESSION_IDLE_SECS = 30 * 60;

export interface SessionOptions {
  store: StateStore;
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

  /** Did Hex publish this? Survives a restart, unlike an in-memory set. */
  isOwn(id: string): boolean {
    return this.options.store.data.messages[id]?.own === true;
  }

  /** Record something Hex said, as part of a session. */
  recordOwn(sessionId: string, message: Omit<StoredMessage, "own">): void {
    this.record(sessionId, { ...message, own: true });
  }

  /** Record any message into a session, and keep the session bounded. */
  record(sessionId: string, message: StoredMessage): void {
    const { data } = this.options.store;
    data.messages[message.id] = message;

    const session =
      data.sessions[sessionId] ??
      ({
        id: sessionId,
        room: message.room,
        participants: [],
        messages: [],
        lastAt: message.at,
      } satisfies StoredSession);

    if (!session.messages.includes(message.id))
      session.messages.push(message.id);
    // Hex is in every session it speaks in; only humans decide continuity.
    if (!message.own && !session.participants.includes(message.author))
      session.participants.push(message.author);
    session.lastAt = Math.max(session.lastAt, message.at);
    // The window the brain gets is bounded; keeping more here helps nobody.
    while (session.messages.length > this.options.maxMessages * 2)
      session.messages.shift();

    data.sessions[sessionId] = session;
    this.options.store.touch();
  }

  /**
   * Which session this message belongs to, creating one if it opens a
   * conversation.
   */
  resolve(inbound: Inbound): { id: string; isNew: boolean } {
    const { data } = this.options.store;
    const room = roomKey(inbound.room);

    // 1. An explicit reply, at any age.
    if (inbound.replyToId) {
      const existing = Object.values(data.sessions).find(
        (session) =>
          session.room === room &&
          session.messages.includes(inbound.replyToId!),
      );
      if (existing) return { id: existing.id, isNew: false };
    }

    // 2. The same person, still within the idle window.
    const cutoff = this.now() - this.idle();
    const recent = Object.values(data.sessions)
      .filter(
        (session) =>
          session.room === room &&
          session.lastAt >= cutoff &&
          session.participants.includes(inbound.author),
      )
      .sort((a, b) => b.lastAt - a.lastAt)[0];
    if (recent) return { id: recent.id, isNew: false };

    // 3. A new conversation, named after the message that opened it.
    return { id: `${room}#${inbound.id.slice(0, 16)}`, isNew: true };
  }

  /**
   * The session's turns before `exclude`, oldest first.
   *
   * Bounded to the newest `maxMessages`: a long-running conversation should cost
   * a fixed amount of context, and the recent turns are the ones that matter.
   */
  history(sessionId: string, excludeId?: string): StoredMessage[] {
    const { data } = this.options.store;
    const session = data.sessions[sessionId];
    if (!session) return [];
    return session.messages
      .filter((id) => id !== excludeId)
      .map((id) => data.messages[id])
      .filter((message): message is StoredMessage => message !== undefined)
      .sort((a, b) => a.at - b.at)
      .slice(-this.options.maxMessages);
  }
}
