/**
 * `hex.config.json` — parsed and validated up front.
 *
 * Every failure here is a startup failure with a path in the message. A bot that
 * boots with a typo'd field and then answers nobody looks identical to a working
 * one, so unknown keys are errors and there are no silent defaults for anything
 * that decides whether Hex speaks or where it publishes.
 */

export type SignerConfig =
  | { type: "nsec"; env: string }
  | { type: "nsec"; file: string }
  | { type: "bunker"; uri: string; stateDir: string };

export interface BrainConfig {
  type: "openai-compatible" | "echo";
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  /** Extra headers, values read from env by name. */
  headerEnv?: Record<string, string>;
}

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

export type TransportConfig = {
  type: "nip-29";
  groups: Nip29GroupConfig[];
  autoJoin: boolean;
};

export interface HexConfig {
  identity: { signer: SignerConfig };
  /** Path to the instructions file, resolved against the config file's dir. */
  instructions?: string;
  /** Names Hex answers to, beyond a p-tag. */
  mentions: string[];
  brain: BrainConfig;
  relays: RelayRoles;
  profile: ProfileConfig;
  context: { messages: number };
  limits: { repliesPerRoomPerHour: number };
  transports: TransportConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`hex.config: ${message}`);
    this.name = "ConfigError";
  }
}

const DEFAULT_CONTEXT_MESSAGES = 40;
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

function parseBrain(value: unknown): BrainConfig {
  const brain = requireRecord(value, "brain");
  const type = requireString(brain.type, "brain.type");

  if (type === "echo") {
    rejectUnknown(brain, ["type"], "brain");
    return { type: "echo" };
  }

  if (type === "openai-compatible") {
    rejectUnknown(
      brain,
      ["type", "baseUrl", "model", "apiKeyEnv", "headerEnv"],
      "brain",
    );
    const headerEnvRaw = brain.headerEnv;
    let headerEnv: Record<string, string> | undefined;
    if (headerEnvRaw !== undefined) {
      const record = requireRecord(headerEnvRaw, "brain.headerEnv");
      headerEnv = {};
      for (const [header, envName] of Object.entries(record))
        headerEnv[header] = requireString(envName, `brain.headerEnv.${header}`);
    }
    return {
      type: "openai-compatible",
      baseUrl: requireString(brain.baseUrl, "brain.baseUrl"),
      model: requireString(brain.model, "brain.model"),
      apiKeyEnv: optionalString(brain.apiKeyEnv, "brain.apiKeyEnv"),
      headerEnv,
    };
  }

  throw new ConfigError(
    `brain.type must be "openai-compatible" or "echo" (got ${JSON.stringify(type)})`,
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
  return {
    publish: profile.publish,
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

function parseTransports(value: unknown): TransportConfig[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new ConfigError("transports must be a non-empty array");

  return value.map((entry, index) => {
    const path = `transports[${index}]`;
    const transport = requireRecord(entry, path);
    const type = requireString(transport.type, `${path}.type`);
    if (type !== "nip-29")
      throw new ConfigError(
        `${path}.type: only "nip-29" is implemented (got ${JSON.stringify(type)})`,
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
      "brain",
      "relays",
      "profile",
      "context",
      "limits",
      "transports",
    ],
    "config",
  );

  const identity = requireRecord(raw.identity, "identity");
  rejectUnknown(identity, ["signer"], "identity");

  const contextRaw = raw.context;
  const context =
    contextRaw === undefined
      ? { messages: DEFAULT_CONTEXT_MESSAGES }
      : (() => {
          const record = requireRecord(contextRaw, "context");
          rejectUnknown(record, ["messages"], "context");
          return {
            messages:
              record.messages === undefined
                ? DEFAULT_CONTEXT_MESSAGES
                : requirePositiveInt(record.messages, "context.messages"),
          };
        })();

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

  const config: HexConfig = {
    identity: { signer: parseSigner(identity.signer) },
    instructions: optionalString(raw.instructions, "instructions"),
    mentions: parseMentions(raw.mentions),
    brain: parseBrain(raw.brain),
    relays: parseRelays(raw.relays),
    profile: parseProfile(raw.profile),
    context,
    limits,
    transports: parseTransports(raw.transports),
  };

  if (config.profile.publish && config.relays.publish.length === 0)
    throw new ConfigError(
      "profile.publish is true but relays.publish is empty — there is nowhere to announce",
    );

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
