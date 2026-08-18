import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { createRelays } from "../relays.js";
import { resolveSigner } from "../signer.js";

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const nsec = nip19.nsecEncode(key);

let relays: ReturnType<typeof createRelays> | undefined;

afterEach(() => {
  relays?.close();
  relays = undefined;
  delete process.env.HEX_TEST_NSEC;
});

describe("resolveSigner", () => {
  it("resolves an nsec named by env var", async () => {
    process.env.HEX_TEST_NSEC = nsec;
    relays = createRelays();
    const resolved = await resolveSigner(
      { type: "nsec", env: "HEX_TEST_NSEC" },
      { baseDir: process.cwd(), relays },
    );
    expect(resolved.pubkey).toBe(pubkey);
    expect(resolved.source).toContain("HEX_TEST_NSEC");
  });

  it("reads a key file relative to the config's directory, not the cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hex-signer-"));
    await writeFile(join(dir, "key"), `${nsec}\n`, "utf8");
    relays = createRelays();
    const resolved = await resolveSigner(
      { type: "nsec", file: "./key" },
      { baseDir: dir, relays },
    );
    expect(resolved.pubkey).toBe(pubkey);
  });

  it("fails clearly when the env var is unset", async () => {
    relays = createRelays();
    await expect(
      resolveSigner(
        { type: "nsec", env: "HEX_TEST_NSEC" },
        { baseDir: process.cwd(), relays },
      ),
    ).rejects.toThrow(/unset or empty/);
  });

  it("fails clearly when the key is not a key", async () => {
    process.env.HEX_TEST_NSEC = "not-a-key";
    relays = createRelays();
    await expect(
      resolveSigner(
        { type: "nsec", env: "HEX_TEST_NSEC" },
        { baseDir: process.cwd(), relays },
      ),
    ).rejects.toThrow(/valid nsec or hex key/);
  });

  it("accepts a bare hex key as well as an nsec", async () => {
    const { bytesToHex } = await import("nostr-tools/utils");
    process.env.HEX_TEST_NSEC = bytesToHex(key);
    relays = createRelays();
    const resolved = await resolveSigner(
      { type: "nsec", env: "HEX_TEST_NSEC" },
      { baseDir: process.cwd(), relays },
    );
    expect(resolved.pubkey).toBe(pubkey);
  });
});
