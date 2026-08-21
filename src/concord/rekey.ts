/**
 * Rekeys and Refoundings — CORD-06, read side.
 *
 * Ported from grimoire's `src/lib/concord/rekey.ts`, minus every builder: Hex
 * never rotates a key, it only follows rotations.
 *
 * Following them is not optional. A channel's address derives from a key AND an
 * epoch, so the first rotation after Hex joins moves the whole conversation to
 * an address it is not subscribed to. A transport that ignored this would not
 * fail — it would go quietly deaf, in a room that still looks configured.
 *
 * How a rotation works, with no ratchets: the rotator mints a fresh key at the
 * next epoch and delivers it as per-recipient blobs (kind 3303, chunked) at an
 * address derived from the PRIOR secret — so every current holder can find it,
 * and a removed member, finding no blob at their locator across all chunks,
 * learns they are out.
 *
 * The blob is fixed-width PER FORM, the width declaring the form (§1),
 * NIP-44-encrypted under the rotator↔recipient pairwise key — an ECDH either
 * side can compute, so a bunker-held identity opens its own blob with one
 * `nip44.decrypt` and no raw-key access:
 *
 *   - a channel rotation's blob is 72 bytes: `scope_id[32] ‖ epoch_be[8] ‖ new_key[32]`;
 *   - a base rotation's member blob is 104, appending `new_control_pk[32]`;
 *   - a staff recipient's is 136, appending `new_control_root[32]`;
 *   - a 72-byte BASE blob is the legacy pre-split form, read and never minted.
 *
 * **What is deliberately NOT checked here: the rotator's authority.** CORD-04 §5
 * has a rotation cite the Grant it acts under, and verifying that citation means
 * folding the Control Plane, which this package does not do. What is checked is
 * CONTINUITY — the commitment proves the rotator held the prior key — so the
 * worst a member can do is hand Hex an extra key at a later epoch. That is
 * survivable only because adoption here is ADDITIVE: prior epochs stay
 * subscribed, so a bogus rotation adds an address nobody writes to rather than
 * moving Hex away from the one everybody does.
 */

import {
  bytesToHex,
  epochKeyCommitment,
  hex32,
  recipientLocator,
} from "./derive.js";
import { KIND_REKEY, KIND_SEAL_ENCRYPTED } from "./kinds.js";
import type { OpenedEvent } from "./stream.js";

/**
 * How many epochs past the one held to watch for a rotation.
 *
 * Watching only `held + 1` strands anyone who MISSES a rotation — offline
 * through it, or behind an auth-gating relay: the channel moves on and the
 * address they poll is never published to again. A window lets a daemon that
 * was down for a weekend catch up, or learn it was removed; the cost is one
 * extra author per epoch on a filter that is already author-scoped.
 */
export const REKEY_LOOKAHEAD = 8;

const ZERO32 = new Uint8Array(32);
export const ROOT_SCOPE_HEX = "0".repeat(64);

/** A rotation's scope: one private channel, or the community_root (a Refounding). */
export type RekeyScope =
  | { kind: "channel"; channelId: Uint8Array }
  | { kind: "root" };

/** The 32-byte scope id: the channel id, or all-zeroes for the root. */
export function rekeyScopeId(scope: RekeyScope): Uint8Array {
  return scope.kind === "channel" ? scope.channelId : ZERO32;
}

/** A tag value the spec writes as a plain decimal, and nothing else. */
function isTagDecimal(value: string | undefined): value is string {
  return value !== undefined && /^(0|[1-9][0-9]*)$/.test(value);
}

function readScopeAndEpoch(plain: Uint8Array): {
  scopeIdHex: string;
  epoch: bigint;
} {
  return {
    scopeIdHex: bytesToHex(plain.slice(0, 32)),
    epoch: new DataView(
      plain.buffer,
      plain.byteOffset,
      plain.byteLength,
    ).getBigUint64(32, false),
  };
}

/**
 * Parse and verify a decrypted 72-byte CHANNEL blob against what the event
 * claims.
 *
 * The scope and epoch live INSIDE the ciphertext and are checked against the
 * event's tags: that is what makes a blob unspliceable, so one minted for
 * another channel can never be replayed onto this one.
 */
export function decodeWrappedKey(
  plain: Uint8Array,
  expectedScopeId: Uint8Array,
  expectedEpoch: bigint,
): Uint8Array {
  if (plain.length !== 72)
    throw new Error(`wrapped key must be 72 bytes, got ${plain.length}`);
  const { scopeIdHex, epoch } = readScopeAndEpoch(plain);
  if (scopeIdHex !== bytesToHex(expectedScopeId))
    throw new Error("wrapped key scope mismatch");
  if (epoch !== expectedEpoch) throw new Error("wrapped key epoch mismatch");
  return plain.slice(40, 72);
}

