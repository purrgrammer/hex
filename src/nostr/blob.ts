/**
 * Size limits, truncation and out-of-band tool results (NIP-xx: Agent Sessions).
 *
 * A tool that prints a build log will outrun any relay's event cap, and a
 * wrapped copy is ~1.4x the rumor after NIP-44 and base64. Truncation is always
 * explicit: the part says how much it dropped and the digest of what it dropped.
 */

import { isKnownPart } from "./types.js";
import type { BlobRef, Truncation, TurnPart } from "./types.js";

export const TEXT_INLINE_MAX = 8 * 1024;
export const TOOL_OUTPUT_INLINE_MAX = 16 * 1024;
export const TURN_MAX_BYTES = 48 * 1024;
export const TRUNCATION_MARKER = "…[truncated]";

/** Digest of the original, so a fuller copy elsewhere can be proven to match. */
export type Digest = (text: string) => Promise<string>;

/** Where an oversize output goes instead of into the event. */
export type BlobSink = (
  text: string,
  mime: string,
) => Promise<Omit<BlobRef, "sha256"> & { sha256?: string }>;

export interface ExternalizeOptions {
  digest: Digest;
  /** Absent means "truncate honestly"; the transcript then says what it lost. */
  sink?: BlobSink;
  textMax?: number;
  outputMax?: number;
}

async function truncation(text: string, digest: Digest): Promise<Truncation> {
  return { bytes: text.length, sha256: await digest(text) };
}

