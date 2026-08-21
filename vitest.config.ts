import { defineConfig } from "vitest/config";

/**
 * Hex's own test config.
 *
 * It used to run from the grimoire monorepo's root config, which is why
 * `vitest run` from inside this package failed to find a setup file: the
 * `setupFiles` and the `nostr-hex` alias both lived in a file this package
 * could not see. Standing alone means owning both.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    /**
     * `.claude/worktrees` holds git worktrees of this repository — full source
     * copies, tests included. Without this the suite runs twice: once here and
     * once against a checkout of some other branch, whose failures belong to
     * that branch and are reported as if they were this one's.
     */
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    /**
     * Runs before any module is imported, and points `HOME` — and so the
     * store's `DEFAULT_HOME` — at a temp directory. A test that opens a store
     * without naming a path must not be able to reach `~/.hex`, where a live
     * daemon holds the writer lease on the real queue.
     */
    setupFiles: ["./test/setup.ts"],
  },
});
