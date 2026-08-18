import { describe, it, expect } from "vitest";
import { parseConfig, parseConfigText, ConfigError } from "../config.js";

const minimal = {
  identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
  brain: { type: "echo" },
  relays: {
    read: ["wss://read.example"],
    publish: ["wss://write.example"],
    dm: ["wss://inbox.example"],
  },
  transports: [
    { type: "nip-29", groups: [{ relay: "wss://groups.example", id: "dev" }] },
  ],
};

describe("parseConfig", () => {
  it("accepts a minimal config and fills the optional defaults", () => {
    const config = parseConfig(minimal);
    expect(config.context.messages).toBe(40);
    expect(config.limits.repliesPerRoomPerHour).toBe(20);
    expect(config.mentions).toEqual([]);
    // No profile means Hex never touches its own metadata.
    expect(config.profile.publish).toBe(false);
    expect(config.transports[0]!.autoJoin).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A typo'd `mentions` silences the agent, so unknown keys are fatal.
    expect(() => parseConfig({ ...minimal, mention: ["hex"] })).toThrow(
      ConfigError,
    );
  });

  it("refuses a config with no brain", () => {
    const { brain, ...withoutBrain } = minimal;
    void brain;
    expect(() => parseConfig(withoutBrain)).toThrow(/brain/);
  });

  it("refuses an inline secret key", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        identity: { signer: { type: "nsec", value: "nsec1…" } },
      }),
    ).toThrow(/not a known option/);
  });

  it("refuses an nsec signer that names neither env nor file", () => {
    expect(() =>
      parseConfig({ ...minimal, identity: { signer: { type: "nsec" } } }),
    ).toThrow(/exactly one of/);
  });

  it("refuses an nsec signer that names both", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        identity: { signer: { type: "nsec", env: "A", file: "./key" } },
      }),
    ).toThrow(/exactly one of/);
  });

  it("requires a bunker signer to persist its client key", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        identity: {
          signer: { type: "bunker", uri: "bunker://abc?relay=wss://x" },
        },
      }),
    ).toThrow(/stateDir/);
  });

  it("requires a bunker URI, not any URL", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        identity: {
          signer: {
            type: "bunker",
            uri: "https://signer.example",
            stateDir: "./state",
          },
        },
      }),
    ).toThrow(/bunker:\/\//);
  });

  it("requires all three relay roles", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        relays: {
          read: ["wss://read.example"],
          publish: ["wss://write.example"],
        },
      }),
    ).toThrow(/relays\.dm/);
  });

  it("rejects a relay URL that is not a websocket", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        relays: { ...minimal.relays, read: ["https://read.example"] },
      }),
    ).toThrow(/ws:\/\/ or wss:\/\//);
  });

  it("allows ws:// — some groups run on one", () => {
    const config = parseConfig({
      ...minimal,
      relays: { ...minimal.relays, read: ["ws://localhost:7777"] },
    });
    expect(config.relays.read[0]).toContain("ws://localhost:7777");
  });

  it("requires both relay and id for a NIP-29 group", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        transports: [{ type: "nip-29", groups: [{ id: "dev" }] }],
      }),
    ).toThrow(/relay/);
  });

  it("does not lowercase a NIP-29 group id", () => {
    // `#h` is case-sensitive: Bitcoin and bitcoin are two rooms on one relay.
    const config = parseConfig({
      ...minimal,
      transports: [
        {
          type: "nip-29",
          groups: [{ relay: "wss://groups.example", id: "Bitcoin" }],
        },
      ],
    });
    expect(config.transports[0]!.groups[0]!.id).toBe("Bitcoin");
  });

  it("refuses a transport type it cannot serve", () => {
    expect(() =>
      parseConfig({ ...minimal, transports: [{ type: "nip-17" }] }),
    ).toThrow(/only "nip-29" is implemented/);
  });

  it("refuses profile.publish with no publish relays", () => {
    // parseRelayList already rejects an empty array, so this is the belt to its
    // braces: the invariant is stated where the reader looks for it.
    expect(() =>
      parseConfig({
        ...minimal,
        relays: { ...minimal.relays, publish: [] },
        profile: { publish: true, name: "Hex" },
      }),
    ).toThrow(/relays\.publish/);
  });

  it("reports invalid JSON as a config error", () => {
    expect(() => parseConfigText("{ not json")).toThrow(ConfigError);
  });
});
