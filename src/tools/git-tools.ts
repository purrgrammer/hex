/**
 * A repository on Nostr, as work rather than as events.
 *
 * NIP-34 puts a repository's issues, patches and pull requests on relays as
 * kinds 1621, 1617 and 1618, and their state as kinds 1630–1633. A model with
 * only `nostr.req` can reach all of it and reliably gets it wrong, because
 * three separate things have to be right at once and none of them is guessable:
 *
 * 1. **Where to look.** A repository announcement names its own relays, and
 *    they are very often not the ones the agent reads by default. A query on
 *    the wrong relays returns nothing and looks exactly like a repository with
 *    no issues.
 * 2. **How to filter.** "Open issues" is not a filter. An issue's state lives
 *    in a SEPARATE event that points back at it, so answering it means two
 *    round trips and a fold, and a model that does one round trip confidently
 *    reports every issue ever filed as open.
 * 3. **Who decides.** Anyone may publish a status event about anyone's issue.
 *    Only the repository's maintainers and the issue's own author count, and a
 *    fold that trusts the newest status full stop lets a stranger close things.
 *
 * So these tools do the three-step properly and hand back the answer. What they
 * are NOT is a git client: nothing here clones, diffs or applies a patch — the
 * agent has a shell and a checkout for that. This is the social half.
 */

import type { Filter, NostrEvent } from "nostr-tools";

