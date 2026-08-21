import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bytesToHex,
  communityIdOf,
  epochKeyCommitment,
} from "../concord/derive.js";
import {
  adoptChannelKey,
  adoptRoot,
  channelStreams,
  currentStream,
  membershipFromBundle,
  membershipFromStored,
  membershipToStored,
  mergeBundle,
} from "../concord/membership.js";
import { checkContinuity, decodeWrappedKey } from "../concord/rekey.js";
import {
  decodeFragment,
  parseInviteLink,
  validateBundle,
  type InviteBundle,
} from "../concord/invite.js";
import { HexStore } from "../store.js";

const OWNER = new Uint8Array(32).fill(0x11);
const SALT = new Uint8Array(32).fill(0x22);
const COMMUNITY = bytesToHex(communityIdOf(OWNER, SALT));
const ROOT = new Uint8Array(32).fill(0x33);
const PUBLIC_CHANNEL = "0a".repeat(32);
const PRIVATE_CHANNEL = "0b".repeat(32);

function bundle(overrides: Partial<InviteBundle> = {}): InviteBundle {
  return {
    community_id: COMMUNITY,
    owner: bytesToHex(OWNER),
    owner_salt: bytesToHex(SALT),
    community_root: bytesToHex(ROOT),
    root_epoch: 2,
    channels: [
      { id: PRIVATE_CHANNEL, key: "0c".repeat(32), epoch: 5, name: "backroom" },
    ],
    relays: ["wss://relay.example/"],
    name: "Mages Guild",
    ...overrides,
  };
}

