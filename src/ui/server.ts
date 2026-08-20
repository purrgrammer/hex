/**
 * The control plane, as a page on this machine.
 *
 * Two planes, one shape. Everything a browser is shown here is the SAME event
 * the operator's own reader gets over a gift wrap — the local record is a tee of
 * the publisher's one door, not a second account of the run — so the UI served
 * from this port and the UI served from a static host render identical data with
 * identical components. What differs is only where the events came from and who
 * is entitled to send a command.
 *
 * Which is the whole reason this binds to loopback and asks for no password.
 * Remotely, a command is a kind-1779 event signed by the operator's key, and the
 * signature is the authorisation. Here, the caller already has a shell on the
 * machine that holds the agent's secret key: a token would be asking someone to
 * prove they are themselves to a process they could simply kill. Loopback IS the
 * boundary, exactly as it is for the tool bridge next door — and for the same
 * reason as there, nothing about that is true of `0.0.0.0`, so this never binds
 * anywhere else.
 *
 * Control is optional and its absence is honest: `hex ui` opens the store with
 * no daemon behind it, so there is nothing to steer, and `/api/hello` says
 * `control: false` rather than offering buttons that would fail.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { nip19 } from "nostr-tools";

import type { HexConfig } from "../config.js";
import type { HexStore, StoredTranscript } from "../store.js";
import type { RelayHealth } from "../relays.js";
import type { SessionControl } from "../nostr/decode-control.js";
import type { SessionCommand } from "../nostr/types.js";
import type { LiveBus } from "./bus.js";

export interface UiServerOptions {
  /** Loopback port. 0 asks the OS for one, which `port` reports back. */
  port: number;
  store: HexStore;
  bus: LiveBus;
  pubkey: string;
  config: HexConfig;
  /** Where the built browser bundle lives. Absent means API only. */
  webRoot?: string;
  /**
   * How a command reaches the running daemon.
   *
   * Absent means read-only, and the UI is told so. Present, it is the SAME
   * entry point a wrapped kind 1779 arrives at — a local button and a remote
   * operator take the identical path through `EveServer.control`, so the two
   * cannot drift into disagreeing about what `cancel` does.
   */
  control?: (control: SessionControl) => Promise<void>;
  /** Dial every configured relay and report. Absent means the panel is hidden. */
  checkRelays?: () => Promise<Map<string, RelayHealth>>;
  log?: (line: string) => void;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** Commands a local button may send. `start` included; nothing else is added. */
const COMMANDS: readonly SessionCommand[] = [
  "start",
  "respond",
  "steer",
  "cancel",
  "compact",
  "clear",
  "reset",
];

interface Json {
  status: number;
  body: unknown;
}

export class UiServer {
  private server?: Server;

  constructor(private readonly options: UiServerOptions) {}

