/**
 * The tools Hex owns, reachable from the runtime that does the thinking.
 *
 * Eve runs the agent in its own process, so a tool it calls executes there — and
 * Hex's tools cannot: `chat.respond` has to answer the exact message that started
 * the turn, on the transport that delivered it, signed by the key that only this
 * process holds. Moving that knowledge into the runtime would mean teaching the
 * runtime about relays, rooms and gift wraps, which is the coupling this package
 * exists to avoid.
 *
 * So the call comes back. A loopback HTTP server binds each live session to the
 * `ToolHost` for the message being answered, and Eve's tool definitions are
 * three lines of `fetch` that know a session id and nothing else. The runtime
 * never sees a relay; the transport never sees a model — the same seam
 * `tools/types.ts` describes, with a process boundary in the middle of it.
 *
 * Three things make it safe to leave open:
 *
 * - It listens on 127.0.0.1 only, so nothing off this machine can reach it.
 * - Every call carries a shared token. Loopback is not a permission — anything
 *   running as any user on this box can reach a loopback port.
 * - **The session id is not the model's to choose.** It is taken from
 *   `ctx.session` on the Eve side, and a session Hex has not bound answers
 *   nothing. Were it an argument, a model could address one correspondent's
 *   answer into another correspondent's conversation.
 *
 * Calls are deduped on Eve's `callId`, because Eve replays a step that was
 * interrupted mid-execution: a retried `chat.respond` would otherwise send the
 * same message twice. The recorded result is replayed instead, which is what the
 * runtime would have recorded had it not been interrupted.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";

import type { ToolHost, ToolResult, ToolSpec } from "../tools/types.js";

export interface ToolBridgeOptions {
  /** Loopback port. 0 asks the OS for one, which `port` reports back. */
  port: number;
  /** Shared secret, sent as `Authorization: Bearer <token>`. */
  token: string;
  log?: (line: string) => void;
}

/** How many completed calls are remembered for replay. */
const MAX_REMEMBERED = 200;

export class ToolBridge {
  private server?: Server;
  private readonly hosts = new Map<string, ToolHost>();
  /** `callId` → what it returned, so an interrupted step replays rather than repeats. */
  private readonly done = new Map<string, ToolResult>();

  constructor(private readonly options: ToolBridgeOptions) {}

  /** The port actually in use, once listening. */
  get port(): number {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : 0;
  }

  /**
   * Point a session's tools at the message being answered.
   *
   * Called once per turn with a fresh host: the per-turn caps in `RoomTools`
   * (one answer, and no answer at all once the turn is cancelled) are per-host,
   * so rebinding is what resets them.
   */
  bind(sessionId: string, host: ToolHost): void {
    this.hosts.set(sessionId, host);
  }

  /** Whatever is currently bound, for a caller that wants to know what landed. */
  hostFor(sessionId: string): ToolHost | undefined {
    return this.hosts.get(sessionId);
  }

  unbind(sessionId: string): void {
    this.hosts.delete(sessionId);
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.route(request)
        .then(({ status, body }) => {
          const text = JSON.stringify(body);
          response.writeHead(status, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(text),
          });
          response.end(text);
        })
        .catch((error: unknown) => {
          // A tool that throws is a tool result, not a dead socket: the runtime
          // is told what went wrong and gets to decide what to do about it.
          const text = JSON.stringify({ ok: false, output: message(error) });
          response.writeHead(500, { "content-type": "application/json" });
          response.end(text);
        });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.options.log?.(`[hex] tools on http://127.0.0.1:${this.port}`);
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.hosts.clear();
  }

  private async route(
    request: IncomingMessage,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/health") return { status: 200, body: { ok: true } };

    const header = request.headers.authorization ?? "";
    if (header !== `Bearer ${this.options.token}`)
      return { status: 401, body: { ok: false, output: "bad token" } };

    if (url.pathname === "/tools" && request.method === "GET") {
      const host = this.hosts.get(url.searchParams.get("session") ?? "");
      const specs: ToolSpec[] = host ? host.list() : [];
      return { status: 200, body: { tools: specs } };
    }

    if (url.pathname === "/call" && request.method === "POST") {
      const body = await json(request);
      const sessionId = str(body.session);
      const callId = str(body.callId);
      const name = str(body.name);
      const args = isRecord(body.arguments) ? body.arguments : {};

      if (!sessionId || !name)
        return {
          status: 400,
          body: { ok: false, output: "a call needs `session` and `name`" },
        };

      if (callId) {
        const already = this.done.get(callId);
        // Eve re-runs a step it interrupted. The answer already went out; saying
        // it twice is the failure this exists to prevent.
        if (already) return { status: 200, body: already };
      }

      const host = this.hosts.get(sessionId);
      if (!host)
        return {
          status: 200,
          body: {
            ok: false,
            output:
              "this session has no room bound to it, so there is nobody to speak to",
          },
        };

      const result = await host.call({ name, arguments: args });
      if (callId) this.remember(callId, result);
      this.options.log?.(
        `[hex] ${name} → ${result.ok ? "ok" : "refused"}: ${result.output.slice(0, 80)}`,
      );
      return { status: 200, body: result };
    }

    return { status: 404, body: { ok: false, output: "no such route" } };
  }

  private remember(callId: string, result: ToolResult): void {
    this.done.set(callId, result);
    // Bounded: a long-lived daemon must not accumulate every call it ever served.
    while (this.done.size > MAX_REMEMBERED) {
      const oldest = this.done.keys().next().value;
      if (oldest === undefined) break;
      this.done.delete(oldest);
    }
  }
}

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.length;
    // A tool argument is prose and a filter, not a payload.
    if (bytes > 256 * 1024) throw new Error("call body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
