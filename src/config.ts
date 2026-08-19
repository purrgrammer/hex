/**
 * `hex.config.json` — parsed and validated up front.
 *
 * Every failure here is a startup failure with a path in the message. A bot that
 * boots with a typo'd field and then answers nobody looks identical to a working
 * one, so unknown keys are errors and there are no silent defaults for anything
 * that decides whether Hex speaks or where it publishes.
 */

import { nip19 } from "nostr-tools";
import { grantCovers, KNOWN_TOOLS } from "./tools/types.js";

export type SignerConfig =
  | { type: "nsec"; env: string }
  | { type: "nsec"; file: string }
  | { type: "bunker"; uri: string; stateDir: string };

export interface BrainConfig {
  type: "openai-compatible" | "echo";
  /** e.g. `https://api.openai.com/v1`. Any chat-completions endpoint. */
  baseUrl?: string;
  model?: string;
  /** Name of the env var holding the key — never the key itself. */
  apiKeyEnv?: string;
  /** Extra headers, values read from env by name. */
  headerEnv?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  /** Round trips the model gets per turn, including the one that answers. */
  maxSteps?: number;
  /** `required` makes the model call a tool rather than answering in prose. */
  toolChoice?: "auto" | "required";
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

/**
 * Where a channel's work actually runs.
 *
 * Only one value today, and it is named rather than implied so that a config
 * asking for something stronger fails loudly instead of quietly getting less
 * than it asked for. `host-worktree` runs commands as the user who started the
 * daemon, in a git worktree of the named repo: fast, shares the operator's
 * toolchain, and offers no protection — anything it runs can read the daemon's
 * own secrets off disk. That is the trade, made deliberately.
 */
export type Isolation = "host-worktree" | "container";

/** Isolation values a config may name, so the error can list them. */
export const ISOLATIONS: readonly Isolation[] = ["host-worktree", "container"];

/**
 * What a container may reach.
 *
 * Required, with no default, because it is the decision that matters: `open`
 * lets `npm install` work and lets an injected model fetch a payload; `none` is
 * kernel-enforced and breaks installs. There is deliberately no domain
 * allowlist — with a container CLI alone that is convention, not enforcement,
 * since anything can connect by IP. The honest version is an internal network
 * plus a proxy that allowlists CONNECT, which is its own piece of work.
 */
export type ContainerNetwork = "none" | "open";

export const CONTAINER_NETWORKS: readonly ContainerNetwork[] = ["none", "open"];

/** Runtimes that speak enough of the Docker CLI for what this uses. */
export const CONTAINER_RUNTIMES = ["docker", "podman", "nerdctl"] as const;

export interface ContainerConfig {
  /** `docker` | `podman` | `nerdctl`, or an absolute path to the binary. */
  runtime: string;
  /**
   * Required, and never built by Hex.
   *
   * `node:26-bookworm` matches this repo's `.nvmrc` and already carries git and
   * a build toolchain — the `-slim` tags do not have git. Building from a shipped
   * Dockerfile would make image builds a subsystem Hex has to own, and would pay
   * for it at the first command of a conversation.
   */
  image: string;
  network: ContainerNetwork;
  /** `--memory`, e.g. `4g`. */
  memory?: string;
  /** `--cpus`, e.g. `2`. */
  cpus?: string;
  pidsLimit?: number;
}

/**
 * What one channel is allowed to do.
 *
 * Named at the top level and referenced by channels, because the interesting
 * property is that two channels share a set — "these rooms get the read tools,
 * this one DM gets the coding tools" — and a set spelled out twice drifts.
 */
export interface ToolsetConfig {
  /** The key it was declared under, for error messages and logs. */
  name: string;
  /** Tool ids or whole namespaces (`nostr.*`). `chat.*` is always present. */
  tools: string[];
  /** Repos this channel may work in, by `repos[].name`. */
  repos: string[];
  isolation?: Isolation;
  /** Wall-clock ceiling for one command. */
  execTimeoutMinutes?: number;
}

export interface Nip29GroupConfig {
  relay: string;
  id: string;
  /** Overrides the transport's, for this group only. */
  toolset?: string;
}

/** Someone allowed to DM Hex, and what they may ask it to do. */
export interface Nip17PeerConfig {
  pubkey: string;
  /** Overrides the transport's, for this person only. */
  toolset?: string;
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
      /** Default for every group that does not name its own. */
      toolset?: string;
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
      /** Default for every peer that does not name their own. */
      toolset?: string;
    };

/**
 * A repository Hex can work in.
 *
 * Named in config for now: the channel-to-repo link lives elsewhere and this
 * package does not read it yet.
 */
export interface RepoConfig {
  /** What people call it: `grimoire`. */
  name: string;
  /** An existing clone on this machine, worked in through git worktrees. */
  path: string;
  /** Branch new work starts from. Defaults to the clone's current HEAD. */
  baseRef?: string;
}

export interface StateConfig {
  /**
   * Where agents keep their homes. Defaults to `~/.hex`.
   *
   * Each agent gets `<home>/<pubkey>/` with its own `data.db` and `worktrees/`,
   * so two agents on one machine share nothing and two configs for one key share
   * a memory.
   */
  home?: string;
  /** How long a conversation stays open to a follow-up that is not a reply. */
  sessionIdleMinutes?: number;
}

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
  state: StateConfig;
  transcript?: TranscriptConfig;
  eve?: EveConfig;
  repos: RepoConfig[];
  /** Named grants, by the key each was declared under. */
  toolsets: Map<string, ToolsetConfig>;
  /** How `isolation: "container"` runs things. Absent unless a toolset asks. */
  container?: ContainerConfig;
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
    // Checked before the generic unknown-key error, because this particular
    // mistake — a key pasted into the config — deserves to be named.
    if (brain.apiKey !== undefined)
      throw new ConfigError(
        "brain.apiKey is not an option — name an env var with brain.apiKeyEnv instead, so the key stays out of the config file",
      );
    rejectUnknown(
      brain,
      [
        "type",
        "baseUrl",
        "model",
        "apiKeyEnv",
        "headerEnv",
        "maxTokens",
        "temperature",
        "maxSteps",
        "toolChoice",
      ],
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
    const baseUrl = requireString(brain.baseUrl, "brain.baseUrl");
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        throw new Error("not http(s)");
    } catch {
      throw new ConfigError(`brain.baseUrl must be an http(s) URL: ${baseUrl}`);
    }

