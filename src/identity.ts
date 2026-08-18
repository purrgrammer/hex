/**
 * Hex's own metadata: kind 0, kind 10002, kind 10050.
 *
 * This module is the only writer of those three kinds. They are built from
 * config, so the config file is the source of truth for who Hex says it is and
 * where it can be reached — and `announce` skips a kind whose published copy
 * already matches, because a restart loop that rewrites replaceables is noise
 * every follower's client has to reconcile.
 *
 * Kind 10050 matters more than it looks: without one, nobody can address Hex
 * over NIP-17 at all, whatever the DM code does later.
 */

import type { NostrEvent } from "nostr-tools";
import type { HexConfig, ProfileConfig, RelayRoles } from "./config.js";
import type { ISigner } from "./signer.js";
import { publishTo, requestNewest, type HexRelays } from "./relays.js";

export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

/**
 * kind 0. Only the fields the config actually set — plus `bot`.
 *
 * NIP-24's `bot` is always written, and defaults to true: Hex IS automation, and
 * a client that dims or filters bot replies can only do so if the flag is there.
 * A config may set it false, which is a claim its operator is making, not a
 * default anyone falls into.
 */
export function buildProfileContent(profile: ProfileConfig): string {
  const fields: Record<string, string | boolean> = { bot: profile.bot ?? true };
  const keys = [
    "name",
    "display_name",
    "about",
    "picture",
    "banner",
    "website",
    "nip05",
    "lud16",
  ] as const;
  for (const key of keys) {
    const value = profile[key];
    if (value !== undefined) fields[key] = value;
  }
  return JSON.stringify(fields);
}

/**
 * kind 10002 (NIP-65). A relay in both roles is written once with no marker,
 * which is what "read and write" means on the wire — a `read`+`write` pair of
 * tags for the same URL says the same thing twice.
 */
export function buildRelayListTags(relays: RelayRoles): string[][] {
  const urls = new Set([...relays.read, ...relays.publish]);
  return [...urls].map((url) => {
    const read = relays.read.includes(url);
    const write = relays.publish.includes(url);
    if (read && write) return ["r", url];
    return ["r", url, read ? "read" : "write"];
  });
}

/** kind 10050 (NIP-17). Exactly the DM inbox, and nothing else. */
export function buildDmRelayTags(relays: RelayRoles): string[][] {
  return relays.dm.map((url) => ["relay", url]);
}

export function buildIdentityTemplates(
  config: HexConfig,
  createdAt: number,
): EventTemplate[] {
  return [
    {
      kind: 0,
      content: buildProfileContent(config.profile),
      tags: [],
      created_at: createdAt,
    },
    {
      kind: 10002,
      content: "",
      tags: buildRelayListTags(config.relays),
      created_at: createdAt,
    },
    {
      kind: 10050,
      content: "",
      tags: buildDmRelayTags(config.relays),
      created_at: createdAt,
    },
  ];
}

/**
 * Is the published copy already what config describes?
 *
 * Compared on content and tags only — `created_at`, `id` and `sig` differ on
 * every rebuild, so including them would make every run a rewrite. Tag order is
 * significant here on purpose: this module builds both sides, so a reordering is
 * a real change in what it would publish.
 */
export function matchesPublished(
  template: EventTemplate,
  published: NostrEvent | null,
): boolean {
  if (!published) return false;
  if (published.kind !== template.kind) return false;
  if (published.content !== template.content) return false;
  return JSON.stringify(published.tags) === JSON.stringify(template.tags);
}

export interface AnnounceResult {
  kind: number;
  action: "published" | "unchanged" | "failed";
  detail?: string;
}

export interface AnnounceOptions {
  dryRun?: boolean;
  now?: () => number;
  /** Deadline per relay for the "is it already published?" lookup. */
  lookupTimeoutMs?: number;
  /** Deadline per relay for each publish. */
  publishTimeoutMs?: number;
}

/**
 * Which publish relays are missing this document?
 *
 * Asked PER RELAY, and only of the relays Hex would write to. Evidence from a
 * read-only relay cannot answer the question: an operator who moves the outbox
 * from A to B and leaves A in `read` would otherwise get `unchanged` from A's
 * stale copy while B — the relay Hex's own kind 10002 now names — holds no
 * profile and no DM relay list at all, forever, since the same stale copy
 * answers every subsequent run.
 *
 * A relay that cannot be read (auth-gated, silent) counts as missing. That
 * republishes on every run, which is churn; the alternative is a relay Hex
 * believes it has announced to and never has.
 */
async function relaysMissing(
  relays: HexRelays,
  pubkey: string,
  publishRelays: string[],
  template: EventTemplate,
  timeoutMs?: number,
): Promise<string[]> {
  const checks = await Promise.all(
    publishRelays.map(async (url) => {
      const published = await requestNewest(
        relays,
        [url],
        { kinds: [template.kind], authors: [pubkey] },
        { timeoutMs },
      );
      return matchesPublished(template, published) ? null : url;
    }),
  );
  return checks.filter((url): url is string => url !== null);
}

/**
 * Publish Hex's identity, skipping the relays that already hold it.
 *
 * Idempotent per relay, not globally: a relay is written to when its own copy
 * does not match, so adding a relay to `publish` backfills it without rewriting
 * the ones that were already correct.
 */
export async function announceIdentity(
  relays: HexRelays,
  signer: ISigner,
  pubkey: string,
  config: HexConfig,
  options: AnnounceOptions = {},
): Promise<AnnounceResult[]> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const templates = buildIdentityTemplates(config, now());
  const results: AnnounceResult[] = [];

  for (const template of templates) {
    const missing = await relaysMissing(
      relays,
      pubkey,
      config.relays.publish,
      template,
      options.lookupTimeoutMs,
    );

    if (missing.length === 0) {
      results.push({ kind: template.kind, action: "unchanged" });
      continue;
    }

    if (options.dryRun) {
      results.push({
        kind: template.kind,
        action: "published",
        detail: `dry run — would send to ${missing.join(", ")}`,
      });
      continue;
    }

    try {
      const event = await signer.signEvent(template);
      const outcomes = await publishTo(
        relays,
        missing,
        event as NostrEvent,
        options.publishTimeoutMs,
      );
      const accepted = outcomes.filter((outcome) => outcome.ok);
      if (accepted.length === 0) {
        results.push({
          kind: template.kind,
          action: "failed",
          detail: outcomes
            .map(
              (outcome) => `${outcome.relay}: ${outcome.message ?? "rejected"}`,
            )
            .join("; "),
        });
        continue;
      }
      results.push({
        kind: template.kind,
        action: "published",
        detail: `${accepted.length}/${outcomes.length} relays accepted`,
      });
    } catch (error) {
      results.push({
        kind: template.kind,
        action: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
