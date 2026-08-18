/**
 * The read tools: what Hex looks up instead of recalling.
 *
 * This is the half of the in-app assistant that transfers wholesale. A model asked
 * "what is kind 9" answers confidently and wrongly from memory — it called it an
 * MLS event on the first live run — and the fix there was the same as here: give
 * it the spec and tell it that tools beat recall.
 *
 * Nothing in this file signs, publishes, or spends. Arguments are shaped by
 * whatever the model read, including message text, which is untrusted; the only
 * effects available are a relay read and an HTTP GET of a public document.
 */

import { nip19 } from "nostr-tools";
import type { Filter, NostrEvent } from "nostr-tools";
import { requestEvents, type HexRelays } from "../relays.js";
import {
  HELP_TOOL,
  REQ_TOOL,
  RESOLVE_TOOL,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

/** Upstream NIPs, the same documents the app's nip window reads. */
const NIPS_BASE =
  "https://raw.githubusercontent.com/nostr-protocol/nips/master";

/** Cap on returned content, so one long article cannot eat the window. */
const MAX_CONTENT_CHARS = 2_000;
/** Cap on a NIP's text. A whole spec is long; the relevant part is near the top. */
const MAX_NIP_CHARS = 12_000;
/** Default when the model names no limit. A peek, not a crawl. */
const DEFAULT_LIMIT = 5;
/** Hard bound: the result is fed back as JSON and has to fit in a context. */
export const MAX_QUERY_LIMIT = 100;

const HEX64 = /^[0-9a-f]{64}$/i;
const SINGLE_LETTER = /^[a-zA-Z]$/;

export interface KnowledgeOptions {
  relays: HexRelays;
  /** Where a REQ goes when the model names no relay. The `read` role. */
  readRelays: string[];
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

/** Kind → what it is, parsed once from the NIPs index. */
interface KindEntry {
  kind: number;
  description: string;
  nip?: string;
}

export class KnowledgeTools {
  private kinds?: Map<number, KindEntry>;
  private readonly nipText = new Map<string, string | null>();

  constructor(private readonly options: KnowledgeOptions) {}

  list(): ToolSpec[] {
    return [
      {
        name: HELP_TOOL,
        description:
          "Look up a NIP's text or an event kind's definition, from the NIPs " +
          "repository itself. Use this instead of recalling spec details.",
        parameters: {
          type: "object",
          properties: {
            nip: { type: "string", description: 'NIP id, e.g. "01" or "29".' },
            kind: { type: "number", description: "Event kind number." },
          },
        },
        prompt:
          "`grimoire.help` returns a NIP's text or a kind's definition from the" +
          " spec itself — read it rather than recalling what a kind number means.",
      },
      {
        name: REQ_TOOL,
        description:
          "Run a REQ against relays and read what comes back. Read-only. " +
          "Takes a NIP-01 filter and returns the events, with long content " +
          "truncated.",
        parameters: {
          type: "object",
          properties: {
            ids: {
              type: "array",
              items: { type: "string" },
              description: "Hex event ids, not note1 or nevent.",
            },
            authors: {
              type: "array",
              items: { type: "string" },
              description: "Hex pubkeys, not npubs.",
            },
            kinds: {
              type: "array",
              items: { type: "number" },
              description: "Event kinds to request.",
            },
            since: {
              type: "number",
              description: "Unix seconds; only events at or after this time.",
            },
            until: {
              type: "number",
              description: "Unix seconds; only events at or before this time.",
            },
            tags: {
              type: "object",
              description:
                'Single-letter tag filters: {"t": ["nostr"]} for a hashtag, ' +
                '{"e": ["<hex>"]} for replies to an event.',
              additionalProperties: {
                type: "array",
                items: { type: "string" },
              },
            },
            limit: {
              type: "number",
              description: `How many events you want. Defaults to ${DEFAULT_LIMIT}, hard bound ${MAX_QUERY_LIMIT}.`,
            },
            relays: {
              type: "array",
              items: { type: "string" },
              description:
                "Leave this out unless the user named a relay. Hex reads from " +
                "its own configured relays otherwise.",
            },
          },
        },
        prompt:
          "`nostr.req` takes a whole NIP-01 filter — ids, authors, kinds, since," +
          " until and single-letter tags — so narrow the query instead of" +
          " fetching kind 1 and sorting it in your head. Answer from what came" +
          " back, quoting it. Leave `relays` out unless the user named one, and" +
          " never invent a URL.",
      },
      {
        name: RESOLVE_TOOL,
        description:
          "Turn a bech32 entity into what it names: a profile for an npub or " +
          "nprofile, the event itself for a note, nevent or naddr.",
        parameters: {
          type: "object",
          properties: {
            entity: {
              type: "string",
              description:
                "An npub, nprofile, note, nevent or naddr, with or without the " +
                "`nostr:` prefix.",
            },
          },
          required: ["entity"],
        },
        prompt:
          "`nostr.resolve` turns a bech32 entity into the person or event it" +
          " names.",
      },
    ];
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case HELP_TOOL:
        return this.help(args);
      case REQ_TOOL:
        return this.req(args);
      case RESOLVE_TOOL:
        return this.resolve(args);
      default:
        return { ok: false, output: `there is no tool called "${name}"` };
    }
  }

  /** Whether this host serves `name`. */
  handles(name: string): boolean {
    return this.list().some((spec) => spec.name === name);
  }

  // ---- grimoire.help -------------------------------------------------------

  private async help(args: Record<string, unknown>): Promise<ToolResult> {
    const result: Record<string, unknown> = {};

    if (typeof args.kind === "number" && Number.isFinite(args.kind)) {
      const entry = await this.kindInfo(args.kind);
      result.kind = entry ?? { kind: args.kind, known: false };
    }

    const nipId = normalizeNipId(
      typeof args.nip === "string"
        ? args.nip
        : ((result.kind as KindEntry | undefined)?.nip ?? undefined),
    );

    if (nipId) {
      const text = await this.fetchNip(nipId);
      result.nip = text
        ? { id: nipId, text }
        : { id: nipId, error: "Could not load this NIP's text." };
    }

    if (Object.keys(result).length === 0)
      return { ok: false, output: "Pass a nip id or a kind number." };
    return { ok: true, output: JSON.stringify(result) };
  }

  /**
   * A kind's meaning, from the NIPs index rather than from memory.
   *
   * The index is one document listing every kind with the NIP that defines it,
   * which is exactly the mapping a model gets wrong. Parsed once per process.
   */
  private async kindInfo(kind: number): Promise<KindEntry | undefined> {
    if (!this.kinds) {
      const text = await this.get(`${NIPS_BASE}/README.md`);
      this.kinds = text ? parseKindTable(text) : new Map();
    }
    return this.kinds.get(kind);
  }

  private async fetchNip(id: string): Promise<string | undefined> {
    const cached = this.nipText.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const text = await this.get(`${NIPS_BASE}/${id}.md`);
    // A null is cached too: a NIP that does not exist must not be re-fetched on
    // every message.
    this.nipText.set(id, text ? text.slice(0, MAX_NIP_CHARS) : null);
    return this.nipText.get(id) ?? undefined;
  }

  private async get(url: string): Promise<string | undefined> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
      });
      if (!response.ok) return undefined;
      return await response.text();
    } catch {
      return undefined;
    }
  }

  // ---- nostr.req -----------------------------------------------------------

  private async req(args: Record<string, unknown>): Promise<ToolResult> {
    const filter: Filter = {};

    const ids = hexList(args.ids);
    if (ids.length) filter.ids = ids;
    const authors = hexList(args.authors);
    if (authors.length) filter.authors = authors;

    if (Array.isArray(args.kinds)) {
      const kinds = args.kinds.filter(
        (kind): kind is number =>
          typeof kind === "number" && Number.isFinite(kind),
      );
      if (kinds.length) filter.kinds = kinds;
    }

    if (typeof args.since === "number") filter.since = Math.floor(args.since);
    if (typeof args.until === "number") filter.until = Math.floor(args.until);

    if (args.tags && typeof args.tags === "object" && !Array.isArray(args.tags))
      for (const [key, values] of Object.entries(
        args.tags as Record<string, unknown>,
      )) {
        if (!SINGLE_LETTER.test(key) || !Array.isArray(values)) continue;
        const strings = values.filter(
          (value): value is string => typeof value === "string" && value !== "",
        );
        if (strings.length)
          (filter as Record<string, unknown>)[`#${key}`] = strings;
      }

    // A filter with no constraint asks a relay for everything it has.
    if (!filter.ids && !filter.authors && !filter.kinds)
      return {
        ok: false,
        output:
          "that filter constrains nothing — pass at least ids, authors or kinds",
      };

    filter.limit = Math.min(
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT,
      MAX_QUERY_LIMIT,
    );

    const named = Array.isArray(args.relays)
      ? args.relays.filter(
          (url): url is string =>
            typeof url === "string" &&
            (url.startsWith("wss://") || url.startsWith("ws://")),
        )
      : [];
    const relays = named.length > 0 ? named : this.options.readRelays;
    if (relays.length === 0)
      return { ok: false, output: "no relay to read from" };

    const events = await requestEvents(this.options.relays, relays, [filter], {
      timeoutMs: this.options.requestTimeoutMs,
    });

    return {
      ok: true,
      output: JSON.stringify({
        // The filter as sent: the model can see why a query came back empty.
        filter,
        relays,
        count: events.length,
        events: events.slice(0, filter.limit).map(describeEvent),
      }),
    };
  }

  // ---- nostr.resolve -------------------------------------------------------

  private async resolve(args: Record<string, unknown>): Promise<ToolResult> {
    const entity =
      typeof args.entity === "string"
        ? args.entity.trim().replace(/^nostr:/, "")
        : "";
    if (!entity)
      return { ok: false, output: "Pass a bech32 entity as `entity`." };

    let decoded: nip19.DecodedResult;
    try {
      decoded = nip19.decode(entity);
    } catch {
      return {
        ok: false,
        output: `${entity} is not a decodable bech32 entity`,
      };
    }

    const relays = this.options.readRelays;

    if (decoded.type === "npub" || decoded.type === "nprofile") {
      const pubkey =
        decoded.type === "npub" ? decoded.data : decoded.data.pubkey;
      const hints =
        decoded.type === "nprofile" ? (decoded.data.relays ?? []) : [];
      const events = await requestEvents(
        this.options.relays,
        [...new Set([...relays, ...hints])],
        [{ kinds: [0], authors: [pubkey], limit: 1 }],
        { timeoutMs: this.options.requestTimeoutMs },
      );
      const profile = events.sort((a, b) => b.created_at - a.created_at)[0];
      return {
        ok: true,
        output: JSON.stringify({
          type: "profile",
          pubkey,
          npub: nip19.npubEncode(pubkey),
          metadata: profile ? safeJson(profile.content) : null,
        }),
      };
    }

    if (decoded.type === "note" || decoded.type === "nevent") {
      const id = decoded.type === "note" ? decoded.data : decoded.data.id;
      const hints =
        decoded.type === "nevent" ? (decoded.data.relays ?? []) : [];
      const events = await requestEvents(
        this.options.relays,
        [...new Set([...relays, ...hints])],
        [{ ids: [id] }],
        { timeoutMs: this.options.requestTimeoutMs },
      );
      const event = events.find((candidate) => candidate.id === id);
      return event
        ? {
            ok: true,
            output: JSON.stringify({
              type: "event",
              event: describeEvent(event),
            }),
          }
        : {
            ok: false,
            output: `${entity} could not be loaded from the relays Hex reads`,
          };
    }

    if (decoded.type === "naddr") {
      const { kind, pubkey, identifier, relays: hints } = decoded.data;
      const events = await requestEvents(
        this.options.relays,
        [...new Set([...relays, ...(hints ?? [])])],
        [{ kinds: [kind], authors: [pubkey], "#d": [identifier], limit: 1 }],
        { timeoutMs: this.options.requestTimeoutMs },
      );
      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      return event
        ? {
            ok: true,
            output: JSON.stringify({
              type: "event",
              event: describeEvent(event),
            }),
          }
        : {
            ok: false,
            output: `${entity} could not be loaded from the relays Hex reads`,
          };
    }

    return {
      ok: false,
      output: `nothing to resolve for a ${decoded.type} entity`,
    };
  }
}

