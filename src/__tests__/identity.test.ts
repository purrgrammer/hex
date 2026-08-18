import { describe, it, expect } from "vitest";
import type { NostrEvent } from "nostr-tools";
import {
  buildDmRelayTags,
  buildIdentityTemplates,
  buildProfileContent,
  buildRelayListTags,
  matchesPublished,
} from "../identity.js";
import { parseConfig } from "../config.js";

const config = parseConfig({
  identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
  brain: { type: "echo" },
  relays: {
    read: ["wss://read.example/", "wss://both.example/"],
    publish: ["wss://both.example/", "wss://write.example/"],
    dm: ["wss://inbox.example/"],
  },
  profile: { publish: true, name: "Hex", about: "grimoire assistant" },
  transports: [
    { type: "nip-29", groups: [{ relay: "wss://groups.example/", id: "dev" }] },
  ],
});

describe("buildProfileContent", () => {
  it("writes only the fields the config set, plus the bot flag", () => {
    expect(JSON.parse(buildProfileContent(config.profile))).toEqual({
      bot: true,
      name: "Hex",
      about: "grimoire assistant",
    });
  });

  it("declares itself a bot by default (NIP-24)", () => {
    // A client that dims or filters automated replies can only do so if the flag
    // is there, and a bot that must be configured into declaring itself is one
    // that ships undeclared.
    expect(JSON.parse(buildProfileContent({ publish: true }))).toEqual({
      bot: true,
    });
  });

  it("honours an explicit bot: false", () => {
    // A claim its operator is making, not a default anyone falls into.
    expect(
      JSON.parse(buildProfileContent({ publish: true, bot: false })),
    ).toEqual({ bot: false });
  });
});

describe("buildRelayListTags", () => {
  it("marks read-only and write-only relays, and leaves a both-roles relay bare", () => {
    // A bare `r` tag already means read and write; a read+write pair says it twice.
    expect(buildRelayListTags(config.relays)).toEqual([
      ["r", "wss://read.example/", "read"],
      ["r", "wss://both.example/"],
      ["r", "wss://write.example/", "write"],
    ]);
  });
});

describe("buildDmRelayTags", () => {
  it("announces exactly the dm role", () => {
    // Not read, not publish: a wrap delivered anywhere else never gets read.
    expect(buildDmRelayTags(config.relays)).toEqual([
      ["relay", "wss://inbox.example/"],
    ]);
  });
});

describe("matchesPublished", () => {
  const [profileTemplate] = buildIdentityTemplates(config, 1000);

  it("is false when nothing is published yet", () => {
    expect(matchesPublished(profileTemplate!, null)).toBe(false);
  });

  it("ignores created_at, id and sig", () => {
    // Otherwise every run is a rewrite of every replaceable.
    const published: NostrEvent = {
      id: "x",
      pubkey: "y",
      sig: "z",
      kind: 0,
      created_at: 5,
      content: profileTemplate!.content,
      tags: [],
    };
    expect(matchesPublished(profileTemplate!, published)).toBe(true);
  });

  it("is false when the content differs", () => {
    const published: NostrEvent = {
      id: "x",
      pubkey: "y",
      sig: "z",
      kind: 0,
      created_at: 5,
      content: JSON.stringify({ name: "Hexx" }),
      tags: [],
    };
    expect(matchesPublished(profileTemplate!, published)).toBe(false);
  });

  it("is false when the tags differ", () => {
    const relayTemplate = buildIdentityTemplates(config, 1000)[1]!;
    const published: NostrEvent = {
      id: "x",
      pubkey: "y",
      sig: "z",
      kind: 10002,
      created_at: 5,
      content: "",
      tags: [["r", "wss://elsewhere.example/"]],
    };
    expect(matchesPublished(relayTemplate, published)).toBe(false);
  });
});

describe("buildIdentityTemplates", () => {
  it("covers kind 0, 10002 and 10050 and nothing else", () => {
    expect(buildIdentityTemplates(config, 1000).map((t) => t.kind)).toEqual([
      0, 10002, 10050,
    ]);
  });
});