/** A parsed base-rotation blob; the width declared the form (§1). */
export interface WrappedBaseKey {
  newRoot: Uint8Array;
  /** The next epoch's Control Plane address; absent on the legacy 72-byte form. */
  controlPk?: string;
}

/**
 * Parse and verify a decrypted BASE blob. The three fixed widths are accepted
 * and anything else is malformed.
 *
 * The 136-byte staff form's `new_control_root` is carried by staff clients that
 * can write the plane; Hex is never staff, so the extra 32 bytes are read past
 * and dropped rather than kept as a secret this process has no use for.
 */
export function decodeWrappedBaseKey(
  plain: Uint8Array,
  expectedEpoch: bigint,
): WrappedBaseKey {
  if (plain.length !== 72 && plain.length !== 104 && plain.length !== 136)
    throw new Error(
      `wrapped base key must be 72, 104 or 136 bytes, got ${plain.length}`,
    );
  const { scopeIdHex, epoch } = readScopeAndEpoch(plain);
  if (scopeIdHex !== ROOT_SCOPE_HEX)
    throw new Error("wrapped key scope mismatch");
  if (epoch !== expectedEpoch) throw new Error("wrapped key epoch mismatch");
  const newRoot = plain.slice(40, 72);
  if (plain.length === 72) return { newRoot };
  return { newRoot, controlPk: bytesToHex(plain.slice(72, 104)) };
}

/** base64 → bytes: how a blob rides through string-only nip44 signers. */
export function base64ToBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

// ── The 3303 rumor ──────────────────────────────────────────────────────────

/** One located, wrapped key. */
export interface RekeyBlob {
  /** Where its recipient finds it (hex of the recipient locator). */
  locator: string;
  /** NIP-44 ciphertext under the rotator↔recipient pairwise key. */
  wrapped: string;
}

export interface ParsedRekey {
  /** The rumor's own id, so one chunk delivered by four relays is parked once. */
  rumorId: string;
  /** The rotator's real pubkey — the seal's signer. */
  rotator: string;
  scopeIdHex: string;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevCommit: string;
  chunkIndex: number;
  chunkCount: number;
  blobs: RekeyBlob[];
  ms: number;
}

/** Parse an opened rekey stream event into its rotation fields. */
export function parseRekey(opened: OpenedEvent): ParsedRekey {
  if (opened.kind !== KIND_REKEY) throw new Error("not a rekey rumor");
  if (opened.sealKind !== KIND_SEAL_ENCRYPTED)
    throw new Error("rekey seals must be encrypted (CORD-02 §5)");

  const tag = (name: string) => opened.tags.find((t) => t[0] === name);
  const scope = tag("scope")?.[1];
  const newEpoch = tag("newepoch")?.[1];
  const prevEpoch = tag("prevepoch")?.[1];
  const prevCommit = tag("prevcommit")?.[1];
  const chunk = tag("chunk");

  if (!scope || !/^[0-9a-f]{64}$/i.test(scope)) throw new Error("bad scope tag");
  if (!isTagDecimal(newEpoch)) throw new Error("bad newepoch tag");
  if (!isTagDecimal(prevEpoch)) throw new Error("bad prevepoch tag");
  if (!prevCommit || !/^[0-9a-f]{64}$/i.test(prevCommit))
    throw new Error("bad prevcommit tag");
  // Spec-shaped decimals, not `Number()`: that would take "1e2", "0x2" and
  // " 2 " as chunk coordinates a stricter peer refuses.
  if (chunk && (!isTagDecimal(chunk[1]) || !isTagDecimal(chunk[2])))
    throw new Error("bad chunk tag");

  const chunkIndex = chunk ? Number(chunk[1]) : 1;
  const chunkCount = chunk ? Number(chunk[2]) : 1;
  if (chunkIndex < 1 || chunkCount < 1 || chunkIndex > chunkCount)
    throw new Error("bad chunk tag");

  let blobs: RekeyBlob[];
  try {
    const parsed = JSON.parse(opened.content) as RekeyBlob[];
    blobs = Array.isArray(parsed)
      ? parsed.filter(
          (blob) =>
            blob &&
            typeof blob.locator === "string" &&
            typeof blob.wrapped === "string",
        )
      : [];
  } catch {
    throw new Error("bad rekey content");
  }

  return {
    rumorId: opened.rumorId,
    rotator: opened.author,
    scopeIdHex: scope.toLowerCase(),
    newEpoch: BigInt(newEpoch),
    prevEpoch: BigInt(prevEpoch),
    prevCommit: prevCommit.toLowerCase(),
    chunkIndex,
    chunkCount,
    blobs,
    ms: opened.ms,
  };
}

