import { describe, it, expect } from "vitest";

import { clipJson, fitPart, TOOL_OUTPUT_INLINE_MAX } from "../nostr/blob.js";

const digest = async (text: string) => `sha-${text.length}`;

describe("clipJson", () => {
  it("keeps a shortened result parseable", () => {
    /**
     * The bug this exists for: a REQ's answer is JSON, and clipping it like a
     * build log produced a prefix no parser would take. The client that knows
     * how to render events as events fell back to showing broken text, which
     * read as a rendering bug rather than a truncation one.
     */
    const events = Array.from({ length: 40 }, (_, at) => ({
      id: String(at).padStart(64, "0"),
      kind: 1621,
      content: "x".repeat(2_000),
      tags: [["a", "30617:abc:grimoire"]],
    }));
    const raw = JSON.stringify({ filter: { kinds: [1621] }, matched: 40, events });
    expect(raw.length).toBeGreaterThan(4_000);

    const clipped = clipJson(raw, 4_000);
    expect(clipped).toBeDefined();
    expect(clipped!.length).toBeLessThanOrEqual(4_000);

    const parsed = JSON.parse(clipped!) as {
      filter: unknown;
      matched: number;
      events: { id: string }[];
    };
    // The shape survives — which is the whole point. What it loses is depth:
    // fewer events, shorter content.
    expect(parsed.filter).toEqual({ kinds: [1621] });
    expect(parsed.matched).toBe(40);
    expect(parsed.events.length).toBeLessThan(40);
    expect(parsed.events[0]!.id).toBe(events[0]!.id);
  });

  it("leaves anything that is not a JSON document alone", () => {
    expect(clipJson("a build log\nwith lines", 10)).toBeUndefined();
    // A bare scalar has no structure to give up, so there is nothing to do
    // that clipping it as text would not do better.
    expect(clipJson('"just a string"', 4)).toBeUndefined();
  });
});

describe("fitPart", () => {
  it("shrinks an oversize JSON tool result without breaking it", async () => {
    const output = JSON.stringify({
      events: Array.from({ length: 200 }, () => ({ content: "y".repeat(500) })),
    });
    const part = await fitPart(
      { type: "tool_result", id: "call_1", name: "nostr_req", output },
      { digest },
    );

    expect(part.type).toBe("tool_result");
    const result = part as { output: string; truncated?: { bytes: number } };
    expect(result.output.length).toBeLessThanOrEqual(TOOL_OUTPUT_INLINE_MAX);
    // Still JSON, and still says how much was dropped.
    expect(() => JSON.parse(result.output)).not.toThrow();
    expect(result.truncated?.bytes).toBe(output.length);
  });
});
