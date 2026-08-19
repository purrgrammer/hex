/**
 * What a container can actually reach.
 *
 * `buildRunArgs` is a pure function precisely so this can be asserted on a machine
 * with no container runtime: the boundary is decided entirely by that argv, and
 * the claim being made — that the daemon's signing key is out of reach — is only
 * as true as the mounts and the environment in it.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../tools/backends.js";
import { HexStore } from "../store.js";
import type { HexConfig } from "../config.js";
import {
  buildRunArgs,
  containerName,
  ContainerBackend,
  HOME_DIR,
  WORK_DIR,
} from "../tools/exec-container.js";
import type { ContainerConfig } from "../config.js";

const CONFIG: ContainerConfig = {
  runtime: "docker",
  image: "node:26-bookworm",
  network: "open",
};

const AGENT = "a".repeat(64);
const WORK = `/Users/someone/.hex/${AGENT}/clones/grimoire-abc123`;
const HOME = `/Users/someone/.hex/${AGENT}/caches/abc123/home`;

function args(config: ContainerConfig = CONFIG, command = "npm test") {
  return buildRunArgs(config, {
    name: "hex-test",
    work: WORK,
    home: HOME,
    agent: AGENT,
    workspace: "nip-17|peer",
    command,
    uid: 501,
    gid: 20,
  });
}

/** The `-v` pairs, as they would be handed to the runtime. */
function mounts(argv: string[]): string[] {
  return argv.flatMap((arg, index) => (arg === "-v" ? [argv[index + 1]] : []));
}

function envs(argv: string[]): string[] {
  return argv.flatMap((arg, index) => (arg === "-e" ? [argv[index + 1]] : []));
}

describe("what is mounted", () => {
  it("mounts exactly the checkout and the conversation's own home", () => {
    expect(mounts(args())).toEqual([
      `${WORK}:${WORK_DIR}`,
      `${HOME}:${HOME_DIR}`,
    ]);
  });

  it("never mounts the agent's own directory, its key, or its memory", () => {
    // The whole claim of this backend in one assertion. `~/.hex/<pubkey>` holds
    // data.db and sits beside the .env with the nsec in it, so any argument
    // naming it — rather than a subdirectory of clones/ or caches/ — is a leak.
    const argv = args();
    for (const mount of mounts(argv)) {
      expect(mount).not.toMatch(/\.env/);
      expect(mount).not.toMatch(/data\.db/);
      expect(
        mount.startsWith(`/Users/someone/.hex/${AGENT}/clones/`) ||
          mount.startsWith(`/Users/someone/.hex/${AGENT}/caches/`),
      ).toBe(true);
    }
  });

  it("never mounts the docker socket", () => {
    // That is root on the host wearing a container costume.
    expect(args().join(" ")).not.toContain("docker.sock");
  });

  it("does not tell the command where on the host it is", () => {
    // The working directory the model sees is `/work`, so an error it reports is
    // portable and it never learns the operator's home layout.
    const argv = args();
    expect(argv[argv.indexOf("-w") + 1]).toBe(WORK_DIR);
  });
});

describe("the environment inside", () => {
  it("is a fixed list, not the daemon's environment filtered", () => {
    expect(
      envs(args())
        .map((entry) => entry.split("=")[0])
        .sort(),
    ).toEqual([
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "HOME",
      "LANG",
      "TERM",
    ]);
  });

  it("carries no name that could hold a secret", () => {
    for (const entry of envs(args()))
      expect(entry).not.toMatch(/NSEC|API_KEY|SECRET|TOKEN|PASSWORD/i);
  });

  it("tells git the checkout is safe, or every git command refuses", () => {
    // The mount root arrives root-owned while its contents are the host uid, so
    // git calls it dubious ownership and refuses to read the repository at all.
    const entries = envs(args());
    expect(entries).toContain("GIT_CONFIG_KEY_0=safe.directory");
    expect(entries).toContain(`GIT_CONFIG_VALUE_0=${WORK_DIR}`);
  });

  it("gives git an identity, or every task fails on its last step", () => {
    // A container has no ~/.gitconfig, and `git commit` refuses without one.
    const entries = envs(args());
    expect(entries).toContain("GIT_AUTHOR_NAME=Hex");
    expect(entries).toContain("GIT_COMMITTER_EMAIL=hex@localhost");
  });
});

