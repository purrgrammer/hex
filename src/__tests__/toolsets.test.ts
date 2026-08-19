/**
 * Who may ask Hex to do what, decided by config.
 *
 * These are the tests that matter most in the package now: a mistake here does
 * not silence the bot, it hands a shell to the wrong channel. Every case below
 * is a configuration a person would plausibly write.
 */

import { describe, it, expect } from "vitest";
import { parseConfig } from "../config.js";
import { toolsetFor } from "../grants.js";
import { grantCovers, filterTools, type ToolSpec } from "../tools/types.js";
import type { Inbound } from "../transports/types.js";

const PEER = "7fa56f5d6962ab1e3cd424e758c3002b8665f7b0d8dcee9fe9e288d7751ac194";
const STRANGER =
  "1111111111111111111111111111111111111111111111111111111111111111";

const base = {
  identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
  brain: { type: "echo" },
  relays: {
    read: ["wss://read.example"],
    publish: ["wss://write.example"],
    dm: ["wss://inbox.example"],
  },
  repos: [{ name: "grimoire", path: "/tmp/grimoire" }],
};

const coder = {
  tools: ["grimoire.*", "nostr.*", "repo.*"],
  repos: ["grimoire"],
  isolation: "host-worktree",
};

/** A config where the one allowed DM peer may run commands. */
const coding = {
  ...base,
  toolsets: { coder, reader: { tools: ["grimoire.help"] } },
  transports: [
    { type: "nip-17", allow: [{ pubkey: PEER, toolset: "coder" }] },
    {
      type: "nip-29",
      toolset: "reader",
      groups: [{ relay: "wss://groups.example", id: "dev" }],
    },
  ],
};

function dm(author: string): Inbound {
  return {
    id: "a".repeat(64),
    author,
    text: "hello",
    createdAt: 0,
    addressesSelf: true,
    room: { transport: "nip-17", id: `dm:${author}` },
    event: {} as Inbound["event"],
  };
}

function group(id: string, relay: string): Inbound {
  return {
    id: "b".repeat(64),
    author: PEER,
    text: "hex hello",
    createdAt: 0,
    addressesSelf: true,
    room: { transport: "nip-29", id, relay },
    event: {} as Inbound["event"],
  };
}

describe("toolset config", () => {
  it("gives a named peer their own toolset", () => {
    const config = parseConfig(coding);
    expect(toolsetFor(config, dm(PEER))?.name).toBe("coder");
  });

  it("falls back to the transport's toolset for a peer with none", () => {
    const config = parseConfig({
      ...coding,
      transports: [
        { type: "nip-17", toolset: "reader", allow: [PEER] },
        ...coding.transports.slice(1),
      ],
    });
    expect(toolsetFor(config, dm(PEER))?.name).toBe("reader");
  });

  it("gives someone off the allow list nothing at all", () => {
    // They should never reach the agent, but if they do, the answer is not
    // "whatever the transport grants everyone else".
    const config = parseConfig(coding);
    expect(toolsetFor(config, dm(STRANGER))).toBeUndefined();
  });

  it("resolves a group by relay AND id, not id alone", () => {
    const config = parseConfig(coding);
    expect(
      toolsetFor(config, group("dev", "wss://groups.example/"))?.name,
    ).toBe("reader");
    // Same id on a different relay is a different group entirely.
    expect(
      toolsetFor(config, group("dev", "wss://elsewhere.example/")),
    ).toBeUndefined();
  });

  it("refuses coding tools on a relay group", () => {
    // A group's membership is the relay's to change, so it can never be the
    // basis for handing out a shell.
    expect(() =>
      parseConfig({
        ...coding,
        transports: [
          { type: "nip-17", allow: [PEER] },
          {
            type: "nip-29",
            toolset: "coder",
            groups: [{ relay: "wss://groups.example", id: "dev" }],
          },
        ],
      }),
    ).toThrow(/NIP-17 only/);
  });

  it("refuses coding tools on one group of a transport, too", () => {
    expect(() =>
      parseConfig({
        ...coding,
        transports: [
          { type: "nip-17", allow: [PEER] },
          {
            type: "nip-29",
            groups: [
              { relay: "wss://groups.example", id: "dev", toolset: "coder" },
            ],
          },
        ],
      }),
    ).toThrow(/NIP-17 only/);
  });

  it("refuses a toolset that grants repo tools with nowhere to run them", () => {
    const { isolation, ...noIsolation } = coder;
    void isolation;
    expect(() =>
      parseConfig({ ...coding, toolsets: { coder: noIsolation } }),
    ).toThrow(/isolation/);
  });

  it("refuses a toolset that grants repo tools with no repos", () => {
    expect(() =>
      parseConfig({ ...coding, toolsets: { coder: { ...coder, repos: [] } } }),
    ).toThrow(/repos/);
  });

  it("refuses isolation on a toolset that cannot run anything", () => {
    expect(() =>
      parseConfig({
        ...coding,
        toolsets: { coder: { ...coder, tools: ["grimoire.help"] } },
      }),
    ).toThrow(/grants no repo tools/);
  });

  it("refuses a repo nobody declared", () => {
    expect(() =>
      parseConfig({
        ...coding,
        toolsets: { coder: { ...coder, repos: ["not-a-repo"] } },
      }),
    ).toThrow(/no repo named/);
  });

  it("refuses a tool id that does not exist", () => {
    // `nostr.request` parses, offers nothing, and reads at runtime as a model
    // that will not use its tools.
    expect(() =>
      parseConfig({
        ...coding,
        toolsets: { reader: { tools: ["nostr.request"] } },
      }),
    ).toThrow(/no tool matches/);
  });

  it("refuses a channel naming a toolset that was never declared", () => {
    expect(() =>
      parseConfig({
        ...coding,
        transports: [
          { type: "nip-17", allow: [{ pubkey: PEER, toolset: "ghost" }] },
        ],
      }),
    ).toThrow(/no toolset named/);
  });

  it("still accepts a bare pubkey in the allow list", () => {
    const config = parseConfig({
      ...base,
      transports: [{ type: "nip-17", allow: [PEER] }],
    });
    const [transport] = config.transports;
    expect(transport?.type === "nip-17" && transport.allow).toEqual([
      { pubkey: PEER },
    ]);
  });
});

