/**
 * Two processes, and one of them restarts on its own.
 *
 * `eve dev` rebuilds whenever anything under `agent/` changes, and the port is
 * refused for a second or two while it does. Nothing downstream can recover a
 * message lost in that window: the queue row is settled the moment a turn is
 * dispatched, deliberately, so a dispatch that throws is a question nobody ever
 * answers. The driver is therefore where the two-process seam has to be made
 * safe, and safety here is entirely about which failures may be repeated.
 */

import { describe, expect, it } from "vitest";

import { EveRuntime } from "../runtime/eve.js";
import {
  RuntimeHttpError,
  RuntimeTimeoutError,
  RuntimeUnreachableError,
  neverLanded,
} from "../runtime/errors.js";
import { refusesWork } from "../eve/serve.js";

const HOST = "http://127.0.0.1:2000";

/** What undici throws when nothing is listening. */
function refused(): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:2000"),
    { code: "ECONNREFUSED" },
  );
  return error;
}

/** Fails the first `times` calls the way a restarting runtime does. */
function flaky(times: number, body: unknown = { sessionId: "wrun_42" }) {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    if (calls <= times) throw refused();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, count: () => calls };
}

/** No sleeping in tests, but record what the driver asked to wait. */
function clockless() {
  const waits: number[] = [];
  return {
    waits,
    wait: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("a runtime that restarts under us", () => {
  it("repeats a message the runtime never received", async () => {
    const { impl, count } = flaky(2);
    const { wait, waits } = clockless();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl, wait });

    // invariant: I19
    expect(await runtime.open({ message: "still there?" })).toBe("wrun_42");
    expect(count()).toBe(3);
    // Backing off, not hammering: a rebuild takes longer than a round trip.
    expect(waits).toEqual([500, 1000]);
  });

  it("gives up rather than retrying forever, and says what it was", async () => {
    const { impl, count } = flaky(99);
    const { wait } = clockless();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl, wait });

    await expect(runtime.cancel("wrun_42")).rejects.toBeInstanceOf(
      RuntimeUnreachableError,
    );
    expect(count()).toBe(4);
  });

  it("does not repeat a request that may already have landed", async () => {
    // A deadline says nothing about whether the runtime read the message. The
    // wedge this exists for stayed up and simply never answered; sending again
    // would put the same turn into the session twice.
    let calls = 0;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        ),
      );
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const { wait } = clockless();
    const runtime = new EveRuntime({
      host: HOST,
      fetchImpl: impl,
      postTimeoutMs: 20,
      wait,
    });

    // invariant: I19
    await expect(runtime.send("wrun_42", "hello")).rejects.toBeInstanceOf(
      RuntimeTimeoutError,
    );
    expect(calls).toBe(1);
  });

  it("keeps the status and what the runtime said with it", async () => {
    const impl = (async () =>
      new Response('{"error":"session wrun_42 is finished"}', {
        status: 409,
        statusText: "Conflict",
      })) as unknown as typeof fetch;
    const { wait } = clockless();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl, wait });

    const error = await runtime.send("wrun_42", "hello").catch((e) => e);
    expect(error).toBeInstanceOf(RuntimeHttpError);
    expect((error as RuntimeHttpError).status).toBe(409);
    // The body, not just the status line: it names the session.
    expect(error.message).toContain("wrun_42 is finished");
  });

  it("does not repeat a request the runtime answered", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response("no", { status: 500, statusText: "Server Error" });
    }) as unknown as typeof fetch;
    const { wait } = clockless();
    const runtime = new EveRuntime({ host: HOST, fetchImpl: impl, wait });

    await expect(runtime.compact("wrun_42")).rejects.toBeInstanceOf(
      RuntimeHttpError,
    );
    expect(calls).toBe(1);
  });

  it("stops on the caller's own shutdown instead of retrying it", async () => {
    const stop = new AbortController();
    stop.abort();
    const { impl, count } = flaky(99);
    const { wait } = clockless();
    const runtime = new EveRuntime({
      host: HOST,
      fetchImpl: impl,
      signal: stop.signal,
      wait,
    });

    await expect(runtime.clear("wrun_42")).rejects.toThrow();
    // A shutdown is not an outage to wait out.
    expect(count()).toBeLessThanOrEqual(1);
  });

  it("reads the code out of the cause chain, not out of the message", () => {
    expect(neverLanded(refused())).toBe(true);
    expect(neverLanded(new Error("connect ECONNREFUSED"))).toBe(false);
    // A cycle in `cause` must not hang the walk.
    const loop = new Error("a") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(neverLanded(loop)).toBe(false);
  });
});

/**
 * What counts as "this session is over" decides whether the next message opens
 * a new run or fails. Reading it out of the message text could not tell a
 * status from any other three-digit number, and could not see the two failures
 * that are about the transport rather than the session at all.
 */
describe("refusesWork", () => {
  it("is true only for a status the runtime chose", () => {
    expect(refusesWork(new RuntimeHttpError(409, "/p", "gone"))).toBe(true);
    expect(refusesWork(new RuntimeHttpError(404, "/p"))).toBe(true);
    expect(refusesWork(new RuntimeHttpError(500, "/p"))).toBe(false);
  });

  it("is false when the runtime never answered", () => {
    expect(refusesWork(new RuntimeUnreachableError("/p", refused()))).toBe(
      false,
    );
    expect(refusesWork(new RuntimeTimeoutError("/p", 30_000))).toBe(false);
  });
});