    // Rejected rather than coerced: a typo here silently changes whether the
    // model is obliged to use the tool at all.
    let toolChoice: "auto" | "required" | undefined;
    if (brain.toolChoice !== undefined) {
      if (brain.toolChoice !== "auto" && brain.toolChoice !== "required")
        throw new ConfigError('brain.toolChoice must be "auto" or "required"');
      toolChoice = brain.toolChoice;
    }

    if (brain.temperature !== undefined) {
      if (typeof brain.temperature !== "number" || brain.temperature < 0)
        throw new ConfigError("brain.temperature must be a number ≥ 0");
    }

    return {
      type: "openai-compatible",
      baseUrl,
      model: requireString(brain.model, "brain.model"),
      apiKeyEnv: optionalString(brain.apiKeyEnv, "brain.apiKeyEnv"),
      headerEnv,
      maxTokens:
        brain.maxTokens === undefined
          ? undefined
          : requirePositiveInt(brain.maxTokens, "brain.maxTokens"),
      maxSteps:
        brain.maxSteps === undefined
          ? undefined
          : requirePositiveInt(brain.maxSteps, "brain.maxSteps"),
      toolChoice,
      temperature: brain.temperature as number | undefined,
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

function parseRepos(value: unknown): RepoConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError("repos must be an array");
  return value.map((entry, index) => {
    const path = `repos[${index}]`;
    const repo = requireRecord(entry, path);
    rejectUnknown(repo, ["name", "path", "baseRef"], path);
    return {
      name: requireString(repo.name, `${path}.name`),
      path: requireString(repo.path, `${path}.path`),
      baseRef: optionalString(repo.baseRef, `${path}.baseRef`),
    };
  });
}

function parseContainer(value: unknown): ContainerConfig | undefined {
  if (value === undefined) return undefined;
  const raw = requireRecord(value, "container");
  rejectUnknown(
    raw,
    ["runtime", "image", "network", "memory", "cpus", "pidsLimit"],
    "container",
  );

  const runtime = optionalString(raw.runtime, "container.runtime") ?? "docker";
  // An absolute path is accepted so an operator can name a runtime this does not
  // know about — and so a test can point at one that does not exist and watch it
  // fail loudly without needing a container runtime installed.
  if (
    !CONTAINER_RUNTIMES.includes(
      runtime as (typeof CONTAINER_RUNTIMES)[number],
    ) &&
    !runtime.startsWith("/")
  )
    throw new ConfigError(
      `container.runtime must be one of ${CONTAINER_RUNTIMES.join(", ")} or an absolute path (got ${JSON.stringify(runtime)})`,
    );

  const network = requireString(raw.network, "container.network");
  if (!CONTAINER_NETWORKS.includes(network as ContainerNetwork))
    throw new ConfigError(
      `container.network must be one of ${CONTAINER_NETWORKS.join(", ")} — there is no domain allowlist, because a container CLI cannot enforce one (got ${JSON.stringify(network)})`,
    );

  return {
    runtime,
    image: requireString(raw.image, "container.image"),
    network: network as ContainerNetwork,
    memory: optionalString(raw.memory, "container.memory"),
    cpus: optionalString(raw.cpus, "container.cpus"),
    pidsLimit:
      raw.pidsLimit === undefined
        ? undefined
        : requirePositiveInt(raw.pidsLimit, "container.pidsLimit"),
  };
}

/** Does this grant list reach any `repo.*` tool? */
function grantsExecution(toolset: ToolsetConfig): boolean {
  return toolset.tools.some((grant) =>
    KNOWN_TOOLS.filter((id) => id.startsWith("repo.")).some((id) =>
      grantCovers(grant, id),
    ),
  );
}

function parseToolsets(
  value: unknown,
  repos: RepoConfig[],
): Map<string, ToolsetConfig> {
  const toolsets = new Map<string, ToolsetConfig>();
  if (value === undefined) return toolsets;
  const record = requireRecord(value, "toolsets");

  for (const [name, entry] of Object.entries(record)) {
    const path = `toolsets.${name}`;
    const raw = requireRecord(entry, path);
    rejectUnknown(
      raw,
      ["tools", "repos", "isolation", "execTimeoutMinutes"],
      path,
    );

    const toolsRaw = raw.tools;
    if (!Array.isArray(toolsRaw))
      throw new ConfigError(`${path}.tools must be an array of tool ids`);
    const tools = toolsRaw.map((tool, index) => {
      const grant = requireString(tool, `${path}.tools[${index}]`);
      // A grant that matches no tool that exists is a typo, and a typo here
      // reads at runtime as a model that will not use its tools.
      if (!KNOWN_TOOLS.some((id) => grantCovers(grant, id)))
        throw new ConfigError(
          `${path}.tools[${index}]: no tool matches ${JSON.stringify(grant)} — known tools are ${KNOWN_TOOLS.join(", ")}`,
        );
      return grant;
    });

    const isolationRaw = optionalString(raw.isolation, `${path}.isolation`);
    if (
      isolationRaw !== undefined &&
      !ISOLATIONS.includes(isolationRaw as Isolation)
    )
      throw new ConfigError(
        `${path}.isolation must be one of ${ISOLATIONS.join(", ")} (got ${JSON.stringify(isolationRaw)})`,
      );
    const isolation = isolationRaw as Isolation | undefined;

    const reposRaw = raw.repos;
    if (reposRaw !== undefined && !Array.isArray(reposRaw))
      throw new ConfigError(`${path}.repos must be an array of repo names`);
    const repoNames = (reposRaw ?? []).map((repo, index) => {
      const repoName = requireString(repo, `${path}.repos[${index}]`);
      if (!repos.some((declared) => declared.name === repoName))
        throw new ConfigError(
          `${path}.repos[${index}]: no repo named ${JSON.stringify(repoName)} is declared under \`repos\``,
        );
      return repoName;
    });

    const toolset: ToolsetConfig = {
      name,
      tools,
      repos: repoNames,
      isolation,
      execTimeoutMinutes:
        raw.execTimeoutMinutes === undefined
          ? undefined
          : requirePositiveInt(
              raw.execTimeoutMinutes,
              `${path}.execTimeoutMinutes`,
            ),
    };

    // Running commands needs somewhere to run them and something to run them
    // on. Both missing is the config that looks like it grants coding and
    // grants a tool that refuses every call.
    if (grantsExecution(toolset)) {
      if (!toolset.isolation)
        throw new ConfigError(
          `${path} grants repo tools but names no \`isolation\` — say where the commands run`,
        );
      if (toolset.repos.length === 0)
        throw new ConfigError(
          `${path} grants repo tools but lists no \`repos\` — say what they may be run on`,
        );
    } else if (toolset.isolation || toolset.repos.length > 0) {
      throw new ConfigError(
        `${path} sets \`isolation\`/\`repos\` but grants no repo tools — add "repo.*" to \`tools\` or drop them`,
      );
    }

    toolsets.set(name, toolset);
  }

  return toolsets;
}

/** The toolset a channel named, checked against what was declared. */
function parseToolsetRef(
  value: unknown,
  path: string,
  toolsets: Map<string, ToolsetConfig>,
): string | undefined {
  const name = optionalString(value, path);
  if (name === undefined) return undefined;
  if (!toolsets.has(name))
    throw new ConfigError(
      `${path}: no toolset named ${JSON.stringify(name)} is declared under \`toolsets\``,
    );
  return name;
}

function parseTransports(
  value: unknown,
  toolsets: Map<string, ToolsetConfig>,
): TransportConfig[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new ConfigError("transports must be a non-empty array");

  /**
   * Coding tools are private mail only.
   *
   * A NIP-29 group is whoever the relay lets in, and its membership can change
   * without Hex hearing about it — so a room is not a set of people the way an
   * allow-list is. Refused here rather than at the call, because a config that
   * parses and then silently declines every command is the harder bug.
   */
  const refuseExecution = (name: string | undefined, path: string) => {
    if (!name) return;
    const toolset = toolsets.get(name);
    if (toolset && grantsExecution(toolset))
      throw new ConfigError(
        `${path}: toolset ${JSON.stringify(name)} grants repo tools, which are NIP-17 only — a relay group's membership is the relay's to change`,
      );
  };

  return value.map((entry, index) => {
    const path = `transports[${index}]`;
    const transport = requireRecord(entry, path);
    const type = requireString(transport.type, `${path}.type`);

    if (type === "nip-17") {
      rejectUnknown(transport, ["type", "allow", "toolset"], path);
      const allowRaw = transport.allow;
      if (!Array.isArray(allowRaw) || allowRaw.length === 0)
        throw new ConfigError(
          `${path}.allow must list who may DM Hex — an empty gate is an open one`,
        );
      return {
        type: "nip-17" as const,
        toolset: parseToolsetRef(
          transport.toolset,
          `${path}.toolset`,
          toolsets,
        ),
        allow: allowRaw.map((who, i) => {
          const wherePeer = `${path}.allow[${i}]`;
          // A bare pubkey is still the common case, and still means "this
          // person, with whatever the transport grants".
          if (typeof who === "string")
            return { pubkey: parsePubkey(who, wherePeer) };
          const peer = requireRecord(who, wherePeer);
          rejectUnknown(peer, ["pubkey", "toolset"], wherePeer);
          return {
            pubkey: parsePubkey(peer.pubkey, `${wherePeer}.pubkey`),
            toolset: parseToolsetRef(
              peer.toolset,
              `${wherePeer}.toolset`,
              toolsets,
            ),
          };
        }),
      };
    }

    if (type !== "nip-29")
      throw new ConfigError(
        `${path}.type must be "nip-29" or "nip-17" (got ${JSON.stringify(type)})`,
      );
    rejectUnknown(transport, ["type", "groups", "autoJoin", "toolset"], path);
    const groupDefault = parseToolsetRef(
      transport.toolset,
      `${path}.toolset`,
      toolsets,
    );
    refuseExecution(groupDefault, `${path}.toolset`);

    const groupsRaw = transport.groups;
    if (!Array.isArray(groupsRaw) || groupsRaw.length === 0)
      throw new ConfigError(`${path}.groups must be a non-empty array`);

    const groups = groupsRaw.map((groupRaw, groupIndex) => {
      const groupPath = `${path}.groups[${groupIndex}]`;
      const group = requireRecord(groupRaw, groupPath);
      rejectUnknown(group, ["relay", "id", "toolset"], groupPath);
      const toolset = parseToolsetRef(
        group.toolset,
        `${groupPath}.toolset`,
        toolsets,
      );
      refuseExecution(toolset, `${groupPath}.toolset`);
      // A group id is only unique within its relay, so both are required and
      // the pair travels together everywhere downstream.
      return {
        relay: parseRelayList([group.relay], `${groupPath}.relay`)[0],
        id: requireString(group.id, `${groupPath}.id`),
        toolset,
      };
    });

    const autoJoin = transport.autoJoin ?? false;
    if (typeof autoJoin !== "boolean")
      throw new ConfigError(`${path}.autoJoin must be a boolean`);

    return { type: "nip-29" as const, groups, autoJoin, toolset: groupDefault };
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
      "state",
      "transcript",
      "eve",
      "repos",
      "toolsets",
      "container",
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

  const stateRaw = raw.state;
  let state: StateConfig = {};
  if (stateRaw !== undefined) {
    const record = requireRecord(stateRaw, "state");
    rejectUnknown(record, ["home", "sessionIdleMinutes"], "state");
    state = {
      home: optionalString(record.home, "state.home"),
      sessionIdleMinutes:
        record.sessionIdleMinutes === undefined
          ? undefined
          : requirePositiveInt(
              record.sessionIdleMinutes,
              "state.sessionIdleMinutes",
            ),
    };
  }

  // Repos first: a toolset names them, and a toolset that names one that does
  // not exist should say so rather than failing on the first command.
  const repos = parseRepos(raw.repos);
  const toolsets = parseToolsets(raw.toolsets, repos);
  const container = parseContainer(raw.container);

  // A toolset that names an isolation with nothing configured for it would parse
  // and then fail every command — the same class of silent misconfiguration as a
  // typo'd tool id, and caught in the same place.
  for (const toolset of toolsets.values())
    if (toolset.isolation === "container" && !container)
      throw new ConfigError(
        `toolsets.${toolset.name} asks for container isolation but there is no top-level \`container\` section — name the image it runs in`,
      );

  const config: HexConfig = {
    identity: { signer: parseSigner(identity.signer) },
    instructions: optionalString(raw.instructions, "instructions"),
    mentions: parseMentions(raw.mentions),
    brain: parseBrain(raw.brain),
    relays: parseRelays(raw.relays),
    profile: parseProfile(raw.profile),
    context,
    limits,
    state,
    transcript: parseTranscript(raw.transcript),
    eve: parseEve(raw.eve),
    repos,
    toolsets,
    container,
    transports: parseTransports(raw.transports, toolsets),
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
