import { describe, it, expect, afterEach } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";

import { createRelays, requestEvents } from "../relays.js";
import { authenticateOwn } from "../nostr/own-relay-auth.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const signer = new PrivateKeySigner(key);

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;
let watcher: { close(): void } | undefined;

afterEach(async () => {
  watcher?.close();
  watcher = undefined;
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

describe("authenticateOwn", () => {
  it("signs in when an inbox relay will not serve the mailbox otherwise", async () => {
    /**
     * The failure this exists to prevent has no error in it. An inbox relay
     * that requires NIP-42 answers an unauthenticated REQ with a CLOSED and
     * then nothing — so Hex's mailbox looks empty rather than locked, and a
     * relay announced in kind 10050 quietly swallows every message sent to it.
     */
    const waiting = finalizeEvent(
      {
        kind: 1059,
        content: "sealed",
        tags: [["p", pubkey]],
        created_at: 1000,
      },
      generateSecretKey(),
    );
    relay = await startMockRelay({ kind: "auth-to-read", events: [waiting] });
    relays = createRelays();

    watcher = authenticateOwn({
      pool: relays.pool,
      relays: [relay.url],
      signer,
    });

    // The REQ is what makes the relay demand authentication in the first place.
    const found = await requestEvents(
      relays,
      [relay.url],
      [{ kinds: [1059], "#p": [pubkey] }],
    );

    // Hex, by its own key: this is Hex's mailbox, so there is nothing to hide.
    expect(relay.authenticated).toContain(pubkey);
    // And the mail actually arrives. Authenticating without the read being
    // retried afterwards would leave the inbox just as empty as before.
    expect(found.map((event) => event.id)).toEqual([waiting.id]);
  });

  it("survives a relay that asks for auth and never sends the challenge", async () => {
    /**
     * This took the daemon down. `Relay.authenticate` reports a missing
     * challenge by THROWING rather than by rejecting, so the `.catch` around it
     * never ran: the throw escaped into the rxjs subscriber that triggered it,
     * was reported as an unhandled error, and rethrown. `hex serve` exited
     * mid-session, having done nothing wrong except ask a relay that had gone
     * quiet under load.
     *
     * The stand-in throws synchronously the way applesauce does. What is being
     * tested is that the process is still here afterwards, and that the failure
     * was said out loud rather than swallowed.
     */
    const said: string[] = [];
    const thrower = {
      authenticated: false,
      authenticate: () => {
        throw new Error("Have not received authentication challenge");
      },
      authRequiredForRead$: {
        subscribe: (fn: (r: boolean) => void) => {
          fn(true);
          return { unsubscribe: () => {} };
        },
      },
      authRequiredForPublish$: { subscribe: () => ({ unsubscribe: () => {} }) },
    };

    watcher = authenticateOwn({
      pool: { relay: () => thrower } as never,
      relays: ["wss://quiet.example"],
      signer,
      log: (line) => said.push(line),
    });

    // The rejection is handled on a microtask, so let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(said.join("\n")).toContain("would not authenticate Hex");
    expect(said.join("\n")).toContain("authentication challenge");
  });

  it("says nothing to a relay that never asks", async () => {
    // An AUTH nobody demanded tells a relay who is reading a public query. Hex
    // has no reason to volunteer that, so the watcher stays silent.
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();

    watcher = authenticateOwn({
      pool: relays.pool,
      relays: [relay.url],
      signer,
    });

    await requestEvents(
      relays,
      [relay.url],
      [{ kinds: [1059], "#p": [pubkey] }],
    );

    expect(relay.authenticated).toEqual([]);
  });
});
