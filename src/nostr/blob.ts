/**
 * Size limits, truncation and out-of-band tool results (NIP-xx: Agent Sessions).
 *
 * A tool that prints a build log will outrun any relay's event cap, and a
 * wrapped copy is ~1.4x the rumor after NIP-44 and base64. Truncation is always
 * explicit: the block says how much it dropped and the digest of what it dropped.
 */

import { isKnownBlock } from "./types.js";
import type { BlobRef, Truncation, TurnBlock } from "./types.js";

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
 * Bring one block within the inline limits, uploading an oversize tool result to
 * the sink when one is supplied. Never emits a block it knows a relay will
 * reject.
 */
export async function fitBlock(
  block: TurnBlock,
  options: ExternalizeOptions,
): Promise<TurnBlock> {
  if (!isKnownBlock(block)) return block;

  const textMax = options.textMax ?? TEXT_INLINE_MAX;
  const outputMax = options.outputMax ?? TOOL_OUTPUT_INLINE_MAX;

  if (
    (block.type === "text" || block.type === "thinking") &&
    block.text.length > textMax
  )
    return {
      ...block,
      text: clip(block.text, textMax),
      truncated: await truncation(block.text, options.digest),
    };

  if (
    block.type === "tool_result" &&
    block.output &&
    block.output.length > outputMax
  ) {
    const sha256 = await options.digest(block.output);
    if (options.sink) {
      const ref = await options.sink(block.output, "text/plain");
      return {
        ...block,
        output: null,
        ref: { ...ref, sha256: ref.sha256 ?? sha256 },
      };
    }
    return {
      ...block,
      output: clip(block.output, outputMax),
      truncated: { bytes: block.output.length, sha256 },
    };
  }

  return block;
}

/** Bring one block under a byte share, whatever kind it is. */
function squeeze(block: TurnBlock, share: number): TurnBlock {
  if (!isKnownBlock(block)) return block;

  if (block.type === "text" || block.type === "thinking")
    return block.text.length <= share
      ? block
      : { ...block, text: clip(block.text, share) };

  if (block.type === "tool_result" && block.output)
    return block.output.length <= share
      ? block
      : { ...block, output: clip(block.output, share) };

  // Arguments are arbitrary JSON with no honest clipping point, so an oversize
  // call drops them for a digest that still names which call it was.
  if (block.type === "tool_call" && block.arguments !== null) {
    const encoded = JSON.stringify(block.arguments);
    if (encoded.length <= share) return block;
    return {
      ...block,
      arguments: null,
      arguments_digest: block.arguments_digest ?? `len:${encoded.length}`,
    };
  }

  return block;
}

/** What replaces a block there was no room for. Never a silent disappearance. */
function dropped(count: number): TurnBlock {
  return {
    type: "text",
    text: `${TRUNCATION_MARKER} ${count} block${count === 1 ? "" : "s"} omitted: this turn exceeded what a relay will accept`,
  };
}

/**
 * Fit a whole turn.
 *
 * Thinking is elided first — the least load-bearing thing in a transcript and
 * usually the largest — and then every block is squeezed against a TOTAL budget
 * rather than a per-block one, because a relay counts the whole event. A block
 * there is no room for is replaced by a marker saying so: a turn that quietly
 * lost half its content reads as a complete turn, which is worse than a short
 * one.
 */
export async function fitTurn(
  blocks: TurnBlock[],
  options: ExternalizeOptions,
): Promise<{ blocks: TurnBlock[]; lossy: boolean }> {
  const fitted: TurnBlock[] = [];
  for (const block of blocks) fitted.push(await fitBlock(block, options));

  if (JSON.stringify(fitted).length <= TURN_MAX_BYTES)
    return { blocks: fitted, lossy: false };

  const elided = fitted.map((block) =>
    block.type === "thinking" ? { ...block, text: "[elided]" } : block,
  );
  if (JSON.stringify(elided).length <= TURN_MAX_BYTES)
    return { blocks: elided, lossy: true };

  const out: TurnBlock[] = [];
  // Headroom for the tags, the JSON scaffolding, and the marker below.
  let budget = TURN_MAX_BYTES - 1024;

  for (let index = 0; index < elided.length; index += 1) {
    const remaining = elided.length - index;
    const share = Math.max(64, Math.floor(budget / remaining));
    const squeezed = squeeze(elided[index]!, share);
    const cost = JSON.stringify(squeezed).length;

    if (cost > budget) {
      out.push(dropped(remaining));
      return { blocks: out, lossy: true };
    }

    out.push(squeezed);
    budget -= cost;
  }

  return { blocks: out, lossy: true };
}
