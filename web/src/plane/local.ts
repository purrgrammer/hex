/**
 * The plane you get when this page is served by the daemon itself.
 *
 * Everything is a `fetch` against the same origin and the stream is SSE, which
 * reconnects on its own — the important property for a page left open next to a
 * process that gets restarted twenty times an afternoon.
 *
 * No token, no login: the server is bound to 127.0.0.1, so anyone who can reach
 * it already has a shell on the machine holding the agent's secret key. See the
 * note at the top of `src/ui/server.ts`.
 */

import type {
  ControlInput,
  Hello,
  LiveMessage,
  Peer,
  Plane,
  RelayHealth,
  SessionSummary,
  WireEvent,
} from "./types.ts";

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new Error(error);
  }
  return body as T;
}

export class LocalPlane implements Plane {
  readonly mode = "local" as const;

  private source?: EventSource;
  private readonly listeners = new Set<(message: LiveMessage) => void>();

  hello(): Promise<Hello> {
    return json<Hello>("/api/hello");
  }

  async sessions(): Promise<SessionSummary[]> {
    const { sessions } = await json<{ sessions: SessionSummary[] }>(
      "/api/sessions",
    );
    return sessions;
  }

  session(id: string): Promise<{ session?: SessionSummary; events: WireEvent[] }> {
    return json(`/api/sessions/${id}`);
  }

  async feed(limit = 100): Promise<WireEvent[]> {
    const { events } = await json<{ events: WireEvent[] }>(
      `/api/feed?limit=${limit}`,
    );
    return events;
  }

  async peers(): Promise<Peer[]> {
    const { peers } = await json<{ peers: Peer[] }>("/api/peers");
    return peers;
  }

  async checkRelays(): Promise<RelayHealth[]> {
    const { relays } = await json<{ relays: Record<string, RelayHealth> }>(
      "/api/relays",
      { method: "POST" },
    );
    return Object.values(relays);
  }

  async control(input: ControlInput): Promise<void> {
    await json("/api/control", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  subscribe(listener: (message: LiveMessage) => void): () => void {
    this.listeners.add(listener);
    // One socket for the page, opened on the first listener: every panel wants
    // the same stream, and a stream per panel is a stream per panel to reconnect.
    if (!this.source) this.open();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  private open(): void {
    const source = new EventSource("/api/stream");
    source.onmessage = (message) => {
      try {
        this.emit(JSON.parse(message.data) as LiveMessage);
      } catch {
        // A malformed frame is one frame, not the end of the stream.
      }
    };
    source.onopen = () =>
      this.emit({ type: "status", at: Date.now(), connected: true });
    source.onerror = () =>
      // EventSource retries by itself; this only reports the gap, so a page in
      // front of a stopped daemon says so instead of looking merely quiet.
      this.emit({
        type: "status",
        at: Date.now(),
        connected: false,
        detail: "the daemon is not answering",
      });
    this.source = source;
  }

  private emit(message: LiveMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  close(): void {
    this.source?.close();
    this.source = undefined;
  }
}
