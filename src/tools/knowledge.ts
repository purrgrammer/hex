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
import catalogue from "../data/commands.json" with { type: "json" };
import {
  HELP_TOOL,
  HELP_TOOL_LEGACY,
  REQ_TOOL,
  RESOLVE_TOOL,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

/** One labelled block of context, as the runtime will read it. */
function block(name: string, value: unknown): string {
  return `<${name}>\n${JSON.stringify(value)}\n</${name}>`;
}

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
  /**
   * Offer grimoire's command catalogue alongside the protocol's docs.
   *
   * Off by default. An agent serving one application wants it; an agent
   * working on Nostr generally does not, and telling it about a command
   * palette it cannot reach is context spent on nothing.
   */
  commands?: boolean;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface CommandEntry {
  name: string;
  synopsis: string;
  summary: string;
  description: string;
  flags?: string[];
  category?: string;
}

/**
 * grimoire's commands, as data.
 *
 * A snapshot generated from the app's own registry by `scripts/sync-commands.mjs`
 * — the in-app assistant reads `manPages` directly, which a published package
 * cannot. Stale by construction if a command changes and nobody re-runs the
 * script, so `--check` exists to fail CI instead of letting Hex describe a
 * command that no longer exists.
 */
export const COMMANDS: CommandEntry[] = catalogue.commands as CommandEntry[];

/** One line per command: the menu that goes in the system prompt. */
export function commandCatalogue(): string {
  return COMMANDS.map(
    (command) =>
      `  ${command.synopsis}${command.flags?.length ? `\n    flags: ${command.flags.join(" ")}` : ""}\n    ${command.summary}`,
  ).join("\n");
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
          "Look up a NIP's text or an event kind's definition, from the spec " +
          "rather than from memory." +
          (this.options.commands
            ? " Also reads a grimoire command's manual page."
            : ""),
        parameters: {
          type: "object",
          properties: {
            nip: { type: "string", description: 'NIP id, e.g. "01" or "29".' },
            kind: { type: "number", description: "Event kind number." },
            /**
             * One client's commands, offered only to an agent that has one.
             *
             * This tool is the protocol's documentation and belongs to any
             * agent working on Nostr; a command palette belongs to grimoire.
             * Bolting the second onto the first told every agent about an
             * application most of them have nothing to do with.
             */
            ...(this.options.commands
              ? {
                  command: {
                    type: "string",
                    // Enumerated: the whole set is two dozen names, and a model
                    // that guesses spends a round finding out it guessed wrong.
                    enum: COMMANDS.map((command) => command.name),
                    description:
                      'A grimoire command name, e.g. "req" — returns its ' +
                      "synopsis, flags and description.",
                  },
                }
              : {}),
          },
        },
        prompt:
          "`nostr.help` returns a NIP's text or a kind's definition — read it" +
          " rather than recalling what a kind number means." +
          (this.options.commands
            ? " It also has grimoire's command manual pages."
            : ""),
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
            e: {
              type: "array",
              items: { type: "string" },
              description: "Event ids, hex — replies to or references of them.",
            },
            p: {
              type: "array",
              items: { type: "string" },
              description: "Pubkeys, hex — events mentioning those people.",
            },
            a: {
              type: "array",
              items: { type: "string" },
              description:
                'Addressable coordinates, "<kind>:<pubkey>:<d>". `nostr.resolve` returns one ready-made as its `tag`.',
            },
            t: {
              type: "array",
              items: { type: "string" },
              description: "Hashtags, without the #.",
            },
            tags: {
              type: "object",
              description:
                "Single-letter tag filters, keyed by the bare letter: " +
                '{"t": ["nostr"]} for a hashtag, {"e": ["<hex>"]} for replies ' +
                'to an event, {"a": ["30023:<pubkey>:<d>"]} for an addressable ' +
                "event. A tag on its own is a valid query — you do not need " +
                "kinds as well. Values are hex ids and pubkeys, never npub or " +
                "note.",
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
          "nprofile, the event itself for a note, nevent or naddr. Also returns " +
          "`tag` and `filter` — the tag to put on an event and the filter to " +
          "query by — so you never have to build an `a` or `e` value yourself.",
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
      case HELP_TOOL_LEGACY:
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
    // The legacy id too: an already-published definition names `grimoire.help`,
    // and a model reading one should not be refused for using what it was told.
    if (name === HELP_TOOL_LEGACY) return true;
    return this.list().some((spec) => spec.name === name);
  }

  // ---- nostr.help ----------------------------------------------------------

  private async help(args: Record<string, unknown>): Promise<ToolResult> {
    const result: Record<string, unknown> = {};

    if (typeof args.command === "string" && args.command.trim()) {
      const wanted = args.command.trim().split(/\s+/)[0]!.toLowerCase();
      const command = COMMANDS.find((entry) => entry.name === wanted);
      result.command = command ?? {
        name: wanted,
        error: `No such command. Known commands: ${COMMANDS.map((entry) => entry.name).join(", ")}.`,
      };
    }

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
      return {
        ok: false,
        output: "Pass a nip id, a kind number, or a command name.",
      };
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

    /**
     * Tag filters, however the caller spelled them.
     *
     * NIP-01 writes them `#e`; this tool's own parameter is a `tags` object
     * keyed by the bare letter; and a model that knows the protocol writes the
     * hash in either place. All three now mean the same thing, because the
     * alternative was what actually happened: a key of `#e` failed the
     * single-letter test, was dropped WITHOUT A WORD, and the query ran as
     * `{kinds:[1621]}` — the whole relay instead of the one thread asked for,
     * answered confidently from a hundred unrelated events.
     *
     * A key that cannot be used is now refused rather than ignored. A query
     * that quietly means something else is worse than no query.
     */
    const tagSources: Record<string, unknown>[] = [];
    if (args.tags && typeof args.tags === "object" && !Array.isArray(args.tags))
      tagSources.push(args.tags as Record<string, unknown>);
    // Top-level `#e`, the way a filter is written in the spec.
    tagSources.push(
      Object.fromEntries(
        Object.entries(args).filter(([key]) => key.startsWith("#")),
      ),
    );
    /**
     * Top-level `e`, `a`, `t` — bare, the way the tool now ASKS for them.
     *
     * The schema used to offer a free-form `tags` map, which compiles to a JSON
     * Schema object with `additionalProperties` and no `properties`. An
     * OpenAI-shaped provider cannot express that, so every call arrived with
     * `tags: {}` and the query ran with no tag at all. The parameters are named
     * now, and a single-character key is unambiguously one of them: every other
     * parameter this tool takes is a word.
     */
    tagSources.push(
      Object.fromEntries(
        Object.entries(args).filter(
          ([key, value]) => key.length === 1 && value !== undefined,
        ),
      ),
    );

    let tagged = 0;
    for (const source of tagSources)
      for (const [rawKey, values] of Object.entries(source)) {
        const key = rawKey.startsWith("#") ? rawKey.slice(1) : rawKey;
        if (!SINGLE_LETTER.test(key))
          return {
            ok: false,
            output: `"${rawKey}" is not a tag filter — a tag is one letter, like "e" or "t". Nothing was queried.`,
          };
        if (!Array.isArray(values))
          return {
            ok: false,
            output: `the "${rawKey}" tag filter needs an array of values. Nothing was queried.`,
          };
        const strings = values.filter(
          (value): value is string => typeof value === "string" && value !== "",
        );
        if (!strings.length)
          return {
            ok: false,
            output: `the "${rawKey}" tag filter had no usable values. Nothing was queried.`,
          };
        (filter as Record<string, unknown>)[`#${key}`] = strings;
        tagged += 1;
      }

    // A filter with no constraint asks a relay for everything it has. A tag on
    // its own IS a constraint — "replies to this event" is one of the most
    // useful queries there is, and refusing it sent the model to fetch a kind
    // wholesale and sift it by hand.
    if (!filter.ids && !filter.authors && !filter.kinds && tagged === 0)
      return {
        ok: false,
        output:
          "that filter constrains nothing — pass at least ids, authors, kinds or a tag",
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

    /**
     * `limit` is per relay, and this asked several.
     *
     * Four relays each honouring `limit: 50` is up to two hundred events, so the
     * union routinely came back three times the size of the limit — and the tool
     * reported that number while showing only the first fifty. A model told "99
     * events" and shown fifty summarised the fifty as if they were the ninety-nine.
     *
     * NEWEST first before the cut, because the first fifty of an unsorted union
     * are whichever relay answered fastest. "The recent ones" has to mean the
     * recent ones.
     */
    const newest = [...events].sort((a, b) => b.created_at - a.created_at);
    const kept = newest.slice(0, filter.limit);

    return {
      ok: true,
      output: JSON.stringify({
        // The filter as sent: the model can see why a query came back empty.
        filter,
        relays,
        matched: events.length,
        returned: kept.length,
        ...(events.length > kept.length
          ? {
              note: `${events.length} events matched across ${relays.length} relays; the ${kept.length} newest are below`,
            }
          : {}),
        events: kept.map(describeEvent),
      }),
    };
  }

  // ---- nostr.resolve -------------------------------------------------------

  /**
   * What the runtime should know before it reads its first message.
   *
   * Four questions, and a runtime handed a bare message can answer none of
   * them. Who is this from — "check my recent posts" sent it hunting kind 1
   * across the whole network and summarising strangers. Where did it come from
   * — an answer for a public group is not an answer for a private message. What
   * is it about — a run scoped to a repository was handed a coordinate it could
   * not read. And who am I — an agent that does not know its own pubkey cannot
   * tell its own notes from anyone else's.
   *
   * Ordered from the LEAST to the most variable, which is the whole trick.
   * These become the prefix of every request, and a provider reuses a cached
   * prefix only up to the first byte that differs: the agent's own identity is
   * the same on every run it will ever do, a channel takes a handful of values,
   * an operator recurs across their own sessions, and the subject is different
   * every time. Put the subject first and nothing after it is ever cached.
   *
   * Nothing here is unique to the session — no session id, no timestamp, no
   * turn counter. A run's identity belongs on the wire, where a reader needs
   * it; in the prompt it is a byte that differs on every run and therefore a
   * cache that never hits.
   *
   * Never throws: a relay that will not answer costs the model a fact, and a
   * run refused because a profile could not be fetched costs it the whole job.
   */
  async ground(input: {
    /** The agent itself. */
    target?: string;
    /** The transport the request arrived over, e.g. `nip-17`, `nip-59`. */
    channel?: { transport: string; id?: string };
    /** Who is asking. */
    operator?: string;
    subjects?: string[][];
  }): Promise<string[]> {
    const blocks: string[] = [];

    if (input.target) {
      const self = await this.person(input.target).catch(() => undefined);
      blocks.push(
        block("target", {
          ...(self ?? {
            pubkey: input.target,
            npub: nip19.npubEncode(input.target),
          }),
          note: "This is you. Your own notes, your own profile, your own key.",
        }),
      );
    }

    if (input.channel)
      blocks.push(
        block("channel", {
          transport: input.channel.transport,
          ...(input.channel.id ? { id: input.channel.id } : {}),
          note:
            input.channel.transport === "nip-59"
              ? "Asked for privately over a gift wrap. There is no room: your transcript is how this is read, and there is nobody to send a chat message to."
              : "A conversation. Anything you want said out loud goes through a chat tool; text you write outside one is private thinking.",
        }),
      );

    if (input.operator) {
      const person = await this.person(input.operator).catch(() => undefined);
      blocks.push(
        block(
          "author",
          person ?? {
            pubkey: input.operator,
            npub: nip19.npubEncode(input.operator),
          },
        ),
      );
    }

    for (const tag of input.subjects ?? []) {
      const resolved = await this.subject(tag).catch(() => undefined);
      if (resolved) blocks.push(block("project", resolved));
    }

    return blocks;
  }

  /** A pubkey with whatever kind 0 says about it. */
  private async person(pubkey: string) {
    const events = await requestEvents(
      this.options.relays,
      this.options.readRelays,
      [{ kinds: [0], authors: [pubkey], limit: 1 }],
      { timeoutMs: this.options.requestTimeoutMs },
    );
    const profile = events.sort((a, b) => b.created_at - a.created_at)[0];
    return {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      nprofile: nip19.nprofileEncode({ pubkey }),
      metadata: profile ? safeJson(profile.content) : null,
    };
  }

  /**
   * What a subject tag names, fetched where fetching is possible.
   *
   * Five kinds of thing, and only two of them are events. A `p` is a person and
   * resolves to their profile; an `r` is a URL and resolves to nothing — the
   * address IS the answer, and guessing that the agent should go and fetch it
   * would be this file deciding to browse the web. An `i` is NIP-73: an
   * identifier for something that does not live on Nostr at all, which is
   * handed over as written along with whatever URL the tag carried for it.
   */
  private async subject(tag: string[]) {
    const [kind, value, hint] = tag;
    const relays = [
      ...new Set([...this.options.readRelays, ...(hint ? [hint] : [])]),
    ];

    if (kind === "e" && value && HEX64.test(value)) {
      const events = await requestEvents(
        this.options.relays,
        relays,
        [{ ids: [value] }],
        { timeoutMs: this.options.requestTimeoutMs },
      );
      const event = events.find((candidate) => candidate.id === value);
      return { tag, event: event ? describeEvent(event) : null };
    }

    if (kind === "a" && value) {
      const parts = value.split(":");
      const addressKind = Number(parts[0]);
      const [, pubkey, identifier = ""] = parts;
      if (!Number.isInteger(addressKind) || !pubkey) return { tag };
      const events = await requestEvents(
        this.options.relays,
        relays,
        [
          {
            kinds: [addressKind],
            authors: [pubkey],
            "#d": [identifier],
            limit: 1,
          },
        ],
        { timeoutMs: this.options.requestTimeoutMs },
      );
      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      return {
        tag,
        address: value,
        event: event ? describeEvent(event) : null,
      };
    }

    if (kind === "p" && value && HEX64.test(value))
      return { tag, ...(await this.person(value)) };

    // Not fetched: a URL is a thing the runtime may decide to read with a tool
    // of its own, and this resolving it would be a relay reader browsing the
    // web on the strength of a tag.
    if (kind === "r" && value) return { tag, url: value };

    /**
     * NIP-73: something with an identity outside Nostr.
     *
     * `["i", "<id>", "<url>"]` — a GitHub issue, an ISBN, a podcast episode.
     * There is nothing to fetch and nothing to decode; what makes it useful is
     * that the runtime is told the thing exists and how it is named.
     */
    if (kind === "i" && value)
      return { tag, external: value, ...(hint ? { url: hint } : {}) };

    return undefined;
  }

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
      const metadata = profile ? safeJson(profile.content) : null;
      return {
        ok: true,
        output: JSON.stringify({
          type: "profile",
          pubkey,
          npub: nip19.npubEncode(pubkey),
          metadata,
          /**
           * How to REFER to this in a filter or an event, spelled out.
           *
           * A model that has resolved an entity almost always wants to query
           * about it next, and turning it into the right tag is a step it gets
           * wrong — `naddr` into an `a` value especially. Handing back the tag
           * removes the step rather than documenting it.
           */
          tag: ["p", pubkey],
          filter: { authors: [pubkey] },
          // Said out loud, because `metadata: null` alone reads to a model as
          // "this person has no name" rather than "nobody here had their kind 0".
          ...(metadata
            ? {}
            : {
                note: "No kind 0 for this pubkey on the relays Hex reads. The person exists; their profile is not here.",
              }),
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
              tag: ["e", event.id],
              filter: { ids: [event.id] },
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
      const address = `${kind}:${pubkey}:${identifier}`;
      /**
       * The `a` value, whether or not the event itself was found.
       *
       * An addressable event's coordinate is derivable from the naddr alone, so
       * a relay that does not hold the event is no reason to withhold the one
       * string the caller is most likely to need — and "not found" plus no tag
       * is what sent models off inventing their own.
       */
      const addressable = {
        tag: ["a", address],
        filter: { kinds: [kind], authors: [pubkey], "#d": [identifier] },
        address,
      };
      return event
        ? {
            ok: true,
            output: JSON.stringify({
              type: "event",
              event: describeEvent(event),
              ...addressable,
            }),
          }
        : {
            ok: true,
            output: JSON.stringify({
              type: "address",
              ...addressable,
              note: `${entity} is not on the relays Hex reads, but this is how to refer to it.`,
            }),
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
