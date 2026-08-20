/**
 * Where the built page is, from wherever this file ended up.
 *
 * `dist/ui/where.js` in an installed package, `src/ui/where.ts` under tsx — two
 * levels up is the package root either way, and the bundle sits at `web/dist`
 * beside `dist/`. Resolved from `import.meta.url` rather than `process.cwd()`,
 * because the daemon is started by launchd from a directory nobody chose.
 *
 * Returns undefined when there is no bundle, which is the ordinary state of a
 * checkout that has not run the web build. The API still serves; only the page
 * is missing, and the server says so in as many words.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function webRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", "web", "dist");
  return existsSync(join(root, "index.html")) ? root : undefined;
}
