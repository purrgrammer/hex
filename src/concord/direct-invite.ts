/**
 * Direct invites — CORD-05 §6, receive half.
 *
 * When the invitee is a known npub the link machinery drops away: the bundle
 * giftwraps straight to them as a STANDARD NIP-59 wrap — ephemeral author, the
 * recipient in the `p` tag, a kind-13 seal signed by the inviter's real key —
 * and not the reversed stream wrap of CORD-01.
 *
 *   wrap(1059, ephemeral author, ["p", recipient], ["k", "3313"])
 *     └ seal(13, signed by the inviter)
 *         └ rumor(3313, content = the invite bundle as JSON)
 *
 * This is how an agent joins a community without a human pasting a link into
 * its config: someone invites Hex's npub the same way they would invite a
 * person, and Hex finds the wrap in the mailbox it already reads.
 *
 * The outer `k` tag is what makes invites INDEXED — `{"kinds":[1059],
 * "#p":[hex], "#k":["3313"]}` finds exactly the invites instead of decrypting
 * everything ever addressed to this key. It is a hint and never authority: an
 * invite is whatever unwraps to a kind-3313 rumor, so an untagged one is
 * honored all the same.
 */

import type { NostrEvent } from "nostr-tools/pure";

import { validateBundle, type InviteBundle } from "./invite.js";
import { KIND_WRAP } from "./kinds.js";

/** The person-addressed invite rumor (CORD-05 §6). */
export const KIND_DIRECT_INVITE = 3313;
/** NIP-59's own seal kind — a classic giftwrap, not a CORD-01 stream seal. */
export const KIND_NIP59_SEAL = 13;

/** All receiving needs from a signer: NIP-44 decrypt. */
export interface InviteDecryptor {
  nip44?: { decrypt(pubkey: string, ciphertext: string): Promise<string> };
}

export interface UnwrappedInvite {
  rumor: {
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
    pubkey: string;
  };
  /** The seal's author — the proven inviter. */
  sender: string;
}

/**
 * Peel a giftwrap addressed to this key. Never throws: a foreign or malformed
 * wrap yields undefined, so a scan over a whole mailbox can skip it.
 *
 * Peeled with the signer's own `nip44.decrypt` rather than nostr-tools' nip59
 * helpers, which want a raw secret key a bunker never exposes. The rumor's
 * claimed author must equal the seal's — NIP-59's anti-spoofing check, and the
 * only thing that makes `sender` mean anything.
 */
export async function unwrapDirectInvite(
  giftWrap: NostrEvent,
  signer: InviteDecryptor,
): Promise<UnwrappedInvite | undefined> {
  if (giftWrap.kind !== KIND_WRAP || !signer.nip44) return undefined;
  try {
    const seal = JSON.parse(
      await signer.nip44.decrypt(giftWrap.pubkey, giftWrap.content),
    ) as NostrEvent;
    if (seal.kind !== KIND_NIP59_SEAL) return undefined;
    const rumor = JSON.parse(
      await signer.nip44.decrypt(seal.pubkey, seal.content),
    ) as UnwrappedInvite["rumor"];
    if (rumor.pubkey !== seal.pubkey) return undefined;
    return { rumor, sender: seal.pubkey };
  } catch {
    return undefined;
  }
}

/**
 * Read an unwrapped rumor as an invite bundle.
 *
 * The rumor's KIND is the authority — the outer `k` tag was only ever a hint —
 * and the bundle is validated exactly as a fetched one: bounded, and refused
 * unless its owner reproduces its community_id.
 */
export function parseDirectInviteRumor(
  kind: number,
  content: string,
): InviteBundle | undefined {
  if (kind !== KIND_DIRECT_INVITE) return undefined;
  try {
    const bundle = JSON.parse(content) as InviteBundle;
    if (
      typeof bundle.community_id !== "string" ||
      typeof bundle.name !== "string"
    )
      return undefined;
    return validateBundle(bundle);
  } catch {
    return undefined;
  }
}
