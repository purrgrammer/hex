/**
 * Writing to Nostr, as Hex.
 *
 * Every other tool in this package reads. These two do not: what they produce is
 * signed by the agent's own key, and a signed event cannot be recalled — a
 * deletion request is a request, and relays that already served the note are
 * under no obligation to forget it. So the shape here is deliberately narrow.
 *
 * **Signing and publishing are the same permission.** `nostr.sign` hands back an
 * event anyone who receives it can publish, so it is bounded exactly as
 * `nostr.publish` is. A tool that would sign what it refuses to publish is a
 * tool with a loophole in it.
 *
 * **Some kinds are refused unless the operator names them.** Not because the
 * model is untrusted in general, but because these particular kinds break the
 * agent in ways it cannot undo or even notice:
 *
 * - `0`, `3`, `10002`, `10050` are REPLACEABLE. Publishing one replaces what the
 *   agent already had — a new 10050 silently redirects every private message
 *   sent to it thereafter, and nothing in the transcript would say so.
 * - `5` asks relays to delete. Aimed at the wrong id it destroys someone's work,
 *   and the agent's own key is authority enough for its own notes.
 * - `4`, `13`, `1059`, `21059` are the encrypted and wrapping kinds. A generic
 *   signer must not mint them: the transports build those deliberately, with the
 *   right seal and the right throwaway key, and a hand-rolled one leaks exactly
 *   what the envelope exists to hide.
 *
 * An operator who wants any of them lists it in `tools.publish.kinds`, which is
 * an explicit, readable decision in a file rather than a model's improvisation.
 */

import { createHash } from "node:crypto";

import { finalizeEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools";

import { publishTo, type HexRelays } from "../relays.js";
import { retract } from "../retract.js";
import {
  PUBLISH_TOOL,
  RM_TOOL,
  SIGN_TOOL,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

/**
 * What this needs of the store: two calls, so the tool stays testable without
 * a database and the store stays free of any notion of a tool.
 */
export interface PublishLedger {
  publishedSince(
    kind: number,
    scope: string,
    since: number,
  ): { id: string; subject: string; sha256: string }[];
  rememberPublished(entry: {
    id: string;
    kind: number;
    scope: string;
    subject: string;
    sha256: string;
    at: number;
  }): void;
}

/** What this needs of a signer: the one method, however the key is held. */
export interface EventSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

/** Kinds refused unless the operator names them. See the note above. */
export const GUARDED_KINDS: readonly number[] = [
  0, 3, 4, 5, 13, 1059, 10002, 10050, 21059,
];

/** A sane ceiling, so a confused loop cannot spend the agent's reputation. */
const DEFAULT_PER_HOUR = 10;
/** Content this long is a document, not a note, and probably a mistake. */
const MAX_CONTENT = 64 * 1024;

/** NIP-34's patch. The one kind whose content has a shape worth checking. */
const KIND_PATCH = 1617;

/**
 * The kinds where publishing the same thing twice is always a mistake.
 *
 * A patch, a pull request and an issue each propose ONE thing to ONE
 * repository. Two of them saying the same thing is not a conversation, it is a
 * maintainer triaging the same work twice. Notes and replies are deliberately
 * absent: people repeat themselves on purpose.
 */
const ONE_PER_THING: readonly number[] = [1617, 1618, 1621];

/** How much of a subject's opening has to match. See `duplicateOf`. */
const OPENING_WORDS = 2;

/**
 * The kinds whose subjects are prose, so their opening means something.
 *
 * Not patches. A patch subject is `[PATCH] fix: …`, and after noise removal
 * every conventional-commit patch to a repository opens on the same two words —
 * "patch fix" — which would refuse the second unrelated fix of the day. Patches
 * are covered by the two exact rules instead, and covered well: a re-executed
 * turn regenerating the same patch produces the same bytes and the same
 * subject, because it is the same commit.
 */
const PROSE_SUBJECTS: readonly number[] = [1618, 1621];

/** How far back a duplicate is still a duplicate. */
const DEFAULT_DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Words too common to tell two subjects apart. */
const NOISE = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "in", "is", "it", "its", "no", "not", "of", "on", "or", "that", "the",
  "there", "this", "to", "was", "were", "with",
]);

