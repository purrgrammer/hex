#!/usr/bin/env node
/**
 * `hex <command> [config]`
 *
 * whoami   — resolve the signer and print the npub. No publishing.
 * check    — validate the config and dial every relay, per role. No publishing.
 * announce — write kind 0 / 10002 / 10050 from config, skipping what matches.
 * eve      — follow an Eve session and publish it as events.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { nip19 } from "nostr-tools";
import { loadConfig } from "./config-file.js";
import { createRelays, checkRelays, type RelayHealth } from "./relays.js";
import { resolveSigner } from "./signer.js";
import { announceIdentity } from "./identity.js";
import { joinConfiguredGroups } from "./transports/nip29-join.js";
import { loadEnvFile } from "./env-file.js";
import type { TransportConfig } from "./config.js";
import { Nip17Transport } from "./transports/nip17.js";
import { HexStore, agentHome, expandHome, DEFAULT_HOME } from "./store.js";
import { streamSession } from "./eve/stream.js";
import { EveTranscript, type RumorSink } from "./eve/transcript.js";

const USAGE = `hex — a transport-agnostic agent for Nostr groups

Usage:
  hex whoami   [config]            print the pubkey the configured signer holds
  hex check    [config]            validate config and dial every relay
  hex announce [config] [--dry-run]  publish kind 0 / 10002 / 10050 from config
  hex join     [config] [--auto] [--dry-run]  request to join NIP-29 groups
  hex dm       [config] <npub> "message"   send a private message, unprompted
  hex eve      [config] <session-id> [--host <url>] [--dry-run]
                                   follow an Eve session, publish it as events

Config defaults to ./hex.config.json.

Secrets come from the environment. Every command loads a \`.env\` beside the
config, or --env-file <path>; a variable already exported always wins.
`;

/** The NIP-29 half of a config's transports. */
function groupTransports(transports: TransportConfig[]) {
  return transports.filter(
    (transport): transport is Extract<TransportConfig, { type: "nip-29" }> =>
      transport.type === "nip-29",
  );
}

/** The DM half, of which at most one matters. */
function dmTransport(transports: TransportConfig[]) {
  return transports.find(
    (transport): transport is Extract<TransportConfig, { type: "nip-17" }> =>
      transport.type === "nip-17",
  );
}

function fail(message: string): never {
  console.error(`hex: ${message}`);
  process.exit(1);
}

