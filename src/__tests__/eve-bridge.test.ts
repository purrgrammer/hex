import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { ToolBridge } from "../eve/bridge.js";
import { RoomTools } from "../tools/room-tools.js";
import type { Inbound } from "../transports/types.js";

const TOKEN = "test-token";

function inbound(text = "hello"): Inbound {
  return {
    id: "a".repeat(64),
    author: "b".repeat(64),
    text,
    createdAt: 1,
    room: { transport: "nip-17", id: "b".repeat(64) },
    tagsSelf: true,
    addressesSelf: true,
    event: {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 14,
      tags: [],
      content: text,
      sig: "",
    },
  };
}

describe("ToolBridge", () => {
  let bridge: ToolBridge;
  let sent: string[];
  let tools: RoomTools;

  const call = (body: unknown, token = TOKEN) =>
    fetch(`http://127.0.0.1:${bridge.port}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    sent = [];
    bridge = new ToolBridge({ port: 0, token: TOKEN });
    await bridge.start();
    tools = new RoomTools({
      transport: {
        reply: async (_to, text) => {
          sent.push(text);
          return "e".repeat(64);
        },
      },
      incoming: inbound(),
    });
    bridge.bind("wrun_1", tools);
  });

  afterEach(() => {
    bridge.stop();
  });

  it("routes a respond call to the bound room", async () => {
    const response = await call({
      session: "wrun_1",
      name: "chat_respond",
      arguments: { text: "an answer" },
    });
    expect(await response.json()).toMatchObject({ ok: true });
    expect(sent).toEqual(["an answer"]);
    expect(tools.delivered).toBe(true);
  });

  it("refuses a call with no token", async () => {
    const response = await call(
      { session: "wrun_1", name: "chat_respond", arguments: { text: "hi" } },
      "wrong",
    );
    expect(response.status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("answers nothing for a session it has not bound", async () => {
    const response = await call({
      session: "wrun_other",
      name: "chat_respond",
      arguments: { text: "into someone else's room" },
    });
    expect(await response.json()).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it("replays a repeated callId instead of sending twice", async () => {
    const body = {
      session: "wrun_1",
      callId: "call_1",
      name: "chat_respond",
      arguments: { text: "once" },
    };
    const first = await (await call(body)).json();
    const second = await (await call(body)).json();
    expect(first).toEqual(second);
    // Eve re-runs a step it interrupted; the room hears it once.
    expect(sent).toEqual(["once"]);
  });

  it("stops answering for a session once it is unbound", async () => {
    bridge.unbind("wrun_1");
    const response = await call({
      session: "wrun_1",
      name: "chat_respond",
      arguments: { text: "too late" },
    });
    expect(await response.json()).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it("lists the tools bound to a session", async () => {
    const response = await fetch(
      `http://127.0.0.1:${bridge.port}/tools?session=wrun_1`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const body = (await response.json()) as { tools: { name: string }[] };
    expect(body.tools.map((tool) => tool.name)).toContain("chat.respond");
  });
});
