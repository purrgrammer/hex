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
import { nip19 } from "nostr-tools";
import { loadConfig } from "./config-file.js";
import { createRelays, checkRelays, type RelayHealth } from "./relays.js";
import { resolveSigner } from "./signer.js";
import { announceIdentity } from "./identity.js";
import { joinConfiguredGroups } from "./transports/nip29-join.js";
import { loadEnvFile } from "./env-file.js";
import type { Isolation, TransportConfig } from "./config.js";
import { createBrain } from "./brain/create.js";
import { Nip29Transport } from "./transports/nip29.js";
import { Nip17Transport } from "./transports/nip17.js";
import type { Transport } from "./transports/types.js";
import { RoomContext } from "./context.js";
import { ReplyGate } from "./policy.js";
import { runAgent } from "./agent.js";
import { ConsoleTools } from "./tools/console-tools.js";
import { KnowledgeTools } from "./tools/knowledge.js";
import { RepoTools } from "./tools/repo-tools.js";
import { createRunner, type Runner } from "./tools/backends.js";
import { ContainerBackend } from "./tools/exec-container.js";
import { toolsetFor } from "./grants.js";
import { HexStore, agentHome, expandHome, DEFAULT_HOME } from "./store.js";
import { SessionTracker } from "./sessions.js";