describe("grants", () => {
  const specs = [
    { name: "chat.respond" },
    { name: "grimoire.help" },
    { name: "nostr.req" },
    { name: "repo.exec" },
  ] as ToolSpec[];

  it("matches an exact id and a whole namespace", () => {
    expect(grantCovers("nostr.req", "nostr.req")).toBe(true);
    expect(grantCovers("nostr.*", "nostr.resolve")).toBe(true);
    expect(grantCovers("nostr.*", "repo.exec")).toBe(false);
  });

  it("has no bare wildcard — a channel says which everything", () => {
    expect(grantCovers("*", "repo.exec")).toBe(false);
  });

  it("keeps only what was granted", () => {
    expect(filterTools(specs, ["grimoire.*"]).map((s) => s.name)).toEqual([
      "grimoire.help",
    ]);
    expect(filterTools(specs, []).length).toBe(0);
  });
});

describe("container isolation in config", () => {
  const container = {
    runtime: "docker",
    image: "node:26-bookworm",
    network: "open",
  };
  const containerCoder = { ...coder, isolation: "container" };
  const dmOnly = [
    { type: "nip-17", allow: [{ pubkey: PEER, toolset: "coder" }] },
  ];

  it("accepts it when there is a container section to run it in", () => {
    const config = parseConfig({
      ...coding,
      container,
      toolsets: { coder: containerCoder },
      transports: dmOnly,
    });
    expect(config.container?.image).toBe("node:26-bookworm");
    expect(config.toolsets.get("coder")?.isolation).toBe("container");
  });

  it("refuses a toolset that asks for a container nobody described", () => {
    // It would parse and then fail every command — the same silent
    // misconfiguration as a typo'd tool id, caught in the same place.
    expect(() =>
      parseConfig({
        ...coding,
        toolsets: { coder: containerCoder },
        transports: dmOnly,
      }),
    ).toThrow(/no top-level `container` section/);
  });

  it("lists both isolations when one is misspelled", () => {
    expect(() =>
      parseConfig({
        ...coding,
        container,
        toolsets: { coder: { ...coder, isolation: "sandbox" } },
        transports: dmOnly,
      }),
    ).toThrow(/host-worktree, container/);
  });

  it("requires an image, and never invents one", () => {
    expect(() =>
      parseConfig({
        ...coding,
        container: { runtime: "docker", network: "open" },
        toolsets: { coder: containerCoder },
        transports: dmOnly,
      }),
    ).toThrow(/container\.image/);
  });

  it("requires a network decision, with no default", () => {
    // It decides what the code can reach; a default would make that choice for
    // the operator in the one place it matters.
    expect(() =>
      parseConfig({
        ...coding,
        container: { runtime: "docker", image: "node:26" },
        toolsets: { coder: containerCoder },
        transports: dmOnly,
      }),
    ).toThrow(/container\.network/);
  });

  it("refuses a network mode it could not actually enforce", () => {
    // A domain allowlist with a container CLI alone is convention, not
    // enforcement — anything can connect by IP.
    expect(() =>
      parseConfig({
        ...coding,
        container: { ...container, network: "allowlist" },
        toolsets: { coder: containerCoder },
        transports: dmOnly,
      }),
    ).toThrow(/none, open/);
  });

  it("takes an absolute path as a runtime, so a missing one can be tested", () => {
    const config = parseConfig({
      ...coding,
      container: { ...container, runtime: "/opt/podman/bin/podman" },
      toolsets: { coder: containerCoder },
      transports: dmOnly,
    });
    expect(config.container?.runtime).toBe("/opt/podman/bin/podman");
  });

  it("refuses a runtime that is neither known nor a path", () => {
    expect(() =>
      parseConfig({
        ...coding,
        container: { ...container, runtime: "rocket" },
        toolsets: { coder: containerCoder },
        transports: dmOnly,
      }),
    ).toThrow(/docker, podman, nerdctl/);
  });

  it("still refuses coding tools on a relay group, container or not", () => {
    expect(() =>
      parseConfig({
        ...coding,
        container,
        toolsets: { coder: containerCoder },
        transports: [
          { type: "nip-17", allow: [PEER] },
          {
            type: "nip-29",
            toolset: "coder",
            groups: [{ relay: "wss://groups.example", id: "dev" }],
          },
        ],
      }),
    ).toThrow(/NIP-17 only/);
  });
});
