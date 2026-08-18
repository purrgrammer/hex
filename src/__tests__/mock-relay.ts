/**
 * A minimal in-process relay, package-local.
 *
 * grimoire's `src/test/mock-relay.ts` is the model, but this package must not
 * import from the app, so only the behaviours Hex's own code has to survive are
 * reproduced here: a relay that answers, and one that connects and then says
 * nothing. The silent case is the one that hangs clients.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { NostrEvent } from "nostr-tools";

export type MockRelayBehaviour =
  /** Serve `events`, then EOSE. */
  | { kind: "normal"; events?: NostrEvent[] }
  /** Accept the REQ and never answer — no EVENT, EOSE, CLOSED or ERROR. */
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
        for (const event of behaviour.events ?? [])
          socket.send(JSON.stringify(["EVENT", subscriptionId, event]));
        socket.send(JSON.stringify(["EOSE", subscriptionId]));
        return;
      }

      if (verb === "EVENT") {
        const event = rest[0] as NostrEvent;
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