/**
 * A subject reduced to what it is about.
 *
 * Case, punctuation and the em-dash clause a model likes to append are not
 * identity: "No opt-in path for hex to speak unprompted -- automation is
 * currently impossible" and the same sentence rephrased are the same issue.
 */
export function normaliseSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The significant words of a subject, in order. */
function significant(subject: string): string[] {
  return normaliseSubject(subject)
    .split(" ")
    .filter((word) => word.length > 0 && !NOISE.has(word));
}

/**
 * Is this the same proposal as one already published?
 *
 * Three rules, each of which has to be explainable in the refusal, because a
 * model told only "duplicate" will rephrase and try again:
 *
 * 1. The same bytes. Certain.
 * 2. The same subject once normalised. Certain enough.
 * 3. The same opening — the first two words that are not noise, for the kinds
 *    whose subjects are prose. This is the one
 *    that earns its keep, and the only reason it is set as low as two: the two
 *    "Memory lives in ..." issues diverged at the third significant word, share
 *    three words out of fourteen, and would clear no similarity threshold that
 *    did not also fire on unrelated work. Dropping noise words is what makes
 *    two enough — "No way for one hex identity ..." opens on "way one", not on
 *    "no way", so it does not collide with every other "No way to ..." issue.
 *
 * A false positive here is cheap and self-correcting: the agent is told which
 * event it already published and that a genuinely different proposal needs a
 * subject that says how it differs. A false negative is a permanent duplicate
 * on four relays that a maintainer triages by hand.
 */
function duplicateOf(
  kind: number,
  candidate: { subject: string; sha256: string },
  earlier: readonly { id: string; subject: string; sha256: string }[],
): { id: string; why: string } | undefined {
  const subject = normaliseSubject(candidate.subject);
  const words = significant(candidate.subject);
  const opening = words.slice(0, OPENING_WORDS);

  for (const previous of earlier) {
    if (previous.sha256 === candidate.sha256)
      return { id: previous.id, why: "the same content, byte for byte" };
    if (subject && previous.subject === subject)
      return { id: previous.id, why: "the same subject" };

    // Only for subjects long enough that their opening is not the whole of
    // them — a two-word subject matching a two-word subject is rule 2's job.
    const theirs = previous.subject
      .split(" ")
      .filter((word) => word.length > 0 && !NOISE.has(word));
    if (
      PROSE_SUBJECTS.includes(kind) &&
      opening.length === OPENING_WORDS &&
      words.length > OPENING_WORDS &&
      theirs.length > OPENING_WORDS &&
      opening.every((word, at) => word === theirs[at])
    )
      return {
        id: previous.id,
        why: `a subject that begins the same way — "${opening.join(" ")}"`,
      };
  }
  return undefined;
}