import { publishTo, requestEvents, type HexRelays } from "../relays.js";
import type { EventSigner } from "./publish.js";
import {
  GIT_ISSUES_TOOL,
  GIT_PATCHES_TOOL,
  GIT_STATE_TOOL,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

export const KIND_REPOSITORY = 30617;
export const KIND_PATCH = 1617;
export const KIND_PULL_REQUEST = 1618;
export const KIND_ISSUE = 1621;

/**
 * Status kinds, and what each one means.
 *
 * The kind IS the state — there is no `status` tag to read — so this table is
 * the whole vocabulary in both directions.
 */
export const STATE_KINDS: Record<string, number> = {
  open: 1630,
  applied: 1631,
  closed: 1632,
  draft: 1633,
};
const STATE_OF: Record<number, string> = Object.fromEntries(
  Object.entries(STATE_KINDS).map(([state, kind]) => [kind, state]),
);

/**
 * What an issue with no status event at all is.
 *
 * NIP-34 does not require one, and in practice most issues never get one until
 * somebody acts on them — so treating "no status" as unknown would report every
 * healthy repository as having nothing open.
 */
const DEFAULT_STATE = "open";

/** A page of issues is a page. A repository with four hundred is not readable. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Enough of the body to know what it is about, not the whole essay. */
const MAX_CONTENT = 600;

export interface GitToolsOptions {
  relays: HexRelays;
  /** Where to look when the repository names no relays of its own. */
  readRelays: string[];
  /** Only set when the operator allowed writing. Without it, state is read-only. */
  signer?: EventSigner;
  pubkey?: string;
  /** Where a status event goes, on top of the repository's own relays. */
  publishRelays?: string[];
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

interface Repository {
  address: string;
  event: NostrEvent;
  name?: string;
  /** The repository's own relays, which is where its issues actually live. */
  relays: string[];
  /** Who may say an issue is closed. The owner is one by definition. */
  maintainers: string[];
}

const tagValues = (event: NostrEvent, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name).flatMap((tag) => tag.slice(1));

const firstTag = (event: NostrEvent, name: string): string | undefined =>
  event.tags.find((tag) => tag[0] === name && tag[1])?.[1];

export class GitTools {
  /** Repositories already looked up, so a follow-up question is one round trip. */
  private readonly known = new Map<string, Repository>();

  constructor(private readonly options: GitToolsOptions) {}

  handles(name: string): boolean {
    return (
      name === GIT_ISSUES_TOOL ||
      name === GIT_PATCHES_TOOL ||
      name === GIT_STATE_TOOL
    );
  }

  list(): ToolSpec[] {
    const specs: ToolSpec[] = [
      {
        name: GIT_ISSUES_TOOL,
        description:
          "List a NIP-34 repository's issues, with their real state. Finds the " +
          "repository's own relays first, then folds in the status events that " +
          "say whether each issue is open, closed, applied or draft. Use this " +
          "instead of a raw kind 1621 query, which cannot tell you the state " +
          "and will usually look on the wrong relays.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description:
                'The repository address, "30617:<pubkey-hex>:<identifier>". ' +
                "This is what an `a` tag on the session carries.",
            },
            state: {
              type: "string",
              enum: ["open", "closed", "applied", "draft", "any"],
              description: `Which issues to return. Defaults to "open".`,
            },
            limit: {
              type: "number",
              description: `How many, newest first. Defaults to ${DEFAULT_LIMIT}, hard bound ${MAX_LIMIT}.`,
            },
          },
          required: ["repo"],
          additionalProperties: false,
        },
        prompt:
          "`git.issues` lists a repository's issues WITH their state, on the" +
          " repository's own relays. Anything about open issues starts here —" +
          " a kind 1621 query cannot answer it, because the state is a separate" +
          " event and the issues are usually not on the relays you read.",
      },
      {
        name: GIT_PATCHES_TOOL,
        description:
          "List a NIP-34 repository's patches (kind 1617) and pull requests " +
          "(kind 1618), with their state folded in the same way as issues.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description:
                'The repository address, "30617:<pubkey-hex>:<identifier>".',
            },
            state: {
              type: "string",
              enum: ["open", "closed", "applied", "draft", "any"],
              description: `Which to return. Defaults to "open".`,
            },
            kind: {
              type: "string",
              enum: ["patch", "pull-request", "any"],
              description: `Defaults to "any", which returns both.`,
            },
            limit: {
              type: "number",
              description: `How many, newest first. Defaults to ${DEFAULT_LIMIT}, hard bound ${MAX_LIMIT}.`,
            },
          },
          required: ["repo"],
          additionalProperties: false,
        },
        prompt:
          "`git.patches` lists a repository's patches and pull requests with" +
          " their state, on the repository's own relays.",
      },
    ];

    // Writing is a separate permission, and without a signer there is nothing
    // to offer — an agent shown a tool it cannot use spends a turn finding out.
    if (this.options.signer && this.options.pubkey)
      specs.push({
        name: GIT_STATE_TOOL,
        description:
          "Change the state of an issue, patch or pull request by publishing a " +
          "NIP-34 status event as this agent. PERMANENT and public: a status " +
          "event cannot be recalled, only superseded. Only the repository's " +
          "maintainers and the thing's own author are authoritative, so check " +
          "that this agent is one of them before using it.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description:
                'The repository address, "30617:<pubkey-hex>:<identifier>".',
            },
            id: {
              type: "string",
              description:
                "The hex event id of the issue, patch or pull request. Not a " +
                "nevent — decode it with `nostr.resolve` first.",
            },
            state: {
              type: "string",
              enum: ["open", "closed", "applied", "draft"],
              description: "The state to set.",
            },
            comment: {
              type: "string",
              description: "Why, in a sentence. Published with the status.",
            },
          },
          required: ["repo", "id", "state"],
          additionalProperties: false,
        },
        prompt:
          "`git.state` opens, closes or resolves an issue or patch. It is a" +
          " public, permanent event signed by you — say why in `comment`, and" +
          " do not use it on a repository you do not maintain.",
      });

    return specs;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const address = typeof args.repo === "string" ? args.repo.trim() : "";
    if (!address)
      return {
        ok: false,
        output:
          'Pass the repository as `repo`, e.g. "30617:<pubkey-hex>:<identifier>".',
      };

    const repository = await this.repository(address);
    if (!repository)
      return {
        ok: false,
        output:
          `No kind 30617 for ${address} on the relays Hex reads. Either the ` +
          `address is wrong or the announcement lives somewhere else — ` +
          `\`nostr.resolve\` on its naddr will say where.`,
      };

    if (name === GIT_STATE_TOOL) return this.setState(repository, args);
    return this.threads(
      repository,
      name === GIT_ISSUES_TOOL
        ? [KIND_ISSUE]
        : kindsOf(typeof args.kind === "string" ? args.kind : "any"),
      args,
    );
  }

  /**
   * The repository announcement, and with it the relays its work lives on.
   *
   * Cached for the life of the process: an announcement is replaceable and
   * changes rarely, and every question about a repository begins with this
   * lookup — paying for it once per session rather than once per question is
   * the difference between a tool that feels instant and one that does not.
   */
  private async repository(address: string): Promise<Repository | undefined> {
    const cached = this.known.get(address);
    if (cached) return cached;

    const [kind, pubkey, identifier = ""] = address.split(":");
    if (Number(kind) !== KIND_REPOSITORY || !pubkey) return undefined;

    const events = await requestEvents(
      this.options.relays,
      this.options.readRelays,
      [
        {
          kinds: [KIND_REPOSITORY],
          authors: [pubkey],
          "#d": [identifier],
          limit: 1,
        },
      ],
      { timeoutMs: this.options.requestTimeoutMs },
    );
    const event = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!event) return undefined;

    const repository: Repository = {
      address,
      event,
      name: firstTag(event, "name"),
      /**
       * The repository's relays FIRST, the agent's own behind them.
       *
       * Both, not either: a repository names where its maintainers publish, and
       * a reader's own relays often hold a copy anyway. Querying only the
       * repository's relays makes one unreachable host look like an empty
       * project; querying only the agent's misses the project entirely.
       */
      relays: [
        ...new Set([
          ...tagValues(event, "relays").filter((url) => /^wss?:\/\//i.test(url)),
          ...this.options.readRelays,
        ]),
      ],
      // The owner is a maintainer whether or not the tag says so.
      maintainers: [...new Set([event.pubkey, ...tagValues(event, "maintainers")])],
    };
    this.known.set(address, repository);
    this.options.log?.(
      `[hex] ${repository.name ?? address} → ${repository.relays.length} relay(s), ${repository.maintainers.length} maintainer(s)`,
    );
    return repository;
  }

  /**
   * Issues or patches, with the state that actually applies to each.
   *
   * Two reads and a fold, which is the whole reason this is a tool: the things
   * themselves, then every status event pointing at any of them, then the
   * newest authoritative status per thread.
   */
  private async threads(
    repository: Repository,
    kinds: number[],
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const want =
      typeof args.state === "string" && args.state ? args.state : DEFAULT_STATE;
    if (want !== "any" && !(want in STATE_KINDS))
      return {
        ok: false,
        output: `\`state\` must be one of ${Object.keys(STATE_KINDS).join(", ")}, or "any".`,
      };

    const asked =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT;
    const limit = Math.min(asked, MAX_LIMIT);

    const filters: Filter[] = [
      { kinds, "#a": [repository.address], limit: MAX_LIMIT * 2 },
    ];
    const found = await requestEvents(
      this.options.relays,
      repository.relays,
      filters,
      { timeoutMs: this.options.requestTimeoutMs },
    );

    const threads = dedupe(found).sort((a, b) => b.created_at - a.created_at);
    if (threads.length === 0)
      return {
        ok: true,
        output: JSON.stringify({
          repo: repository.address,
          relays: repository.relays,
          matched: 0,
          note: "Nothing of those kinds is tagged to this repository on its own relays.",
        }),
      };

    const states = await this.statesFor(repository, threads);

    const rows = threads
      .map((event) => ({
        state: states.get(event.id) ?? DEFAULT_STATE,
        event,
      }))
      .filter((row) => want === "any" || row.state === want);

    const page = rows.slice(0, limit);

    return {
      ok: true,
      output: JSON.stringify({
        repo: repository.address,
        name: repository.name,
        relays: repository.relays,
        state: want,
        matched: rows.length,
        returned: page.length,
        ...(rows.length > page.length
          ? {
              note: `${rows.length} matched; the ${page.length} newest are below.`,
            }
          : {}),
        // Named `events` so the same reader that renders a REQ's answer renders
        // this one — the extra fields ride alongside rather than replacing it.
        events: page.map((row) => describeThread(row.event, row.state)),
      }),
    };
  }

  /**
   * The state of each thread, decided by who is allowed to decide it.
   *
   * The newest status event wins, but only among the ones that count: a
   * maintainer may set any state, and an author may set their own thread's.
   * Without that rule anyone could close anything by publishing a 1632, which
   * a fold over "the newest status" would obey without noticing.
   */
  private async statesFor(
    repository: Repository,
    threads: NostrEvent[],
  ): Promise<Map<string, string>> {
    const ids = threads.map((event) => event.id);
    const authors = new Map(threads.map((event) => [event.id, event.pubkey]));

    const statuses = await requestEvents(
      this.options.relays,
      repository.relays,
      [{ kinds: Object.values(STATE_KINDS), "#e": ids }],
      { timeoutMs: this.options.requestTimeoutMs },
    );

    const newest = new Map<string, NostrEvent>();
    for (const status of statuses) {
      const target = status.tags.find((tag) => tag[0] === "e" && tag[1])?.[1];
      if (!target || !authors.has(target)) continue;

      const allowed =
        repository.maintainers.includes(status.pubkey) ||
        authors.get(target) === status.pubkey;
      if (!allowed) continue;

      const current = newest.get(target);
      if (!current || status.created_at > current.created_at)
        newest.set(target, status);
    }

    return new Map(
      [...newest].map(([id, status]) => [
        id,
        STATE_OF[status.kind] ?? DEFAULT_STATE,
      ]),
    );
  }

  /** Publish a status event as this agent. Public, permanent, superseded only. */
  private async setState(
    repository: Repository,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const signer = this.options.signer;
    const pubkey = this.options.pubkey;
    if (!signer || !pubkey)
      return { ok: false, output: "this agent is not configured to write." };

    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!/^[0-9a-f]{64}$/i.test(id))
      return {
        ok: false,
        output:
          "`id` must be a 64-character hex event id. A nevent goes through " +
          "`nostr.resolve` first.",
      };

    const state = typeof args.state === "string" ? args.state : "";
    const kind = STATE_KINDS[state];
    if (!kind)
      return {
        ok: false,
        output: `\`state\` must be one of ${Object.keys(STATE_KINDS).join(", ")}.`,
      };

    /**
     * Said, not refused.
     *
     * A status event from a stranger is not invalid — it is simply ignored by
     * readers that apply the rule — so publishing one is a waste rather than an
     * attack, and an agent asked by its operator to comment on someone else's
     * repository should be able to. What it should not do is believe it worked.
     */
    const authoritative = repository.maintainers.includes(pubkey);

    const template = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["e", id, "", "root"],
        ["a", repository.address],
        // The maintainers, so a reader can check the rule without fetching the
        // repository first — which is what NIP-34 asks a status event to carry.
        ...repository.maintainers.map((maintainer) => ["p", maintainer]),
      ],
      content: typeof args.comment === "string" ? args.comment : "",
    };

    const event = await signer.signEvent(template);
    const relays = [
      ...new Set([...repository.relays, ...(this.options.publishRelays ?? [])]),
    ];
    const outcomes = await publishTo(this.options.relays, relays, event);
    const accepted = outcomes.filter((outcome) => outcome.ok);

    if (accepted.length === 0)
      return {
        ok: false,
        output: `no relay accepted it: ${outcomes
          .map((outcome) => `${outcome.relay} (${outcome.message ?? "refused"})`)
          .join(", ")}`,
      };

    this.options.log?.(
      `[hex] ${state} ${id.slice(0, 12)}… on ${repository.name ?? repository.address}`,
    );
    return {
      ok: true,
      output: JSON.stringify({
        published: event.id,
        state,
        kind,
        relays: accepted.map((outcome) => outcome.relay),
        ...(authoritative
          ? {}
          : {
              warning:
                "This agent is not a maintainer of that repository and did not " +
                "author the thread, so readers applying NIP-34's rule will " +
                "ignore this status. It is published, and it will not count.",
            }),
      }),
    };
  }
}