export interface RekeyRotationSet {
  rotator: string;
  scopeIdHex: string;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevCommit: string;
  chunkCount: number;
  /** chunkIndex → chunk. */
  chunks: Map<number, ParsedRekey>;
  complete: boolean;
}

/**
 * Group parsed chunks into rotations.
 *
 * Correlated by (rotator, scope, newepoch, prevcommit), so two rotators racing
 * on one epoch never merge into a single set (§2). A rotation is COMPLETE only
 * when every chunk is held: a missing chunk is a gap, never a removal.
 */
export function groupRotations(parsed: ParsedRekey[]): RekeyRotationSet[] {
  const byKey = new Map<string, RekeyRotationSet>();
  for (const chunk of parsed) {
    const key = `${chunk.rotator}:${chunk.scopeIdHex}:${chunk.newEpoch}:${chunk.prevCommit}`;
    let set = byKey.get(key);
    if (!set) {
      set = {
        rotator: chunk.rotator,
        scopeIdHex: chunk.scopeIdHex,
        newEpoch: chunk.newEpoch,
        prevEpoch: chunk.prevEpoch,
        prevCommit: chunk.prevCommit,
        chunkCount: chunk.chunkCount,
        chunks: new Map(),
        complete: false,
      };
      byKey.set(key, set);
    }
    if (chunk.chunkCount === set.chunkCount) set.chunks.set(chunk.chunkIndex, chunk);
  }
  for (const set of byKey.values()) set.complete = set.chunks.size >= set.chunkCount;
  return [...byKey.values()];
}

/**
 * Verify a rotation's CONTINUITY against the key currently held: the commitment
 * over (prevEpoch, heldKey) must equal the event's `prevcommit`.
 *
 * A mismatch at a HIGHER prevepoch means a rotation was missed and the gap has
 * to be fetched first; anything else is a fork or garbage (§2).
 */
export function checkContinuity(
  set: { prevEpoch: bigint; prevCommit: string },
  heldEpoch: bigint,
  heldKey: Uint8Array,
): { ok: true } | { ok: false; reason: "gap" | "fork" } {
  if (set.prevEpoch === heldEpoch) {
    const commit = bytesToHex(epochKeyCommitment(heldEpoch, heldKey));
    return commit === set.prevCommit
      ? { ok: true }
      : { ok: false, reason: "fork" };
  }
  return { ok: false, reason: set.prevEpoch > heldEpoch ? "gap" : "fork" };
}

/** Find our blob across a rotation's chunks. */
export function findBlob(
  set: RekeyRotationSet,
  locatorHex: string,
): RekeyBlob | undefined {
  for (const chunk of set.chunks.values()) {
    const hit = chunk.blobs.find((blob) => blob.locator === locatorHex);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * When did this rotation publish? The newest of its chunks.
 *
 * What it is for: telling a REMOVAL apart from community history. A member who
 * joins on a slightly stale invite lands on a rotation they were never part of —
 * complete, continuity-valid, and carrying no blob for them. Reading that as a
 * removal would evict an agent from a community it had just been invited to.
 */
export function rotationPublishedAtMs(set: RekeyRotationSet): number {
  let newest = 0;
  for (const chunk of set.chunks.values())
    if (chunk.ms > newest) newest = chunk.ms;
  return newest;
}

/**
 * Race convergence (§3): among candidates at the same continuity point, the
 * lexicographically lowest new key wins. Both stay held, so messages sent into
 * the losing fork remain readable; only the chain converges.
 */
export function lowerKeyWins(a: Uint8Array, b: Uint8Array): Uint8Array {
  return bytesToHex(a) <= bytesToHex(b) ? a : b;
}

/** Our own locator for a rotation — public inputs only, so a bunker can do it. */
export function myLocator(
  rotatorHex: string,
  selfHex: string,
  scopeIdHex: string,
  newEpoch: bigint,
): string {
  return bytesToHex(
    recipientLocator(
      hex32(rotatorHex),
      hex32(selfHex),
      hex32(scopeIdHex),
      newEpoch,
    ),
  );
}
