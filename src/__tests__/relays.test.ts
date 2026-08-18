import { describe, it, expect, afterEach } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import {
  createRelays,
  checkRelay,
  checkRelays,
  describeError,
  requestEvents,
  publishTo,
} from "../relays.js";
import { startMockRelay, type MockRelay } from "./mock-relay.js";

const key = generateSecretKey();

function note(content: string, createdAt = 1000) {
  return finalizeEvent(
    { kind: 1, content, tags: [], created_at: createdAt },
    key,
  );
}

let relay: MockRelay | undefined;
let relays: ReturnType<typeof createRelays> | undefined;

afterEach(async () => {
  relays?.close();
  relays = undefined;
  await relay?.close();
  relay = undefined;
});

describe("checkRelay", () => {
  it("reports a relay that answers as ok", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const health = await checkRelay(relays, relay.url);
    expect(health.state).toBe("ok");
  });

  it("reports a relay that accepts the request and says nothing as silent", async () => {
    // Not "no events": this is the shape that pins a client forever.
    relay = await startMockRelay({ kind: "silent" });
    relays = createRelays();
    const health = await checkRelay(relays, relay.url, 300);
    expect(health.state).toBe("silent");
  });

  it("does not bless a relay that refused the subscription", async () => {
    // applesauce completes a CLOSED-without-prefix stream gracefully, so this
    // relay used to be reported `ok` with a round-trip time — for a relay Hex
    // will read nothing from.
    relay = await startMockRelay({
      kind: "closed-no-prefix",
      reason: "we do not serve that filter",
    });
    relays = createRelays();
    const health = await checkRelay(relays, relay.url, 1000);
    expect(health.state).toBe("error");
    if (health.state === "error")
      expect(health.message).toContain("do not serve");
  });

  it("names an auth gate as an auth gate, not as broken", async () => {
    // The operator needs to know which one it is before wondering why Hex reads
    // nothing there.
    relay = await startMockRelay({ kind: "auth-required" });
    relays = createRelays();
    const health = await checkRelay(relays, relay.url, 1000);
    expect(health.state).toBe("auth-required");
  });

  it("reports an unreachable relay without hanging", async () => {
    relays = createRelays();
    // Port 1 is not listening; the check must settle either way.
    const health = await checkRelay(relays, "ws://127.0.0.1:1/", 500);
    expect(health.state === "error" || health.state === "silent").toBe(true);
  });
});

describe("checkRelays", () => {
  it("checks a relay named by two roles exactly once", async () => {
    // A pool hands out one Relay per URL, so two concurrent checks share a
    // socket — and the second REQ landing during the first one's teardown
    // reported a live relay as ERROR under one role and ok under the other.
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const health = await checkRelays(relays, [relay.url, relay.url]);
    expect(health.size).toBe(1);
    expect(health.get(relay.url)?.state).toBe("ok");
  });
});

describe("describeError", () => {
  it("reads the message off a non-Error rejection", () => {
    // `ws` rejects with an ErrorEvent; String() on it says [object ErrorEvent].
    expect(
      describeError({ type: "error", message: "connect ECONNREFUSED" }),
    ).toBe("connect ECONNREFUSED");
  });

  it("unwraps the cause an ErrorEvent carries when its own message is empty", () => {
    // The bare fallback said "ERROR — error", which tells an operator nothing.
    expect(
      describeError({
        type: "error",
        message: "",
        error: new Error("socket hang up"),
      }),
    ).toBe("socket hang up");
  });

  it("falls back to the event type when there is nothing else", () => {
    expect(describeError({ type: "error", message: "" })).toBe("error");
  });

  it("passes an Error's message through", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

describe("requestEvents", () => {
  it("collects what the relay served", async () => {
    relay = await startMockRelay({ kind: "normal", events: [note("hello")] });
    relays = createRelays();
    const events = await requestEvents(relays, [relay.url], [{ kinds: [1] }]);
    expect(events.map((event) => event.content)).toEqual(["hello"]);
  });

  it("resolves with what arrived when the relay never finishes", async () => {
    relay = await startMockRelay({ kind: "silent" });
    relays = createRelays();
    const events = await requestEvents(relays, [relay.url], [{ kinds: [1] }], {
      timeoutMs: 300,
    });
    expect(events).toEqual([]);
  });
});

describe("publishTo", () => {
  it("reports each relay's own answer", async () => {
    relay = await startMockRelay({ kind: "normal" });
    relays = createRelays();
    const event = note("published");
    const outcomes = await publishTo(relays, [relay.url], event);
    expect(outcomes).toEqual([{ relay: relay.url, ok: true, message: "" }]);
    expect(relay.received.map((received) => received.id)).toEqual([event.id]);
  });
});