/**
 * An event as the model should see it.
 *
 * The bech32 to quote is supplied rather than left to the model: one handed only
 * hex writes an npub with a bad checksum, and grimoire renders an undecodable
 * reference as dead text. The `nevent` carries kind and author, so an adapter
 * reading it can dispatch without fetching first.
 */
function describeEvent(event: NostrEvent) {
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    npub: nip19.npubEncode(event.pubkey),
    nevent: nip19.neventEncode({
      id: event.id,
      kind: event.kind,
      author: event.pubkey,
    }),
    created_at: event.created_at,
    tags: event.tags,
    content:
      event.content.length > MAX_CONTENT_CHARS
        ? `${event.content.slice(0, MAX_CONTENT_CHARS)}…[truncated]`
        : event.content,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function hexList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && HEX64.test(entry),
  );
}

/** `nip-65`, `NIP65`, `65`, `1` all mean the same document. */
export function normalizeNipId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/^nip-?/i, "").trim();
  if (!/^[0-9A-Za-z]{1,3}$/.test(digits)) return undefined;
  return digits.toUpperCase().padStart(2, "0");
}

/**
 * Kind rows out of the NIPs index.
 *
 * The table is markdown: `| `9` | Chat Message | [29](29.md) |`. Ranges and
 * anything unparseable are skipped rather than guessed at — a missing row makes
 * the tool say "known: false", which is a true answer.
 */
export function parseKindTable(readme: string): Map<number, KindEntry> {
  const kinds = new Map<number, KindEntry>();
  for (const line of readme.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const kindCell = cells[1]!.replace(/`/g, "").trim();
    if (!/^\d+$/.test(kindCell)) continue;
    const description = cells[2]!.replace(/[`*]/g, "").trim();
    if (!description) continue;
    const nipMatch = /\[(\d+|[0-9A-Za-z]{2})\]/.exec(cells[3] ?? "");
    kinds.set(Number(kindCell), {
      kind: Number(kindCell),
      description,
      nip: nipMatch?.[1],
    });
  }
  return kinds;
}
