import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OpenAICompatibleBrain,
  completionsUrl,
  buildMessages,
} from "../brain/openai-compatible.js";
import { createBrain } from "../brain/create.js";
import { parseConfig } from "../config.js";
import { ConsoleTools } from "../tools/console-tools.js";
import { RESPOND_TOOL, wireName } from "../tools/types.js";
import type { BrainRequest } from "../brain/types.js";
import type { Room } from "../transports/types.js";

interface Captured {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface FakeProvider {
  baseUrl: string;
  received: Captured[];
  close(): Promise<void>;
}

/**
 * A chat-completions endpoint that records what it was sent and answers with a
 * scripted sequence — one entry per round trip, so a tool-calling loop can be
 * driven turn by turn.
 */
async function startProvider(
  replies: { status?: number; body?: unknown }[] = [],
): Promise<FakeProvider> {
  const received: Captured[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
      });
      const reply =
        replies[Math.min(received.length - 1, replies.length - 1)] ?? {};
      response.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(reply.body ?? { choices: [] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** An assistant message that calls `respond`. */
function respondCall(text: string, id = "call-1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: RESPOND_TOOL,
                arguments: JSON.stringify({ text }),
              },
            },
          ],
        },
      },
    ],
  };
}

function plainText(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

const SELF = "a".repeat(64);
const ROOM: Room = {
  transport: "nip-29",
  id: "dev",
  relay: "wss://g.example/",
};

function requestWith(
  tools: ConsoleTools,
  overrides: Partial<BrainRequest> = {},
): BrainRequest {
  return {
    instructions: "You are Hex.",
    history: [],
    tools,
    incoming: {
      id: "id1",
      author: "b".repeat(64),
      text: "what is kind 9?",
      createdAt: 1000,
      room: ROOM,
      addressesSelf: true,
      event: {
        id: "id1",
        pubkey: "b".repeat(64),
        created_at: 1000,
        kind: 9,
        content: "what is kind 9?",
        tags: [],
        sig: "",
      },
    },
    ...overrides,
  };
}

/** Collects what `respond` delivered instead of printing it. */
function collector() {
  const said: string[] = [];
  const tools = new ConsoleTools(ROOM, "b".repeat(64), (text) =>
    said.push(text.trim()),
  );
  return { said, tools };
}

let provider: FakeProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

describe("completionsUrl", () => {
  it("keeps the base path when it has no trailing slash", () => {
    // `new URL("chat/completions", ".../v1")` drops the `v1`, which 404s and
    // looks like a broken provider rather than a broken URL.
    expect(completionsUrl("https://api.example/v1")).toBe(
      "https://api.example/v1/chat/completions",
    );
  });

  it("does not double the slash when the base has one", () => {
    expect(completionsUrl("https://api.example/v1/")).toBe(
      "https://api.example/v1/chat/completions",
    );
  });
});

describe("buildMessages", () => {
  it("labels each speaker and marks Hex's own turns as the assistant", () => {
    // A group is not a two-party chat: unlabelled `user` turns lose who asked.
    const { tools } = collector();
    const messages = buildMessages(
      requestWith(tools, {
        history: [
          { author: "c".repeat(64), name: "alice", text: "hi", at: 1 },
          { author: SELF, text: "hello", at: 2 },
        ],
      }),
      SELF,
    );

    // One system message: the operator's instructions, then the runtime's rules
    // and the tool paragraph. Assert on the conversation, not on indices.
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("You are Hex.");
    expect(messages[0]!.content).toContain(RESPOND_TOOL);
    const conversation = messages.filter(
      (message) => message.role !== "system",
    );
    expect(conversation[0]).toEqual({ role: "user", content: "alice: hi" });
    expect(conversation[1]).toEqual({ role: "assistant", content: "hello" });
    expect(conversation[2]!.content).toContain("what is kind 9?");
  });

  it("falls back to a short pubkey when there is no display name", () => {
    const { tools } = collector();
    const messages = buildMessages(
      requestWith(tools, {
        history: [{ author: "c".repeat(64), text: "hi", at: 1 }],
      }),
    );
    const conversation = messages.filter(
      (message) => message.role !== "system",
    );
    expect(conversation[0]!.content).toBe("cccccccc…: hi");
  });
});

describe("OpenAICompatibleBrain", () => {
  it("offers the host's tools and delivers through respond", async () => {
    provider = await startProvider([{ body: respondCall("a group message") }]);
    const { said, tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "some-model",
      apiKey: "sk-test",
      headers: { "X-Extra": "yes" },
      maxTokens: 256,
      temperature: 0.4,
    });

    const outcome = await brain.turn(requestWith(tools));

    expect(said).toEqual(["a group message"]);
    expect(outcome.delivered).toBe(true);

    const [captured] = provider.received;
    expect(captured!.url).toBe("/v1/chat/completions");
    expect(captured!.headers.authorization).toBe("Bearer sk-test");
    expect(captured!.headers["x-extra"]).toBe("yes");
    expect(captured!.body.model).toBe("some-model");
    expect(captured!.body.tool_choice).toBe("auto");
    // The tool the host offered, in the wire's shape.
    const wireTools = captured!.body.tools as {
      function: { name: string };
    }[];
    // A dot is not a portable function name, so the wire carries an underscore
    // while the prompt and the registry keep the canonical id.
    expect(wireTools.map((tool) => tool.function.name)).toEqual([
      wireName(RESPOND_TOOL),
    ]);
  });

  it("feeds the tool's result back and keeps going", async () => {
    // A model that called a tool must learn what came of it, or it cannot correct
    // course — that feedback loop is the whole point of tools over return values.
    provider = await startProvider([
      {
        body: {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "nonexistent", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      },
      { body: respondCall("recovered") },
    ]);
    const { said, tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
    });

    const outcome = await brain.turn(requestWith(tools));

    expect(said).toEqual(["recovered"]);
    expect(outcome.delivered).toBe(true);
    // The second request carries the assistant's call and the tool's answer.
    const second = provider.received[1]!.body.messages as {
      role: string;
      content: string | null;
    }[];
    // The assistant's own call, then the tool's answer to it, at the end.
    expect(second.slice(-2).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(second.at(-1)!.content).toContain("no tool called");
  });

  it("tells the model when its arguments were not valid JSON", async () => {
    provider = await startProvider([
      {
        body: {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: RESPOND_TOOL, arguments: "{not json" },
                  },
                ],
              },
            },
          ],
        },
      },
      { body: respondCall("second try") },
    ]);
    const { said, tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
    });

    await brain.turn(requestWith(tools));

    expect(said).toEqual(["second try"]);
    const second = provider.received[1]!.body.messages as {
      content: string | null;
    }[];
    expect(second.at(-1)!.content).toContain("not valid JSON");
  });

  it("delivers a plain-text answer that forgot the tool, and says so", async () => {
    // Dropping it would be silence in the room, which is the worse failure.
    provider = await startProvider([{ body: plainText("kind 9, plainly") }]);
    const { said, tools } = collector();
    const lines: string[] = [];
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
      log: (line) => lines.push(line),
    });

    const outcome = await brain.turn(requestWith(tools));

    expect(said).toEqual(["kind 9, plainly"]);
    expect(outcome.delivered).toBe(true);
    expect(lines.some((line) => line.includes("without calling respond"))).toBe(
      true,
    );
  });

  it("can be made strict about the tool contract", async () => {
    provider = await startProvider([{ body: plainText("kind 9, plainly") }]);
    const { said, tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
      deliverPlainText: false,
    });

    const outcome = await brain.turn(requestWith(tools));

    expect(said).toEqual([]);
    expect(outcome.delivered).toBe(false);
    expect(outcome.note).toContain("never called respond");
  });

  it("stops as soon as the answer is delivered", async () => {
    // Answering is terminal: another round trip buys prose nobody reads, or a
    // second message in the room.
    provider = await startProvider([
      { body: respondCall("the answer") },
      { body: plainText("I hope that helped") },
    ]);
    const { said, tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
    });

    const outcome = await brain.turn(requestWith(tools));

    expect(said).toEqual(["the answer"]);
    expect(provider.received).toHaveLength(1);
    expect(outcome.note).toContain("1 step");
  });

  it("stays quiet when the model says and does nothing", async () => {
    provider = await startProvider([{ body: plainText("") }]);
    const { said, tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
    });

    const outcome = await brain.turn(requestWith(tools));

    expect(said).toEqual([]);
    expect(outcome.delivered).toBe(false);
    expect(outcome.note).toBe("stayed quiet");
  });

  it("gives up after maxSteps rather than looping forever", async () => {
    // A model that keeps calling a tool and never answers must not burn a room's
    // budget indefinitely.
    provider = await startProvider([
      {
        body: {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c",
                    type: "function",
                    function: { name: "nonexistent", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const { said, tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
      maxSteps: 3,
    });

    const outcome = await brain.turn(requestWith(tools));

    expect(said).toEqual([]);
    expect(outcome.delivered).toBe(false);
    expect(outcome.note).toContain("3 steps");
    expect(provider.received).toHaveLength(3);
  });

  it("sends no Authorization header when there is no key", async () => {
    // A local llama.cpp wants no auth, and `Bearer undefined` is a 401.
    provider = await startProvider([{ body: respondCall("hi") }]);
    const { tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "local",
    });
    await brain.turn(requestWith(tools));
    expect(provider.received[0]!.headers.authorization).toBeUndefined();
  });

  it("omits max_tokens and temperature when unset", async () => {
    // Sending nulls makes strict providers reject the whole request.
    provider = await startProvider([{ body: respondCall("hi") }]);
    const { tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "local",
    });
    await brain.turn(requestWith(tools));
    expect(provider.received[0]!.body).not.toHaveProperty("max_tokens");
    expect(provider.received[0]!.body).not.toHaveProperty("temperature");
  });

  it("throws on a rejected request instead of going quiet", async () => {
    // Silence is a legitimate outcome, so a wrong key must not be able to produce
    // it — a bot with a bad key would be indistinguishable from one that had
    // nothing to add.
    provider = await startProvider([
      { status: 401, body: { error: { message: "invalid api key" } } },
    ]);
    const { tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
      apiKey: "sk-wrong",
    });

    await expect(brain.turn(requestWith(tools))).rejects.toThrow(/401/);
  });

  it("never puts the key in an error message", async () => {
    provider = await startProvider([{ status: 500, body: { error: "boom" } }]);
    const { tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
      apiKey: "sk-secret-value",
    });

    await expect(brain.turn(requestWith(tools))).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("sk-secret-value"),
      }) as Error,
    );
  });

  it("reports an unreachable provider with its URL", async () => {
    const { tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      timeoutMs: 500,
    });
    await expect(brain.turn(requestWith(tools))).rejects.toThrow(
      /127\.0\.0\.1:1/,
    );
  });
});

