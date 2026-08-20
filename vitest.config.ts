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
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