function kindsOf(kind: string): number[] {
  if (kind === "patch") return [KIND_PATCH];
  if (kind === "pull-request") return [KIND_PULL_REQUEST];
  return [KIND_PATCH, KIND_PULL_REQUEST];
}

/** Four relays deliver the same event four times. */
function dedupe(events: NostrEvent[]): NostrEvent[] {
  const seen = new Map<string, NostrEvent>();
  for (const event of events) if (!seen.has(event.id)) seen.set(event.id, event);
  return [...seen.values()];
}

/**
 * One thread, as much of it as is worth reading.
 *
 * `subject` is where NIP-34 puts the title, falling back to the first line of
 * the body — an issue with neither is rare and reads as "(no title)" rather
 * than as a blank row.
 */
function describeThread(event: NostrEvent, state: string) {
  const subject = firstTag(event, "subject");
  const firstLine = event.content.split("\n").find((line) => line.trim());
  return {
    id: event.id,
    kind: event.kind,
    state,
    title: subject ?? firstLine?.slice(0, 120) ?? "(no title)",
    author: event.pubkey,
    created_at: event.created_at,
    labels: [
      ...tagValues(event, "t"),
      ...event.tags.filter((tag) => tag[0] === "l" && tag[1]).map((tag) => tag[1]!),
    ],
    content:
      event.content.length > MAX_CONTENT
        ? `${event.content.slice(0, MAX_CONTENT)}…[truncated]`
        : event.content,
  };
}
