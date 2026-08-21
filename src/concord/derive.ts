/**
 * Concord derivations — CORD-02 Appendix A (frozen).
 *
 * Ported from grimoire's `src/lib/concord/derive.ts`, itself ported from armada.
 * This file is WIRE FORMAT: every address Concord uses comes out of a community
 * secret through one of the shapes below, and changing any labeled byte
 * re-addresses every prior event — a channel Hex could no longer read and a
 * message no member could. Keep it byte-identical to the reference
 * implementation; the test vectors beside it are what "byte-identical" means in
 * practice.
 *
 * Construction (A.1): `HKDF-SHA256(ikm=secret, salt=∅, info, L=32)` where
 *   `info = utf8(label) || 0x00 || id[32] || epoch_be[8]?`
 * The id is always present (all-zeroes where a label has no meaningful id); the
 * epoch is the only omittable field, and the scalar-normalize retry counter
 * (A.3) appends after whatever fields are present, starting at byte 0.
 *
 * Only the labels Hex actually addresses are here. The rest of the A.6 registry
 * (voice, guestbook, grants, pins, banlists, invite registries) is left in
 * grimoire: an unused derivation is a wire constant nothing tests.
 */

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getConversationKey } from "nostr-tools/nip44";

// ── Labels (A.6, frozen) ────────────────────────────────────────────────────

const LABEL_CHANNEL = "concord/channel";
const LABEL_CONTROL = "concord/control";
const LABEL_REKEY_PSEUDONYM = "concord/rekey-pseudonym";
const LABEL_BASE_REKEY_PSEUDONYM = "concord/base-rekey-pseudonym";
const LABEL_RECIPIENT_PSEUDONYM = "concord/recipient-pseudonym";
const LABEL_INVITE_KEY = "concord/invite-key";

/** The community_id commitment prefix (A.4) — plain SHA-256, not the hkdf shape. */
const LABEL_COMMUNITY = "concord/community";
/** The epoch-key commitment prefix (A.5). */
const LABEL_EPOCH_COMMITMENT = "concord/epoch-key-commitment";

const ZERO32 = new Uint8Array(32);
const ASCII = new TextEncoder();

export { bytesToHex, hexToBytes };

/** Parse a 64-char hex string to 32 bytes, throwing on anything else. */
export function hex32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex))
    throw new Error(`invalid 64-char hex (got ${hex.length} chars)`);
  return hexToBytes(hex.toLowerCase());
}

function assert32(name: string, bytes: Uint8Array): void {
  if (bytes.length !== 32)
    throw new Error(`${name} must be 32 bytes, got ${bytes.length}`);
}

function toEpoch(epoch: number | bigint): bigint {
  return typeof epoch === "bigint" ? epoch : BigInt(epoch);
}

function u64be(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, false);
  return out;
}

// ── A.1: the frozen info layout ─────────────────────────────────────────────

/** `utf8(label) || 0x00 || id[32] || epoch_be[8]?` — epoch omitted when undefined. */
function buildInfo(
  label: string,
  id32: Uint8Array,
  epoch?: bigint,
): Uint8Array {
  assert32("id", id32);
  const labelBytes = ASCII.encode(label);
  const hasEpoch = epoch !== undefined;
  const out = new Uint8Array(labelBytes.length + 1 + 32 + (hasEpoch ? 8 : 0));
  let offset = 0;
  out.set(labelBytes, offset);
  offset += labelBytes.length;
  out[offset] = 0x00;
  offset += 1;
  out.set(id32, offset);
  offset += 32;
  if (hasEpoch) out.set(u64be(epoch), offset);
  return out;
}

/** HKDF-SHA256, zero-length salt, 32-byte output. */
function hkdf32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), info, 32);
}

// ── A.3: scalar_normalize ───────────────────────────────────────────────────

/**
 * Reduce an hkdf seed to a valid secp256k1 secret key. A seed that is not a
 * valid scalar appends one incrementing counter byte to the info and retries,
 * the counter starting at 0 (A.3). The reject branch is ~2^-128 rare; the
 * counter is what keeps it deterministic across implementations.
 */
