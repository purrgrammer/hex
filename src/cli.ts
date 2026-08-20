#!/usr/bin/env node
/**
 * `hex <command> [config]`
 *
 * whoami   — resolve the signer and print the npub. No publishing.
 * check    — validate the config and dial every relay, per role. No publishing.
 * announce — write kind 0 / 10002 / 10050 from config, skipping what matches.
 * eve      — follow an Eve session and publish it as events.
 * serve     — answer private messages by running them through Eve.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { basename } from "node:path";
import { nip19 } from "nostr-tools";
import { loadConfig } from "./config-file.js";
import { createRelays, checkRelays, type RelayHealth } from "./relays.js";
import { resolveSigner } from "./signer.js";
import { announceIdentity } from "./identity.js";
import { joinConfiguredGroups } from "./transports/nip29-join.js";
import { loadEnvFile } from "./env-file.js";
import type { TransportConfig } from "./config.js";
import type { Inbound } from "./transports/types.js";
import { KIND_FILE_MESSAGE, Nip17Transport } from "./transports/nip17.js";
import { Nip29Transport } from "./transports/nip29.js";
import {
  fileMessageTags,
  imetaTag,
  upload,
  type Uploaded,
} from "./blossom.js";
import { HexStore, agentHome, expandHome, DEFAULT_HOME } from "./store.js";
import { streamSession } from "./eve/stream.js";
import { EveTranscript, type RumorSink } from "./eve/transcript.js";
import { EveServer } from "./eve/serve.js";
import { ToolBridge } from "./eve/bridge.js";
import { parseSessionControl } from "./nostr/decode-control.js";
import { readAgentInfo } from "./eve/info.js";
import { Prices } from "./eve/pricing.js";
import { KnowledgeTools } from "./tools/knowledge.js";
import { RoomTools } from "./tools/room-tools.js";
import { PublishTools } from "./tools/publish.js";
import { BlossomTools } from "./tools/blossom-tools.js";
import { GitTools } from "./tools/git-tools.js";
import { ReplyGate } from "./policy.js";

const USAGE = `hex — a transport-agnostic agent for Nostr groups

Usage:
  hex whoami   [config]            print the pubkey the configured signer holds
  hex check    [config]            validate config and dial every relay
  hex announce [config] [--dry-run]  publish kind 0 / 10002 / 10050 from config
  hex join     [config] [--auto] [--dry-run]  request to join NIP-29 groups
  hex send     [config] <target> "message" [--transport <name>]
               [--attach <path>] [--no-encrypt]
                                   say something unprompted. <target> is an npub
                                   (nip-17) or <relay-host>'<group-id> (nip-29)
  hex dm       [config] <npub> "message" [--attach <path>] [--no-encrypt]
                                   the same thing, fixed to nip-17
  hex eve      [config] <session-id> [--host <url>] [--dry-run]
                                   follow an Eve session, publish it as events
  hex serve    [config] [--host <url>] [--no-reply]
                                   answer DMs by running them through Eve

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

/**
 * Did the stream just end, rather than fail?
 *
 * undici reports a body the far side closed as a bare `TypeError: terminated`,
 * with the real reason on `cause`. It is indistinguishable from a crash by type
 * alone, which is why this is a named check and not a `catch {}`.
 */
function isDisconnect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "terminated") return true;
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return (
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE"
  );
}