export interface PublishToolsOptions {
  signer: EventSigner;
  pubkey: string;
  relays: HexRelays;
  /** Where an event goes when the model names no relay. */
  publishRelays: string[];
  /** Where the agent looks events up, for `nostr.rm` to check authorship. */
  readRelays?: string[];
  /**
   * What has already been published, so the same proposal is not filed twice.
   *
   * Optional: a `hex eve` run with no home still publishes, it just cannot
   * remember. Absent, the check is skipped rather than faked.
   */
  ledger?: PublishLedger;
  /** How far back a duplicate is still a duplicate. Default six hours. */
  duplicateWindowMs?: number;
  /** Guarded kinds the operator has explicitly allowed. */
  allowKinds?: number[];
  perHour?: number;
  /** Log instead of publishing, so the whole path can be exercised safely. */
  dryRun?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * A NIP-34 patch is `git format-patch` output, and nothing else will do.
 *
 * Four of the first six patches this agent published were corrupt, in three
 * different ways: one lost its head, one its tail, one a hunk out of the middle,
 * and a twin of that last one differed by twenty-seven bytes. None were near any
 * size limit. Whatever loses the bytes, the damage is only cheap to fix BEFORE
 * signing — after that it is a permanent broken proposal on four relays that a
 * maintainer has to triage by hand.
 *
 * So the shape is checked rather than trusted. Not a parser: a patch that gets
 * past this can still be wrong, but it cannot be obviously mangled.
 */
function malformedPatch(content: string): string | undefined {
  if (!content.startsWith("From "))
    return (
      "a kind 1617 must be `git format-patch` output, which begins with " +
      "`From <sha> <date>`. This one does not, so its beginning is missing — " +
      "which is what happens when a large value loses its first chunk on the " +
      "way here. Rebuild it and send the whole thing."
    );

  const lines = content.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  // `git format-patch` signs off with its own version after a `-- ` line.
  if (!/^\d+\.\d+/.test(last) && last.trim() !== "--")
    return (
      "a kind 1617 ends with git's own version after a `-- ` line; this one " +
      `ends with ${JSON.stringify(last.slice(0, 60))}, so the end is missing. ` +
      "That is a truncated patch, not a short one."
    );

  if (!lines.some((line) => line.startsWith("diff --git ")))
    return "a kind 1617 carries a diff, and there is no `diff --git` line in this one";

  /**
   * Every hunk header promises a number of lines. A chunk dropped from the
   * middle breaks that promise while leaving both ends of the patch intact —
   * which is exactly the corruption the two checks above cannot see.
   */
  for (let at = 0; at < lines.length; at += 1) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(
      lines[at] ?? "",
    );
    if (!header) continue;
    const before = header[1] === undefined ? 1 : Number(header[1]);
    const after = header[2] === undefined ? 1 : Number(header[2]);
    let minus = 0;
    let plus = 0;
    for (let cursor = at + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.startsWith("@@") || line.startsWith("diff --git ")) break;
      if (line.startsWith("-- ") || line.trimEnd() === "--") break;
      if (line.startsWith("+")) plus += 1;
      else if (line.startsWith("-")) minus += 1;
      else if (line.startsWith(" ") || line === "") {
        minus += 1;
        plus += 1;
      }
    }
    if (minus < before || plus < after)
      return (
        `the hunk at line ${at + 1} promises ${before} lines before and ` +
        `${after} after, and carries ${minus} and ${plus}. Something was lost ` +
        "from the middle of this patch."
      );
  }
  return undefined;
}

export class PublishTools {
  /** Timestamps of what was published, for the hourly bound. */
  private readonly published: number[] = [];