function hkdfToSecretKey(ikm: Uint8Array, baseInfo: Uint8Array): Uint8Array {
  {
    const seed = hkdf32(ikm, baseInfo);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  for (let counter = 0; counter <= 0xff; counter++) {
    const info = new Uint8Array(baseInfo.length + 1);
    info.set(baseInfo, 0);
    info[baseInfo.length] = counter;
    const seed = hkdf32(ikm, info);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  throw new Error("scalar rejection 257 times running is impossible");
}

// ── A.2: group_key ──────────────────────────────────────────────────────────

/**
 * A plane's stream keypair: the x-only pubkey is the on-wire address (what a
 * REQ asks for in `authors` and what a NIP-42 AUTH must prove), the secret key
 * signs its wraps, and the NIP-44 self-ECDH conversation key encrypts them.
 */
export interface GroupKey {
  /** secp256k1 secret key — signs this stream's wraps. */
  sk: Uint8Array;
  /** x-only pubkey hex — the stream address. */
  pk: string;
  /**
   * NIP-44 conversation key (self-ECDH of `sk` with its own `pk`).
   *
   * Lazy: the ECDH is the expensive half of a derivation, and a key held only
   * for its address — a subscription filter, an auth registration — never needs
   * one.
   */
  readonly convKey: Uint8Array;
}

/**
 * A stream as a READER holds it.
 *
 * Every plane Hex touches is a full {@link GroupKey}, but a split Control Plane
 * (CORD-01's Write-Restricted Stream) hands members an address and a read key
 * and keeps the signing secret with staff — so `sk` is optional, and anything
 * that only reads takes this shape.
 */
export interface StreamKeyView {
  pk: string;
  readonly convKey: Uint8Array;
  sk?: Uint8Array;
  /**
   * Write-restricted: the address belongs to a narrower writer set, so the
   * wrap's own signature actually proves something and a reader MUST check it.
   * An ordinary stream's wrap is signed with a key every reader holds and
   * proves nothing.
   */
  restricted?: boolean;
}

/**
 * Derivation memo, keyed by (label, secret, id, epoch).
 *
 * Sound because Appendix A is frozen and every consumer treats a GroupKey as
 * read-only. Bounded, because a long-running daemon that follows a rekeying
 * community derives a new key set per epoch forever, and an unbounded map of
 * secrets is a leak in both senses of the word.
 */
const memo = new Map<string, GroupKey>();
const MEMO_MAX = 4096;

function groupKeyCached(
  label: string,
  secret: Uint8Array,
  id: Uint8Array,
  epoch?: bigint,
): GroupKey {
  const memoKey = `${label}|${bytesToHex(secret)}|${bytesToHex(id)}|${epoch ?? ""}`;
  const hit = memo.get(memoKey);
  if (hit) return hit;

  const sk = hkdfToSecretKey(secret, buildInfo(label, id, epoch));
  const pk = bytesToHex(schnorr.getPublicKey(sk));
  let convKey: Uint8Array | undefined;
  const key: GroupKey = {
    sk,
    pk,
    get convKey(): Uint8Array {
      return (convKey ??= getConversationKey(sk, pk));
    },
  };

  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(memoKey, key);
  return key;
}

/** Drop every cached derivation — the memo holds stream secrets. */
export function clearDerivationMemo(): void {
  memo.clear();
}

// ── Plane keys ──────────────────────────────────────────────────────────────

/**
 * A Channel's group key (CORD-03 §1). `secret` is the community_root at its
 * root epoch for a PUBLIC channel, or the channel's own independent key at its
 * channel epoch for a PRIVATE one — which is the entire difference between the
 * two kinds of channel.
 */
export function channelGroupKey(
  secret: Uint8Array,
  channelId: Uint8Array,
  epoch: number | bigint,
): GroupKey {
  assert32("secret", secret);
  assert32("channelId", channelId);
  return groupKeyCached(LABEL_CHANNEL, secret, channelId, toEpoch(epoch));
}

/**
 * The Control Plane's community_root-keyed group key (CORD-02 §5).
 *
 * Post-split this is the plane's READ key: its `convKey` opens the wraps every
 * member can read, while the address is the delivered `control_pk`. On a legacy
 * pre-split epoch the same derivation was the whole plane, address included.
 */
export function controlGroupKey(
  communityRoot: Uint8Array,
  communityId: Uint8Array,
  epoch: number | bigint,
): GroupKey {
  assert32("communityRoot", communityRoot);
  assert32("communityId", communityId);
  return groupKeyCached(
    LABEL_CONTROL,
    communityRoot,
    communityId,
    toEpoch(epoch),
  );
}

/**
 * A private Channel's rekey address for `newEpoch`, keyed by the PRIOR
 * community_root (CORD-06 §2).
 *
 * Derived from the prior secret on purpose: every current keyholder can find
 * the rotation, and a removed member — who no longer holds it — cannot.
 */
export function channelRekeyGroupKey(
  priorRoot: Uint8Array,
  channelId: Uint8Array,
  newEpoch: number | bigint,
): GroupKey {
  assert32("priorRoot", priorRoot);
  assert32("channelId", channelId);
  return groupKeyCached(
    LABEL_REKEY_PSEUDONYM,
    priorRoot,
    channelId,
    toEpoch(newEpoch),
  );
}

/** The base-rotation (Refounding) rekey address for `newEpoch`. */
export function baseRekeyGroupKey(
  priorRoot: Uint8Array,
  communityId: Uint8Array,
  newEpoch: number | bigint,
): GroupKey {
  assert32("priorRoot", priorRoot);
  assert32("communityId", communityId);
  return groupKeyCached(
    LABEL_BASE_REKEY_PSEUDONYM,
    priorRoot,
    communityId,
    toEpoch(newEpoch),
  );
}

// ── Coordinates (keyless 32-byte locators) ──────────────────────────────────

/**
 * A rekey blob's per-recipient locator (CORD-06 §2):
 * `hkdf(rotator_xonly || recipient_xonly, "concord/recipient-pseudonym", scope_id, epoch)`.
 *
 * Derived from PUBLIC inputs, so a bunker-held identity finds its own blob
 * without raw-key access. It appears only inside the encrypted rekey event.
 */
export function recipientLocator(
  rotatorXonly: Uint8Array,
  recipientXonly: Uint8Array,
  scopeId: Uint8Array,
  newEpoch: number | bigint,
): Uint8Array {
  assert32("rotatorXonly", rotatorXonly);
  assert32("recipientXonly", recipientXonly);
  assert32("scopeId", scopeId);
  const ikm = new Uint8Array(64);
  ikm.set(rotatorXonly, 0);
  ikm.set(recipientXonly, 32);
  return hkdf32(
    ikm,
    buildInfo(LABEL_RECIPIENT_PSEUDONYM, scopeId, toEpoch(newEpoch)),
  );
}

/** The public-invite bundle's decrypt key, from the link's unlock token. */
export function inviteBundleKey(token: Uint8Array): Uint8Array {
  return hkdf32(token, buildInfo(LABEL_INVITE_KEY, ZERO32));
}

// ── A.4: community_id ───────────────────────────────────────────────────────

/**
 * The self-certifying community identity:
 * `sha256("concord/community" || owner_xonly || owner_salt)`.
 *
 * This is what makes an invite trustworthy without trusting the inviter: a
 * bundle whose owner and salt do not reproduce its community_id is a different
 * community wearing the name.
 */
export function communityIdOf(
  ownerXonly: Uint8Array,
  ownerSalt: Uint8Array,
): Uint8Array {
  assert32("ownerXonly", ownerXonly);
  assert32("ownerSalt", ownerSalt);
  const label = ASCII.encode(LABEL_COMMUNITY);
  const pre = new Uint8Array(label.length + 64);
  pre.set(label, 0);
  pre.set(ownerXonly, label.length);
  pre.set(ownerSalt, label.length + 32);
  return sha256(pre);
}

/** Whether a claimed (owner, salt) pair reproduces `communityIdHex`. */
export function verifyCommunityId(
  communityIdHex: string,
  ownerHex: string,
  ownerSaltHex: string,
): boolean {
  try {
    return (
      bytesToHex(communityIdOf(hex32(ownerHex), hex32(ownerSaltHex))) ===
      communityIdHex.toLowerCase()
    );
  } catch {
    return false;
  }
}

// ── A.5: epoch-key commitment ───────────────────────────────────────────────

/**
 * `sha256("concord/epoch-key-commitment" || prev_epoch_be || prev_key)` (CORD-06).
 *
 * A rotation carries this, and it is the only thing that proves the rotation
 * extends the key already held rather than replacing it with a stranger's.
 */
export function epochKeyCommitment(
  prevEpoch: number | bigint,
  prevKey: Uint8Array,
): Uint8Array {
  assert32("prevKey", prevKey);
  const label = ASCII.encode(LABEL_EPOCH_COMMITMENT);
  const pre = new Uint8Array(label.length + 8 + 32);
  pre.set(label, 0);
  pre.set(u64be(toEpoch(prevEpoch)), label.length);
  pre.set(prevKey, label.length + 8);
  return sha256(pre);
}