function describeDisconnect(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })
    ?.cause;
  return (
    cause?.message ??
    cause?.code ??
    (error instanceof Error ? error.message : String(error))
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
      "no-reply": { type: "boolean", default: false },
      attach: { type: "string", multiple: true },
      transport: { type: "string" },
      "as-file": { type: "boolean", default: false },
      "no-encrypt": { type: "boolean", default: false },
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

  /**
   * A price list, so a provider that reports no cost still gets one.
   *
   * Built here because two commands publish transcripts. Loaded lazily by the
   * first estimate and refreshed on its own schedule; a failure is a log line
   * and a blank cost, never a stalled transcript.
   */
  const pricingConfig = config.eve?.pricing;
  const prices = pricingConfig
    ? new Prices({
        url: pricingConfig.url,
        token: pricingConfig.tokenEnv
          ? process.env[pricingConfig.tokenEnv]
          : undefined,
        log: (line) => console.log(line),
      })
    : undefined;
  // Warm it now so the first step of the first turn is already priced.
  if (prices) void prices.load();

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
          { dryRun: values["dry-run"], log: (line) => console.log(line) },
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
      case "dm":
      case "send": {
        const [who, ...words] = args;
        const text = words.join(" ").trim();
        if (!who)
          fail(
            'usage: hex send [config] <npub | <relay-host>\'<group-id>> "message"',
          );

        /**
         * Which protocol, from the shape of the target.
         *
         * The two notations cannot be confused for one another — an npub is
         * bech32 or 64 hex, a NIP-29 group is `<relay-host>'<group-id>` and
         * NIP-29 itself writes it that way. So the transport is inferred and
         * `--transport` is an override for the case where a target is
         * ambiguous or a config offers two. `hex dm` forces nip-17, because
         * that is what the word has always meant here.
         */
        const looksLikeGroup = who.includes("'");
        const transportName =
          command === "dm"
            ? "nip-17"
            : (values.transport ?? (looksLikeGroup ? "nip-29" : "nip-17"));

        if (transportName !== "nip-17" && transportName !== "nip-29")
          fail(
            `--transport ${transportName} is not a transport this build has — nip-17 or nip-29`,
          );
        // A file IS a message. Words are only required when nothing else is
        // being sent — `--as-file` in particular needs the text EMPTY, since a
        // kind 15's content is the URL and nothing else.
        if (!text && (values.attach ?? []).length === 0)
          fail("a message with no words and no files in it says nothing");

        const resolved = await resolveSigner(config.identity.signer, {
          baseDir: loaded.baseDir,
          relays,
        });

        /**
         * Files, uploaded before the message that points at them.
         *
         * Encrypted unless told otherwise IN A DM: that message is sealed and
         * wrapped, and a plain image inside it is a public URL on a public
         * host, which undoes the envelope for the one part of the message
         * anyone actually looks at. A group message is already public, so
         * encrypting its attachment hides it from the very people it is for —
         * there, plain is the default and `--encrypt` is the override.
         */
        const attachments = values.attach ?? [];
        const imetas: string[][] = [];
        const uploads: Uploaded[] = [];
        let body = text;

        if (attachments.length > 0) {
          const blossomConfig = config.tools?.blossom;
          if (!blossomConfig?.servers.length)
            fail(
              "attaching a file needs `tools.blossom.servers` — there is no default host",
            );
          const encrypted = values["no-encrypt"]
            ? false
            : transportName === "nip-17" &&
              blossomConfig.encryptByDefault !== false;

          for (const path of attachments) {
            const uploaded = await upload(path, {
              servers: blossomConfig.servers,
              signer: resolved.signer,
              encrypted,
              log: (line) => console.log(line),
            });
            imetas.push(imetaTag(uploaded));
            uploads.push(uploaded);
            body = body ? `${body}\n${uploaded.url}` : uploaded.url;
            console.log(
              `[hex] ${basename(path)} → ${uploaded.url}${encrypted ? " (encrypted)" : ""}`,
            );
          }
        }

        if (transportName === "nip-29") {
          const [host, groupId] = who.includes("'")
            ? (who.split("'", 2) as [string, string])
            : fail(
                `${who} is not a group — NIP-29 names one <relay-host>'<group-id>`,
              );
          const relay = host.startsWith("ws") ? host : `wss://${host}`;
          const group = config.transports.find(
            (t): t is Extract<TransportConfig, { type: "nip-29" }> =>
              t.type === "nip-29",
          );
          if (!group) fail("this config has no nip-29 transport");
          if (
            !group.groups.some(
              (configured) =>
                configured.id === groupId &&
                configured.relay.replace(/\/$/, "") === relay.replace(/\/$/, ""),
            )
          )
            fail(
              `${who} is not a group this config joins — add it to the nip-29 transport first`,
            );

          const transport = new Nip29Transport({
            relays,
            signer: resolved.signer,
            pubkey: resolved.pubkey,
            groups: group.groups,
            mentions: config.mentions,
            since: Math.floor(Date.now() / 1000),
          });

          if (values["dry-run"]) {
            console.log(`would post to ${who}: ${body}`);
          } else {
            const id = await transport.post(
              { transport: "nip-29", id: groupId, relay },
              body,
              imetas,
            );
            console.log(`sent ${id}`);
          }
          transport.stop();
          await resolved.close();
          return;
        }

        const dm = dmTransport(config.transports);
        if (!dm) fail("this config has no nip-17 transport");

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

        const transport = new Nip17Transport({
          relays,
          signer: resolved.signer,
          pubkey: resolved.pubkey,
          inboxRelays: config.relays.dm,
          relayHints: config.relays.dm,
          readRelays: config.relays.read,
          allow: dm.allow.map((allowed) => allowed.pubkey),
          since: Math.floor(Date.now() / 1000),
          log: (line) => console.log(line),
        });

        /**
         * A kind 15 when the message IS the file.
         *
         * NIP-17 says a file message's content is the URL and nothing else, so
         * this is only offered for a single attachment with no words of its
         * own — anything else would have to throw away either the text or the
         * other files to fit the shape.
         */
        const asFile =
          values["as-file"] && uploads.length === 1 && !text.trim();
        if (values["as-file"] && !asFile)
          fail(
            "--as-file needs exactly one attachment and no message text: a kind 15's content is the URL",
          );

        const kind = asFile ? KIND_FILE_MESSAGE : undefined;
        const messageTags = asFile
          ? [...imetas, ...fileMessageTags(uploads[0]!)]
          : imetas;

        if (values["dry-run"]) {
          console.log(
            `would send to ${nip19.npubEncode(peer)} as kind ${kind ?? 14}: ${body}`,
          );
          for (const tag of messageTags) console.log(`  ${tag.join(" | ")}`);
        } else {
          const id = await transport.send(
            peer,
            body,
            undefined,
            messageTags,
            kind,
          );
          console.log(`sent ${id}${asFile ? " (kind 15)" : ""}`);
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
          // Live progress needs somewhere both sides can reach: a DM inbox relay
          // may refuse kind 21059, and the head says where it went instead.
          relayHints: config.relays.dm,
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
            deltaRelays: config.relays.dm,
            prices,
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

        /**
         * Why the follow ended, which is not the same as how the session ended.
         *
         * The endpoint is a live follow with no end of its own, so the stream
         * finishing means the CONNECTION finished — the dev server closed it, the
         * network went away, undici raised its opaque `terminated`. None of that
         * is the agent being done, and a head that claims `done` because a socket
         * dropped is a lie a reader cannot detect. So a disconnect leaves the
         * status exactly where Eve last put it, and a restart resumes from the
         * cursor.
         */
        let disconnected = false;
        try {
          for await (const { index, event } of streamSession({
            host,
            sessionId,
            startIndex: transcript.streamIndex,
            signal: abort.signal,
          }))
            await transcript.handle(event, index);
          disconnected = true;
        } catch (error) {
          if (abort.signal.aborted) {
            // The operator's Ctrl-C, not a failure.
          } else if (isDisconnect(error)) {
            disconnected = true;
            console.log(`stream ended: ${describeDisconnect(error)}`);
          } else throw error;
        }

        if (interrupted) await transcript.close("aborted");
        else if (disconnected) await transcript.close();
        else await transcript.close("done");
        transport?.stop();
        store.close();
        await resolved.close();
        return;
      }

      case "serve": {
        const transcriptConfig = config.transcript;
        if (!transcriptConfig)
          fail(
            "this config has no `transcript` section, so a session would run with nobody to read it",
          );
        const host = values.host ?? config.eve?.host;
        if (!host)
          fail("no Eve host — set `eve.host` in the config or pass --host");
        const dm = dmTransport(config.transports);
        if (!dm)
          fail(
            "`serve` answers private messages, so it needs a nip-17 transport",
          );

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
        const store = HexStore.open(home.db);

        const startedAt = Math.floor(Date.now() / 1000);
        const transport = new Nip17Transport({
          relays,
          signer: resolved.signer,
          pubkey: resolved.pubkey,
          inboxRelays: config.relays.dm,
          // Live progress needs somewhere both sides can reach: a DM inbox relay
          // may refuse kind 21059, and the head says where it went instead.
          relayHints: config.relays.dm,
          readRelays: config.relays.read,
          allow: dm.allow.map((peer) => peer.pubkey),
          since: startedAt,
          /**
           * Instructions from the operator, on the same wraps as the messages.
           *
           * Not gated by the reply gate: a control event is not a question and
           * costs no model turn, so `before-start` and the rate limit — which
           * exist to stop a backlog spending money — would only make a stop
           * button unreliable. What it IS gated by is authorship, in
           * `parseSessionControl`.
           */
          onRumor: (rumor) => {
            const read = parseSessionControl(rumor as never, {
              agent: resolved.pubkey,
              operator: transcriptConfig.to[0] ?? resolved.pubkey,
            });
            if (!read) return;
            if ("refused" in read) {
              console.log(`[hex] control ignored: ${read.refused}`);
              return;
            }
            void server.control(read.control);
          },
          log: (line) => console.log(line),
        });

        /**
         * Hex's own tools, if the config opened a bridge for them.
         *
         * The runtime does the thinking and this process does the Nostr: reading
         * relays, resolving bech32, and — the one that matters — speaking. Set
         * up here rather than inside `EveServer` because these are the operator's
         * tools, bound to the operator's relays and key, and the server's job is
         * to run turns, not to decide what an agent may do.
         */
        const bridgeConfig = config.eve?.bridge;


        /**
         * The write tools, only if the config asked for them.
         *
         * What these produce is signed by the agent's key and cannot be
         * recalled, so the default is read-only and turning it on is a decision
         * someone made on purpose in a file.
         */
        const publishConfig = config.tools?.publish;
        const publishing =
          bridgeConfig && publishConfig?.enabled
            ? new PublishTools({
                signer: resolved.signer,
                pubkey: resolved.pubkey,
                relays,
                publishRelays: config.relays.publish,
                allowKinds: publishConfig.kinds,
                perHour: publishConfig.perHour,
                dryRun: publishConfig.dryRun,
                log: (line) => console.log(line),
              })
            : undefined;

        /**
         * Uploading, if the operator named somewhere to upload to.
         *
         * Built per message rather than once: whether an attachment is
         * encrypted depends on the ROOM it is going to, and only the inbound
         * message knows which that is.
         */
        const blossomConfig = config.tools?.blossom;
        const blossomFor = (inbound?: Inbound) =>
          bridgeConfig && blossomConfig?.enabled
            ? new BlossomTools({
                servers: blossomConfig.servers,
                signer: resolved.signer,
                // A private conversation's file is encrypted; a public group's
                // is not, because encrypting it hides it from the room.
                // A private conversation's file is encrypted, and so is one
                // from a run with no room at all — that run was asked for over
                // a gift wrap, and its reader is the operator who asked.
                encryptByDefault:
                  (inbound?.room.transport ?? "nip-17") === "nip-17" &&
                  blossomConfig.encryptByDefault !== false,
                perHour: blossomConfig.perHour,
                log: (line) => console.log(line),
              })
            : undefined;

        /**
         * The read tools, shared by every session.
         *
         * Built once and handed to both the per-message host and the bridge's
         * roomless fallback, so a run reading relays gets the same reader
         * whether or not anybody is talking to it.
         */
        const knowledge: KnowledgeTools | undefined = bridgeConfig
          ? new KnowledgeTools({ relays, readRelays: config.relays.read })
          : undefined;

        /**
         * A repository's issues and patches, when the operator asked for them.
         *
         * Shared rather than per-message: what it reads is public, and which
         * room asked has no bearing on the answer. The signer is handed over
         * only when `write` is on — without it the tool that opens and closes
         * things is not offered at all.
         */
        const gitConfig = config.tools?.git;
        const git =
          bridgeConfig && gitConfig?.enabled
            ? new GitTools({
                relays,
                readRelays: config.relays.read,
                publishRelays: config.relays.publish,
                signer: gitConfig.write ? resolved.signer : undefined,
                pubkey: gitConfig.write ? resolved.pubkey : undefined,
                log: (line) => console.log(line),
              })
            : undefined;

        let bridge: ToolBridge | undefined;
        if (bridgeConfig) {
          const token = process.env[bridgeConfig.tokenEnv];
          if (!token)
            fail(
              `eve.bridge.tokenEnv names $${bridgeConfig.tokenEnv}, which is not set — the bridge will not open without a shared token`,
            );
          bridge = new ToolBridge({
            port: bridgeConfig.port,
            token,
            /**
             * What any session can do, room or no room.
             *
             * Built lazily and per call so it is never a stale object, and with
             * no `incoming` — which is what drops `chat.*` from it. Reading
             * relays, resolving entities, publishing as the agent and uploading
             * a blob are all things a run can legitimately want without there
             * being anybody to talk to.
             */
            fallback: () =>
              new RoomTools({
                transport,
                requestedBy: transcriptConfig.to[0],
                selfPubkey: resolved.pubkey,
                knowledge,
                publish: publishing,
                blossom: blossomFor(),
                git,
                log: (line) => console.log(line),
              }),
            log: (line) => console.log(line),
          });
          await bridge.start();
        }

        const server = new EveServer({
          host,
          transport,
          reply: !values["no-reply"],
          /**
           * What this run was set up with, asked of the runtime itself.
           *
           * The instructions file in this config is not it: under `serve` the
           * prompt lives on the Eve side, and publishing this package's copy
           * would describe an agent nobody ran.
           */
          describe: async () => {
            const info = await readAgentInfo({ host });
            if (!info) return undefined;
            return {
              name: config.profile.name ?? transcriptConfig.slug,
              about: config.profile.about,
              picture: config.profile.picture,
              instructions: info.instructions,
              tools: info.tools,
              repositories: config.repositories,
            };
          },
          /**
           * Who is asking, and what about — resolved once, before the run.
           *
           * Uses the same reader the tools use, so what the model is told up
           * front and what it would learn by looking cannot disagree.
           */
          ground: knowledge
            ? (input) => knowledge.ground(input)
            : undefined,
          tools:
            bridge && knowledge
              ? {
                  bridge,
                  host: (inbound) =>
                    new RoomTools({
                      transport,
                      incoming: inbound,
                      requestedBy: transcriptConfig.to[0],
                      selfPubkey: resolved.pubkey,
                      knowledge,
                      publish: publishing,
                      blossom: blossomFor(inbound),
                      git,
                      log: (line) => console.log(line),
                    }),
                }
              : undefined,
          log: (line) => console.log(line),
          transcript: {
            agentPubkey: resolved.pubkey,
            slug: transcriptConfig.slug,
            recipients: transcriptConfig.to,
            store,
            sink: transport,
            deltas: transcriptConfig.deltas,
            deltaRelays: config.relays.dm,
            prices,
            log: (line) => console.log(line),
          },
        });

        console.log(`npub    ${nip19.npubEncode(resolved.pubkey)}`);
        console.log(`eve     ${host}`);
        console.log(
          `to      ${transcriptConfig.to.map((p) => nip19.npubEncode(p).slice(0, 16) + "…").join(", ")}`,
        );
        console.log(
          `allow   ${dm.allow.map((peer) => nip19.npubEncode(peer.pubkey).slice(0, 16) + "…").join(", ")}`,
        );
        console.log(
          values["no-reply"]
            ? "publishing sessions only — nothing will be said in the conversation"
            : "answering in the conversation, with the session published alongside",
        );

        /**
         * The gate decides, before a single token is spent.
         *
         * Not optional and not a nicety. A NIP-17 inbox filter has to reach two
         * days back — a wrap's timestamp is randomised that far, so a strict
         * `since` drops messages sent this second — which means every start reads
         * the BACKLOG. Without the gate, the first run of this command opened an
         * Eve session for a month of old conversation and queued twenty more:
         * real money, on questions nobody had just asked.
         *
         * `before-start` is the rule that matters here. The rest matter too: its
         * own messages come back through the same subscription, four relays
         * deliver the same wrap four times, and one turn per room at a time is
         * what stops a stall fanning out.
         */
        const gate = new ReplyGate({
          selfPubkey: resolved.pubkey,
          mentions: config.mentions,
          startedAt,
          repliesPerRoomPerHour: config.limits.repliesPerRoomPerHour,
          now: () => Math.floor(Date.now() / 1000),
        });

        /**
         * One turn per message, and a failure is reported rather than fatal.
         *
         * A daemon that dies on one bad question stops answering every later one,
         * which is the failure mode of every bot that has ever gone quiet without
         * saying why.
         */
        const subscription = transport.start().subscribe({
          next: (inbound) => {
            const verdict = gate.consider(inbound);

            /**
             * `interrupt` is the one verdict that asks for an action.
             *
             * It used to be logged with the refusals and the message thrown
             * away, so writing while Hex was working meant not being answered at
             * all — the worst reading of "not that, this". The running turn is
             * cancelled and this message takes over.
             */
            if (!verdict.reply && verdict.reason === "interrupt") {
              console.log(
                `[hex] ${inbound.author.slice(0, 8)}… interrupted: ${inbound.text.slice(0, 80)}`,
              );
              gate.begin(inbound);
              void server
                .interrupt(inbound)
                .then(() => gate.end(inbound, true))
                .catch((error: unknown) => {
                  gate.end(inbound, false);
                  console.log(
                    `[hex] the turn failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                });
              return;
            }

            if (!verdict.reply) {
              // Said out loud, because an unanswered message with no explanation
              // is the hardest kind of bug to be told about.
              if (
                verdict.reason !== "own-message" &&
                verdict.reason !== "duplicate"
              )
                console.log(
                  `[hex] ${inbound.author.slice(0, 8)}… not answered: ${verdict.reason}`,
                );
              return;
            }

            console.log(
              `[hex] ${inbound.author.slice(0, 8)}… asked: ${inbound.text.slice(0, 80)}`,
            );
            gate.begin(inbound);
            void server
              .handle(inbound)
              .then(() => gate.end(inbound, true))
              .catch((error: unknown) => {
                gate.end(inbound, false);
                console.log(
                  `[hex] the turn failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          },
          error: (error: unknown) => {
            console.log(
              `[hex] the inbox stopped: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });

        if (bridge)
          console.log(
            `tools   http://127.0.0.1:${bridge.port} — chat.respond, chat.react, chat.history, nostr.help, nostr.req, nostr.resolve${publishing ? ` + nostr.publish, nostr.sign${publishConfig?.dryRun ? " (dry run)" : ""}` : ""}`,
          );
        /**
         * Settle anything the last run left mid-flight before taking new work.
         *
         * A head that says `active` because a process was killed is a lie no
         * reader can detect, and it never expires on its own.
         */
        await server.catchUp();

        console.log(`listening dms on ${config.relays.dm.join(", ")}`);

        await new Promise<void>((resolveRun) => {
          const shutdown = (signal: string) => {
            console.log(`\n${signal} — stopping`);
            resolveRun();
          };
          process.once("SIGINT", () => shutdown("SIGINT"));
          process.once("SIGTERM", () => shutdown("SIGTERM"));
        });

        subscription.unsubscribe();
        // Every followed session keeps whatever status Eve last reported: the
        // follower is leaving, the sessions are not over.
        await server.close();
        bridge?.stop();
        transport.stop();
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
