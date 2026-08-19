/**
 * What a container can actually reach.
 *
 * `buildRunArgs` is a pure function precisely so this can be asserted on a machine
 * with no container runtime: the boundary is decided entirely by that argv, and
 * the claim being made — that the daemon's signing key is out of reach — is only
 * as true as the mounts and the environment in it.
 */

import { describe, it, expect } from "vitest";
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
      "HOME",
      "LANG",
      "TERM",
    ]);
  });

  it("carries no name that could hold a secret", () => {
    for (const entry of envs(args()))
      expect(entry).not.toMatch(/NSEC|API_KEY|SECRET|TOKEN|PASSWORD/i);
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
    expect(containerName("nip-17|abc#def'ghi")).toMatch(/^hex-[\w.-]+$/);
  });
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
