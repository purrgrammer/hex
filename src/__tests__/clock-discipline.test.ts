/**
 * Nothing under property test may read the wall clock behind the property's
 * back.
 *
 * A model-based test drives time: it advances a clock to a TTL boundary and
 * asserts what expiry does there. Every ambient `Date.now()` is a hole in that
 * — the code takes a different clock from the one the property is holding, and
 * the interesting boundary becomes unreachable rather than failing. Same for
 * `Math.random()`, which makes a shrunk counterexample unreproducible.
 *
 * A read that genuinely has to happen is allowed, and has to say so on the line
 * above it:
 *
 *   // clock: <why this one is not a decision>
 *
 * Deliberately narrow. This covers the modules the store properties drive; the
 * rest of the tree still reads the clock freely, and widening the list is how
 * a module joins the harness.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * Modules whose clock a caller can hold — every one of them, now.
 *
 * The list used to be just the store, and the other three each read the wall
 * clock through their own default in their own unit. Each was correct alone;
 * the hazard was a value crossing between them, and one did.
 */
const DISCIPLINED = [
  "src/clock.ts",
  "src/store.ts",
  "src/runner.ts",
  "src/outbound.ts",
  "src/tools/publish.ts",
];

const AMBIENT = /\b(Date\.now\(\)|Math\.random\(\))/;
const ALLOWED = /^\s*\/\/ clock:/;

describe("clock discipline", () => {
  for (const file of DISCIPLINED) {
    it(`${file} reads the wall clock only where it says why`, () => {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      const unmarked: string[] = [];
      lines.forEach((line, index) => {
        if (!AMBIENT.test(line)) return;
        if (ALLOWED.test(lines[index - 1] ?? "")) return;
        unmarked.push(`${file}:${index + 1}: ${line.trim()}`);
      });
      expect(unmarked).toEqual([]);
    });
  }

  it("keeps every timestamp in one unit", () => {
    /**
     * A duration may be milliseconds and says so in its name. A TIMESTAMP may
     * not: unix seconds, everywhere, because that is what Nostr uses and what
     * every column here stores. A conversion is allowed exactly where the two
     * meet, and it has to be `secondsFrom` — a named call somebody can grep for
     * — rather than a `/ 1000` buried in an expression.
     *
     * That is not pedantry. The stamp this catches was written by one clock and
     * read against another, and the window it decided simply never opened.
     */
    const offenders: string[] = [];
    for (const file of DISCIPLINED) {
      // `clock.ts` IS the conversion. Everywhere else has to call it.
      if (file === "src/clock.ts") continue;
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/\/\s*1000\b/.test(line)) return;
        // Prose describing the old shape is not the old shape.
        if (/^\s*(\*|\/\/)/.test(line)) return;
        if (ALLOWED.test(lines[index - 1] ?? "")) return;
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the marker meaningful by requiring a reason after it", () => {
    for (const file of DISCIPLINED) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const marker of text.match(/^\s*\/\/ clock:.*$/gm) ?? [])
        expect(
          marker.replace(/^\s*\/\/ clock:/, "").trim().length,
        ).toBeGreaterThan(10);
    }
  });
});
