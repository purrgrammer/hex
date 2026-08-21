import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import { PrivateKeySigner } from "applesauce-signers";
import {
  GiftWrapFactory,
  WrappedMessageFactory,
} from "applesauce-common/factories";

import { createRelays } from "../relays.js";
import { HexStore } from "../store.js";
import {
  Ingestor,
  controlEvent,
  messageEvent,
  settleControl,
  type HexEventType,
  type MessagePayload,
  type QueuedEvent,
} from "../ingest.js";
import { Nip17Transport } from "../transports/nip17.js";
import type { Inbound } from "../transports/types.js";
import type { SessionControl } from "../nostr/decode-control.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

/**
 * The invariants these pin down: an accepted event is durable before any
 * downstream code observes it, and each (transport, event id) enqueues at most
 * once in the horizon — across relays, across wraps of one rumor, and across
 * restarts.
 */

const hexKey = generateSecretKey();
const hexPubkey = getPublicKey(hexKey);
const hexSigner = PrivateKeySigner.fromKey(hexKey);

const peerKey = generateSecretKey();
const peerPubkey = getPublicKey(peerKey);
const peerSigner = PrivateKeySigner.fromKey(peerKey);

let dir: string;
let store: HexStore;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hex-ingest-"));
  path = join(dir, "data.db");
  store = HexStore.open(path);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function groupMessage(id: string, text = "hex?"): Inbound {
  return {
    id,
    author: peerPubkey,
    text,
    createdAt: 1_700_000_000,
    room: { transport: "nip-29", id: "bitcoin", relay: "wss://relay.example/" },
    tagsSelf: true,
    addressesSelf: true,
    event: { id, pubkey: peerPubkey, tags: [] } as unknown as NostrEvent,
  };
}

function instruction(id: string): SessionControl {
  return {
    id,
    operator: peerPubkey,
    agent: hexPubkey,
    session: "s-1",
    command: "cancel",
  };
}

/** An ingestor that records what it was handed and settles every row. */
function recording(options: { log?: (line: string) => void } = {}) {
  const seen: QueuedEvent[] = [];
  const ingest: Ingestor = new Ingestor({
    store,
    log: options.log,
    dispatch: (queued) => {
      seen.push(queued);
      ingest.finish(queued.seq, "handled");
    },
  });
  return { ingest, seen };
}

describe("accepting an event", () => {
  it("counts one nip-29 message once, however often the relay serves it", () => {
    const { ingest, seen } = recording();
    const message = groupMessage("e".repeat(64));

    expect(ingest.accept(message)).toBeGreaterThan(0);
    // Same event, second delivery. NIP-29 had no dedupe at all before this.
    expect(ingest.accept(message)).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect((seen[0]!.event.payload as MessagePayload).text).toBe("hex?");
  });

  it("keys the dedupe on transport and id, not id alone", () => {
    const id = "a".repeat(64);
    expect(
      store.enqueueInbound(messageEvent(groupMessage(id))),
    ).toBeGreaterThan(0);
    const asDm = messageEvent({
      ...groupMessage(id),
      room: { transport: "nip-17", id: peerPubkey },
    });
    // Two protocols can mint the same id; one is not the other's duplicate.
    expect(store.enqueueInbound(asDm)).toBeGreaterThan(0);
  });

  it("still knows an event after the process restarts", () => {
    const event = messageEvent(groupMessage("b".repeat(64)));
    expect(store.enqueueInbound(event)).toBeGreaterThan(0);

    store.close();
    store = HexStore.open(path);
    // In memory this was the whole bug: a restart re-read the inbox window and
    // answered everything in it again.
    expect(store.enqueueInbound(event)).toBeUndefined();
  });

  it("records what became of the row", () => {
    const seq = store.enqueueInbound(
      messageEvent(groupMessage("c".repeat(64))),
    );
    store.finishInbound(seq!, "dropped:rate-limited");
    expect(store.inboundOutcome(seq!)).toBe("dropped:rate-limited");
    expect(store.pendingInbound()).toHaveLength(0);
  });
});

