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

/** Modules a property drives, and so must be able to hold the clock for. */
const DISCIPLINED = ["src/store.ts"];

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
