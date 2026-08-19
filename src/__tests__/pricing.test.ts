import { describe, expect, it } from "vitest";

import { Prices } from "../eve/pricing.js";

const TABLE = {
  data: [
    {
      id: "moonshotai/kimi-k3",
      pricing: {
        type: "per_token",
        currency: "USD",
        input_per_1M_tokens: 3.165,
        output_per_1M_tokens: 15.825,
      },
    },
    { id: "no-price", pricing: { currency: "USD" } },
  ],
};

function host(body: unknown = TABLE, ok = true) {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

describe("Prices", () => {
  it("prices a model the runtime names with a provider prefix", async () => {
    const eve = host();
    const prices = new Prices({ url: "https://example/models", fetchImpl: eve.impl });
    await prices.load();

    // Eve reports `ppq/moonshotai/kimi-k3`; the table knows the tail.
    const cost = prices.estimate("ppq/moonshotai/kimi-k3", {
      input: 1_000_000,
      output: 100_000,
    });
    expect(cost).toEqual({ amount: "4.747500", currency: "USD" });
  });

  it("says nothing for a model it has no price for", async () => {
    const eve = host();
    const prices = new Prices({ url: "https://example/models", fetchImpl: eve.impl });
    await prices.load();
    expect(prices.estimate("no-price", { input: 10, output: 10 })).toBeUndefined();
    expect(prices.estimate("never-heard-of-it", { input: 10, output: 10 })).toBeUndefined();
  });

  it("survives an endpoint that is down, and does not hammer it", async () => {
    /**
     * A transcript that stopped publishing because a price list was unreachable
     * would be a far worse bug than a missing cost.
     */
    const eve = host({}, false);
    const prices = new Prices({ url: "https://example/models", fetchImpl: eve.impl });
    await prices.load();
    await prices.load();
    expect(eve.calls()).toBe(1);
    expect(prices.estimate("anything", { input: 10, output: 10 })).toBeUndefined();
  });
});
