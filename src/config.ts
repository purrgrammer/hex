/**
 * `hex.config.json` — parsed and validated up front.
 *
 * Every failure here is a startup failure with a path in the message. A bot that
 * boots with a typo'd field and then answers nobody looks identical to a working
 * one, so unknown keys are errors and there are no silent defaults for anything
 * that decides whether Hex speaks or where it publishes.
 */

import { nip19 } from "nostr-tools";

export type SignerConfig =
  | { type: "nsec"; env: string }
  | { type: "nsec"; file: string }
  | { type: "bunker"; uri: string; stateDir: string };

export interface RelayRoles {
  /** Lookups: kind 0, metadata, anything Hex reads that is not a transport. */
  read: string[];
  /** Hex's own outbox: kind 0, 10002, 10050. Never a group message. */
  publish: string[];
  /** NIP-17 inbox. Exactly what kind 10050 announces. */
  dm: string[];
}

export interface ProfileConfig {
  publish: boolean;
  /**
   * NIP-24 `bot`: the content is the result of automation.
   *
   * Defaults to TRUE, because that is what this package builds. Someone reading a
   * room deserves to know a reply came from a machine, and a bot that has to be
   * configured into declaring itself is one that will ship undeclared.
   */
  bot?: boolean;
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
}

export interface Nip29GroupConfig {
  relay: string;
  id: string;
}

/** Someone allowed to DM Hex. */
export interface Nip17PeerConfig {
  pubkey: string;
}

/**
 * Publish what an agent did, to the people named here (NIP-xx: Agent Sessions).
 *
 * Absent means nothing is published. Opt-in deliberately: an agent that starts
 * mailing its transcripts because it was upgraded is one that leaked a
 * conversation nobody asked it to send.
 */
export interface TranscriptConfig {
  /** Who receives it. Hex keeps a copy in its own inbox regardless. */
  to: string[];
  /** The `d` tag of the agent's definition. Defaults to `hex`. */
  slug: string;
  /**
   * Stream progress as it happens, on wraps a relay must not store.
   *
   * On by default: without it a watcher sees nothing until a turn finishes, and
   * a turn that runs a build takes minutes.
   */
  deltas: boolean;
  /** Publish the kind-31779 definition at startup. */
  announce: boolean;
}

/**
 * Where the Eve runtime answers.
 *
 * A session's events are read from `<host>/eve/v1/session/<id>/stream`. No
 * default: a publisher that guesses the port silently follows nothing.
 */
export interface EveConfig {
  host: string;
}

export type TransportConfig =
  | {
      type: "nip-29";
      groups: Nip29GroupConfig[];
      autoJoin: boolean;
    }
  | {
      type: "nip-17";
      /**
       * Who may DM Hex, as hex pubkeys (npubs are accepted and decoded).
       *
       * Required and non-empty. A private message needs no mention to be
       * addressed, so this list is the only gate there is — an open inbox is an
       * open invitation to spend the operator's tokens, and to ask for code to
       * be run.
       */
      allow: Nip17PeerConfig[];
    };

export interface StateConfig {
  /**
   * Where agents keep their homes. Defaults to `~/.hex`.
   *
   * Each agent gets `<home>/<pubkey>/` with its own `data.db`, so two agents on
   * one machine share nothing and two configs for one key share a memory.
   */
  home?: string;
}

export interface HexConfig {
  identity: { signer: SignerConfig };
  /** Path to the instructions file, resolved against the config file's dir. */
  instructions?: string;
  /** Names Hex answers to, beyond a p-tag. */
  mentions: string[];
  relays: RelayRoles;
  profile: ProfileConfig;
  limits: { repliesPerRoomPerHour: number };
  state: StateConfig;
  transcript?: TranscriptConfig;
  eve?: EveConfig;
  transports: TransportConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`hex.config: ${message}`);
    this.name = "ConfigError";
  }
}

const DEFAULT_REPLIES_PER_HOUR = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigError(`${path} must be an object`);
  return value;
}

/** Unknown keys are typos, and a typo'd `mentions` is a silent agent. */
function rejectUnknown(
  value: Record<string, unknown>,
  known: string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key))
      throw new ConfigError(
        `${path}.${key} is not a known option (expected one of: ${known.join(", ")})`,
      );
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ConfigError(`${path} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path);
}

function requirePositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new ConfigError(`${path} must be a positive integer`);
  return value;
}

/**
 * Relay URLs, normalized enough to compare. A `ws://` relay is allowed — some
 * groups run on one — but anything that is not a websocket URL is a mistake
 * worth failing on.
 */
function parseRelayList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new ConfigError(`${path} must be a non-empty array of relay URLs`);
  return value.map((entry, index) => {
    const raw = requireString(entry, `${path}[${index}]`);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConfigError(`${path}[${index}] is not a valid URL: ${raw}`);
    }
    if (url.protocol !== "wss:" && url.protocol !== "ws:")
      throw new ConfigError(
        `${path}[${index}] must be a ws:// or wss:// URL: ${raw}`,
      );
    return url.toString();
  });
}

