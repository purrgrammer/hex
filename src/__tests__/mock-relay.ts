/**
 * A minimal in-process relay, package-local.
 *
 * grimoire's `src/test/mock-relay.ts` is the model, but this package must not
 * import from the app, so only the behaviours Hex's own code has to survive are
 * reproduced here: a relay that answers, and one that connects and then says
 * nothing. The silent case is the one that hangs clients.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { Filter, NostrEvent } from "nostr-tools";

function matchesFilter(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const name = key.slice(1);
    const matched = event.tags.some(
      (tag) => tag[0] === name && (values as string[]).includes(tag[1] ?? ""),
    );
    if (!matched) return false;
  }
  return true;
}

export type MockRelayBehaviour =
  /** Serve `events`, then EOSE. */
  | { kind: "normal"; events?: NostrEvent[] }
  /** Answer nothing at all: no EVENT, EOSE, CLOSED, ERROR, or OK on a publish. */
  | { kind: "silent" }
  /** Challenge on connect, then refuse every REQ with an `auth-required` CLOSED. */
  | { kind: "auth-required" };

export interface MockRelay {
  url: string;
  /** Every event the relay was asked to store, in arrival order. */
  received: NostrEvent[];
  close(): Promise<void>;
}

export async function startMockRelay(
  behaviour: MockRelayBehaviour,
): Promise<MockRelay> {
  const server = new WebSocketServer({ port: 0 });
  const received: NostrEvent[] = [];
  const sockets = new Set<WebSocket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (behaviour.kind === "auth-required")
      socket.send(JSON.stringify(["AUTH", "challenge-string"]));
    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      const [verb, ...rest] = message as [string, ...unknown[]];

      if (verb === "REQ") {
        if (behaviour.kind === "silent") return;
        const subscriptionId = rest[0] as string;
        if (behaviour.kind === "auth-required") {
          socket.send(
            JSON.stringify([
              "CLOSED",
              subscriptionId,
              "auth-required: authenticate to read",
            ]),
          );
          return;
        }
        // Real filter semantics for the fields Hex actually sends. Serving
        // everything to every REQ would let a `kinds:[10002]` lookup come back
        // holding a kind 0 — which is exactly the mistake `matchesPublished`
        // exists to catch, hidden by the relay instead of caught by the test.
        const filters = rest.slice(1) as Filter[];
        // Serve what was published to it as well as what it was seeded with — a
        // relay that forgets its own EVENTs cannot exercise "already published".
        for (const event of [...(behaviour.events ?? []), ...received])
          if (filters.some((filter) => matchesFilter(filter, event)))
            socket.send(JSON.stringify(["EVENT", subscriptionId, event]));
        socket.send(JSON.stringify(["EOSE", subscriptionId]));
        return;
      }

      if (verb === "EVENT") {
        const event = rest[0] as NostrEvent;
        // Silent means silent in both directions: no OK either. A relay that
        // takes an EVENT and never acknowledges it has not stored anything.
        if (behaviour.kind === "silent") return;
        received.push(event);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }

      if (verb === "CLOSE") return;
    });
  });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null)
    throw new Error("mock relay did not bind a port");

  return {
    url: `ws://127.0.0.1:${address.port}/`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.terminate();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
