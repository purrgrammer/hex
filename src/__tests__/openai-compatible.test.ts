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
import type { BrainRequest } from "../brain/types.js";

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

/** A chat-completions endpoint that records what it was sent. */
async function startProvider(
  reply: { status?: number; body?: unknown } = {},
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
      response.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify(
          reply.body ?? {
            choices: [
              { message: { content: "  a kind 9 is a group message  " } },
            ],
          },
        ),
      );
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

const SELF = "a".repeat(64);

function request(overrides: Partial<BrainRequest> = {}): BrainRequest {
  return {
    instructions: "You are Hex.",
    history: [],
    incoming: {
      id: "id1",
      author: "b".repeat(64),
      text: "what is kind 9?",
      createdAt: 1000,
      room: { transport: "nip-29", id: "dev", relay: "wss://groups.example/" },
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
    const messages = buildMessages(
      request({
        history: [
          { author: "c".repeat(64), name: "alice", text: "hi", at: 1 },
          { author: SELF, text: "hello", at: 2 },
        ],
      }),
      SELF,
    );

    expect(messages[0]).toEqual({ role: "system", content: "You are Hex." });
    expect(messages[1]).toEqual({ role: "user", content: "alice: hi" });
    expect(messages[2]).toEqual({ role: "assistant", content: "hello" });
    expect(messages[3]!.role).toBe("user");
    expect(messages[3]!.content).toContain("what is kind 9?");
  });

  it("falls back to a short pubkey when there is no display name", () => {
    const messages = buildMessages(
      request({
        history: [{ author: "c".repeat(64), text: "hi", at: 1 }],
      }),
    );
    expect(messages[1]!.content).toBe("cccccccc…: hi");
  });
});

describe("OpenAICompatibleBrain", () => {
  it("posts to the right path with the key and the model", async () => {
    provider = await startProvider();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "some-model",
      apiKey: "sk-test",
      headers: { "X-Extra": "yes" },
      maxTokens: 256,
      temperature: 0.4,
    });

    const reply = await brain.respond(request());

    expect(reply).toBe("a kind 9 is a group message");
    const [captured] = provider.received;
    expect(captured!.url).toBe("/v1/chat/completions");
    expect(captured!.headers.authorization).toBe("Bearer sk-test");
    expect(captured!.headers["x-extra"]).toBe("yes");
    expect(captured!.body.model).toBe("some-model");
    expect(captured!.body.max_tokens).toBe(256);
    expect(captured!.body.temperature).toBe(0.4);
  });

  it("sends no Authorization header when there is no key", async () => {
    // A local llama.cpp wants no auth, and `Bearer undefined` is a 401.
    provider = await startProvider();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "local",
    });
    await brain.respond(request());
    expect(provider.received[0]!.headers.authorization).toBeUndefined();
  });

  it("omits max_tokens and temperature when unset", async () => {
    // Sending nulls makes strict providers reject the whole request.
    provider = await startProvider();
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "local",
    });
    await brain.respond(request());
    expect(provider.received[0]!.body).not.toHaveProperty("max_tokens");
    expect(provider.received[0]!.body).not.toHaveProperty("temperature");
  });

  it("throws on a rejected request instead of going quiet", async () => {
    // `null` means "stay silent" and is a legitimate answer, so a wrong key must
    // not be able to produce it — a bot with a bad key would be indistinguishable
    // from one that had nothing to add.
    provider = await startProvider({
      status: 401,
      body: { error: { message: "invalid api key" } },
    });
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
      apiKey: "sk-wrong",
    });

    await expect(brain.respond(request())).rejects.toThrow(/401/);
  });

  it("never puts the key in an error message", async () => {
    provider = await startProvider({ status: 500, body: { error: "boom" } });
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
      apiKey: "sk-secret-value",
    });

    await expect(brain.respond(request())).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("sk-secret-value"),
      }) as Error,
    );
  });

  it("treats an empty completion as silence", async () => {
    provider = await startProvider({
      body: { choices: [{ message: { content: "   " } }] },
    });
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
    });
    expect(await brain.respond(request())).toBeNull();
  });

  it("treats a response with no choices as silence", async () => {
    provider = await startProvider({ body: {} });
    const brain = new OpenAICompatibleBrain({
      baseUrl: provider.baseUrl,
      model: "m",
    });
    expect(await brain.respond(request())).toBeNull();
  });

  it("reports an unreachable provider with its URL", async () => {
    const brain = new OpenAICompatibleBrain({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      timeoutMs: 500,
    });
    await expect(brain.respond(request())).rejects.toThrow(/127\.0\.0\.1:1/);
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
});