describe("createBrain", () => {
  const base = {
    identity: { signer: { type: "nsec", env: "HEX_NSEC" } },
    relays: {
      read: ["wss://r.example"],
      publish: ["wss://r.example"],
      dm: ["wss://r.example"],
    },
    transports: [
      { type: "nip-29", groups: [{ relay: "wss://g.example", id: "d" }] },
    ],
  };

  it("resolves the API key from the environment at startup", () => {
    const config = parseConfig({
      ...base,
      brain: {
        type: "openai-compatible",
        baseUrl: "https://api.example/v1",
        model: "m",
        apiKeyEnv: "HEX_TEST_KEY",
      },
    });
    expect(() => createBrain(config.brain, { env: {} })).toThrow(
      /HEX_TEST_KEY/,
    );
    expect(createBrain(config.brain, { env: { HEX_TEST_KEY: "k" } }).name).toBe(
      "openai-compatible",
    );
  });

  it("honours --brain echo over the configured provider", () => {
    const config = parseConfig({
      ...base,
      brain: {
        type: "openai-compatible",
        baseUrl: "https://api.example/v1",
        model: "m",
        apiKeyEnv: "HEX_TEST_KEY",
      },
    });
    // No key needed: the override is what makes a smoke test possible.
    expect(createBrain(config.brain, { env: {}, override: "echo" }).name).toBe(
      "echo",
    );
  });

  it("refuses an api key written into the config", () => {
    expect(() =>
      parseConfig({
        ...base,
        brain: {
          type: "openai-compatible",
          baseUrl: "https://api.example/v1",
          model: "m",
          apiKey: "sk-oops",
        },
      }),
    ).toThrow(/apiKeyEnv instead/);
  });

  it("refuses a base URL that is not http(s)", () => {
    expect(() =>
      parseConfig({
        ...base,
        brain: {
          type: "openai-compatible",
          baseUrl: "wss://api.example/v1",
          model: "m",
        },
      }),
    ).toThrow(/http\(s\) URL/);
  });

  it("accepts maxSteps", () => {
    const config = parseConfig({
      ...base,
      brain: {
        type: "openai-compatible",
        baseUrl: "https://api.example/v1",
        model: "m",
        maxSteps: 6,
      },
    });
    expect(config.brain.maxSteps).toBe(6);
  });
});

