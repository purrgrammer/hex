import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../env-file.js";

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hex-env-"));
  for (const [name, content] of Object.entries(files))
    await writeFile(join(dir, name), content, "utf8");
  return dir;
}

describe("loadEnvFile", () => {
  it("applies a .env beside the config", async () => {
    const dir = await dirWith({ ".env": "HEX_NSEC=nsec1abc\n" });
    const env: NodeJS.ProcessEnv = {};
    const result = await loadEnvFile(dir, undefined, env);
    expect(env.HEX_NSEC).toBe("nsec1abc");
    expect(result.applied).toEqual(["HEX_NSEC"]);
  });

  it("never overrides a variable the environment already set", async () => {
    // Someone who exported a key for one run should not be silently overridden
    // by a stale file next to the config.
    const dir = await dirWith({ ".env": "HEX_NSEC=from-file\n" });
    const env: NodeJS.ProcessEnv = { HEX_NSEC: "from-shell" };
    const result = await loadEnvFile(dir, undefined, env);
    expect(env.HEX_NSEC).toBe("from-shell");
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["HEX_NSEC"]);
  });

  it("reports names, never values", async () => {
    // The whole point of the file is that the secret is not in the config; a log
    // line that echoes it back undoes that.
    const dir = await dirWith({ ".env": "HEX_NSEC=nsec1secret\n" });
    const result = await loadEnvFile(dir, undefined, {});
    expect(JSON.stringify(result)).not.toContain("nsec1secret");
  });

  it("is quiet when there is no .env", async () => {
    const dir = await dirWith({});
    const result = await loadEnvFile(dir, undefined, {});
    expect(result).toEqual({ path: null, applied: [], skipped: [] });
  });

  it("fails loudly when --env-file names a file that is not there", async () => {
    // Asked for by name and missing is a typo, and continuing produces an agent
    // that cannot find its key for reasons nobody can see.
    const dir = await dirWith({});
    await expect(loadEnvFile(dir, "./nope.env", {})).rejects.toThrow(
      /could not be read/,
    );
  });

  it("resolves --env-file against the config's directory", async () => {
    const dir = await dirWith({ "secrets.env": "HEX_API_KEY=k\n" });
    const env: NodeJS.ProcessEnv = {};
    await loadEnvFile(dir, "./secrets.env", env);
    expect(env.HEX_API_KEY).toBe("k");
  });

  it("handles quotes, comments and blank lines", async () => {
    const dir = await dirWith({
      ".env": '# a comment\n\nHEX_NSEC="nsec1quoted"\nHEX_API_KEY=plain\n',
    });
    const env: NodeJS.ProcessEnv = {};
    await loadEnvFile(dir, undefined, env);
    expect(env.HEX_NSEC).toBe("nsec1quoted");
    expect(env.HEX_API_KEY).toBe("plain");
  });
});
