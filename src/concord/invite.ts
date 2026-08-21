/**
 * Invites — CORD-05, read half.
 *
 * Ported from grimoire's `src/lib/concord/invite.ts`. An invite is how Hex gets
 * into a community at all: there is no "join by id", because a community has no
 * public address to knock at. What an invite hands over IS the membership — the
 * community_root, the epoch it is good at, the private channel keys granted, and
 * the relays the community lives on.
 *
 * Two forms, and this reads both:
 *
 * - a **link**, `$BASE/invite/<naddr>#<fragment>` — the naddr is a public
 *   locator naming the bundle `(33301, link_signer, d="")`, and the fragment is
 *   an off-network secret. A fragment is never sent to a server, so relays see
 *   where a bundle sits and can never open one;
 * - a **direct invite**, the same bundle giftwrapped to an npub, with nothing to
 *   fetch.
 *
 * Trust does not rest on the inviter: `community_id` is a commitment to the
 * owner's key (A.4), so a bundle whose owner and salt fail to reproduce it is
 * refused. A bundle is also attacker-crafted input reached by following a link,
 * so it is BOUNDED before anything allocates.
 */

import { nip19 } from "nostr-tools";
import { decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { inviteBundleKey, verifyCommunityId } from "./derive.js";
import { KIND_INVITE_BUNDLE } from "./kinds.js";

/** The link's unlock token: 16 random bytes (CORD-05 §2). */
export const TOKEN_BYTES = 16;
/** The fragment carries at most 3 bootstrap relays (CORD-05 §3). */
export const MAX_BOOTSTRAP_RELAYS = 3;
/** The fragment format byte, which also selects the dictionary generation. */
export const FRAGMENT_VERSION = 4;
/** A hostile link must not become an unbounded allocation (CORD-05 §1). */
export const MAX_BUNDLE_CHANNELS = 256;
/** Nothing sane names more relays than this, and a hostile link might. */
export const MAX_BUNDLE_RELAYS = 16;

/** The keys an invite delivers (CORD-05 §1). */
export interface InviteBundle {
  community_id: string;
  owner: string;
  owner_salt: string;
  community_root: string;
  root_epoch: number;
  /**
   * The Control Plane's signer pubkey at that epoch. Absent means a legacy,
   * pre-split community (CORD-06 §3). Hex folds no control state, so it carries
   * this only so a later reader has it.
   */
  control_pk?: string;
  /** The granted PRIVATE channels. Public ones derive from the root. */
  channels: Array<{ id: string; key: string; epoch: number; name: string }>;
  relays: string[];
  name: string;
  /** Optional, unix ms: past it the bundle still parses, joining refuses. */
  expires_at?: number;
  creator_npub?: string;
  label?: string;
  [key: string]: unknown;
}

export class InviteError extends Error {
  constructor(
    public code:
      | "bad-link"
      | "bad-fragment"
      | "bad-bundle"
      | "owner-mismatch"
      | "revoked"
      | "expired"
      | "bounds",
    message: string,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

/** Invite-bundle marker values for the `vsk` tag: live, and revocation. */
const VSK_INVITE_LIVE = "6";
const VSK_INVITE_REVOKED = "9";

function boundBundle(bundle: InviteBundle): InviteBundle {
  if (!Array.isArray(bundle.channels)) bundle.channels = [];
  if (bundle.channels.length > MAX_BUNDLE_CHANNELS)
    throw new InviteError(
      "bounds",
      `bundle carries ${bundle.channels.length} channels (cap ${MAX_BUNDLE_CHANNELS})`,
    );
  const relays = Array.isArray(bundle.relays) ? bundle.relays : [];
  bundle.relays = relays
    .filter(
      (relay): relay is string =>
        typeof relay === "string" && /^wss?:\/\//i.test(relay),
    )
    .slice(0, MAX_BUNDLE_RELAYS);
  return bundle;
}

/**
 * Validate a decrypted bundle however it arrived: the §1 bounds, and the
 * self-certifying `community_id` reproducing from (owner, salt).
 *
 * Expiry is deliberately the caller's business — an expired bundle is still a
 * readable description of a community, and only joining on one is wrong.
 */
export function validateBundle(bundle: InviteBundle): InviteBundle {
  boundBundle(bundle);
  if (
    typeof bundle.community_root !== "string" ||
    !/^[0-9a-f]{64}$/i.test(bundle.community_root)
  )
    throw new InviteError("bad-bundle", "bundle carries no community_root");
  if (typeof bundle.root_epoch !== "number" || bundle.root_epoch < 0)
    throw new InviteError("bad-bundle", "bundle carries no root epoch");
  if (!verifyCommunityId(bundle.community_id, bundle.owner, bundle.owner_salt))
    throw new InviteError(
      "owner-mismatch",
      "this invite's owner does not reproduce its community_id",
    );
  return bundle;
}

/** Whether a bundle's shelf life has run out (`expires_at` is unix ms). */
export function inviteExpired(bundle: InviteBundle, nowMs = Date.now()) {
  return typeof bundle.expires_at === "number" && nowMs > bundle.expires_at;
}

/**
 * Verify and decrypt a fetched bundle event.
 *
 * The coordinate is the anti-squat guard — a different author is a different
 * coordinate — but the signature and author are re-checked anyway, so a relay
 * handing back garbage is refused rather than parsed.
 */
export function parseBundleEvent(
  event: NostrEvent,
  expectedSigner: string,
  token: Uint8Array,
): InviteBundle {
  if (
    event.kind !== KIND_INVITE_BUNDLE ||
    event.pubkey !== expectedSigner ||
    !verifyEvent(event)
  )
    throw new InviteError("bad-bundle", "not a valid invite bundle event");

  const vsk = event.tags.find((tag) => tag[0] === "vsk")?.[1];
  if (vsk === VSK_INVITE_REVOKED)
    throw new InviteError("revoked", "this invite link has been revoked");
  if (vsk !== VSK_INVITE_LIVE)
    throw new InviteError("bad-bundle", `unknown bundle marker: ${vsk}`);

  let bundle: InviteBundle;
  try {
    bundle = JSON.parse(
      nip44Decrypt(event.content, inviteBundleKey(token)),
    ) as InviteBundle;
  } catch (error) {
    throw new InviteError(
      "bad-bundle",
      `bundle would not decrypt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return validateBundle(bundle);
}

// ── The fragment codec (CORD-05 §3) ─────────────────────────────────────────

/**
 * The stock relay dictionary, generation 4.
 *
 * The one place relay URLs are spelled out in this package, and it is not a
 * relay choice: a link minted with the stock flag carries ZERO relay bytes, so
 * a client without this table cannot decode where its bundle lives. Protocol
 * data, versioned by the fragment's own format byte. Hex connects to these only
 * while fetching one bundle.
 */
export const RELAY_DICTIONARY: Record<number, string> = {
  1: "wss://jskitty.com/nostr",
  2: "wss://asia.vectorapp.io/nostr",
  3: "wss://relay.ditto.pub",
  4: "wss://relay.dreamith.to",
};

/** The stock set the flags bit selects (dictionary ids 1–4, in order). */
export const STOCK_RELAYS: string[] = [1, 2, 3, 4].map(
  (index) => RELAY_DICTIONARY[index]!,
);

/** flags bit 0: the stock set is in use, and zero relay bytes follow. */
const FLAG_STOCK_SET = 0x01;

function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.trim(), "base64url"));
}

/** Decode an invite fragment into its token and bootstrap relays. */
export function decodeFragment(fragment: string): {
  token: Uint8Array;
  relays: string[];
} {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(fragment);
  } catch {
    throw new InviteError("bad-fragment", "fragment is not base64url");
  }
  let offset = 0;
  const need = (count: number) => {
    if (offset + count > bytes.length)
      throw new InviteError("bad-fragment", "fragment truncated");
  };

  need(2);
  const version = bytes[offset++]!;
  // A client MAY refuse a lower version rather than decode it against the wrong
  // dictionary generation (CORD-05 §3).
  if (version < FRAGMENT_VERSION)
    throw new InviteError(
      "bad-fragment",
      `this invite uses an older link format (version ${version})`,
    );
  if (version > FRAGMENT_VERSION)
    throw new InviteError(
      "bad-fragment",
      `this invite uses link format ${version}, newer than this build reads`,
    );
  const flags = bytes[offset++]!;

  const relays: string[] = [];
  if (flags & FLAG_STOCK_SET) {
    relays.push(...STOCK_RELAYS);
  } else {
    need(1);
    const count = bytes[offset++]!;
    if (count > MAX_BOOTSTRAP_RELAYS)
      throw new InviteError("bad-fragment", "too many bootstrap relays");
    const decoder = new TextDecoder();
    for (let index = 0; index < count; index++) {
      need(1);
      const lead = bytes[offset++]!;
      if (lead >= 1 && lead <= 254) {
        // An unknown dictionary id is SKIPPED rather than fatal: the dictionary
        // grows, and a link naming a relay this build has not heard of still
        // resolves through the others.
        const url = RELAY_DICTIONARY[lead];
        if (url) relays.push(url);
        continue;
      }
      need(1);
      const length = bytes[offset++]!;
      need(length);
      const text = decoder.decode(bytes.slice(offset, offset + length));
      offset += length;
      relays.push(lead === 255 ? text : `wss://${text}`);
    }
  }

  need(TOKEN_BYTES);
  const token = bytes.slice(offset, offset + TOKEN_BYTES);
  offset += TOKEN_BYTES;
  if (offset !== bytes.length)
    throw new InviteError("bad-fragment", "trailing bytes in fragment");
  return { token, relays };
}

// ── The link (CORD-05 §2) ───────────────────────────────────────────────────

export const INVITE_PATH_PREFIX = "/invite/";

/** A parsed invite link: the bundle's coordinate plus the fragment's secrets. */
export interface ParsedInviteLink {
  /** The link signer's pubkey (hex) — the bundle's coordinate author. */
  linkSigner: string;
  token: Uint8Array;
  bootstrapRelays: string[];
  naddr: string;
}

function naddrToSigner(naddr: string): string | undefined {
  try {
    const decoded = nip19.decode(naddr);
    if (decoded.type !== "naddr") return undefined;
    const data = decoded.data;
    if (data.kind !== KIND_INVITE_BUNDLE || data.identifier !== "")
      return undefined;
    return data.pubkey;
  } catch {
    return undefined;
  }
}

/**
 * Parse an invite from a full URL (`…/invite/<naddr>#<fragment>`) or the
 * domain-agnostic bare form (`<naddr>#<fragment>`).
 *
 * The base is cosmetic — only the naddr and the fragment are protocol — so the
 * same link opens whichever client's domain minted it.
 */
export function parseInviteLink(input: string): ParsedInviteLink | undefined {
  const trimmed = input.trim();
  let naddr: string | undefined;
  let fragment: string | undefined;

  if (/^naddr1[a-z0-9]+#.+$/i.test(trimmed)) {
    const [head, ...rest] = trimmed.split("#");
    naddr = head;
    fragment = rest.join("#");
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!url.pathname.startsWith(INVITE_PATH_PREFIX)) return undefined;
    naddr = decodeURIComponent(
      url.pathname.slice(INVITE_PATH_PREFIX.length),
    ).replace(/\/$/, "");
    fragment = url.hash.replace(/^#/, "");
  }

  if (!naddr || !fragment) return undefined;
  const linkSigner = naddrToSigner(naddr);
  if (!linkSigner) return undefined;
  const { token, relays } = decodeFragment(fragment);
  return { linkSigner, token, bootstrapRelays: relays, naddr };
}
