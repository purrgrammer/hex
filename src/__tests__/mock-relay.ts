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
  | { kind: "auth-required" }
  /**
   * Challenge on connect and refuse every EVENT until the socket AUTHs.
   *
   * What a NIP-42 inbox relay actually does to a publish, which is the case that
   * silently dropped gift wraps: the message is refused, not lost, and the client
   * has to decide which key to authenticate with.
   */
  | { kind: "auth-to-write" }
  /**
   * Challenge on connect, refuse every REQ until this socket has AUTHed, then
   * serve normally. This is what an inbox relay that protects its users' mail
   * actually does — `auth-required` above never relents, so it can prove a
   * client copes with a wall but not that it got through one.
   */
  | { kind: "auth-to-read"; events?: NostrEvent[] }
  /**
   * Refuse every REQ with a CLOSED carrying NO machine-readable prefix, and
   * accept publishes.
   *
   * The shape that reported `ok`: applesauce completes such a stream gracefully,
   * so a relay that served nothing and refused the subscription looked identical
   * to one that answered EOSE with no events.
   */
  | { kind: "closed-no-prefix"; reason?: string };

export interface MockRelay {
  url: string;
  /** Every event the relay was asked to store, in arrival order. */
  received: NostrEvent[];
  /** Pubkeys that have AUTHed on any connection, in order. */
  authenticated: string[];
  close(): Promise<void>;
}

export async function startMockRelay(
  behaviour: MockRelayBehaviour,
): Promise<MockRelay> {
  const server = new WebSocketServer({ port: 0 });
  const received: NostrEvent[] = [];
  const authenticated: string[] = [];
  const sockets = new Set<WebSocket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (
      behaviour.kind === "auth-required" ||
      behaviour.kind === "auth-to-write" ||
      behaviour.kind === "auth-to-read"
    )
      socket.send(JSON.stringify(["AUTH", "challenge-string"]));
    // Who this socket has authenticated as, if anyone.
    let authenticatedAs: string | undefined;
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
        if (behaviour.kind === "auth-to-read" && !authenticatedAs) {
          socket.send(
            JSON.stringify([
              "CLOSED",
              subscriptionId,
              "auth-required: authenticate to read",
            ]),
          );
          return;
        }
        if (behaviour.kind === "closed-no-prefix") {
          socket.send(
            JSON.stringify([
              "CLOSED",
              subscriptionId,
              behaviour.reason ?? "we do not serve that filter",
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
        const seeded = "events" in behaviour ? (behaviour.events ?? []) : [];
        for (const event of [...seeded, ...received])
          if (filters.some((filter) => matchesFilter(filter, event)))
            socket.send(JSON.stringify(["EVENT", subscriptionId, event]));
        socket.send(JSON.stringify(["EOSE", subscriptionId]));
        return;
      }

      if (verb === "AUTH") {
        const event = rest[0] as NostrEvent;
        authenticatedAs = event.pubkey;
        authenticated.push(event.pubkey);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }

      if (verb === "EVENT") {
        const event = rest[0] as NostrEvent;
        if (behaviour.kind === "auth-to-write" && !authenticatedAs) {
          socket.send(
            JSON.stringify([
              "OK",
              event.id,
              false,
              "auth-required: we only take events from authenticated clients",
            ]),
          );
          return;
        }
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
    authenticated,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.terminate();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
