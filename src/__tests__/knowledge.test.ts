import { describe, it, expect, afterEach } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { createRelays } from "../relays.js";
import {
  KnowledgeTools,
  MAX_QUERY_LIMIT,
  normalizeNipId,
  parseKindTable,
} from "../tools/knowledge.js";
import { HELP_TOOL, REQ_TOOL, RESOLVE_TOOL } from "../tools/types.js";
import { COMMANDS, commandCatalogue } from "../tools/knowledge.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const authorKey = generateSecretKey();
const author = getPublicKey(authorKey);

/** An excerpt of the NIPs index, in the shape the real one has. */
const README = `
# NIPs

## Event Kinds

| kind          | description                | NIP                                   |
| ------------- | -------------------------- | ------------------------------------- |
| \`0\`         | User Metadata              | [01](01.md)                           |
| \`1\`         | Short Text Note            | [10](10.md)                           |
| \`9\`         | Chat Message               | [29](29.md)                           |
| \`1059\`      | Gift Wrap                  | [59](59.md)                           |
| \`5000\`-\`5999\` | Job Request            | [90](90.md)                           |
`;

function fakeFetch(pages: Record<string, string>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const body = pages[url];
    if (body === undefined)
      return new Response("not found", { status: 404 }) as unknown as Response;
    return new Response(body, { status: 200 }) as unknown as Response;
  }) as unknown as typeof fetch;
}

const NIPS = "https://raw.githubusercontent.com/nostr-protocol/nips/master";

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;

afterEach(async () => {
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

describe("parseKindTable", () => {
  it("reads kind, description and NIP out of the index", () => {
    const kinds = parseKindTable(README);
    expect(kinds.get(9)).toEqual({
      kind: 9,
      description: "Chat Message",
      nip: "29",
    });
    expect(kinds.get(1059)?.nip).toBe("59");
  });

  it("skips a range rather than guessing at it", () => {
    // `5000`-`5999` is not one kind, and pretending it is 5000 would be a lie.
    const kinds = parseKindTable(README);
    expect(kinds.has(5000)).toBe(false);
  });
});

describe("normalizeNipId", () => {
  it("accepts every way a NIP gets written", () => {
    expect(normalizeNipId("nip-65")).toBe("65");
    expect(normalizeNipId("NIP29")).toBe("29");
    expect(normalizeNipId("1")).toBe("01");
    expect(normalizeNipId("C7")).toBe("C7");
  });

  it("refuses something that is not a NIP id", () => {
    expect(normalizeNipId("../../etc/passwd")).toBeUndefined();
    expect(normalizeNipId("")).toBeUndefined();
  });
});

describe("grimoire.help", () => {
  it("answers a kind number from the spec, with the NIP that defines it", async () => {
    // The whole reason this tool exists: asked from memory, the model called
    // kind 9 an MLS event.
    relays = createRelays();
    const tools = new KnowledgeTools({
      relays,
      readRelays: [],
      fetchImpl: fakeFetch({
        [`${NIPS}/README.md`]: README,
        [`${NIPS}/29.md`]: "# NIP-29\n\nRelay-based groups.",
      }),
    });

    const result = await tools.call(HELP_TOOL, { kind: 9 });
    const payload = JSON.parse(result.output) as {
      kind: { description: string; nip: string };
      nip: { id: string; text: string };
    };

    expect(result.ok).toBe(true);
    expect(payload.kind.description).toBe("Chat Message");
    // The kind's own NIP is fetched without being asked for: a kind number alone
    // is the common question, and the answer is in that document.
    expect(payload.nip.id).toBe("29");
    expect(payload.nip.text).toContain("Relay-based groups");
  });

  it("says a kind is unknown rather than inventing it", async () => {
    relays = createRelays();
    const tools = new KnowledgeTools({
      relays,
      readRelays: [],
      fetchImpl: fakeFetch({ [`${NIPS}/README.md`]: README }),
    });
    const result = await tools.call(HELP_TOOL, { kind: 424242 });
    expect(result.output).toContain('"known":false');
  });

  it("reports a NIP it could not load", async () => {
    relays = createRelays();
    const tools = new KnowledgeTools({
      relays,
      readRelays: [],
      fetchImpl: fakeFetch({}),
    });
    const result = await tools.call(HELP_TOOL, { nip: "99" });
    expect(result.output).toContain("Could not load");
  });

  it("needs something to look up", async () => {
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [] });
    const result = await tools.call(HELP_TOOL, {});
    expect(result.ok).toBe(false);
  });
});

