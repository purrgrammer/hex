/**
 * What the local UI is watching, while it happens.
 *
 * The store is the record and this is the liveness. A turn lands in `events`
 * whether or not anybody is looking; a delta never lands anywhere, because kind
 * 21777 is ephemeral by protocol and the turn that closes it repeats every word.
 * A browser open on the session still wants to see the text arrive, so both go
 * through here and only one of them is kept.
 *
 * Deliberately not an EventEmitter: a listener that throws must not take the
 * publisher down with it. A UI socket that died mid-write is the ordinary case,
 * not an exception, and Hex's job is to answer messages rather than to survive
 * its own dashboard.
 */

/** Everything a watching client can be told, discriminated by `type`. */
export type LiveMessage =
  | { type: "event"; event: LiveEvent }
  | { type: "delta"; event: LiveEvent }
  | { type: "log"; at: number; line: string }
  | { type: "hello"; at: number };

/** A rumor, flattened the way the HTTP surface hands them over. */
export interface LiveEvent {
  id: string;
  kind: number;
  pubkey: string;
  createdAt: number;
  content: string;
  tags: string[][];
  sessionId?: string;
  seq?: number;
}

/** How many log lines a client that connects late is handed. */
const LOG_BACKLOG = 200;

export class LiveBus {
  private readonly listeners = new Set<(message: LiveMessage) => void>();
  private readonly logs: { at: number; line: string }[] = [];

  /** Returns the unsubscribe, because a socket that closes must let go. */
  subscribe(listener: (message: LiveMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The recent log, for a client that connected after the interesting part. */
  backlog(): { at: number; line: string }[] {
    return [...this.logs];
  }

  emit(message: LiveMessage): void {
    if (message.type === "log") {
      this.logs.push({ at: message.at, line: message.line });
      if (this.logs.length > LOG_BACKLOG)
        this.logs.splice(0, this.logs.length - LOG_BACKLOG);
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A dead socket is not this process's problem.
      }
    }
  }

  log(line: string): void {
    this.emit({ type: "log", at: Date.now(), line });
  }
}
