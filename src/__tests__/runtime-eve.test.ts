/**
 * The Eve driver's half of the runtime port.
 *
 * These routes used to be string literals scattered through the publisher, and
 * the only thing that checked them was a live Eve. Now that they are one class,
 * this is the contract a second backend is measured against: the same seven
 * verbs, the same arguments, whatever HTTP or IPC happens underneath.
 */

import { describe, expect, it } from "vitest";

import { EveRuntime } from "../runtime/eve.js";

const HOST = "http://127.0.0.1:2000";

/** Records every call and answers with whatever the test needs. */
function recorder(body: unknown = {}) {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("EveRuntime", () => {
  it("opens a session and reports the id the runtime chose", async () => {
    const { calls, impl } = recorder({ sessionId: "wrun_42" });
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl });

    const id = await runtime.open({
      message: "what kinds does this relay serve?",
      context: ["You are talking to alice."],
    });

    expect(id).toBe("wrun_42");
    expect(calls[0]!.url).toBe(`${HOST}/eve/v1/session`);
    expect(calls[0]!.body).toEqual({
      message: "what kinds does this relay serve?",
      clientContext: ["You are talking to alice."],
    });
  });

  it("refuses to invent a session id the runtime did not name", async () => {
    // The failure this guards is silent: a session opened, and every later
    // instruction addressed to `undefined`.
    const { impl } = recorder({});
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl });
    await expect(runtime.open({ message: "hi" })).rejects.toThrow(
      /named no session/,
    );
  });

  it("passes the turn policy on rather than letting the runtime pick", async () => {
    // Eve's own default cancels the running turn. Hex's is to queue behind it,
    // so a driver that omits this quietly throws away work.
    const { calls, impl } = recorder();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl });

    await runtime.send("wrun_42", "also check the tests", { policy: "queue" });

    expect(calls[0]!.body).toEqual({
      message: "also check the tests",
      turnPolicy: "queue",
    });
  });

  it("answers a request without steering, and steers without answering", async () => {
    const { calls, impl } = recorder();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl });

    await runtime.respond("wrun_42", [
      { requestId: "req_1", optionId: "approve" },
    ]);
    await runtime.send("wrun_42", "no, the other one");

    // The two forms are exclusive by design: `inputResponses` resolves and does
    // not steer, `message` steers and resolves nothing.
    expect(calls[0]!.body).toEqual({
      inputResponses: [{ requestId: "req_1", optionId: "approve" }],
    });
    expect(calls[1]!.body).toEqual({ message: "no, the other one" });
  });

  it("routes cancel, compact, clear and reset to their own paths", async () => {
    const { calls, impl } = recorder();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl });

    await runtime.cancel("wrun_42", "turn_3");
    await runtime.compact("wrun_42");
    await runtime.clear("wrun_42");
    await runtime.reset("wrun_42", "done with it");

    const base = `${HOST}/eve/v1/session/wrun_42`;
    expect(calls.map((call) => call.url)).toEqual([
      `${base}/cancel`,
      `${base}/compact`,
      `${base}/clear`,
      `${base}/reset`,
    ]);
    expect(calls[0]!.body).toEqual({ turnId: "turn_3" });
    expect(calls[3]!.body).toEqual({ reason: "done with it" });
  });

  it("says which backend refused, not just that something did", async () => {
    const impl = (async () =>
      new Response("nope", {
        status: 503,
        statusText: "Service Unavailable",
      })) as unknown as typeof fetch;
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl });
    await expect(runtime.cancel("wrun_42")).rejects.toThrow(/503/);
  });

  it("escapes a session id rather than pasting it into a path", async () => {
    const { calls, impl } = recorder();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl });
    await runtime.cancel("wrun/42?x=1");
    expect(calls[0]!.url).toBe(
      `${HOST}/eve/v1/session/wrun%2F42%3Fx%3D1/cancel`,
    );
  });
});
