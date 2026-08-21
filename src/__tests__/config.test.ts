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
      parseConfig({ ...minimal, transports: [{ type: "nip-04" }] }),
    ).toThrow(/must be "nip-29", "nip-17" or "concord"/);
  });

  it("refuses a Concord transport with no community", () => {
    expect(() =>
      parseConfig({ ...minimal, transports: [{ type: "concord" }] }),
    ).toThrow(/communities must be a non-empty array/);
  });

  it("reads a Concord community, its channels and who may invite Hex", () => {
    const community = "a".repeat(64);
    const channel = "b".repeat(64);
    const inviter = "c".repeat(64);
    const config = parseConfig({
      ...minimal,
      transports: [
        {
          type: "concord",
          communities: [
            { id: community, channels: [{ id: channel, name: "grimoire" }] },
          ],
          acceptInvitesFrom: [inviter],
        },
      ],
    });
    const [transport] = config.transports;
    expect(
      transport?.type === "concord" ? transport.communities : undefined,
    ).toMatchObject([{ id: community, channels: [{ id: channel }] }]);
    expect(
      transport?.type === "concord" ? transport.acceptInvitesFrom : undefined,
    ).toEqual([inviter]);
  });

  it("refuses a community or channel id that is not 32 bytes of hex", () => {
    // A mistyped id is an address nobody publishes to, which looks exactly like
    // a quiet room — so it is a startup failure instead.
    expect(() =>
      parseConfig({
        ...minimal,
        transports: [{ type: "concord", communities: [{ id: "nope" }] }],
      }),
    ).toThrow(/64-char hex community id/);
    expect(() =>
      parseConfig({
        ...minimal,
        transports: [
          {
            type: "concord",
            communities: [{ id: "a".repeat(64), channels: ["nope"] }],
          },
        ],
      }),
    ).toThrow(/64-char hex channel id/);
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

describe("policy rules", () => {
  it("is absent unless stated, so the compiled-in default applies", () => {
    expect(parseConfig(minimal).policy).toBeUndefined();
  });

  it("accepts a rule and decodes an npub peer", () => {
    const config = parseConfig({
      ...minimal,
      policy: [
        {
          types: ["message", "timer"],
          where: { transport: "nip-17", peer: "$turn-holder" },
          when: "in-turn",
          do: "steer",
        },
        { types: ["message"], where: { addressed: true }, do: "respond" },
        {
          types: ["message"],
          where: {
            peer: "npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m",
          },
          do: "collect",
        },
      ],
    });
    expect(config.policy?.[0]?.where?.peer).toBe("$turn-holder");
    expect(config.policy?.[1]?.when).toBeUndefined();
    // An npub is decoded here, so a rule and a route compare as one shape.
    expect(config.policy?.[2]?.where?.peer).toBe(
      "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2",
    );
  });

  it("refuses a rule that is not an array", () => {
    expect(() => parseConfig({ ...minimal, policy: {} })).toThrow(
      /policy must be an array/,
    );
  });

  it("refuses an unknown key on a rule and on its where", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [{ types: ["message"], do: "respond", unless: {} }],
      }),
    ).toThrow(/policy\[0\]\.unless is not a known option/);
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [{ types: ["message"], where: { kind: 9 }, do: "respond" }],
      }),
    ).toThrow(/policy\[0\]\.where\.kind is not a known option/);
  });

  it("refuses an event type this build does not know", () => {
    // A row naming an unknown type is ignored at runtime; a RULE naming one is
    // a typo someone expects to work, and silence is not a diagnosis.
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [{ types: ["mention"], do: "respond" }],
      }),
    ).toThrow(/not a known event type/);
  });

  it("refuses an empty types list", () => {
    expect(() =>
      parseConfig({ ...minimal, policy: [{ types: [], do: "respond" }] }),
    ).toThrow(/at least one event type/);
  });

  it("refuses an unknown disposition and an unknown when", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [{ types: ["message"], do: "reply" }],
      }),
    ).toThrow(/policy\[0\]\.do must be one of/);
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [{ types: ["message"], when: "busy", do: "respond" }],
      }),
    ).toThrow(/policy\[0\]\.when must be one of/);
  });

  it("refuses an unknown transport and a peer that is not a pubkey", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [
          { types: ["message"], where: { transport: "nip-4" }, do: "respond" },
        ],
      }),
    ).toThrow(/where\.transport must be one of/);
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [
          { types: ["message"], where: { peer: "alice" }, do: "respond" },
        ],
      }),
    ).toThrow(/where\.peer must be an npub or a 64-character hex pubkey/);
  });

  it("refuses a non-boolean predicate flag", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        policy: [
          { types: ["message"], where: { addressed: "yes" }, do: "respond" },
        ],
      }),
    ).toThrow(/where\.addressed must be a boolean/);
  });
});

/**
 * A limit nobody set is still a limit somebody pays for.
 *
 * `maxConcurrentTurns` used to default to "no cap", and no cap is one flood
 * away from a model run per speaker: lanes are per (peer, room), so fifty
 * people mentioning Hex at once is fifty simultaneous sessions. Nothing is
 * dropped by capping — the excess waits in its lane — so the cost of a default
 * is latency and the cost of no default is unbounded spend.
 */
describe("what a config that says nothing about limits means", () => {
  it("caps concurrent turns rather than leaving them unbounded", () => {
    const limits = parseConfig(minimal).limits;
    expect(limits.maxConcurrentTurns).toBeGreaterThan(0);
    expect(limits.repliesPerRoomPerHour).toBeGreaterThan(0);
  });

  it("still lets an operator raise it", () => {
    const raised = parseConfig({
      ...minimal,
      limits: { maxConcurrentTurns: 32 },
    }).limits;
    expect(raised.maxConcurrentTurns).toBe(32);
  });
});
