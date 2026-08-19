import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HexStore, agentHome } from "../store.js";
import { TranscriptPublisher, type RumorSink } from "../transcript.js";
import type { Rumor } from "../nostr/types.js";
import type { Room } from "../transports/types.js";

const AGENT = "9".repeat(64);
const OPERATOR = "1".repeat(64);
const ROOM: Room = { transport: "nip-17", id: OPERATOR };

/** A sink that keeps what it was asked to publish. */
function sink() {
  const sent: { rumor: Rumor; ephemeral: boolean }[] = [];
  const impl: RumorSink = {
    publishRumor: async (rumor, _recipients, options) => {
      sent.push({ rumor, ephemeral: options?.ephemeral ?? false });
      return { delivered: [OPERATOR], undeliverable: [] };
    },
  };
  return { impl, sent };
}

const tag = (rumor: Rumor, name: string) =>
  rumor.tags.find((t) => t[0] === name)?.[1];

describe("TranscriptPublisher", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hex-transcript-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function publisher(store: HexStore, impl: RumorSink) {
    return new TranscriptPublisher({
      agentPubkey: AGENT,
      slug: "hex",
      recipients: [OPERATOR],
      store,
      sink: impl,
      model: { id: "test-model", provider: "test" },
      // No real timers: every delta is flushed by a boundary in these tests.
      setTimer: () => 0,
      clearTimer: () => {},
    });
  }

  it("chains turns and moves the status through a run", async () => {
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    await pub.open("nip-17|peer#abc", ROOM, "a question", { id: "e".repeat(64) });
    pub.startTurn("nip-17|peer#abc");
    await pub.append("nip-17|peer#abc", "user", [
      { type: "text", text: "which relays carry 30023?" },
    ]);
    await pub.append(
      "nip-17|peer#abc",
      "assistant",
      [{ type: "text", text: "checking" }],
      { stop: "end_turn", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
    );
    await pub.status("nip-17|peer#abc", "idle");

    const turns = sent.filter((s) => s.rumor.kind === 1777);
    expect(turns.map((t) => tag(t.rumor, "seq"))).toEqual(["1", "2"]);
    // The second turn names the first: without this a reader sees a fork.
    expect(tag(turns[1]!.rumor, "prev")).toBe(turns[0]!.rumor.id);

    const heads = sent.filter((s) => s.rumor.kind === 31777);
    expect(tag(heads[0]!.rumor, "status")).toBe("active");
    expect(tag(heads.at(-1)!.rumor, "status")).toBe("idle");
    expect(tag(heads.at(-1)!.rumor, "last-seq")).toBe("2");
    expect(tag(heads[0]!.rumor, "e")).toBe("e".repeat(64));
    // Usage accumulates on the head, so what a session spent survives the turns.
    expect(heads.at(-1)!.rumor.tags.find((t) => t[0] === "usage")).toEqual([
      "usage",
      "10",
      "5",
      "0",
      "0",
    ]);

    store.close();
  });

  it("resumes the chain after a restart instead of forking it", async () => {
    const first = HexStore.open(agentHome(home, AGENT).db);
    const one = sink();
    const before = publisher(first, one.impl);
    await before.open("s1", ROOM, "t");
    before.startTurn("s1");
    await before.append("s1", "user", [{ type: "text", text: "one" }]);
    const lastId = one.sent.filter((s) => s.rumor.kind === 1777).at(-1)!.rumor.id;
    first.close();

    // A new process, the same home: the cursor comes back off disk.
    const second = HexStore.open(agentHome(home, AGENT).db);
    const two = sink();
    const after = publisher(second, two.impl);
    await after.open("s1", ROOM, "t");
    after.startTurn("s1");
    await after.append("s1", "assistant", [{ type: "text", text: "two" }]);

    const resumed = two.sent.filter((s) => s.rumor.kind === 1777).at(-1)!.rumor;
    expect(tag(resumed, "seq")).toBe("2");
    expect(tag(resumed, "prev")).toBe(lastId);

    second.close();
  });

  it("closes a session a previous process left open", async () => {
    const first = HexStore.open(agentHome(home, AGENT).db);
    const one = sink();
    const before = publisher(first, one.impl);
    await before.open("s1", ROOM, "t");
    first.close();

    const second = HexStore.open(agentHome(home, AGENT).db);
    expect(second.openTranscripts().map((t) => t.status)).toEqual(["active"]);

    const two = sink();
    await publisher(second, two.impl).closeAll("aborted");

    // A head that says `active` forever is a lie a reader cannot detect.
    const head = two.sent.filter((s) => s.rumor.kind === 31777).at(-1)!.rumor;
    expect(tag(head, "status")).toBe("aborted");
    expect(tag(head, "ended")).toBeDefined();
    expect(second.openTranscripts()).toEqual([]);

    second.close();
  });

  it("streams deltas on an ephemeral wrap and turns on a durable one", async () => {
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = publisher(store, impl);

    await pub.open("s1", ROOM, "t");
    pub.startTurn("s1");
    pub.push("s1", "text", "checking the ");
    pub.push("s1", "text", "relay monitors");
    await pub.append("s1", "assistant", [
      { type: "text", text: "checking the relay monitors" },
    ]);

    const deltas = sent.filter((s) => s.rumor.kind === 21777);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.ephemeral).toBe(true);
    expect(deltas[0]!.rumor.content).toBe("checking the relay monitors");
    expect(tag(deltas[0]!.rumor, "part")).toBe("1");
    expect(sent.find((s) => s.rumor.kind === 1777)!.ephemeral).toBe(false);

    store.close();
  });

  it("says nothing when there is nobody to say it to", async () => {
    const store = HexStore.open(agentHome(home, AGENT).db);
    const { impl, sent } = sink();
    const pub = new TranscriptPublisher({
      agentPubkey: AGENT,
      slug: "hex",
      recipients: [],
      store,
      sink: impl,
    });

    await pub.open("s1", ROOM, "t");
    pub.startTurn("s1");
    await pub.append("s1", "user", [{ type: "text", text: "hello" }]);

    expect(sent).toEqual([]);
    store.close();
  });
});