function parseSigner(value: unknown): SignerConfig {
  const signer = requireRecord(value, "identity.signer");
  const type = requireString(signer.type, "identity.signer.type");

  if (type === "nsec") {
    rejectUnknown(signer, ["type", "env", "file"], "identity.signer");
    const env = optionalString(signer.env, "identity.signer.env");
    const file = optionalString(signer.file, "identity.signer.file");
    if ((env && file) || (!env && !file))
      throw new ConfigError(
        "identity.signer needs exactly one of `env` or `file` — a secret key is never inline in the config",
      );
    return env ? { type: "nsec", env } : { type: "nsec", file: file! };
  }

  if (type === "bunker") {
    rejectUnknown(signer, ["type", "uri", "stateDir"], "identity.signer");
    const uri = requireString(signer.uri, "identity.signer.uri");
    if (!uri.startsWith("bunker://"))
      throw new ConfigError("identity.signer.uri must be a bunker:// URI");
    // The client keypair has to survive a restart or every boot re-pairs.
    const stateDir = requireString(signer.stateDir, "identity.signer.stateDir");
    return { type: "bunker", uri, stateDir };
  }

  throw new ConfigError(
    `identity.signer.type must be "nsec" or "bunker" (got ${JSON.stringify(type)})`,
  );
}

function parseRelays(value: unknown): RelayRoles {
  const relays = requireRecord(value, "relays");
  rejectUnknown(relays, ["read", "publish", "dm"], "relays");
  return {
    read: parseRelayList(relays.read, "relays.read"),
    publish: parseRelayList(relays.publish, "relays.publish"),
    dm: parseRelayList(relays.dm, "relays.dm"),
  };
}

function parseProfile(value: unknown): ProfileConfig {
  if (value === undefined) return { publish: false };
  const profile = requireRecord(value, "profile");
  rejectUnknown(
    profile,
    [
      "publish",
      "bot",
      "name",
      "display_name",
      "about",
      "picture",
      "banner",
      "website",
      "nip05",
      "lud16",
    ],
    "profile",
  );
  if (typeof profile.publish !== "boolean")
    throw new ConfigError("profile.publish must be a boolean");

  // `publish: true` with no fields builds `{}` and replaces whatever profile
  // that npub had — a kind 0 is replaceable, so the old one is gone from every
  // relay that honours the replacement. Nothing recovers it.
  const fields = Object.keys(profile).filter((key) => key !== "publish");
  if (profile.publish && fields.length === 0)
    throw new ConfigError(
      "profile.publish is true but no profile fields are set — that would replace Hex's kind 0 with an empty one",
    );

  if (profile.bot !== undefined && typeof profile.bot !== "boolean")
    throw new ConfigError("profile.bot must be a boolean");

  return {
    publish: profile.publish,
    bot: profile.bot,
    name: optionalString(profile.name, "profile.name"),
    display_name: optionalString(profile.display_name, "profile.display_name"),
    about: optionalString(profile.about, "profile.about"),
    picture: optionalString(profile.picture, "profile.picture"),
    banner: optionalString(profile.banner, "profile.banner"),
    website: optionalString(profile.website, "profile.website"),
    nip05: optionalString(profile.nip05, "profile.nip05"),
    lud16: optionalString(profile.lud16, "profile.lud16"),
  };
}

/** An npub or a hex pubkey, as hex. */
function parsePubkey(value: unknown, path: string): string {
  const raw = requireString(value, path);
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  if (raw.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type === "npub") return decoded.data;
    } catch {
      // Falls through to the error below, which names the field.
    }
  }
  throw new ConfigError(`${path} must be an npub or a 64-character hex pubkey`);
}

function parseTranscript(value: unknown): TranscriptConfig | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "transcript");

  const to = record.to;
  if (!Array.isArray(to) || to.length === 0)
    throw new ConfigError(
      "transcript.to must name at least one recipient — a transcript with nobody to read it is work for nothing",
    );

  return {
    to: to.map((entry, index) => parsePubkey(entry, `transcript.to[${index}]`)),
    slug:
      record.slug === undefined
        ? "hex"
        : requireString(record.slug, "transcript.slug"),
    deltas: record.deltas === undefined ? true : record.deltas === true,
    announce: record.announce === undefined ? true : record.announce === true,
  };
}

function parseEve(value: unknown): EveConfig | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "eve");
  const host = requireString(record.host, "eve.host");
  try {
    new URL(host);
  } catch {
    throw new ConfigError(`eve.host must be a URL, not "${host}"`);
  }
  return { host };
}

