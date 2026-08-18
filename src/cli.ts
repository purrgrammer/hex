#!/usr/bin/env node
/**
 * `hex <command> [config]`
 *
 * whoami   — resolve the signer and print the npub. No publishing.
 * check    — validate the config and dial every relay, per role. No publishing.
 * announce — write kind 0 / 10002 / 10050 from config, skipping what matches.
 * run      — join, listen on every configured group, and answer when addressed.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { nip19 } from "nostr-tools";
import { loadConfig } from "./config-file.js";
import { createRelays, checkRelays, type RelayHealth } from "./relays.js";
import { resolveSigner } from "./signer.js";
import { announceIdentity } from "./identity.js";
import { joinConfiguredGroups } from "./transports/nip29-join.js";
import { loadEnvFile } from "./env-file.js";
import { createBrain } from "./brain/create.js";
import { Nip29Transport } from "./transports/nip29.js";
import { RoomContext } from "./context.js";
import { ReplyGate } from "./policy.js";
import { runAgent } from "./agent.js";
import { ConsoleTools } from "./tools/console-tools.js";
import { KnowledgeTools } from "./tools/knowledge.js";
import { StateStore, defaultStatePath } from "./state.js";
import { SessionTracker } from "./sessions.js";

const USAGE = `hex — a transport-agnostic agent for Nostr groups

Usage:
  hex whoami   [config]            print the pubkey the configured signer holds
  hex check    [config]            validate config and dial every relay
  hex announce [config] [--dry-run]  publish kind 0 / 10002 / 10050 from config
  hex join     [config] [--auto] [--dry-run]  request to join NIP-29 groups
  hex ask      [config] "question" [--brain echo]  one turn through the brain
  hex run      [config] [--dry-run] [--brain echo]  join, listen, and answer

Config defaults to ./hex.config.json.

Secrets come from the environment. Every command loads a \`.env\` beside the
config, or --env-file <path>; a variable already exported always wins.
`;

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
      brain: { type: "string" },
      help: { type: "boolean", default: false, short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const [command, configArg] = positionals;
  const configPath = configArg ?? "hex.config.json";
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
        console.log(`brain   ${config.brain.type}`);
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
            config.transports.flatMap((transport) =>
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

      case "ask": {
        // One turn through the brain, with no relay and no room. This is how a
        // provider gets verified: base URL, key, model and instructions, before
        // any of it is wired to a group where failures are somebody else's
        // problem.
        const question = positionals.slice(2).join(" ").trim();
        if (!question) fail('ask needs a question: hex ask [config] "…"');

        const brain = createBrain(config.brain, {
          override: values.brain === "echo" ? "echo" : undefined,
          log: (line) => console.log(line),
        });
        console.log(`brain   ${brain.name}`);

        const room = {
          transport: "nip-29" as const,
          id: "local",
          label: "hex ask",
        };
        // The same tools a room turn gets: speaking, pointed at stdout, plus the
        // read tools — so `hex ask` verifies the whole surface, not a subset.
        const tools = new ConsoleTools(
          room,
          "0".repeat(64),
          (text) => console.log(text),
          new KnowledgeTools({ relays, readRelays: config.relays.read }),
        );

        const outcome = await brain.turn({
          instructions: loaded.instructions,
          history: [],
          tools,
          incoming: {
            id: "local",
            author: "0".repeat(64),
            text: question,
            createdAt: Math.floor(Date.now() / 1000),
            room,
            addressesSelf: true,
            event: {
              id: "local",
              pubkey: "0".repeat(64),
              created_at: Math.floor(Date.now() / 1000),
              kind: 9,
              content: question,
              tags: [],
              sig: "",
            },
          },
        });

        // Silence is a real outcome: the brain chose to stay out of it.
        if (!outcome.delivered)
          console.log(`(silence)${outcome.note ? ` — ${outcome.note}` : ""}`);
        return;
      }

      case "join": {
        // Every configured group, or only the ones marked autoJoin with --auto.
        const groups = config.transports.flatMap((transport) =>
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

      case "run": {
        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });
        const brain = createBrain(config.brain, {
          selfPubkey: resolved.pubkey,
          override: values.brain === "echo" ? "echo" : undefined,
          log: (line) => console.log(line),
        });

        console.log(`npub    ${nip19.npubEncode(resolved.pubkey)}`);
        console.log(`brain   ${brain.name}`);
        console.log(
          `mentions ${config.mentions.length ? config.mentions.join(", ") : "(none — only a p-tag will reach Hex)"}`,
        );
        if (values["dry-run"])
          console.log("dry run — answers are logged, nothing is published");

        // Say who you are before speaking, if the config owns the profile.
        if (config.profile.publish && !values["dry-run"]) {
          const announced = await announceIdentity(
            relays,
            resolved.signer,
            resolved.pubkey,
            config,
          );
          for (const result of announced)
            console.log(`kind ${result.kind}  ${result.action}`);
        }

        const autoJoinGroups = config.transports.flatMap((transport) =>
          transport.autoJoin ? transport.groups : [],
        );
        if (autoJoinGroups.length > 0) {
          const outcomes = await joinConfiguredGroups(
            relays,
            resolved.signer,
            resolved.pubkey,
            autoJoinGroups,
            { dryRun: values["dry-run"] },
          );
          for (const outcome of outcomes)
            console.log(`join    ${outcome.group}  ${outcome.action}`);
        }

        // Conversations outlive the process: what Hex said, and which messages
        // belong together, are read back from disk before the first REQ.
        const statePath = config.state.file
          ? resolve(loaded.baseDir, config.state.file)
          : defaultStatePath(loaded.baseDir);
        const store = new StateStore(statePath);
        await store.load();
        const sessions = new SessionTracker({
          store,
          maxMessages: config.context.messages,
          idleSecs: config.state.sessionIdleMinutes
            ? config.state.sessionIdleMinutes * 60
            : undefined,
        });
        console.log(`state   ${statePath}`);

        // Unix seconds, captured once: the subscription's floor and the gate's
        // cutoff are the same instant, so nothing is fetched that would only be
        // refused as backfill.
        const startedAt = Math.floor(Date.now() / 1000);

        const transports = config.transports.map(
          (transport) =>
            new Nip29Transport({
              relays,
              signer: resolved.signer,
              pubkey: resolved.pubkey,
              groups: transport.groups,
              mentions: config.mentions,
              since: startedAt,
              isOwnMessage: (id) => sessions.isOwn(id),
            }),
        );

        const agent = runAgent({
          transports,
          gate: new ReplyGate({
            selfPubkey: resolved.pubkey,
            mentions: config.mentions,
            startedAt,
            repliesPerRoomPerHour: config.limits.repliesPerRoomPerHour,
            now: () => Math.floor(Date.now() / 1000),
          }),
          brain,
          context: new RoomContext({
            relays,
            lookupRelays: config.relays.read,
            messages: config.context.messages,
            sessions,
          }),
          sessions,
          instructions: loaded.instructions,
          dryRun: values["dry-run"],
          knowledge: new KnowledgeTools({
            relays,
            readRelays: config.relays.read,
          }),
        });

        for (const group of config.transports.flatMap(
          (transport) => transport.groups,
        ))
          console.log(`listening ${group.relay}'${group.id}`);

        // Runs until interrupted. The signer is closed on the way out so a
        // bunker session ends cleanly rather than timing out on the far side.
        await new Promise<void>((resolveRun) => {
          const shutdown = (signal: string) => {
            console.log(`\n${signal} — stopping`);
            agent.stop();
            resolveRun();
          };
          process.once("SIGINT", () => shutdown("SIGINT"));
          process.once("SIGTERM", () => shutdown("SIGTERM"));
        });

        await agent.idle();
        // Anything the last turn recorded belongs on disk before the process
        // goes; a debounced write that never fired is a conversation lost.
        await store.flush();
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
