import { describe, it, expect } from "vitest";
import { parseConfig, parseConfigText, ConfigError } from "../config.js";

const minimal = {
  identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
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
    expect(config.limits.repliesPerRoomPerHour).toBe(20);
    expect(config.mentions).toEqual([]);
    // No profile means Hex never touches its own metadata.
    expect(config.profile.publish).toBe(false);
    const [transport] = config.transports;
    expect(transport?.type === "nip-29" && transport.autoJoin).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A typo'd `mentions` silences the agent, so unknown keys are fatal.
    expect(() => parseConfig({ ...minimal, mention: ["hex"] })).toThrow(
      ConfigError,
    );
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
    const [transport] = config.transports;
    expect(
      transport?.type === "nip-29" ? transport.groups[0]!.id : undefined,
    ).toBe("Bitcoin");
  });

  it("refuses a transport type it cannot serve", () => {
    expect(() =>
      parseConfig({ ...minimal, transports: [{ type: "concord" }] }),
    ).toThrow(/must be "nip-29" or "nip-17"/);
  });

  it("refuses a DM transport with nobody allowed", () => {
    // A private message needs no mention to be addressed, so an empty allow list
    // is an open inbox — and an open invitation to spend the operator's tokens.
    expect(() =>
      parseConfig({ ...minimal, transports: [{ type: "nip-17", allow: [] }] }),
    ).toThrow(/an empty gate is an open one/);
  });

  it("takes npubs in the allow list and stores them as hex", () => {
    const config = parseConfig({
      ...minimal,
      transports: [
        {
          type: "nip-17",
          allow: [
            "npub107jk7htfv243u0x5ynn43scq9wrxtaasmrwwa8lfu2ydwag6cx2quqncxg",
          ],
        },
      ],
    });
    const [transport] = config.transports;
    expect(transport?.type === "nip-17" && transport.allow[0]?.pubkey).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("refuses something that is neither an npub nor a hex key", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        transports: [{ type: "nip-17", allow: ["alice@example.com"] }],
      }),
    ).toThrow(/npub or a 64-character hex pubkey/);
  });

  it("refuses profile.publish with no profile fields", () => {
    // It would build `{}` and replace whatever kind 0 that npub had. A kind 0 is
    // replaceable; nothing brings the old one back.
    expect(() =>
      parseConfig({ ...minimal, profile: { publish: true } }),
    ).toThrow(/no profile fields/);
  });

  it("allows profile.publish false with no fields", () => {
    // "managed elsewhere" is a legitimate configuration.
    expect(
      parseConfig({ ...minimal, profile: { publish: false } }).profile,
    ).toEqual({ publish: false });
  });

  it("takes bot as a boolean and refuses anything else", () => {
    expect(
      parseConfig({ ...minimal, profile: { publish: true, bot: false } })
        .profile.bot,
    ).toBe(false);
    expect(() =>
      parseConfig({ ...minimal, profile: { publish: true, bot: "yes" } }),
    ).toThrow(/profile\.bot/);
  });

  it("refuses an empty publish role outright", () => {
    // There is nowhere to announce, and nowhere to send anything else either.
    expect(() =>
      parseConfig({ ...minimal, relays: { ...minimal.relays, publish: [] } }),
    ).toThrow(/relays\.publish/);
  });

  it("reports invalid JSON as a config error", () => {
    expect(() => parseConfigText("{ not json")).toThrow(ConfigError);
  });
});

describe("transcript and eve sections", () => {
  const OPERATOR = "1".repeat(64);

  it("is absent unless configured — publishing is never a default", () => {
    // An agent that starts mailing its conversations because it was upgraded has
    // leaked one nobody asked it to send.
    expect(parseConfig(minimal).transcript).toBeUndefined();
    expect(parseConfig(minimal).eve).toBeUndefined();
  });

  it("fills the defaults a recipient list implies", () => {
    const config = parseConfig({
      ...minimal,
      transcript: { to: [OPERATOR] },
    });
    expect(config.transcript).toEqual({
      to: [OPERATOR],
      slug: "hex",
      deltas: true,
      announce: true,
    });
  });

  it("refuses a transcript with nobody to read it", () => {
    expect(() => parseConfig({ ...minimal, transcript: { to: [] } })).toThrow(
      /at least one recipient/,
    );
  });

  it("refuses an eve host that is not a URL", () => {
    // A host the URL parser cannot read follows nothing and says nothing.
    expect(() =>
      parseConfig({ ...minimal, eve: { host: "127.0.0.1:2000" } }),
    ).toThrow(/must be a URL/);
    expect(
      parseConfig({ ...minimal, eve: { host: "http://127.0.0.1:2000" } }).eve,
    ).toEqual({ host: "http://127.0.0.1:2000" });
  });
});