describe("the command catalogue", () => {
  it("carries grimoire's commands, generated from the app's own registry", () => {
    // A snapshot: `scripts/sync-commands.mjs` regenerates it, and `--check`
    // fails when it is stale.
    expect(COMMANDS.length).toBeGreaterThan(15);
    const req = COMMANDS.find((command) => command.name === "req");
    expect(req?.synopsis).toContain("req");
    expect(req?.flags?.length).toBeGreaterThan(0);
  });

  it("renders as a menu, one command per entry with its flags", () => {
    const menu = commandCatalogue();
    expect(menu).toContain("req");
    expect(menu).toContain("flags:");
  });

  it("answers a command by name, and names the set when asked for one that is not there", async () => {
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [] });

    const found = await tools.call(HELP_TOOL, { command: "chat" });
    expect(found.ok).toBe(true);
    expect(found.output).toContain("synopsis");

    const missing = await tools.call(HELP_TOOL, { command: "sendMessage" });
    expect(missing.output).toContain("No such command");
    expect(missing.output).toContain("req");
  });

  it("enumerates the command names in the tool schema", () => {
    // A provider that enforces enums will not let the model guess.
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [] });
    const help = tools.list().find((spec) => spec.name === HELP_TOOL);
    const parameters = help!.parameters as {
      properties: { command: { enum: string[] } };
    };
    expect(parameters.properties.command.enum).toContain("req");
  });
});

describe("nostr.req", () => {
  function note(content: string, kind = 1) {
    return finalizeEvent(
      { kind, content, created_at: 1000, tags: [["t", "nostr"]] },
      authorKey,
    );
  }

  it("reads from the configured relays and returns quotable entities", async () => {
    relay = await startMockRelay({ kind: "normal", events: [note("hello")] });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });

    const result = await tools.call(REQ_TOOL, { kinds: [1] });
    const payload = JSON.parse(result.output) as {
      count: number;
      events: { npub: string; nevent: string; content: string }[];
    };

    expect(payload.count).toBe(1);
    // Supplied, not left to the model: one handed only hex writes an npub with a
    // bad checksum, and grimoire renders that as dead text.
    expect(payload.events[0]!.npub).toBe(nip19.npubEncode(author));
    expect(nip19.decode(payload.events[0]!.nevent).type).toBe("nevent");
  });

  it("refuses a filter that constrains nothing", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });
    const result = await tools.call(REQ_TOOL, { limit: 10 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("constrains nothing");
  });

  it("caps the limit however much was asked for", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });
    const result = await tools.call(REQ_TOOL, { kinds: [1], limit: 100_000 });
    const payload = JSON.parse(result.output) as { filter: { limit: number } };
    expect(payload.filter.limit).toBe(MAX_QUERY_LIMIT);
  });

  it("drops a pubkey that is not hex rather than sending it", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });
    const result = await tools.call(REQ_TOOL, {
      kinds: [1],
      authors: ["npub1whatever", author],
    });
    const payload = JSON.parse(result.output) as {
      filter: { authors: string[] };
    };
    expect(payload.filter.authors).toEqual([author]);
  });

  it("keeps single-letter tag filters and drops the rest", async () => {
    relay = await startMockRelay({ kind: "normal", events: [note("tagged")] });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });
    const result = await tools.call(REQ_TOOL, {
      kinds: [1],
      tags: { t: ["nostr"], notaletter: ["x"] },
    });
    const payload = JSON.parse(result.output) as {
      filter: Record<string, unknown>;
    };
    expect(payload.filter["#t"]).toEqual(["nostr"]);
    expect(payload.filter["#notaletter"]).toBeUndefined();
  });

  it("ignores a relay the model invented that is not a websocket URL", async () => {
    relay = await startMockRelay({ kind: "normal", events: [note("hi")] });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });
    const result = await tools.call(REQ_TOOL, {
      kinds: [1],
      relays: ["https://not-a-relay.example"],
    });
    const payload = JSON.parse(result.output) as { relays: string[] };
    expect(payload.relays).toEqual([relay.url]);
  });
});

describe("nostr.resolve", () => {
  it("resolves an npub to its profile", async () => {
    const profile = finalizeEvent(
      {
        kind: 0,
        content: JSON.stringify({ name: "alice" }),
        created_at: 1000,
        tags: [],
      },
      authorKey,
    );
    relay = await startMockRelay({ kind: "normal", events: [profile] });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });

    const result = await tools.call(RESOLVE_TOOL, {
      entity: `nostr:${nip19.npubEncode(author)}`,
    });
    const payload = JSON.parse(result.output) as {
      type: string;
      metadata: { name: string };
    };
    expect(payload.type).toBe("profile");
    expect(payload.metadata.name).toBe("alice");
  });

  it("resolves an nevent to the event itself", async () => {
    const event = finalizeEvent(
      { kind: 1, content: "the note", created_at: 1000, tags: [] },
      authorKey,
    );
    relay = await startMockRelay({ kind: "normal", events: [event] });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });

    const result = await tools.call(RESOLVE_TOOL, {
      entity: nip19.neventEncode({ id: event.id, kind: 1, author }),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("the note");
  });

  it("says an entity could not be loaded rather than guessing", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [relay.url] });
    const result = await tools.call(RESOLVE_TOOL, {
      entity: nip19.noteEncode("f".repeat(64)),
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("could not be loaded");
  });

  it("refuses something that is not bech32", async () => {
    relays = createRelays();
    const tools = new KnowledgeTools({ relays, readRelays: [] });
    const result = await tools.call(RESOLVE_TOOL, {
      entity: "just some words",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not a decodable");
  });
});
