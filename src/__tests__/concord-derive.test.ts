import { describe, it, expect } from "vitest";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";

import {
  baseRekeyGroupKey,
  bytesToHex,
  channelGroupKey,
  channelRekeyGroupKey,
  communityIdOf,
  controlGroupKey,
  epochKeyCommitment,
  inviteBundleKey,
  recipientLocator,
  verifyCommunityId,
} from "../concord/derive.js";

const A = new Uint8Array(32).fill(1);
const B = new Uint8Array(32).fill(2);
const C = new Uint8Array(32).fill(3);
const R = new Uint8Array(32).fill(0xab);

/**
 * Frozen vectors, taken from grimoire's `derive.test.ts`, which generated them
 * by running its port and armada `bc19d1f` side by side over these inputs.
 *
 * They are the point of this file. Everything else about a derivation is
 * structural — deterministic, distinct, epoch-rolling — and would pass on ANY
 * self-consistent implementation, including a wrong one. Only pinned bytes
 * catch the failure that matters here: a derivation that is internally
 * consistent and disagrees with every other Concord client, which presents as
 * "the community is empty" rather than as an error.
 */
const VECTORS = {
  "channel.pk":
    "20b59d9cc1472395cf5c954dbd2e6322c0ca005b08004f8f443a2f65d3c8b8aa",
  "channel.pk@7":
    "27526e33567b8b5359cf3be7214d3b87dcaf438a6f814c0fea55f632ceeffca7",
  "channel.convKey":
    "b3981d32dc407f390642ca3e51d145c82e092b889e0fd7164b0ebb4579cf296e",
  "channel.sk":
    "4b902405c5fd7f0b2e5046cd61fb8ceb13a1874b8e9fddaf280e5ed2e3359fa5",
  "control.pk":
    "57d6c4ac20f59c5b016fc1d4d81df87cd85449564640b5d5dbb8d0e89f6fcb0a",
  "control.convKey":
    "87a02b010e0166c458bfe0fae8070047d962ceab6d8e43fac6d852ac568935ff",
  "channelRekey.pk":
    "50e50179593692b590c19d5f256b0c2edea163883b48f1a930258ee8afee4d7c",
  "baseRekey.pk":
    "32a09463ee1304cde07d48ab19028684d742b6b7170481a700a240d9c70caf4a",
  recipientLocator:
    "dfe3f8953b7c59755bbbb3f6edc777220cd7f0545c83fa01334b242f4db04a33",
  inviteBundleKey:
    "94bf8b0d89e579ddaeccf8d9db3f5de5c86a1259c597f2560ff0120173bc5e1f",
  communityIdOf:
    "637fba842161c1360163b53a5c6ad5c77ddba0759949a5f6285fc5e9b6d114c0",
  epochKeyCommitment:
    "cbf65d7d59ee87ce0dca143892b56711d4cda9c147f4109b63defcf450c8beb7",
} as const;

describe("Concord derivations (CORD-02 Appendix A)", () => {
  it("matches armada and grimoire byte for byte", () => {
    expect(channelGroupKey(A, B, 0).pk).toBe(VECTORS["channel.pk"]);
    expect(channelGroupKey(A, B, 7).pk).toBe(VECTORS["channel.pk@7"]);
    expect(bytesToHex(channelGroupKey(A, B, 0).convKey)).toBe(
      VECTORS["channel.convKey"],
    );
    expect(bytesToHex(channelGroupKey(A, B, 0).sk)).toBe(VECTORS["channel.sk"]);
    expect(controlGroupKey(A, B, 0).pk).toBe(VECTORS["control.pk"]);
    expect(bytesToHex(controlGroupKey(A, B, 0).convKey)).toBe(
      VECTORS["control.convKey"],
    );
    expect(channelRekeyGroupKey(A, B, 1).pk).toBe(VECTORS["channelRekey.pk"]);
    expect(baseRekeyGroupKey(A, B, 1).pk).toBe(VECTORS["baseRekey.pk"]);
    expect(bytesToHex(recipientLocator(A, B, C, 3))).toBe(
      VECTORS.recipientLocator,
    );
    expect(bytesToHex(inviteBundleKey(new Uint8Array(16).fill(7)))).toBe(
      VECTORS.inviteBundleKey,
    );
    expect(bytesToHex(communityIdOf(A, B))).toBe(VECTORS.communityIdOf);
    expect(bytesToHex(epochKeyCommitment(2, R))).toBe(
      VECTORS.epochKeyCommitment,
    );
  });

  it("matches an independent construction of the A.1 info layout", () => {
    // Rebuilt from the spec text rather than from the port, so the vectors
    // above are anchored to Appendix A and not merely to another
    // implementation that could share a mistake.
    const label = new TextEncoder().encode("concord/channel");
    const info = new Uint8Array(label.length + 1 + 32 + 8);
    info.set(label, 0);
    info[label.length] = 0x00;
    info.set(B, label.length + 1);
    new DataView(info.buffer).setBigUint64(label.length + 33, 7n, false);
    const sk = hkdf(sha256, A, new Uint8Array(0), info, 32);
    expect(bytesToHex(schnorr.getPublicKey(sk))).toBe(VECTORS["channel.pk@7"]);
  });

  it("re-addresses everything when the epoch turns", () => {
    // Why a rotation makes a client deaf rather than broken: the address is a
    // different key entirely, and nothing about the old one stops working.
    expect(channelGroupKey(A, B, 0).pk).not.toBe(channelGroupKey(A, B, 1).pk);
    expect(channelGroupKey(A, B, 0).pk).not.toBe(channelGroupKey(B, B, 0).pk);
  });

  it("refuses an owner that does not reproduce its community_id", () => {
    const id = bytesToHex(communityIdOf(A, B));
    expect(verifyCommunityId(id, bytesToHex(A), bytesToHex(B))).toBe(true);
    // The whole trust model of an invite: a compromised inviter cannot smuggle
    // a false owner for a real community.
    expect(verifyCommunityId(id, bytesToHex(C), bytesToHex(B))).toBe(false);
    expect(verifyCommunityId(id, bytesToHex(A), bytesToHex(C))).toBe(false);
  });

  it("keeps the rekey labels apart", () => {
    // A channel rotation and a refounding at the same epoch must never share an
    // address, or one would be read as the other.
    expect(channelRekeyGroupKey(A, B, 1).pk).not.toBe(
      baseRekeyGroupKey(A, B, 1).pk,
    );
  });
});