  /**
   * One publish at a time per repository and kind.
   *
   * The two executions of a re-executed turn OVERLAP — proved in the stream
   * this was written for, where the second execution's first action ran while
   * the first execution's was still in flight. Reading the ledger, then
   * spending up to ten seconds talking to relays, then writing it, lets both
   * through: each sees a ledger that does not yet mention the other. So the
   * whole check-publish-record sequence is serialised on what the ledger keys
   * off, and the second call reads a ledger the first has already written.
   *
   * Per scope rather than globally: two proposals to two repositories have
   * nothing to say to each other, and a slow relay on one should not hold up
   * the other.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: PublishToolsOptions) {}

  private get allowed(): Set<number> {
    return new Set(this.options.allowKinds ?? []);
  }

  list(): ToolSpec[] {
    const guarded = GUARDED_KINDS.filter((kind) => !this.allowed.has(kind));
    const refused = guarded.length
      ? ` Refuses kinds ${guarded.join(", ")} unless the operator allowed them.`
      : "";

    const parameters = {
      type: "object",
      properties: {
        kind: { type: "number", description: "Event kind." },
        content: { type: "string", description: "The event's content." },
        tags: {
          type: "array",
          description:
            'Tags, as arrays of strings: [["e","<hex>"],["p","<hex>"]]. ' +
            "Hex ids and pubkeys, never npub or note.",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["kind", "content"],
    };

    return [
      {
        name: PUBLISH_TOOL,
        description:
          `Sign an event with Hex's key and publish it. This is PUBLIC and ` +
          `permanent — a deletion request is a request, and relays are not ` +
          `obliged to honour it.${refused}`,
        parameters: {
          ...parameters,
          properties: {
            ...parameters.properties,
            relays: {
              type: "array",
              items: { type: "string" },
              description:
                "Leave this out unless the user named a relay. Hex publishes " +
                "to its own configured relays otherwise.",
            },
            sha256: {
              type: "string",
              description:
                "The sha256 of `content`, computed where you built it. For a " +
                "kind 1617 patch, ALWAYS send this: pipe the patch through " +
                "`sha256sum` in the same command that produces it, and pass " +
                "the hex digest here. Large values sometimes lose a chunk on " +
                "the way to this tool, and this is the only thing that " +
                "notices. A mismatch publishes nothing and tells you so.",
            },
          },
        },
        prompt:
          "`nostr.publish` writes to the network as Hex, publicly and" +
          " permanently. Say what you are about to post and why before you" +
          " post it, and never post on a guess about what someone meant.",
      },
      {
        name: SIGN_TOOL,
        description:
          "Sign an event with Hex's key and return it WITHOUT publishing, for " +
          "someone else to inspect or relay." +
          refused,
        parameters,
        prompt:
          "`nostr.sign` returns a signed event without sending it — the same" +
          " bounds as publishing, because a signed event is one relay call away" +
          " from being published by whoever holds it.",
      },
      {
        name: RM_TOOL,
        description:
          "Ask relays to forget events THIS agent published, by id. Only its " +
          "own: every id is fetched first and one signed by anyone else is " +
          "refused. Deletion is a request — a relay that already served the " +
          "event may keep serving it, and a reader that cached it never hears " +
          "the ask — so this repairs a mistake without erasing it.",
        parameters: {
          type: "object",
          properties: {
            ids: {
              type: "array",
              items: { type: "string" },
              description:
                "Event ids, 64 hex characters each. Never note or nevent.",
            },
            reason: {
              type: "string",
              description:
                "Why, for whoever reads the deletion request. One line.",
            },
          },
          required: ["ids"],
        },
        prompt:
          "`nostr.rm` retracts something this agent published. Reach for it" +
          " when a published event was a mistake — a duplicate, or wrong —" +
          " and say which id and why before you do.",
      },
    ];
  }

  handles(name: string): boolean {
    return name === PUBLISH_TOOL || name === SIGN_TOOL || name === RM_TOOL;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === RM_TOOL) return await this.remove(args);

    const template = this.templateFor(args);
    if ("error" in template) return { ok: false, output: template.error };

    // Only the kinds the ledger guards need the queue; a note waits for nobody.
    if (!this.options.ledger || !ONE_PER_THING.includes(template.value.kind))
      return await this.write(name, args, template.value);

    const key = `${template.value.kind}:${PublishTools.scopeOf(template.value)}`;
    const queued = (this.inFlight.get(key) ?? Promise.resolve()).then(
      () => this.write(name, args, template.value),
      () => this.write(name, args, template.value),
    );
    this.inFlight.set(key, queued);
    try {
      return await queued;
    } finally {
      if (this.inFlight.get(key) === queued) this.inFlight.delete(key);
    }
  }

  /** Everything after the queue: the check, the publish and the record. */
  private async write(
    name: string,
    args: Record<string, unknown>,
    value: EventTemplate,
  ): Promise<ToolResult> {
    const template = { value };

    /**
     * Already filed?
     *
     * Checked before the rate limit, and a hit does not spend the hourly
     * budget: refusing to repeat work is not work. Checked for signing too,
     * for the reason at the top of this file: a signed event is one relay call
     * from being published by whoever holds it, so a tool that signs what
     * publish refuses is the loophole that note warns about.
     */
    const already = this.duplicate(template.value);
    if (already) return { ok: false, output: already };

    if (name === SIGN_TOOL) {
      const event = await this.sign(template.value);
      return { ok: true, output: JSON.stringify({ signed: event }) };
    }

    const rate = this.withinRate();
    if (rate) return { ok: false, output: rate };

    const named = Array.isArray(args.relays)
      ? args.relays.filter(
          (url): url is string =>
            typeof url === "string" &&
            (url.startsWith("wss://") || url.startsWith("ws://")),
        )
      : [];
    const relays = named.length > 0 ? named : this.options.publishRelays;
    if (relays.length === 0)
      return { ok: false, output: "no relay to publish to" };

    const event = await this.sign(template.value);

    if (this.options.dryRun) {
      this.options.log?.(
        `[hex] would publish kind ${event.kind}: ${event.content.slice(0, 120)}`,
      );
      return {
        ok: true,
        output: JSON.stringify({
          id: event.id,
          dryRun: true,
          note: "nothing was published",
        }),
      };
    }

    const outcomes = await publishTo(this.options.relays, relays, event);
    const accepted = outcomes.filter((outcome) => outcome.ok);
    // Counted only when it landed: a publish nobody took has not spent the
    // agent's hourly budget, because it has not been seen.
    if (accepted.length > 0) {
      this.published.push(this.now());
      this.record(event);
    }

    return {
      // A relay that refused is not a tool that failed, but it is not a success
      // either — the caller is told the truth and decides.
      ok: accepted.length > 0,
      output: JSON.stringify({
        id: event.id,
        nevent: undefined,
        accepted: accepted.map((outcome) => outcome.relay),
        refused: outcomes
          .filter((outcome) => !outcome.ok)
          .map((outcome) => ({ relay: outcome.relay, why: outcome.message })),
      }),
    };
  }