function describeHealth(health: RelayHealth): string {
  switch (health.state) {
    case "ok":
      return `ok (${health.roundTripMs}ms)`;
    case "silent":
      // Deliberately distinct from "no events": a relay that accepted the REQ
      // and said nothing is the shape that hangs clients.
      return "SILENT — accepted the request and never answered";
    case "auth-required":
      return "AUTH — reachable, but serves nothing until Hex authenticates (NIP-42)";
    case "error":
      return `ERROR — ${health.message}`;
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      auto: { type: "boolean", default: false },
      "env-file": { type: "string" },
      host: { type: "string" },
      help: { type: "boolean", default: false, short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  /**
   * `[config]` is optional, so tell it apart from the command's own arguments.
   *
   * Positionally it cannot be done: `hex eve ses_01ABC` and
   * `hex eve ./other.json` have the same shape. A config is a path — it ends in
   * `.json`, or it exists on disk — and anything else is the command's argument.
   * Without this, the documented `hex eve <session-id>` form failed with ENOENT
   * on the session id.
   */
  const [command, ...rest] = positionals;
  const first = rest[0];
  const looksLikeConfig =
    first !== undefined &&
    (first.endsWith(".json") || first.includes("/") || existsSync(first));
  const configPath = looksLikeConfig ? first : "hex.config.json";
  const args = looksLikeConfig ? rest.slice(1) : rest;

  const loaded = await loadConfig(configPath);
  const { config } = loaded;

  // Secrets live in the environment; a `.env` beside the config is where people
  // put them. Loaded before the signer is resolved, and never over a variable
  // the real environment already set.
  const env = await loadEnvFile(loaded.baseDir, values["env-file"]);
  if (env.path && env.applied.length > 0)
    console.log(`env     ${env.path} (${env.applied.join(", ")})`);

  const relays = createRelays();

  try {
    switch (command) {
      case "whoami": {
        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });
        console.log(`pubkey  ${resolved.pubkey}`);
        console.log(`npub    ${nip19.npubEncode(resolved.pubkey)}`);
        console.log(`signer  ${resolved.source}`);
        await resolved.close();
        return;
      }

      case "check": {
        console.log(`config  ${loaded.path}`);
        console.log(
          `mentions ${config.mentions.length ? config.mentions.join(", ") : "(none — only a p-tag will reach Hex)"}`,
        );

        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });
        console.log(`signer  ${resolved.source}`);
        console.log(`npub    ${nip19.npubEncode(resolved.pubkey)}`);

        const roles: [string, string[]][] = [
          ["read", config.relays.read],
          ["publish", config.relays.publish],
          ["dm", config.relays.dm],
          [
            "nip-29 groups",
            groupTransports(config.transports).flatMap((transport) =>
              transport.groups.map((group) => group.relay),
            ),
          ],
        ];

        // One check per relay, then reported under every role that names it:
        // roles overlap, and checking a relay twice at once races its own socket.
        const health = await checkRelays(
          relays,
          roles.flatMap(([, urls]) => urls),
        );
        const unhealthy = [...health.values()].filter(
          (result) => result.state !== "ok",
        ).length;

        for (const [role, urls] of roles) {
          if (urls.length === 0) continue;
          console.log(`\n${role}:`);
          for (const url of new Set(urls)) {
            const result = health.get(url);
            console.log(
              `  ${url}  ${result ? describeHealth(result) : "not checked"}`,
            );
          }
        }

        await resolved.close();
        if (unhealthy > 0) {
          console.error(`\n${unhealthy} relay(s) did not answer cleanly`);
          process.exitCode = 1;
        }
        return;
      }

      case "announce": {
        if (!config.profile.publish)
          fail(
            "profile.publish is false — this config says Hex's metadata is managed elsewhere",
          );

        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });
        const results = await announceIdentity(
          relays,
          resolved.signer,
          resolved.pubkey,
          config,
          { dryRun: values["dry-run"] },
        );
        for (const result of results)
          console.log(
            `kind ${result.kind}  ${result.action}${result.detail ? ` — ${result.detail}` : ""}`,
          );
        await resolved.close();
        if (results.some((result) => result.action === "failed"))
          process.exitCode = 1;
        return;
      }

      case "join": {
        // Every configured group, or only the ones marked autoJoin with --auto.
        const groups = groupTransports(config.transports).flatMap(
          (transport) =>
            values.auto && !transport.autoJoin ? [] : transport.groups,
        );
        if (groups.length === 0)
          fail(
            values.auto
              ? "no configured group has autoJoin set"
              : "no NIP-29 groups are configured",
          );

        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });
        const outcomes = await joinConfiguredGroups(
          relays,
          resolved.signer,
          resolved.pubkey,
          groups,
          { dryRun: values["dry-run"] },
        );
        for (const outcome of outcomes)
          console.log(
            `${outcome.group}  ${outcome.action}${
              outcome.action === "failed" ? ` — ${outcome.detail}` : ""
            }`,
          );
        await resolved.close();
        if (outcomes.some((outcome) => outcome.action === "failed"))
          process.exitCode = 1;
        return;
      }

      /**
       * Speak first: a private message to someone, unprompted.
       *
       * For reporting on work rather than answering about it — a long task
       * finishing, a build breaking. Restricted to the DM allow-list, because
       * an agent that can message anyone is a spam engine with a signing key.
       */
      case "dm": {
        const dm = dmTransport(config.transports);
        if (!dm) fail("this config has no nip-17 transport");
        const [who, ...words] = args;
        const text = words.join(" ").trim();
        if (!who || !text) fail('usage: hex dm [config] <npub|hex> "message"');

        const peer = /^[0-9a-f]{64}$/i.test(who)
          ? who.toLowerCase()
          : (() => {
              try {
                const decoded = nip19.decode(who);
                if (decoded.type === "npub") return decoded.data;
              } catch {
                // Named below rather than throwing something opaque.
              }
              return fail(`${who} is not an npub or a hex pubkey`);
            })();

        if (!dm.allow.some((allowed) => allowed.pubkey === peer))
          fail(
            `${nip19.npubEncode(peer).slice(0, 16)}… is not on this config's DM allow list`,
          );

        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });
        const transport = new Nip17Transport({
          relays,
          signer: resolved.signer,
          pubkey: resolved.pubkey,
          inboxRelays: config.relays.dm,
          readRelays: config.relays.read,
          allow: dm.allow.map((allowed) => allowed.pubkey),
          since: Math.floor(Date.now() / 1000),
          log: (line) => console.log(line),
        });

        if (values["dry-run"]) {
          console.log(`would send to ${nip19.npubEncode(peer)}: ${text}`);
        } else {
          const id = await transport.send(peer, text);
          console.log(`sent ${id}`);
        }
        transport.stop();
        await resolved.close();
        return;
      }

      case "eve": {
        const transcriptConfig = config.transcript;
        if (!transcriptConfig)
          fail(
            "this config has no `transcript` section, so there is nobody to publish a session to",
          );
        const host = values.host ?? config.eve?.host;
        if (!host)
          fail("no Eve host — set `eve.host` in the config or pass --host");

        const [sessionId] = args;
        if (!sessionId)
          fail("usage: hex eve [config] <session-id> [--host <url>]");

        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });

        // The cursor lives with the agent's other state, keyed by its pubkey, so
        // two agents on one machine never resume each other's stream.
        const home = agentHome(
          config.state.home
            ? expandHome(config.state.home, loaded.baseDir)
            : DEFAULT_HOME,
          resolved.pubkey,
        );
        const store = HexStore.open(home.db);

        /**
         * Where a rumor goes.
         *
         * A dry run prints instead of publishing, which is how the mapping gets
         * checked against a real Eve host with no relay involved — and the field
         * names in this consumer are the thing most likely to be wrong.
         */
        const dm = dmTransport(config.transports);
        let sink: RumorSink;
        let transport: Nip17Transport | undefined;
        if (values["dry-run"]) {
          sink = {
            publishRumor: async (rumor, recipients, publishOptions) => {
              console.log(
                `${publishOptions?.ephemeral ? "delta " : "would"} kind ${rumor.kind} ${
                  rumor.tags
                    .filter((t) =>
                      ["seq", "role", "status", "delta"].includes(t[0]!),
                    )
                    .map((t) => t.join("="))
                    .join(" ") || "—"
                } ${rumor.content.slice(0, 120)}`,
              );
              return { delivered: recipients, undeliverable: [] };
            },
          };
        } else {
          if (!dm)
            fail(
              "publishing a transcript needs a nip-17 transport — a gift wrap has nowhere else to go",
            );
          transport = new Nip17Transport({
            relays,
            signer: resolved.signer,
            pubkey: resolved.pubkey,
            inboxRelays: config.relays.dm,
            readRelays: config.relays.read,
            allow: dm.allow.map((peer) => peer.pubkey),
            since: Math.floor(Date.now() / 1000),
            log: (line) => console.log(line),
          });
          sink = transport;
        }

        const transcript = new EveTranscript(
          {
            agentPubkey: resolved.pubkey,
            slug: transcriptConfig.slug,
            recipients: transcriptConfig.to,
            store,
            sink,
            deltas: transcriptConfig.deltas,
            log: (line) => console.log(line),
          },
          sessionId,
        );

        console.log(`npub    ${nip19.npubEncode(resolved.pubkey)}`);
        console.log(`eve     ${host}`);
        console.log(
          `session ${sessionId} from index ${transcript.streamIndex}`,
        );
        console.log(
          `to      ${transcriptConfig.to.map((p) => nip19.npubEncode(p).slice(0, 16) + "…").join(", ")}`,
        );

        if (transcriptConfig.announce)
          await transcript.announce({
            name: config.profile.name ?? transcriptConfig.slug,
            about: config.profile.about,
            picture: config.profile.picture,
            instructions: loaded.instructions || undefined,
          });

        // Interrupting a follow is not the session ending — Eve keeps running —
        // so the head says `aborted`, which is "nobody is watching any more".
        const abort = new AbortController();
        let interrupted = false;
        const stop = (signal: string) => {
          if (interrupted) return;
          interrupted = true;
          console.log(`\n${signal} — stopping`);
          abort.abort();
        };
        process.once("SIGINT", () => stop("SIGINT"));
        process.once("SIGTERM", () => stop("SIGTERM"));

        try {
          for await (const { index, event } of streamSession({
            host,
            sessionId,
            startIndex: transcript.streamIndex,
            // A live follow, which is the only mode the endpoint has.

            signal: abort.signal,
          }))
            await transcript.handle(event, index);
        } catch (error) {
          // An aborted fetch is the operator's Ctrl-C, not a failure.
          if (!abort.signal.aborted) throw error;
        }

        await transcript.close(interrupted ? "aborted" : "done");
        transport?.stop();
        store.close();
        await resolved.close();
        return;
      }

      default:
        fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    relays.close();
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