describe("draining", () => {
  it("ignores a type this version does not know, and keeps going", () => {
    const lines: string[] = [];
    const { ingest, seen } = recording({ log: (line) => lines.push(line) });

    const stranger = {
      ...messageEvent(groupMessage("d".repeat(64))),
      type: "prophecy" as HexEventType,
    };
    const unknownSeq = store.enqueueInbound(stranger)!;
    const knownSeq = store.enqueueInbound(
      messageEvent(groupMessage("f".repeat(64))),
    )!;

    ingest.drain();

    expect(store.inboundOutcome(unknownSeq)).toBe("ignored");
    expect(lines.some((line) => line.includes("prophecy"))).toBe(true);
    // The unknown row is skipped, not a wall: what follows it still runs.
    expect(seen.map((queued) => queued.seq)).toEqual([knownSeq]);
  });

  it("hands rows over in arrival order", () => {
    const { ingest, seen } = recording();
    ingest.accept(groupMessage("1".repeat(64)));
    ingest.accept(groupMessage("2".repeat(64)));
    ingest.acceptControl(instruction("3".repeat(64)));
    expect(seen.map((queued) => queued.type)).toEqual([
      "message",
      "message",
      "control",
    ]);
  });

  it("never hands one row over twice", () => {
    const seen: QueuedEvent[] = [];
    // Nothing settles the row: a second drain must still not re-dispatch it.
    const ingest = new Ingestor({ store, dispatch: (q) => seen.push(q) });
    ingest.accept(groupMessage("4".repeat(64)));
    ingest.drain();
    ingest.drain();
    expect(seen).toHaveLength(1);
  });
});

describe("what a dead process left behind", () => {
  it("redelivers both, because the row answers for itself", () => {
    const messageSeq = store.enqueueInbound(
      messageEvent(groupMessage("5".repeat(64))),
    )!;
    const controlSeq = store.enqueueInbound(
      controlEvent(instruction("6".repeat(64))),
    )!;

    const { ingest, seen } = recording();
    ingest.start();
    ingest.stop();

    // The message used to be settled `dropped:restart` here without ever
    // being dispatched, because the only thing that could answer it was an
    // `Inbound` held in the dead process's memory. It is handed on now; this
    // fake dispatch is what settles it `handled`.
    expect(store.inboundOutcome(messageSeq)).not.toMatch(/^dropped/);
    expect(seen.map((queued) => queued.seq)).toEqual([messageSeq, controlSeq]);
    // And it arrives answerable, not as a bare record.
    const redelivered = seen.find((queued) => queued.seq === messageSeq)!;
    expect(redelivered.carrier).toBeDefined();
    expect(redelivered.carrier!.id).toBe("5".repeat(64));
    expect(redelivered.carrier!.room.id).toBeTruthy();
  });

  it("gives up only on a row written before the raw event was kept", () => {
    const seq = store.enqueueInbound(
      messageEvent(groupMessage("8".repeat(64))),
    )!;
    // What an upgrade leaves behind: a row from a build that stored no raw.
    store.rawForTests?.(seq, null);

    const { ingest, seen } = recording();
    ingest.start();
    ingest.stop();
    const forMessage = seen.find((queued) => queued.seq === seq);
    expect(forMessage?.carrier).toBeUndefined();
  });

  it("leaves a control owed when acting on it fails", () => {
    const seq = store.enqueueInbound(
      controlEvent(instruction("7".repeat(64))),
    )!;
    const failing = new Ingestor({
      store,
      // Settling only on success is the whole point: an unsettled row is the
      // retry.
      dispatch: () => {
        /* the runtime is down */
      },
    });
    failing.drain();

    expect(store.pendingInbound().map((row) => row.seq)).toEqual([seq]);
    expect(store.inboundOutcome(seq)).toBeUndefined();
  });

  it("gives up on a control too old for any redelivery to have helped", () => {
    /**
     * The bound the relay used to provide. An instruction that can never land —
     * a stop for a run that already ended, a session this agent never published
     * — would otherwise be handed to `dispatch` at every start for the life of
     * the home.
     */
    const stale = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
    const seq = store.enqueueInbound(
      controlEvent(instruction("8".repeat(64)), stale),
    )!;
    const fresh = store.enqueueInbound(
      controlEvent(instruction("9".repeat(64))),
    )!;

    const { ingest, seen } = recording();
    ingest.start();
    ingest.stop();

    expect(store.inboundOutcome(seq)).toBe("dropped:expired");
    expect(seen.map((queued) => queued.seq)).toEqual([fresh]);
  });
});

