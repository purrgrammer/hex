import { describe, it, expect, afterEach } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";
import { createRelays } from "../relays.js";
import {
  isGroupMember,
  joinGroup,
  joinConfiguredGroups,
  KIND_JOIN_REQUEST,
} from "../transports/nip29-join.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const signer = PrivateKeySigner.fromKey(key);
const relayKey = generateSecretKey();

const GROUP_ID = "NkeVhXuWHGKKJCpn";

/** A relay-signed membership list (kind 39002) naming `members`. */
function memberList(id: string, members: string[], kind = 39002) {
  return finalizeEvent(
    {
      kind,
      content: "",
      created_at: 1000,
      tags: [["d", id], ...members.map((member) => ["p", member])],
    },
    relayKey,
  );
}

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;

afterEach(async () => {
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

describe("isGroupMember", () => {
  it("is true when the member list names the pubkey", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [memberList(GROUP_ID, [pubkey])],
    });
    relays = createRelays();
    expect(
      await isGroupMember(relays, { relay: relay.url, id: GROUP_ID }, pubkey),
    ).toBe(true);
  });

  it("is true when only the ADMIN list names the pubkey", async () => {
    // A relay lists an admin in 39001 and need not repeat them in 39002, so
    // checking members alone has Hex ask to join a group it moderates.
    relay = await startMockRelay({
      kind: "normal",
      events: [memberList(GROUP_ID, [pubkey], 39001)],
    });
    relays = createRelays();
    expect(
      await isGroupMember(relays, { relay: relay.url, id: GROUP_ID }, pubkey),
    ).toBe(true);
  });

  it("is false when the list names someone else", async () => {
    relay = await startMockRelay({
      kind: "normal",
      events: [memberList(GROUP_ID, [getPublicKey(generateSecretKey())])],
    });
    relays = createRelays();
    expect(
      await isGroupMember(relays, { relay: relay.url, id: GROUP_ID }, pubkey),
    ).toBe(false);
  });

  it("does not read another group's list", async () => {
    // `#d` is case-sensitive and per-group; a shared relay hosts many rooms.
    relay = await startMockRelay({
      kind: "normal",
      events: [memberList("other-group", [pubkey])],
    });
    relays = createRelays();
    expect(
      await isGroupMember(relays, { relay: relay.url, id: GROUP_ID }, pubkey),
    ).toBe(false);
  });
});

describe("joinGroup", () => {
  it("sends a kind 9021 h-tagged to the group, and only to its relay", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const outcome = await joinGroup(
      relays,
      signer,
      pubkey,
      { relay: relay.url, id: GROUP_ID },
      { now: () => 1000 },
    );

    expect(outcome.action).toBe("requested");
    expect(relay.received).toHaveLength(1);
    const request = relay.received[0]!;
    expect(request.kind).toBe(KIND_JOIN_REQUEST);
    expect(request.tags).toEqual([["h", GROUP_ID]]);
    expect(request.pubkey).toBe(pubkey);
  });

  it("sends nothing when Hex is already a member", async () => {
    // Startup runs this on every configured group; a join per boot is noise the
    // relay has to moderate.
    relay = await startMockRelay({
      kind: "normal",
      events: [memberList(GROUP_ID, [pubkey])],
    });
    relays = createRelays();
    const outcome = await joinGroup(relays, signer, pubkey, {
      relay: relay.url,
      id: GROUP_ID,
    });
    expect(outcome.action).toBe("already-member");
    expect(relay.received).toEqual([]);
  });

  it("sends nothing on a dry run", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const outcome = await joinGroup(
      relays,
      signer,
      pubkey,
      { relay: relay.url, id: GROUP_ID },
      { dryRun: true },
    );
    expect(outcome.action).toBe("requested");
    expect(relay.received).toEqual([]);
  });

  it("reports a relay that never answers as failed rather than hanging", async () => {
    relay = await startMockRelay({ kind: "silent" });
    relays = createRelays();
    const outcome = await joinGroup(
      relays,
      signer,
      pubkey,
      { relay: relay.url, id: GROUP_ID },
      { lookupTimeoutMs: 300, publishTimeoutMs: 300 },
    );
    expect(outcome.action).toBe("failed");
  });
});

describe("joinConfiguredGroups", () => {
  it("one unreachable group does not stop the others", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const outcomes = await joinConfiguredGroups(
      relays,
      signer,
      pubkey,
      [
        { relay: relay.url, id: GROUP_ID },
        { relay: "ws://127.0.0.1:1/", id: "nowhere" },
      ],
      { lookupTimeoutMs: 300, publishTimeoutMs: 300, now: () => 1000 },
    );

    expect(outcomes.map((outcome) => outcome.action)).toEqual([
      "requested",
      "failed",
    ]);
    expect(relay.received).toHaveLength(1);
  });
});