const USAGE = `hex — a transport-agnostic agent for Nostr groups

Usage:
  hex whoami   [config]            print the pubkey the configured signer holds
  hex check    [config]            validate config and dial every relay
  hex announce [config] [--dry-run]  publish kind 0 / 10002 / 10050 from config
  hex join     [config] [--auto] [--dry-run]  request to join NIP-29 groups
  hex ask      [config] "question" [--as <npub>]  one turn through the brain
  hex dm       [config] <npub> "message"   send a private message, unprompted
  hex run      [config] [--dry-run] [--brain echo]  join, listen, and answer

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
      brain: { type: "string" },
      as: { type: "string" },
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

        // Who may ask for what. Printed even when nothing is granted, because
        // "no channel can run anything" is the fact an operator wants confirmed.
        console.log("\ncapabilities:");
        if (config.toolsets.size === 0) {
          console.log("  (none — every channel gets the read tools only)");
        } else {
          for (const [name, toolset] of config.toolsets) {
            const where = toolset.isolation
              ? ` — runs in ${toolset.repos.join(", ")} (${toolset.isolation}, ${toolset.execTimeoutMinutes ?? 15}min)`
              : "";
            console.log(`  ${name}: ${toolset.tools.join(" ")}${where}`);
          }
          for (const transport of config.transports) {
            if (transport.type === "nip-17")
              for (const peer of transport.allow)
                console.log(
                  `  dm ${nip19.npubEncode(peer.pubkey).slice(0, 16)}… → ${peer.toolset ?? transport.toolset ?? "(default)"}`,
                );
            else
              for (const group of transport.groups)
                console.log(
                  `  ${group.relay}'${group.id} → ${group.toolset ?? transport.toolset ?? "(default)"}`,
                );
          }
        }

        /**
         * The container, checked rather than described.
         *
         * An operator has to be able to see the boundary without knowing the
         * runtime's CLI, and a missing image has to fail here rather than at the
         * first command someone asks for.
         */
        if (config.container) {
          const used = [...config.toolsets.values()].some(
            (toolset) => toolset.isolation === "container",
          );
          console.log("\ncontainer:");
          if (!used) {
            // A section nobody reads is a typo'd `isolation` somewhere.
            console.log("  configured but no toolset uses it");
          }
          console.log(`  runtime   ${config.container.runtime}`);
          console.log(`  image     ${config.container.image}`);
          console.log(
            config.container.network === "none"
              ? "  network   none — no egress at all, which also breaks installs"
              : "  network   open — full egress; on a cloud host the instance metadata endpoint is reachable",
          );

          const backend = new ContainerBackend({
            config: config.container,
            agent: resolved.pubkey,
            mountFor: (request) => request.cwd,
            homeFor: (request) => request.cwd,
          });
          try {
            await backend.preflight();
            console.log("  ready     yes");
          } catch (error) {
            console.log(
              `  ready     NO — ${error instanceof Error ? error.message : String(error)}`,
            );
            process.exitCode = 1;
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

        /**
         * `--as <npub>` asks the question as a DM from that person.
         *
         * Which matters because the coding tools only exist for a channel that
         * was granted them, and driving that end to end otherwise needs a
         * second key to send the DM from. The grant is resolved through the
         * same function the daemon uses, so this is the real path and not a
         * bypass: a pubkey that is not on the allow-list gets nothing.
         */
        const asRaw = values.as;
        const asPubkey = asRaw
          ? /^[0-9a-f]{64}$/i.test(asRaw)
            ? asRaw.toLowerCase()
            : (() => {
                try {
                  const decoded = nip19.decode(asRaw);
                  if (decoded.type === "npub") return decoded.data;
                } catch {
                  // Named below.
                }
                return fail(`--as ${asRaw} is not an npub or a hex pubkey`);
              })()
          : "0".repeat(64);

        const room = asRaw
          ? { transport: "nip-17" as const, id: asPubkey, label: "hex ask" }
          : { transport: "nip-29" as const, id: "local", label: "hex ask" };

        let repoTools: RepoTools | undefined;
        let askGrants: string[] | undefined;
        if (asRaw) {
          const resolved = await resolveSigner(config.identity.signer, {
            baseDir: loaded.baseDir,
            relays,
          });
          const home = agentHome(
            config.state.home
              ? expandHome(config.state.home, loaded.baseDir)
              : DEFAULT_HOME,
            resolved.pubkey,
          );
          await resolved.close();
          const store = HexStore.open(home.db);
          const toolset = toolsetFor(config, {
            id: "local",
            author: asPubkey,
            text: question,
            createdAt: 0,
            addressesSelf: true,
            room,
          } as Parameters<typeof toolsetFor>[1]);
          console.log(`as      ${asRaw} → ${toolset?.name ?? "(default)"}`);
          askGrants = toolset?.tools;
          if (toolset?.isolation && toolset.repos.length > 0) {
            const runner = createRunner(toolset.isolation, {
              config,
              store,
              home,
              agent: resolved.pubkey,
              log: (line) => console.log(line),
            });
            // Fails here rather than at the first command, in the runtime's own
            // words: a harness that quietly ran on the host would be lying about
            // what it is checking.
            await runner.backend.preflight();
            repoTools = new RepoTools({
              worktrees: runner.checkout,
              backend: runner.backend,
              repos: toolset.repos,
              // Named, so repeated `hex ask` runs share one checkout instead
              // of leaving a worktree behind per question. Deliberately the
              // same key the daemon would use for a DM with this person, so
              // the harness works in the tree they would be working in.
              workspace: `nip-17|${asPubkey}`,
              requestedBy: asPubkey,
              dryRun: values["dry-run"],
              timeoutMs: toolset.execTimeoutMinutes
                ? toolset.execTimeoutMinutes * 60_000
                : undefined,
              log: (line) => console.log(line),
            });
          }
        }

        // The same tools a room turn gets: speaking, pointed at stdout, plus the
        // read tools — so `hex ask` verifies the whole surface, not a subset.
        const tools = new ConsoleTools(
          room,
          asPubkey,
          (text) => console.log(text),
          new KnowledgeTools({ relays, readRelays: config.relays.read }),
          repoTools,
          askGrants,
        );

        const outcome = await brain.turn({
          instructions: loaded.instructions,
          history: [],
          tools,
          incoming: {
            id: "local",
            author: asPubkey,
            text: question,
            createdAt: Math.floor(Date.now() / 1000),
            room,
            addressesSelf: true,
            event: {
              id: "local",
              pubkey: asPubkey,
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
        const [, , who, ...rest] = positionals;
        const text = rest.join(" ").trim();
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

        const autoJoinGroups = groupTransports(config.transports).flatMap(
          (transport) => (transport.autoJoin ? transport.groups : []),
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

        // Conversations outlive the process. The agent's home is named by its
        // pubkey, so two agents on one machine share nothing.
        const home = agentHome(
          config.state.home
            ? expandHome(config.state.home, loaded.baseDir)
            : DEFAULT_HOME,
          resolved.pubkey,
        );
        const store = HexStore.open(home.db);
        store.prune();
        const sessions = new SessionTracker({
          store,
          maxMessages: config.context.messages,
          idleSecs: config.state.sessionIdleMinutes
            ? config.state.sessionIdleMinutes * 60
            : undefined,
        });
        const counts = store.counts();
        console.log(
          `home    ${home.dir} (${counts.sessions} sessions, ${counts.messages} messages)`,
        );

        // Unix seconds, captured once: the subscription's floor and the gate's
        // cutoff are the same instant, so nothing is fetched that would only be
        // refused as backfill.
        const startedAt = Math.floor(Date.now() / 1000);

        const transports: Transport[] = groupTransports(config.transports).map(
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

        // Private messages, if the config opened that door — and it only opens
        // to the pubkeys it names, because a DM needs no mention to be addressed.
        const dm = dmTransport(config.transports);
        if (dm) {
          transports.push(
            new Nip17Transport({
              relays,
              signer: resolved.signer,
              pubkey: resolved.pubkey,
              inboxRelays: config.relays.dm,
              readRelays: config.relays.read,
              allow: dm.allow.map((peer) => peer.pubkey),
              since: startedAt,
              log: (line) => console.log(line),
            }),
          );
          console.log(
            `dm      ${dm.allow.length} allowed: ${dm.allow
              .map(
                (peer) =>
                  nip19.npubEncode(peer.pubkey).slice(0, 16) +
                  "…" +
                  ((peer.toolset ?? dm.toolset)
                    ? ` (${peer.toolset ?? dm.toolset})`
                    : ""),
              )
              .join(", ")}`,
          );
        }

        /**
         * One runner per isolation, built once and shared by every turn.
         *
         * Preflighted before a single relay is subscribed to: a daemon that
         * boots and then fails every command is indistinguishable from a broken
         * bot, and launchd's log is the only place the operator will look.
         */
        const runners = new Map<Isolation, Runner>();
        for (const toolset of config.toolsets.values()) {
          if (!toolset.isolation || runners.has(toolset.isolation)) continue;
          const runner = createRunner(toolset.isolation, {
            config,
            store,
            home,
            agent: resolved.pubkey,
            log: (line) => console.log(line),
          });
          await runner.backend.preflight();
          console.log(`runner  ${toolset.isolation} ready`);
          // A container left behind by a crash still holds a mount into the
          // operator's disk, so leftovers are reaped before new ones are made.
          if (runner.backend instanceof ContainerBackend)
            await runner.backend.sweep();
          runners.set(toolset.isolation, runner);
        }

        const agent = runAgent({
          transports,
          /**
           * What this message's channel may do.
           *
           * Built here rather than inside the agent because it is a config
           * question, and resolved per message because the answer differs by
           * room and by speaker. A channel with no toolset gets `undefined`,
           * which is the read tools and no execution.
           */
          capabilities: (inbound, workspace) => {
            const toolset = toolsetFor(config, inbound);
            if (!toolset) return {};
            return {
              grants: toolset.tools,
              repo:
                toolset.isolation &&
                toolset.repos.length > 0 &&
                runners.has(toolset.isolation)
                  ? new RepoTools({
                      worktrees: runners.get(toolset.isolation)!.checkout,
                      backend: runners.get(toolset.isolation)!.backend,
                      repos: toolset.repos,
                      workspace,
                      requestedBy: inbound.author,
                      dryRun: values["dry-run"],
                      timeoutMs: toolset.execTimeoutMinutes
                        ? toolset.execTimeoutMinutes * 60_000
                        : undefined,
                      log: (line) => console.log(line),
                    })
                  : undefined,
            };
          },
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

        for (const group of groupTransports(config.transports).flatMap(
          (transport) => transport.groups,
        ))
          console.log(`listening ${group.relay}'${group.id}`);
        if (dm) console.log(`listening dms on ${config.relays.dm.join(", ")}`);

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
        // Every write already committed as it happened; this just releases the
        // file handle so a supervisor's restart is not racing a WAL checkpoint.
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