describe("settling a control's row", () => {
  it("leaves the row pending when the instruction never landed", () => {
    const seq = store.enqueueInbound(
      controlEvent(instruction("a1".padEnd(64, "0"))),
    )!;
    const ingest = new Ingestor({ store, dispatch: () => {} });

    expect(settleControl(ingest, seq, "unavailable")).toBe(false);
    expect(store.inboundOutcome(seq)).toBeUndefined();
    expect(store.pendingInbound().map((row) => row.seq)).toEqual([seq]);
  });

  it("settles it under every other outcome", () => {
    const ingest = new Ingestor({ store, dispatch: () => {} });
    for (const outcome of ["handled", "duplicate", "refused"] as const) {
      const seq = store.enqueueInbound(
        controlEvent(instruction(`${outcome}`.padEnd(64, "0"))),
      )!;
      expect(settleControl(ingest, seq, outcome)).toBe(true);
      expect(store.inboundOutcome(seq)).toBe(outcome);
    }
    expect(store.pendingInbound()).toHaveLength(0);
  });
});

describe("transport cursors", () => {
  it("moves forward and only forward", () => {
    store.rememberTransportCursor("nip-17", "wss://a.example/", "inbox", 100);
    store.rememberTransportCursor("nip-17", "wss://a.example/", "inbox", 50);
    expect(
      store.transportCursorFor("nip-17", "wss://a.example/", "inbox"),
    ).toBe(100);
  });

  it("keeps each relay's own position", () => {
    store.rememberTransportCursor("concord", "wss://a.example/", "s", 10);
    store.rememberTransportCursor("concord", "wss://b.example/", "s", 20);
    expect(store.transportCursorFor("concord", "wss://a.example/", "s")).toBe(
      10,
    );
    expect(store.transportCursorFor("concord", "wss://b.example/", "s")).toBe(
      20,
    );
  });

  it("carries an existing home's Concord cursors into the new table", () => {
    // A home written before this table existed: opening it must not lose the
    // read position, or the first start re-ingests the community.
    const older = join(dir, "older.db");
    const raw = new DatabaseSync(older);
    raw.exec(
      `CREATE TABLE IF NOT EXISTS concord_cursors (
         relay TEXT NOT NULL, stream TEXT NOT NULL, since INTEGER NOT NULL,
         PRIMARY KEY (relay, stream))`,
    );
    raw
      .prepare(`INSERT INTO concord_cursors VALUES (?, ?, ?)`)
      .run("wss://old.example/", "aa".repeat(32), 4242);
    raw.close();

    const opened = HexStore.open(older);
    expect(opened.cursorFor("wss://old.example/", "aa".repeat(32))).toBe(4242);
    opened.close();
  });
});

describe("a rumor that arrives in several wraps", () => {
  let relay: MockRelay | undefined;
  let relays: ReturnType<typeof createRelays> | undefined;
  let transport: Nip17Transport | undefined;

  afterEach(async () => {
    transport?.stop();
    transport = undefined;
    relays?.close();
    relays = undefined;
    await relay?.close();
    relay = undefined;
  });

  it("is one message, not one per wrap", async () => {
    const rumor = await WrappedMessageFactory.create(
      hexPubkey,
      "hex, are you there?",
    ).stamp(peerSigner);
    const first = await GiftWrapFactory.create(peerSigner, hexPubkey, rumor);
    const second = await GiftWrapFactory.create(peerSigner, hexPubkey, rumor);
    // The envelopes differ — each is signed by its own throwaway key — which is
    // exactly why deduping on the wrap counted one question as two.
    expect(first.id).not.toBe(second.id);

    relay = await startMockRelay({ kind: "normal", events: [first, second] });
    relays = createRelays();
    transport = new Nip17Transport({
      relays,
      signer: hexSigner,
      pubkey: hexPubkey,
      inboxRelays: [relay.url],
      readRelays: [relay.url],
      allow: [peerPubkey],
      since: 0,
      publishTimeoutMs: 1000,
    });

    const { ingest, seen } = recording();
    const opened: string[] = [];
    const subscription = transport.start().subscribe((inbound) => {
      opened.push(inbound.id);
      ingest.accept(inbound);
    });
    await new Promise((settle) => setTimeout(settle, 500));
    subscription.unsubscribe();

    // Both wraps opened, and both carried the same rumor: the transport no
    // longer dedupes, and the identity it hands over is the rumor's.
    expect(opened).toHaveLength(2);
    expect(new Set(opened).size).toBe(1);
    expect(seen).toHaveLength(1);
    expect((seen[0]!.event.payload as MessagePayload).text).toBe(
      "hex, are you there?",
    );
    expect(seen[0]!.event.id).toBe(opened[0]);
  });
});