  /**
   * Retract the agent's own events.
   *
   * Bounded like a publish, because it is one: a kind 5 is signed by the same
   * key and lands on the same relays. It does not go through `templateFor`,
   * whose guard refuses kind 5 outright — that guard exists to stop a generic
   * signer minting deletion requests for arbitrary ids, and the authorship
   * check in `retract` is the narrower thing that replaces it here.
   */
  private async remove(args: Record<string, unknown>): Promise<ToolResult> {
    const ids = Array.isArray(args.ids)
      ? args.ids.filter((id): id is string => typeof id === "string")
      : [];
    if (ids.length === 0)
      return { ok: false, output: "`ids` must list at least one event id" };
    if (ids.length > 20)
      return {
        ok: false,
        output: `that is ${ids.length} ids; retract at most 20 at a time`,
      };

    const rate = this.withinRate();
    if (rate) return { ok: false, output: rate };

    const reason = typeof args.reason === "string" ? args.reason : undefined;
    const result = await retract(ids, {
      relays: this.options.relays,
      signer: this.options.signer,
      pubkey: this.options.pubkey,
      readRelays: this.options.readRelays ?? this.options.publishRelays,
      publishRelays: this.options.publishRelays,
      reason,
      dryRun: this.options.dryRun,
    });

    const retracted = result.targets.filter((target) => !target.refused);
    if (result.outcomes.some((outcome) => outcome.ok)) this.published.push(this.now());

    return {
      ok: retracted.length > 0,
      output: JSON.stringify({
        request: result.request?.id,
        dryRun: this.options.dryRun || undefined,
        retracted: retracted.map((target) => target.id),
        refused: result.targets
          .filter((target) => target.refused)
          .map((target) => ({ id: target.id, why: target.refused })),
        accepted: result.outcomes
          .filter((outcome) => outcome.ok)
          .map((outcome) => outcome.relay),
        note:
          "a deletion request is a request; relays and caches are not obliged" +
          " to honour it",
      }),
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * The `a` tag an event hangs off, which for NIP-34 is the repository.
   *
   * Scoping by it is what keeps the check honest: the same subject on two
   * different repositories is two proposals, not one repeated.
   */
  private static scopeOf(template: EventTemplate): string {
    return template.tags.find((tag) => tag[0] === "a")?.[1] ?? "";
  }

  private static subjectOf(template: EventTemplate): string {
    const tagged = template.tags.find((tag) => tag[0] === "subject")?.[1];
    if (tagged) return tagged;
    // A patch carries its subject in the format-patch header, not in a tag.
    const header = /^Subject:\s*(.+)$/m.exec(template.content);
    return header?.[1]?.trim() ?? template.content.split("\n")[0] ?? "";
  }

  /** Whether this proposal has already been filed, and how it is known. */
  private duplicate(template: EventTemplate): string | undefined {
    const ledger = this.options.ledger;
    if (!ledger || !ONE_PER_THING.includes(template.kind)) return undefined;

    const window =
      this.options.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
    const since = Math.floor((this.now() - window) / 1000);
    const earlier = ledger.publishedSince(
      template.kind,
      PublishTools.scopeOf(template),
      since,
    );
    if (earlier.length === 0) return undefined;

    const hit = duplicateOf(
      template.kind,
      {
        subject: PublishTools.subjectOf(template),
        sha256: createHash("sha256")
          .update(template.content, "utf8")
          .digest("hex"),
      },
      earlier,
    );
    if (!hit) return undefined;

    return (
      `this agent already published ${hit.id} with ${hit.why}, and nothing ` +
      "was published now. You have done this already — do not compose it " +
      "again. If it really is a different proposal, give it a subject that " +
      `says how it differs, or retract ${hit.id.slice(0, 12)} with nostr.rm ` +
      "and publish the one you meant."
    );
  }

  /** Remember one, so the next execution of this turn sees it. */
  private record(event: NostrEvent): void {
    if (!this.options.ledger || !ONE_PER_THING.includes(event.kind)) return;
    this.options.ledger.rememberPublished({
      id: event.id,
      kind: event.kind,
      scope: PublishTools.scopeOf(event),
      subject: normaliseSubject(PublishTools.subjectOf(event)),
      sha256: createHash("sha256").update(event.content, "utf8").digest("hex"),
      at: Math.floor(this.now() / 1000),
    });
  }

  private withinRate(): string | undefined {
    const cap = this.options.perHour ?? DEFAULT_PER_HOUR;
    const hourAgo = this.now() - 60 * 60 * 1000;
    while (this.published.length && this.published[0]! < hourAgo)
      this.published.shift();
    return this.published.length >= cap
      ? `Hex has already published ${this.published.length} events this hour, which is its limit. Nothing was published.`
      : undefined;
  }

  private templateFor(
    args: Record<string, unknown>,
  ): { value: EventTemplate } | { error: string } {
    const kind = typeof args.kind === "number" ? Math.floor(args.kind) : NaN;
    if (!Number.isInteger(kind) || kind < 0 || kind > 65535)
      return { error: "an event needs a `kind` between 0 and 65535" };

    if (GUARDED_KINDS.includes(kind) && !this.allowed.has(kind))
      return {
        error:
          `kind ${kind} is not one this agent may write. Replaceable identity ` +
          `and relay-list kinds redirect the agent silently, deletion requests ` +
          `destroy what they name, and the encrypted kinds are built by the ` +
          `transports rather than by hand. Ask the operator to allow it in ` +
          `\`tools.publish.kinds\` if it is really wanted.`,
      };

    const content = typeof args.content === "string" ? args.content : undefined;
    if (content === undefined)
      return { error: "an event needs `content`, even if it is empty" };
    if (content.length > MAX_CONTENT)
      return {
        error: `that content is ${content.length} characters; the limit is ${MAX_CONTENT}`,
      };

    /**
     * The digest the caller computed where the content was BUILT.
     *
     * The shape check below catches a patch that arrives obviously mangled. It
     * cannot catch one that lost a chunk and still parses, and one of the four
     * broken patches differed from its intact twin by twenty-seven bytes. A
     * digest taken in the sandbox — `git format-patch --stdout | sha256sum` —
     * and checked here is the only thing that sees that, because it is the only
     * thing that knows what was meant.
     *
     * Optional, and silent when absent: an agent publishing a note has nothing
     * to compare against and should not be made to invent one.
     */
    const expected =
      typeof args.sha256 === "string" ? args.sha256.trim().toLowerCase() : "";
    if (expected) {
      if (!/^[0-9a-f]{64}$/.test(expected))
        return { error: "`sha256` must be 64 hex characters, or left out" };
      const actual = createHash("sha256").update(content, "utf8").digest("hex");
      if (actual !== expected)
        return {
          error:
            `the content that arrived hashes to ${actual}, and you said ` +
            `${expected}. It was damaged on the way here — ${content.length} ` +
            "characters arrived. Nothing was published. Send it again.",
        };
    }

    if (kind === KIND_PATCH) {
      const wrong = malformedPatch(content);
      if (wrong) return { error: wrong };
    }

    const tags: string[][] = [];
    if (args.tags !== undefined) {
      if (!Array.isArray(args.tags))
        return { error: "`tags` must be an array of arrays of strings" };
      for (const tag of args.tags) {
        if (
          !Array.isArray(tag) ||
          tag.length === 0 ||
          tag.some((value) => typeof value !== "string")
        )
          return {
            error: `every tag must be a non-empty array of strings; got ${JSON.stringify(tag)}`,
          };
        tags.push(tag as string[]);
      }
    }

    return {
      value: {
        kind,
        content,
        tags,
        // The agent's clock, never the model's: a `created_at` it could choose
        // is one it could backdate into somebody else's thread.
        created_at: Math.floor(this.now() / 1000),
      },
    };
  }

  private async sign(template: EventTemplate): Promise<NostrEvent> {
    return this.options.signer.signEvent(template);
  }
}

/** For a caller holding a raw secret key rather than a signer object. */
export function signerFromSecret(secret: Uint8Array): EventSigner {
  return {
    signEvent: async (template) => finalizeEvent(template, secret),
  };
}