describe("a membership is the keys, and nothing else", () => {
  it("takes private channels from the invite and public ones from the config", () => {
    const held = membershipFromBundle(bundle(), [
      { id: PUBLIC_CHANNEL, name: "grimoire" },
    ]);
    expect(held.channels.map((channel) => channel.name)).toEqual([
      "backroom",
      "grimoire",
    ]);
    // A public channel holds no key of its own: it derives from the root every
    // member already has, which is the whole difference between the two kinds.
    expect(held.channels.find((c) => c.name === "grimoire")?.keys).toEqual([]);
  });

  it("keeps every held epoch readable when a rotation lands", () => {
    const held = membershipFromBundle(bundle(), [{ id: PUBLIC_CHANNEL }]);
    const before = channelStreams(held, held.channels[1]!).map(
      (s) => s.group.pk,
    );
    expect(before).toHaveLength(1);

    adoptRoot(held, { epoch: 3n, key: new Uint8Array(32).fill(0x44) });

    const after = channelStreams(held, held.channels[1]!);
    // Additive: the new epoch is where Hex writes, and the old address stays
    // subscribed so the conversation does not appear to have been erased.
    expect(after).toHaveLength(2);
    expect(after[0]?.epoch).toBe(3n);
    expect(after.map((s) => s.group.pk)).toContain(before[0]);
    expect(currentStream(held, held.channels[1]!)?.epoch).toBe(3n);
  });

  it("converges two rotators racing on one epoch", () => {
    const held = membershipFromBundle(bundle(), []);
    const low = new Uint8Array(32).fill(0x01);
    const high = new Uint8Array(32).fill(0xfe);
    adoptChannelKey(held, PRIVATE_CHANNEL, { epoch: 6n, key: high });
    adoptChannelKey(held, PRIVATE_CHANNEL, { epoch: 6n, key: low });
    // The lower key wins the chain; the loser stays held, so anything written
    // into the losing fork is still readable.
    expect(currentStream(held, held.channels[0]!)?.epoch).toBe(6n);
    expect(held.channels[0]!.keys).toHaveLength(3);
    expect(
      bytesToHex(held.channels[0]!.keys.find((key) => key.epoch === 6n)!.key),
    ).toBe(bytesToHex(low));
    expect(currentStream(held, held.channels[0]!)!.group.pk).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("never walks backwards on a stale bundle", () => {
    const held = membershipFromBundle(bundle({ root_epoch: 5 }), []);
    mergeBundle(held, bundle({ root_epoch: 2 }));
    // A stale invite carries keys the community has already rotated past.
    expect(currentStream(held, held.channels[0]!)).toBeDefined();
    expect(held.roots.map((root) => root.epoch)).toContain(5n);
    expect(
      [...held.roots].sort((a, b) => (a.epoch > b.epoch ? -1 : 1))[0]?.epoch,
    ).toBe(5n);
  });

  it("survives a restart with its keys intact", () => {
    const held = membershipFromBundle(bundle(), [{ id: PUBLIC_CHANNEL }]);
    const reloaded = membershipFromStored(membershipToStored(held));
    expect(reloaded.communityIdHex).toBe(held.communityIdHex);
    expect(channelStreams(reloaded, reloaded.channels[0]!)[0]?.group.pk).toBe(
      channelStreams(held, held.channels[0]!)[0]?.group.pk,
    );
  });
});

describe("a rotation is only adopted when it extends what is held", () => {
  it("recognises its own continuity, a gap, and a fork", () => {
    const commit = bytesToHex(epochKeyCommitment(2n, ROOT));
    expect(
      checkContinuity({ prevEpoch: 2n, prevCommit: commit }, 2n, ROOT),
    ).toEqual({ ok: true });
    // A rotation chained onto an epoch we never reached: fetch the gap first.
    expect(
      checkContinuity(
        { prevEpoch: 4n, prevCommit: commit },
        2n,
        ROOT,
      ).valueOf(),
    ).toMatchObject({ ok: false, reason: "gap" });
    // Same epoch, different prior key: a fork, or garbage.
    expect(
      checkContinuity(
        { prevEpoch: 2n, prevCommit: "f".repeat(64) },
        2n,
        ROOT,
      ).valueOf(),
    ).toMatchObject({ ok: false, reason: "fork" });
  });

  it("refuses a blob minted for another channel", () => {
    const scope = new Uint8Array(32).fill(0x0b);
    const other = new Uint8Array(32).fill(0x0e);
    const plain = new Uint8Array(72);
    plain.set(scope, 0);
    new DataView(plain.buffer).setBigUint64(32, 6n, false);
    plain.set(new Uint8Array(32).fill(0x77), 40);

    expect(bytesToHex(decodeWrappedKey(plain, scope, 6n))).toBe(
      "77".repeat(32),
    );
    // The scope and epoch live inside the ciphertext, which is what makes a
    // blob unspliceable onto a channel it was not minted for.
    expect(() => decodeWrappedKey(plain, other, 6n)).toThrow(/scope mismatch/);
    expect(() => decodeWrappedKey(plain, scope, 7n)).toThrow(/epoch mismatch/);
  });
});

describe("invites", () => {
  it("refuses a bundle whose owner does not reproduce its community_id", () => {
    expect(() => validateBundle(bundle())).not.toThrow();
    expect(() => validateBundle(bundle({ owner: "0e".repeat(32) }))).toThrow(
      /does not reproduce/,
    );
  });

  it("reads a link's fragment without sending it anywhere", () => {
    // version 4, stock-relay flag, 16 token bytes.
    const bytes = new Uint8Array(2 + 16);
    bytes[0] = 4;
    bytes[1] = 0x01;
    bytes.fill(0xab, 2);
    const fragment = Buffer.from(bytes).toString("base64url");
    const decoded = decodeFragment(fragment);
    expect(decoded.token).toHaveLength(16);
    expect(decoded.relays).toHaveLength(4);

    // Anything that is not recognisably an invite falls through rather than
    // throwing, so a caller can try its other parsers.
    expect(
      parseInviteLink("https://example.test/not-an-invite"),
    ).toBeUndefined();
  });

  it("refuses a truncated or over-long fragment", () => {
    expect(() => decodeFragment("BA")).toThrow(/truncated/);
    const trailing = new Uint8Array(2 + 17);
    trailing[0] = 4;
    trailing[1] = 0x01;
    expect(() =>
      decodeFragment(Buffer.from(trailing).toString("base64url")),
    ).toThrow(/trailing bytes/);
  });
});

describe("what the store has to remember", () => {
  it("keeps a membership, its cursors and what Hex already answered", () => {
    const dir = mkdtempSync(join(tmpdir(), "hex-concord-"));
    const store = HexStore.open(join(dir, "data.db"));

    const held = membershipFromBundle(bundle(), [{ id: PUBLIC_CHANNEL }]);
    store.saveMembership(held);
    adoptRoot(held, { epoch: 3n, key: new Uint8Array(32).fill(0x44) });
    store.saveMembership(held);

    const [stored] = store.storedMemberships();
    expect(stored?.roots).toHaveLength(2);
    // There is nothing to re-fetch: this row is the only copy of what Hex
    // holds, and a rotation that was not written down is a room it cannot
    // re-enter.
    expect(membershipFromStored(stored!).roots.map((r) => r.epoch)).toContain(
      3n,
    );

    store.rememberCursor("wss://relay.example/", "aa".repeat(32), 100);
    store.rememberCursor("wss://relay.example/", "aa".repeat(32), 50);
    // Forward only: events do not arrive in order, and a cursor walked
    // backwards re-ingests everything between.
    expect(store.cursorFor("wss://relay.example/", "aa".repeat(32))).toBe(100);

    store.rememberRumor("ab".repeat(32), false);
    store.rememberRumor("ac".repeat(32), true);
    expect(store.sawRumor("ab".repeat(32))).toBe(true);
    expect(store.isOwnRumor("ab".repeat(32))).toBe(false);
    // The one that makes a conversation a conversation across a restart.
    expect(store.isOwnRumor("ac".repeat(32))).toBe(true);

    store.close();
  });
});