  get port(): number {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : 0;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.send(response, {
          status: 500,
          body: { error: message(error) },
        });
      });
    });

    await new Promise<void>((ready, failed) => {
      server.once("error", failed);
      // 127.0.0.1 and never a host argument: see the note at the top of the file.
      server.listen(this.options.port, "127.0.0.1", () => {
        server.off("error", failed);
        ready();
      });
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (path === "/api/stream") return this.stream(response);
    if (path.startsWith("/api/")) {
      const answer = await this.api(request, path, url);
      return this.send(response, answer);
    }
    return this.static(path, response);
  }

  // ── The API ───────────────────────────────────────────────────────────────

  private async api(
    request: IncomingMessage,
    path: string,
    url: URL,
  ): Promise<Json> {
    const { store, config, pubkey } = this.options;

    if (path === "/api/hello") {
      const transcript = config.transcript;
      return {
        status: 200,
        body: {
          mode: "local",
          pubkey,
          npub: nip19.npubEncode(pubkey),
          slug: transcript?.slug,
          operator: transcript?.to?.[0],
          eveHost: config.eve?.host,
          control: !!this.options.control,
          relayCheck: !!this.options.checkRelays,
          profile: config.profile,
          mentions: config.mentions,
          limits: config.limits,
          relays: config.relays,
          transports: config.transports.map((transport) =>
            transport.type === "nip-29"
              ? { type: transport.type, groups: transport.groups }
              : {
                  type: transport.type,
                  allow: transport.allow.map((peer) => peer.pubkey),
                },
          ),
          tools: {
            publish: config.tools?.publish?.enabled ?? false,
            publishKinds: config.tools?.publish?.kinds ?? [],
            dryRun: config.tools?.publish?.dryRun ?? false,
            blossom: config.tools?.blossom?.enabled ?? false,
            git: config.tools?.git?.enabled ?? false,
            bridge: !!config.eve?.bridge,
          },
          repositories: config.repositories ?? [],
        },
      };
    }

    if (path === "/api/sessions" && request.method === "GET") {
      const peers = new Map(
        store.conversations().map((row) => [row.sessionId, row]),
      );
      return {
        status: 200,
        body: {
          sessions: store.allTranscripts(200).map((transcript) => ({
            ...view(transcript),
            peer: peers.get(transcript.sessionId)?.peer,
            room: peers.get(transcript.sessionId)?.room || undefined,
          })),
        },
      };
    }

    const one = /^\/api\/sessions\/([0-9a-f]{64})$/.exec(path);
    if (one?.[1] && request.method === "GET") {
      const wireId = one[1];
      const transcript = store.transcriptForNostrId(wireId);
      return {
        status: transcript ? 200 : 404,
        body: transcript
          ? {
              session: view(transcript),
              events: store.eventsFor(wireId),
            }
          : { error: "no run on this machine is published under that id" },
      };
    }

    if (path === "/api/feed" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return {
        status: 200,
        body: {
          events: store.recentEvents(
            Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100,
          ),
        },
      };
    }

    if (path === "/api/peers" && request.method === "GET")
      return { status: 200, body: { peers: store.conversations() } };

    if (path === "/api/relays" && request.method === "POST") {
      const check = this.options.checkRelays;
      if (!check)
        return {
          status: 501,
          body: { error: "this process holds no relay pool to dial with" },
        };
      const health = await check();
      return {
        status: 200,
        body: { relays: Object.fromEntries(health) },
      };
    }

    if (path === "/api/control" && request.method === "POST")
      return this.command(request);

    return { status: 404, body: { error: `no route for ${path}` } };
  }

  /**
   * A button, turned into the same instruction a relay would have delivered.
   *
   * The control object is built here rather than a rumor signed and sent to a
   * relay and read back, because there is nobody to authenticate: the operator
   * is the process. What is NOT skipped is the shape — the same
   * `SessionControl`, the same handler — so a command that works from a phone
   * works from this page and neither has a path of its own to get wrong.
   *
   * `operator` is the configured operator rather than the caller, since it is
   * what the head names and what a later remote command will be checked
   * against. `id` is fresh random bytes: the id is what the daemon dedupes on,
   * and a reused one would be silently ignored as an instruction already obeyed.
   */
  private async command(request: IncomingMessage): Promise<Json> {
    const apply = this.options.control;
    if (!apply)
      return {
        status: 501,
        body: {
          error:
            "this page is a reader — no daemon is running behind it to take commands",
        },
      };

    const body = await readJson(request);
    if (!body) return { status: 400, body: { error: "expected a JSON body" } };

    const command = body.command;
    if (
      typeof command !== "string" ||
      !(COMMANDS as readonly string[]).includes(command)
    )
      return {
        status: 400,
        body: { error: `command must be one of: ${COMMANDS.join(", ")}` },
      };

    const session =
      typeof body.session === "string" && /^[0-9a-f]{64}$/.test(body.session)
        ? body.session
        : undefined;
    // Every verb but `start` names a run that already exists.
    if (command !== "start" && !session)
      return {
        status: 400,
        body: { error: `a ${command} has to name the session it is for` },
      };

    const control: SessionControl = {
      id: randomBytes(32).toString("hex"),
      operator: this.options.config.transcript?.to?.[0] ?? this.options.pubkey,
      agent: this.options.pubkey,
      session: session ?? randomBytes(32).toString("hex"),
      command: command as SessionCommand,
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.request === "string" ? { request: body.request } : {}),
      ...(typeof body.turn === "string" ? { turn: body.turn } : {}),
      ...(typeof body.option === "string" ? { option: body.option } : {}),
      ...(body.policy === "queue" || body.policy === "steer"
        ? { policy: body.policy }
        : {}),
      ...(Array.isArray(body.subjects)
        ? { subjects: body.subjects as string[][] }
        : {}),
    };

    this.options.log?.(`[hex] ui → ${command}${session ? ` ${session.slice(0, 8)}…` : ""}`);
    // Not awaited: `respond` and `steer` run a whole turn, and a browser holding
    // a socket open for four minutes to learn nothing it will not also see on
    // the stream is a request that times out on the way to succeeding.
    void apply(control).catch((error: unknown) => {
      this.options.bus.log(`[hex] the command failed: ${message(error)}`);
    });
    return { status: 202, body: { accepted: control.id, session: control.session } };
  }

  // ── The stream ────────────────────────────────────────────────────────────

  /**
   * Server-sent events, because this only ever goes one way.
   *
   * A websocket would buy a channel back that nothing needs: commands are POSTs
   * with an answer, and everything else here is the agent talking. SSE also
   * reconnects on its own, which matters for a page left open beside a daemon
   * that gets restarted.
   */
  private stream(response: ServerResponse): void {
    const { bus } = this.options;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // The one header that matters behind a proxy: buffering an event stream
      // turns "live" into "all at once, later".
      "x-accel-buffering": "no",
    });

    const write = (message: unknown) => {
      response.write(`data: ${JSON.stringify(message)}\n\n`);
    };

    write({ type: "hello", at: Date.now() });
    for (const line of bus.backlog())
      write({ type: "log", at: line.at, line: line.line });

    const unsubscribe = bus.subscribe(write);
    // A comment line every twenty seconds: an idle agent and a dead socket look
    // identical to a browser otherwise, and it reconnects to find out.
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);

    response.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  // ── The bundle ────────────────────────────────────────────────────────────

  /**
   * The built page, or the router's fallback.
   *
   * Anything that is not a file is `index.html`, because the routes are the
   * browser's. Paths are resolved and then checked to be inside the root: a
   * request for `../../.env` is a request this process would otherwise happily
   * answer with the secret key it was told never to inline.
   */
  private static(path: string, response: ServerResponse): void {
    const root = this.options.webRoot;
    if (!root) {
      this.send(response, {
        status: 404,
        body: {
          error:
            "no web bundle was built — run `npm run build:web`, or use the API",
        },
      });
      return;
    }

    const wanted = resolve(root, "." + normalize(path));
    const file =
      wanted.startsWith(resolve(root)) &&
      existsSync(wanted) &&
      statSync(wanted).isFile()
        ? wanted
        : join(root, "index.html");

    if (!existsSync(file)) {
      this.send(response, {
        status: 404,
        body: { error: "the web bundle is missing its index.html" },
      });
      return;
    }

    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": file.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(response);
  }

  private send(response: ServerResponse, answer: Json): void {
    const text = JSON.stringify(answer.body);
    response.writeHead(answer.status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    response.end(text);
  }
}

/** The store's row, as the wire's id names it — which is all a browser knows. */
function view(transcript: StoredTranscript) {
  return {
    id: transcript.nostrId,
    title: transcript.title,
    status: transcript.status,
    turn: transcript.turn,
    seq: transcript.seq,
    startedAt: transcript.startedAt,
    endedAt: transcript.endedAt,
    inTokens: transcript.inTokens,
    outTokens: transcript.outTokens,
    cacheRead: transcript.cacheRead,
    cacheWrite: transcript.cacheWrite,
    cost: transcript.cost,
    pending: transcript.pending ?? [],
    channel: transcript.channel,
    subjects: transcript.subjects ?? [],
    carriage: transcript.carriage,
    group: transcript.group,
    groupRelay: transcript.groupRelay,
  };
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // A command is a sentence, not an upload.
    if (size > 256 * 1024) return undefined;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
