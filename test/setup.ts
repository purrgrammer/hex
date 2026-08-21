/**
 * Every test gets its own home, and none of them get yours.
 *
 * `DEFAULT_HOME` is `~/.hex`, read at import time, and the live daemon keeps
 * its store — the queue, the spool, the writer lease — under it. A test that
 * opens a store without naming a path would otherwise open THAT one, take the
 * lease off a running `hex serve`, and prune rows a property was about to
 * generate over. Pointing `HOME` at a temp directory before any module is
 * imported makes the accident impossible rather than merely unlikely.
 *
 * Set on `process.env` because `os.homedir()` reads it; the store computes
 * `DEFAULT_HOME` from that at module load, and vitest runs this file first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hex-test-home-"));

process.env["HOME"] = home;
// Windows and some tooling read these instead. Cheap to keep in step.
process.env["USERPROFILE"] = home;

process.on("exit", () => {
  rmSync(home, { recursive: true, force: true });
});