/** Keep the head and the tail: a stack trace's ends carry the information. */
function clip(text: string, max: number): string {
  const head = Math.floor((max * 2) / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n${TRUNCATION_MARKER}\n${text.slice(-tail)}`;
}

/**
 * Steps a JSON result is shrunk through, roomiest first.
 *
 * Each pass caps how long a string may be and how many entries an array keeps.
 * The first one that fits wins, so a result loses only as much as it has to.
 */
const JSON_PASSES: { strings: number; entries: number }[] = [
  { strings: 1_000, entries: 20 },
  { strings: 400, entries: 12 },
  { strings: 200, entries: 8 },
  { strings: 120, entries: 5 },
  { strings: 60, entries: 3 },
  { strings: 40, entries: 1 },
];

/** One pass: cap every string and every array, all the way down. */
function shrink(
  value: unknown,
  limits: { strings: number; entries: number },
): unknown {
  if (typeof value === "string")
    return value.length <= limits.strings
      ? value
      : `${value.slice(0, limits.strings)}${TRUNCATION_MARKER}`;
  if (Array.isArray(value))
    return value
      .slice(0, limits.entries)
      .map((entry) => shrink(entry, limits));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        shrink(entry, limits),
      ]),
    );
  return value;
}

/**
 * Shorten a JSON tool result WITHOUT making it stop being JSON.
 *
 * Cutting a long string in half is fine for a build log and destroys a JSON
 * document: what arrives is a prefix that no parser will take, so a reader that
 * knows how to render a REQ's answer as events renders a wall of broken text
 * instead — which is exactly what happened, and it looked like a rendering bug
 * rather than a truncation one.
 *
 * So a result that IS JSON is shrunk structurally: strings are capped and
 * arrays are cut short, from the inside, until the whole thing fits. What comes
 * out still parses, and the part's own `truncated` field is what says it is not
 * the whole story.
 *
 * Returns undefined when the value is not JSON, or when no pass gets it under
 * the limit — both meaning "fall back to clipping it as text".
 */
export function clipJson(text: string, max: number): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  // A bare string or number is not a document with structure to give up.
  if (!parsed || typeof parsed !== "object") return undefined;

  for (const limits of JSON_PASSES) {
    const candidate = JSON.stringify(shrink(parsed, limits));
    if (candidate.length <= max) return candidate;
  }
  return undefined;
}

/**
 * Bring one part within the inline limits, uploading an oversize tool result to
 * the sink when one is supplied. Never emits a part it knows a relay will
 * reject.
 */
export async function fitPart(
  part: TurnPart,
  options: ExternalizeOptions,
): Promise<TurnPart> {
  if (!isKnownPart(part)) return part;

  const textMax = options.textMax ?? TEXT_INLINE_MAX;
  const outputMax = options.outputMax ?? TOOL_OUTPUT_INLINE_MAX;

  if (
    (part.type === "text" || part.type === "reasoning") &&
    part.text.length > textMax
  )
    return {
      ...part,
      text: clip(part.text, textMax),
      truncated: await truncation(part.text, options.digest),
    };

  if (
    part.type === "tool_result" &&
    part.output &&
    part.output.length > outputMax
  ) {
    const sha256 = await options.digest(part.output);
    if (options.sink) {
      const ref = await options.sink(part.output, "text/plain");
      return {
        ...part,
        output: null,
        ref: { ...ref, sha256: ref.sha256 ?? sha256 },
      };
    }
    return {
      ...part,
      // Structurally if it is JSON, as text if it is not.
      output: clipJson(part.output, outputMax) ?? clip(part.output, outputMax),
      truncated: { bytes: part.output.length, sha256 },
    };
  }

  return part;
}

/** Bring one part under a byte share, whatever kind it is. */
function squeeze(part: TurnPart, share: number): TurnPart {
  if (!isKnownPart(part)) return part;

  if (part.type === "text" || part.type === "reasoning")
    return part.text.length <= share
      ? part
      : { ...part, text: clip(part.text, share) };

  if (part.type === "tool_result" && part.output)
    return part.output.length <= share
      ? part
      : {
          ...part,
          output: clipJson(part.output, share) ?? clip(part.output, share),
        };

  // Arguments are arbitrary JSON with no honest clipping point, so an oversize
  // call drops them for a digest that still names which call it was.
  if (part.type === "tool_call" && part.arguments !== null) {
    const encoded = JSON.stringify(part.arguments);
    if (encoded.length <= share) return part;
    return {
      ...part,
      arguments: null,
      arguments_digest: part.arguments_digest ?? `len:${encoded.length}`,
    };
  }

  return part;
}

/** What replaces a part there was no room for. Never a silent disappearance. */
function dropped(count: number): TurnPart {
  return {
    type: "text",
    text: `${TRUNCATION_MARKER} ${count} part${count === 1 ? "" : "s"} omitted: this turn exceeded what a relay will accept`,
  };
}

/**
 * Fit a whole turn.
 *
 * Thinking is elided first — the least load-bearing thing in a transcript and
 * usually the largest — and then every part is squeezed against a TOTAL budget
 * rather than a per-part one, because a relay counts the whole event. A part
 * there is no room for is replaced by a marker saying so: a turn that quietly
 * lost half its content reads as a complete turn, which is worse than a short
 * one.
 */
export async function fitTurn(
  parts: TurnPart[],
  options: ExternalizeOptions,
): Promise<{ parts: TurnPart[]; lossy: boolean }> {
  const fitted: TurnPart[] = [];
  for (const part of parts) fitted.push(await fitPart(part, options));

  if (JSON.stringify(fitted).length <= TURN_MAX_BYTES)
    return { parts: fitted, lossy: false };

  const elided = fitted.map((part) =>
    part.type === "reasoning" ? { ...part, text: "[elided]" } : part,
  );
  if (JSON.stringify(elided).length <= TURN_MAX_BYTES)
    return { parts: elided, lossy: true };

  const out: TurnPart[] = [];
  // Headroom for the tags, the JSON scaffolding, and the marker below.
  let budget = TURN_MAX_BYTES - 1024;

  for (let index = 0; index < elided.length; index += 1) {
    const remaining = elided.length - index;
    const share = Math.max(64, Math.floor(budget / remaining));
    const squeezed = squeeze(elided[index]!, share);
    const cost = JSON.stringify(squeezed).length;

    if (cost > budget) {
      out.push(dropped(remaining));
      return { parts: out, lossy: true };
    }

    out.push(squeezed);
    budget -= cost;
  }

  return { parts: out, lossy: true };
}
