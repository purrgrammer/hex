#!/usr/bin/env node
/**
 * Copy grimoire's command catalogue into this package, as data.
 *
 * Hex answers questions about grimoire, and "which command shows me that" is one
 * of them — the in-app assistant reads `manPages` straight from the app for
 * exactly this. A published package cannot: `src/` is not shipped, so an import
 * would resolve during development and fail on install.
 *
 * So the catalogue is generated and committed. It is a snapshot, which means it
 * can go stale; run this after adding or changing a command, the same way
 * `/sync-nips` is run after the specs move.
 *
 *   node scripts/sync-commands.mjs [--check]
 *
 * `--check` exits non-zero when the committed copy is out of date, so CI can say
 * so rather than letting Hex describe a command that no longer exists.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");
const source = join(repoRoot, "src", "types", "man.ts");
const target = join(packageRoot, "src", "data", "commands.json");

/**
 * The catalogue as data, parsed out of the module rather than imported.
 *
 * `man.ts` carries `argParser` functions and app imports, so it cannot be loaded
 * from a plain Node script. The fields Hex needs are all string literals, and a
 * command whose entry cannot be read is skipped rather than half-copied.
 */
function parseCatalogue(text) {
  const commands = [];
  // Each entry starts at `  <name>: {` inside `manPages`.
  const entryPattern = /^ {2}([a-z0-9-]+): \{$/gm;
  let match;
  while ((match = entryPattern.exec(text)) !== null) {
    const start = match.index;
    const next = text.indexOf("\n  },", start);
    if (next === -1) continue;
    const body = text.slice(start, next);

    const field = (name) => {
      const single = new RegExp(`\\n\\s{4}${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
      const wrapped = new RegExp(`\\n\\s{4}${name}:\\n\\s+"((?:[^"\\\\]|\\\\.)*)"`);
      const found = single.exec(body) ?? wrapped.exec(body);
      return found ? JSON.parse(`"${found[1]}"`) : undefined;
    };

    const flags = [...body.matchAll(/flag:\s*"((?:[^"\\]|\\.)*)"/g)].map((flag) =>
      JSON.parse(`"${flag[1]}"`),
    );

    const name = field("name") ?? match[1];
    const synopsis = field("synopsis");
    const description = field("description");
    const category = field("category");
    if (!synopsis || !description) continue;

    commands.push({
      name,
      synopsis,
      // First sentence only: the catalogue is a menu, and `grimoire.help`
      // returns the whole entry when asked about one command.
      summary: `${description.split(". ")[0].replace(/\.$/, "")}.`,
      description,
      ...(flags.length ? { flags } : {}),
      ...(category ? { category } : {}),
    });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

const text = await readFile(source, "utf8");
const commands = parseCatalogue(text);
if (commands.length < 10)
  throw new Error(
    `only parsed ${commands.length} commands from ${source} — the file's shape probably changed`,
  );

const json = `${JSON.stringify({ commands }, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== json) {
    console.error(
      `${target} is out of date — run: node scripts/sync-commands.mjs`,
    );
    process.exit(1);
  }
  console.log(`${commands.length} commands, up to date`);
} else {
  await writeFile(target, json, "utf8");
  console.log(`wrote ${commands.length} commands to ${target}`);
}
