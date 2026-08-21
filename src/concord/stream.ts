/**
 * Concord Private Streams — CORD-01. Wire format.
 *
 * Ported from grimoire's `src/lib/concord/stream.ts`.
 *
 * A stream event REVERSES NIP-59: the author is fixed (the plane's derived
 * stream key), the `p` tag is an ephemeral throwaway, and the wrap is encrypted
 * under the stream's own NIP-44 self-ECDH conversation key rather than under
 * the p-tagged key. Inside rides a seal signed by the author's REAL key, around
 * an unsigned rumor carrying the functional kind:
 *
 *   wrap(1059/21059, signed by the stream key)
 *     └ seal(20013 encrypted | 20014 plaintext, signed by the author)
 *         └ rumor(unsigned, the functional kind)
 *
 * So a relay serving a Concord channel sees a stream of events by one author to
 * one-time recipients, and can tell neither who is talking nor to whom.
 */

import {
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
} from "nostr-tools/nip44";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";
import type {
  EventTemplate,
  NostrEvent,
  UnsignedEvent,
} from "nostr-tools/pure";

import type { GroupKey, StreamKeyView } from "./derive.js";
import {
  KIND_SEAL_ENCRYPTED,
  KIND_SEAL_PLAINTEXT,
  KIND_WRAP,
  KIND_WRAP_EPHEMERAL,
} from "./kinds.js";

/** An unsigned rumor: an event shape with an id and no signature. */
export type NostrRumor = Omit<NostrEvent, "sig">;

export class StreamError extends Error {
  constructor(
    public code:
      | "decrypt"
      | "parse"
      | "bad-wrap-kind"
      | "bad-wrap-signature"
      | "bad-seal-kind"
      | "bad-seal-signature"
      | "author-mismatch"
      | "bad-rumor-id"
      | "bad-ms"
      | "binding-mismatch"
      | "oversize",
    message: string,
  ) {
    super(message);
    this.name = "StreamError";
  }
}

/** NIP-44's hard plaintext cap, enforced at every layer (CORD-02 Appendix B). */
export const NIP44_MAX_PLAINTEXT = 65_535;

const TAG_MS = "ms";

/**
 * Encrypt, refusing anything over the cap.
 *
 * Enforced here rather than left to the library: a lenient publisher mints
 * events a strict reader cannot open, and the reader is every other client.
 */
function encryptChecked(convKey: Uint8Array, plaintext: string): string {
  if (new TextEncoder().encode(plaintext).length > NIP44_MAX_PLAINTEXT)
    throw new StreamError(
      "oversize",
      "plaintext exceeds the NIP-44 65,535-byte cap",
    );
  return nip44Encrypt(plaintext, convKey);
}

// ── Building ────────────────────────────────────────────────────────────────

/**
 * Build an unsigned rumor.
 *
 * `ms` is the full send time in epoch MILLIseconds: `created_at` carries the
 * seconds and the `ms` tag the 0..999 remainder, so the true ordering key is
 * `created_at * 1000 + ms` (CORD-02 §4). Pass `ms: null` for a rumor that
 * carries no sub-second ordering.
 */
