/**
 * NIP-42 where Hex has a reason to say who it is, and nowhere else.
 *
 * An inbox relay that requires authentication to READ is not being obstructive:
 * a kind-1059 wrap is addressed by `#p`, so anyone may ask a relay for anyone
 * else's mail. Demanding that the reader prove the pubkey is theirs is the only
 * thing standing between a gift wrap and an observer who wants to know who is
 * talking to whom, even without opening it.
 *
 * So Hex authenticates as Hex here, which costs nothing — it is Hex's own
 * mailbox and the relay already sees the `#p` filter. The same holds for Hex's
 * outbox: a kind 0, 10002 or 10050 is signed by Hex and says so, and a relay
 * that wants an AUTH before storing one learns nothing it could not read off
 * the event.
 *
 * Announcing such a relay in kind 10050 without doing this is worse than not
 * listing it at all: senders publish there, the relay accepts, and Hex's
 * subscription returns nothing for ever. The relay is reachable, the message is
 * stored, and nobody is told.
 *
 * **This must never touch the pool a peer's wrap goes out on.** That wrap is
 * signed by a throwaway key precisely so the relay cannot tell who sent it, and
 * a socket already authenticated as Hex hands it over. `publishUnattributed`
 * builds its own `RelayPool` per send and authenticates as the wrap; this
 * watcher runs on the shared pool, which carries only Hex's reads and Hex's own
 * self-addressed copy.
 *
 * Named relays, not the pool. The sibling `relay-auth-manager` package watches a
 * pool's `add$`/`remove$` and would therefore sign in to every relay Hex ever
 * touches — a group relay, a lookup relay, whatever a model reaches with
 * `nostr.req`. Announcing "I am Hex" to a relay that only had to serve a public
 * query is identity spent for nothing. Only relays Hex named in its own config,
 * as its own inbox or its own outbox, are ever handed one.
 */

import type { RelayPool } from "applesauce-relay";
import type { Subscription } from "rxjs";

import type { ISigner } from "../signer.js";

export interface OwnRelayAuthOptions {
  pool: RelayPool;
  /** Relays where Hex is the subject: its own inbox, its own outbox. */
  relays: string[];
  signer: ISigner;
  log?: (line: string) => void;
}

/**
 * Watch each named relay and authenticate as Hex when it asks.
 *
 * Reading and writing are separate demands and a relay may make either: an
 * inbox relay guards reads so nobody trawls other people's mail, an outbox
 * relay guards writes so nobody fills it with strangers' events. Watching only
 * one leaves the other failing in silence — `announce` timed out against
 * exactly such a relay while the read path was already signing in.
 *
 * Driven by the relay's own `authRequiredFor…$` rather than by dialling
 * everything up front: a relay that never challenges is never handed an AUTH it
 * did not ask for, and one that starts challenging mid-session, or after a
 * reconnect, is answered then rather than only at startup.
 */
export function authenticateOwn(options: OwnRelayAuthOptions): {
  close(): void;
} {
  const { pool, signer } = options;
  const log = options.log ?? (() => {});
  const subscriptions: Subscription[] = [];
  /** One in-flight AUTH per relay: the observable can fire twice on reconnect. */
  const inFlight = new Set<string>();

  for (const url of [...new Set(options.relays)]) {
    let relay;
    try {
      relay = pool.relay(url);
    } catch (error) {
      // A URL applesauce will not take is a config error, not a runtime one —
      // said once, and the other relays carry on.
      log(
        `[hex] ${url} could not be dialled to authenticate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    const armed = relay;
    const signIn = (what: string) => (required: boolean) => {
      if (!required || armed.authenticated || inFlight.has(url)) return;
      inFlight.add(url);
      void armed
        .authenticate(signer)
        .then((response) => {
          if (response.ok)
            log(`[hex] ${url} wanted NIP-42 to ${what}; signed in`);
          else
            log(
              `[hex] ${url} refused Hex's authentication: ${
                response.message ?? "no reason given"
              }`,
            );
        })
        .catch((error: unknown) => {
          log(
            `[hex] ${url} would not authenticate Hex: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => inFlight.delete(url));
    };

    subscriptions.push(
      relay.authRequiredForRead$.subscribe(signIn("read")),
      relay.authRequiredForPublish$.subscribe(signIn("publish")),
    );
  }

  return {
    close: () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
    },
  };
}