describe("cancelling a turn", () => {
  it("stops before asking the model when it is already cancelled", async () => {
    // No provider is started: reaching the network at all would fail the test.
    const { tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "some-model",
    });

    const outcome = await brain.turn(
      requestWith(tools, { signal: AbortSignal.abort() }),
    );
    expect(outcome.note).toBe("cancelled");
    expect(outcome.delivered).toBe(false);
  });

  it("hands the fetch a signal that fires when the turn is cancelled", async () => {
    // `AbortSignal.any` being constructed is not proof it was wired; this
    // observes the signal the request actually received.
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      controller.abort();
      // Reject the way an aborted fetch does, so the loop takes the abort path.
      throw new Error("aborted");
    }) as unknown as typeof fetch;

    const { tools } = collector();
    const brain = new OpenAICompatibleBrain({
      baseUrl: "http://provider.invalid/v1",
      model: "some-model",
      fetchImpl,
    });

    const outcome = await brain.turn(
      requestWith(tools, { signal: controller.signal }),
    );
    expect(seen?.aborted).toBe(true);
    // A cancel is reported as an outcome, never as a thrown failure.
    expect(outcome.note).toBe("cancelled");
  });

  it("does not run the rest of a batch after a cancel", async () => {
    // A model can ask for three things in one step. Two of them must not run
    // after someone said stop.
    const controller = new AbortController();
    const ran: string[] = [];
    const host = {
      room: ROOM,
      requestedBy: "b".repeat(64),
      delivered: false,
      list: () => [
        {
          name: "grimoire.help",
          description: "d",
          parameters: {},
          prompt: "p",
        },
      ],
      call: async (call: { name: string }) => {
        ran.push(call.name);
        controller.abort();
        return { ok: true, output: "done" };
      },
    };

    const threeCalls = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [1, 2, 3].map((n) => ({
              id: `c${n}`,
              type: "function",
              function: { name: "grimoire_help", arguments: "{}" },
            })),
          },
        },
      ],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(threeCalls), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const brain = new OpenAICompatibleBrain({
      baseUrl: "http://provider.invalid/v1",
      model: "some-model",
      fetchImpl,
    });

    const outcome = await brain.turn(
      requestWith(host as never, { signal: controller.signal }),
    );
    // The wire name, because resolving it back to the canonical id is the
    // host's job and this fake host is standing in for one.
    expect(ran).toEqual(["grimoire_help"]);
    expect(outcome.note).toBe("cancelled");
  });
});