describe("how it is confined", () => {
  it("drops capabilities, refuses privilege escalation, and caps processes", () => {
    const argv = args();
    expect(argv[argv.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(argv[argv.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(argv).toContain("--pids-limit");
  });

  it("runs as the host user so the operator can edit what Hex wrote", () => {
    expect(args()[args().indexOf("--user") + 1]).toBe("501:20");
  });

  it("removes itself and reaps zombies", () => {
    expect(args()).toContain("--rm");
    expect(args()).toContain("--init");
  });

  it("labels itself so a leftover can be found and swept", () => {
    expect(args()).toContain(`hex.agent=${AGENT}`);
  });

  it("turns network off when told to, and does not pretend to allowlist", () => {
    const off = args({ ...CONFIG, network: "none" });
    expect(off[off.indexOf("--network") + 1]).toBe("none");
    const on = args();
    expect(on[on.indexOf("--network") + 1]).toBe("bridge");
  });

  it("passes memory and cpu ceilings only when configured", () => {
    expect(args()).not.toContain("--memory");
    const capped = args({ ...CONFIG, memory: "4g", cpus: "2" });
    expect(capped[capped.indexOf("--memory") + 1]).toBe("4g");
    expect(capped[capped.indexOf("--cpus") + 1]).toBe("2");
  });

  it("runs the command last, through bash, unaltered", () => {
    const argv = args(CONFIG, "npm test -- --run 'a b'");
    expect(argv.slice(-3)).toEqual(["bash", "-lc", "npm test -- --run 'a b'"]);
    expect(argv[argv.length - 4]).toBe(CONFIG.image);
  });
});

describe("naming", () => {
  it("strips whatever a room key contains that a container name may not", () => {
    // Room keys carry `|`, `'` and `#`; a container name allows none of them.
    expect(containerName("nip-17|abc#def'ghi", 1)).toMatch(/^hex-[\w.-]+$/);
  });

  it("never gives the mount probe the same name as the command it precedes", () => {
    // It used to, for every real room key: the name was the id truncated to a
    // legal length, and a key is `nip-17|<64 hex>-<repo>` — so the repo and the
    // `-probe` suffix both fell off the end and the two names came out identical.
    // `onFinish` fires `rm -f <name>` without awaiting it, so a shared name is the
    // probe's removal racing the operator's first command.
    const id = `nip-17|${"a".repeat(64)}-grimoire`;
    expect(containerName(id, 1, true)).not.toBe(containerName(id, 2));
  });

  it("gives two commands in one workspace different names", () => {
    // Same reason, the sequential case: the previous container's `rm -f` is still
    // in flight when the next `run --name` starts, and the runtime refuses a name
    // already in use.
    const id = `nip-17|${"b".repeat(64)}-grimoire`;
    expect(containerName(id, 1)).not.toBe(containerName(id, 2));
  });

  it("still distinguishes two repos in one conversation", () => {
    // The repo name is past the length a readable name could carry, so it has to
    // reach the name through the digest or not at all.
    const workspace = `nip-17|${"c".repeat(64)}`;
    expect(containerName(`${workspace}-grimoire`, 1)).not.toBe(
      containerName(`${workspace}-otherrepo`, 1),
    );
  });
});

describe("the container's home", () => {
  it("exists before it is mounted", async () => {
    // A `-v` source that does not exist is not an error: the daemon CREATES it,
    // and on Linux it creates it as root — while the container runs as the
    // operator's uid, so `/home/hex` comes up unwritable and `npm install` dies
    // on EACCES against its own cache. Invisible on macOS, where Docker Desktop
    // creates the path through the file-sharing layer as the user.
    const root = await mkdtemp(join(tmpdir(), "hex-home-"));
    const home = join(root, "caches", "deadbeef", "home");
    const backend = new ContainerBackend({
      config: { ...CONFIG, runtime: "/nonexistent/docker" },
      agent: AGENT,
      mountFor: () => WORK,
      homeFor: () => home,
    });
    try {
      // Past the mount probe, so the missing runtime is the only thing that
      // fails — and it fails after the directory is made, which is the point.
      await backend.run(
        {
          id: "nip-17|peer-grimoire",
          command: "true",
          cwd: WORK,
          timeoutMs: 5_000,
        },
        { skipMountCheck: true },
      );
      expect(existsSync(home)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("is named by digest, so no room key reaches a host path", async () => {
    // A room key carries a transport, a relay URL and a group id, and a `-v` spec
    // is colon-delimited with at most three fields — so `wss://…` in the source
    // path is a mount the runtime rejects. `checkMount` would then report it as a
    // file-sharing problem with the checkout, which mounts fine. Coding tools are
    // refused outside NIP-17 at parse time, so this is the belt to that brace: the
    // path is built from a key whose shape Hex does not choose.
    const root = await mkdtemp(join(tmpdir(), "hex-runner-"));
    const store = HexStore.open(join(root, "data.db"));
    try {
      const runner = createRunner("container", {
        config: {
          container: CONFIG,
          repos: [{ name: "grimoire", path: join(root, "repo") }],
        } as unknown as HexConfig,
        store,
        home: { dir: root, worktrees: join(root, "worktrees") },
        agent: AGENT,
      });
      await (runner.backend as ContainerBackend).run(
        {
          id: "nip-29|wss://groups.example.invalid/|grp-grimoire",
          command: "true",
          cwd: WORK,
          timeoutMs: 5_000,
        },
        { skipMountCheck: true },
      );
      const caches = join(root, "caches");
      const made = readdirSync(caches);
      expect(made).toHaveLength(1);
      expect(made[0]).not.toContain(":");
      expect(made[0]).not.toContain("/");
      expect(existsSync(join(caches, made[0], "home"))).toBe(true);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("failing loudly", () => {
  it("reports a runtime that is not there, rather than falling back", async () => {
    // The guarantee is not "we chose not to fall back" but "there is nothing to
    // fall back to" — this is the path an operator hits with no Docker installed.
    const backend = new ContainerBackend({
      config: { ...CONFIG, runtime: "/nonexistent/docker" },
      agent: AGENT,
      mountFor: () => WORK,
      homeFor: () => HOME,
    });
    await expect(backend.preflight()).rejects.toThrow(/nonexistent\/docker/);
  });
});