export function buildRumor(options: {
  kind: number;
  content: string;
  tags?: string[][];
  pubkey: string;
  ms?: number | null;
  createdAtSecs?: number;
}): NostrRumor {
  const tags = [...(options.tags ?? [])];
  let createdAt: number;
  if (options.ms === null || options.ms === undefined) {
    createdAt = options.createdAtSecs ?? Math.floor(Date.now() / 1000);
  } else {
    // A glitched clock is a local fault, not a reason to publish an `ms` tag
    // every reader will drop as malformed. Fail closed.
    if (!Number.isFinite(options.ms) || options.ms < 0)
      throw new StreamError(
        "bad-ms",
        `send time must be a non-negative epoch-ms, got ${options.ms}`,
      );
    createdAt = Math.floor(options.ms / 1000);
    tags.push([TAG_MS, (Math.floor(options.ms) % 1000).toString()]);
  }
  const unsigned: UnsignedEvent = {
    kind: options.kind,
    content: options.content,
    tags,
    created_at: createdAt,
    pubkey: options.pubkey,
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

/** The one thing a send needs from a signer. */
export interface StreamSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

/**
 * Seal a rumor with the author's REAL identity.
 *
 * The seal is what proves who wrote the message — the wrap around it is signed
 * by a key every member holds and proves nothing. One signer round-trip per
 * send, which for a NIP-46 bunker is a remote call.
 */
export async function sealRumor(
  rumor: NostrRumor,
  sealKind: typeof KIND_SEAL_ENCRYPTED | typeof KIND_SEAL_PLAINTEXT,
  stream: StreamKeyView,
  signer: StreamSigner,
): Promise<NostrEvent> {
  const rumorJson = JSON.stringify(rumor);
  const content =
    sealKind === KIND_SEAL_ENCRYPTED
      ? encryptChecked(stream.convKey, rumorJson)
      : rumorJson;
  return signer.signEvent({
    kind: sealKind,
    content,
    tags: [],
    created_at: rumor.created_at,
  });
}

/**
 * Wrap a signed seal into the outer stream event: encrypted under the stream
 * conversation key, signed by the stream key, tagged with a random ephemeral
 * `p` (NIP-59 reversed). `created_at` is NOT tweaked (CORD-01).
 *
 * `expiration` (unix seconds) puts a NIP-40 tag on the WRAP so relays purge the
 * ciphertext — CORD-08 §2's deliberate exception to the no-outer-tags rule, and
 * always matching the rumor's own signed `expiration`, which is what readers
 * enforce.
 */
export function wrapSeal(
  seal: NostrEvent,
  stream: GroupKey,
  options?: {
    ephemeral?: boolean;
    ephemeralSk?: Uint8Array;
    expiration?: number;
  },
): NostrEvent {
  const ephemeralSk = options?.ephemeralSk ?? generateSecretKey();
  const tags: string[][] = [["p", getPublicKey(ephemeralSk)]];
  if (options?.expiration !== undefined)
    tags.push(["expiration", String(Math.floor(options.expiration))]);
  return finalizeEvent(
    {
      kind: options?.ephemeral ? KIND_WRAP_EPHEMERAL : KIND_WRAP,
      content: encryptChecked(stream.convKey, JSON.stringify(seal)),
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    stream.sk,
  );
}

// ── Opening ─────────────────────────────────────────────────────────────────

/** A fully-opened, fully-verified stream event. */
export interface OpenedEvent {
  /** The rumor id — the message id, and the dedupe key. */
  rumorId: string;
  /** The verified real author: the seal's signer, which equals the rumor's pubkey. */
  author: string;
  kind: number;
  content: string;
  tags: string[][];
  /** Ordering timestamp in epoch ms: `created_at * 1000 + ms`. */
  ms: number;
  createdAt: number;
  /** The wrap's id — what a relay addresses, and the transport's dedupe key. */
  wrapId: string;
  /** The stream address this was read from (the wrap's author). */
  streamPk: string;
  /** Which seal form carried it, checked at ingest against the plane rules. */
  sealKind: number;
}

/**
 * Reconstruct the ms timestamp.
 *
 * A missing tag means offset 0; a malformed one throws rather than clamping —
 * CORD-02 §5 treats an out-of-range `ms` as malformed, and clamping would let
 * the excess smuggle arbitrary "future" past a clock check. Strict decimal,
 * because `Number()` accepts "0x1f", "1e2" and " 5 ", and two clients
 * disagreeing about that diverge on the ordering basis every comparison rides.
 */
export function resolveMs(createdAtSecs: number, tags: string[][]): number {
  const tag = tags.find((candidate) => candidate[0] === TAG_MS);
  if (!tag) return createdAtSecs * 1000;
  const raw = tag[1];
  if (raw === undefined || !/^(0|[1-9][0-9]{0,2})$/.test(raw))
    throw new StreamError("bad-ms", `malformed ms tag: ${raw}`);
  const value = Number(raw);
  if (value > 999) throw new StreamError("bad-ms", `malformed ms tag: ${raw}`);
  return createdAtSecs * 1000 + value;
}

/**
 * Open and fully verify one wrap under its plane's key:
 *
 *  1. the wrap's author must BE the stream address, or it is not ours. Its own
 *     signature is not checked for an ordinary stream — that signature is made
 *     with a key every reader holds and proves nothing — but a write-restricted
 *     stream's IS, because there the signer set is narrower than the readership;
 *  2. decrypt the wrap into the seal, and verify the seal's signature. That is
 *     the authorship proof, and the only one;
 *  3. recover the rumor, check that its id is its own NIP-01 hash (an id is the
 *     ordering tiebreak — never trust a claimed one) and that its pubkey equals
 *     the seal's signer, or a keyholder could re-seal another member's rumor
 *     under their own name.
 */
export function openWrap(
  wrap: NostrRumor,
  stream: StreamKeyView,
): OpenedEvent {
  if (wrap.kind !== KIND_WRAP && wrap.kind !== KIND_WRAP_EPHEMERAL)
    throw new StreamError(
      "bad-wrap-kind",
      `not a stream wrap: kind ${wrap.kind}`,
    );
  if (wrap.pubkey !== stream.pk)
    throw new StreamError(
      "author-mismatch",
      "wrap author is not this stream's address",
    );
  if (stream.restricted) {
    const signed = wrap as NostrRumor & { sig?: string };
    if (typeof signed.sig !== "string" || !verifyEvent(signed as NostrEvent))
      throw new StreamError(
        "bad-wrap-signature",
        "write-restricted wrap signature invalid",
      );
  }

  let seal: NostrEvent;
  try {
    seal = JSON.parse(nip44Decrypt(wrap.content, stream.convKey)) as NostrEvent;
  } catch (error) {
    throw new StreamError(
      "decrypt",
      `wrap decrypt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (seal.kind !== KIND_SEAL_ENCRYPTED && seal.kind !== KIND_SEAL_PLAINTEXT)
    throw new StreamError("bad-seal-kind", `unknown seal kind ${seal.kind}`);
  if (!verifyEvent(seal))
    throw new StreamError("bad-seal-signature", "seal signature invalid");

  let rumor: NostrRumor;
  try {
    const json =
      seal.kind === KIND_SEAL_ENCRYPTED
        ? nip44Decrypt(seal.content, stream.convKey)
        : seal.content;
    rumor = JSON.parse(json) as NostrRumor;
  } catch (error) {
    throw new StreamError(
      seal.kind === KIND_SEAL_ENCRYPTED ? "decrypt" : "parse",
      `rumor recover: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (rumor.pubkey !== seal.pubkey)
    throw new StreamError(
      "author-mismatch",
      "rumor author does not match the seal's signer",
    );
  const expectedId = getEventHash({
    kind: rumor.kind,
    content: rumor.content,
    tags: rumor.tags,
    created_at: rumor.created_at,
    pubkey: rumor.pubkey,
  });
  if (rumor.id !== expectedId)
    throw new StreamError("bad-rumor-id", "rumor id is not its event hash");

  return {
    rumorId: rumor.id,
    author: seal.pubkey,
    kind: rumor.kind,
    content: rumor.content,
    tags: rumor.tags,
    ms: resolveMs(rumor.created_at, rumor.tags),
    createdAt: rumor.created_at,
    wrapId: wrap.id,
    streamPk: wrap.pubkey,
    sealKind: seal.kind,
  };
}

// ── Chat-plane binding (CORD-03 §3) ─────────────────────────────────────────

const TAG_CHANNEL = "channel";
const TAG_EPOCH = "epoch";

/** The binding every chat rumor must commit: `["channel", id]` + `["epoch", n]`. */
export function channelBindingTags(
  channelIdHex: string,
  epoch: bigint,
): string[][] {
  return [
    [TAG_CHANNEL, channelIdHex],
    [TAG_EPOCH, epoch.toString()],
  ];
}

/** A tag required to appear AT MOST ONCE — a binding must be unambiguous. */
function uniqueTag(tags: string[][], name: string): string | undefined {
  let found: string | undefined;
  for (const tag of tags) {
    if (tag[0] === name) {
      if (found !== undefined)
        throw new StreamError(
          "binding-mismatch",
          `duplicate binding tag: ${name}`,
        );
      found = tag[1];
    }
  }
  return found;
}

/**
 * Enforce the binding: the rumor's committed channel and epoch must strict-equal
 * the coordinate whose key opened the wrap.
 *
 * Without this a keyholder could splice one author's rumor into a context they
 * never chose — the same signed words, in a room they were not said in.
 */
export function checkChannelBinding(
  opened: Pick<OpenedEvent, "tags">,
  channelIdHex: string,
  epoch: bigint,
): void {
  if (uniqueTag(opened.tags, TAG_CHANNEL) !== channelIdHex)
    throw new StreamError(
      "binding-mismatch",
      "channel-binding mismatch (splice)",
    );
  if (uniqueTag(opened.tags, TAG_EPOCH) !== epoch.toString())
    throw new StreamError("binding-mismatch", "epoch-binding mismatch (splice)");
}

/**
 * Read a rumor's own binding back out.
 *
 * `checkChannelBinding` answers "does this match what I opened it with", which
 * is the ingress question. A write asks the other one: an already-bound rumor
 * has to go to the address it commits to, and only the rumor knows which that
 * is. Undefined for anything that is not bound to exactly one channel and epoch.
 */
export function channelBindingOf(
  tags: string[][],
): { channelIdHex: string; epoch: bigint } | undefined {
  try {
    const channelIdHex = uniqueTag(tags, TAG_CHANNEL);
    const epoch = uniqueTag(tags, TAG_EPOCH);
    if (!channelIdHex || !epoch) return undefined;
    if (!/^(0|[1-9][0-9]*)$/.test(epoch)) return undefined;
    return { channelIdHex, epoch: BigInt(epoch) };
  } catch {
    return undefined;
  }
}