function parseTransports(value: unknown): TransportConfig[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new ConfigError("transports must be a non-empty array");

  return value.map((entry, index) => {
    const path = `transports[${index}]`;
    const transport = requireRecord(entry, path);
    const type = requireString(transport.type, `${path}.type`);

    if (type === "nip-17") {
      rejectUnknown(transport, ["type", "allow"], path);
      const allowRaw = transport.allow;
      if (!Array.isArray(allowRaw) || allowRaw.length === 0)
        throw new ConfigError(
          `${path}.allow must list who may DM Hex — an empty gate is an open one`,
        );
      return {
        type: "nip-17" as const,
        allow: allowRaw.map((who, i) => {
          const wherePeer = `${path}.allow[${i}]`;
          if (typeof who === "string")
            return { pubkey: parsePubkey(who, wherePeer) };
          const peer = requireRecord(who, wherePeer);
          rejectUnknown(peer, ["pubkey"], wherePeer);
          return { pubkey: parsePubkey(peer.pubkey, `${wherePeer}.pubkey`) };
        }),
      };
    }

    if (type !== "nip-29")
      throw new ConfigError(
        `${path}.type must be "nip-29" or "nip-17" (got ${JSON.stringify(type)})`,
      );
    rejectUnknown(transport, ["type", "groups", "autoJoin"], path);

    const groupsRaw = transport.groups;
    if (!Array.isArray(groupsRaw) || groupsRaw.length === 0)
      throw new ConfigError(`${path}.groups must be a non-empty array`);

    const groups = groupsRaw.map((groupRaw, groupIndex) => {
      const groupPath = `${path}.groups[${groupIndex}]`;
      const group = requireRecord(groupRaw, groupPath);
      rejectUnknown(group, ["relay", "id"], groupPath);
      // A group id is only unique within its relay, so both are required and
      // the pair travels together everywhere downstream.
      return {
        relay: parseRelayList([group.relay], `${groupPath}.relay`)[0],
        id: requireString(group.id, `${groupPath}.id`),
      };
    });

    const autoJoin = transport.autoJoin ?? false;
    if (typeof autoJoin !== "boolean")
      throw new ConfigError(`${path}.autoJoin must be a boolean`);

    return { type: "nip-29" as const, groups, autoJoin };
  });
}

function parseMentions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ConfigError("mentions must be an array of strings");
  return value.map((entry, index) =>
    requireString(entry, `mentions[${index}]`),
  );
}

/** Validate a parsed JSON object into a `HexConfig`. */
export function parseConfig(input: unknown): HexConfig {
  const raw = requireRecord(input, "config");
  rejectUnknown(
    raw,
    [
      "identity",
      "instructions",
      "mentions",
      "relays",
      "profile",
      "limits",
      "state",
      "transcript",
      "eve",
      "transports",
    ],
    "config",
  );

  const identity = requireRecord(raw.identity, "identity");
  rejectUnknown(identity, ["signer"], "identity");

  const limitsRaw = raw.limits;
  const limits =
    limitsRaw === undefined
      ? { repliesPerRoomPerHour: DEFAULT_REPLIES_PER_HOUR }
      : (() => {
          const record = requireRecord(limitsRaw, "limits");
          rejectUnknown(record, ["repliesPerRoomPerHour"], "limits");
          return {
            repliesPerRoomPerHour:
              record.repliesPerRoomPerHour === undefined
                ? DEFAULT_REPLIES_PER_HOUR
                : requirePositiveInt(
                    record.repliesPerRoomPerHour,
                    "limits.repliesPerRoomPerHour",
                  ),
          };
        })();

  const stateRaw = raw.state;
  let state: StateConfig = {};
  if (stateRaw !== undefined) {
    const record = requireRecord(stateRaw, "state");
    rejectUnknown(record, ["home"], "state");
    state = { home: optionalString(record.home, "state.home") };
  }

  const config: HexConfig = {
    identity: { signer: parseSigner(identity.signer) },
    instructions: optionalString(raw.instructions, "instructions"),
    mentions: parseMentions(raw.mentions),
    relays: parseRelays(raw.relays),
    profile: parseProfile(raw.profile),
    limits,
    state,
    transcript: parseTranscript(raw.transcript),
    eve: parseEve(raw.eve),
    transports: parseTransports(raw.transports),
  };

  // `relays.publish` cannot be empty — `parseRelayList` already refused that —
  // so the only cross-field check worth making here is the one `parseProfile`
  // cannot see on its own. There is none yet; the profile-field check lives
  // there, where the fields are.
  return config;
}

/** Parse a config file's text. Kept separate from IO so tests need no disk. */
export function parseConfigText(text: string): HexConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseConfig(json);
}
