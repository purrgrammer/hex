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

describe("cache-aware estimates", () => {
  const table = {
    data: [
      {
        id: "claude-sonnet-5",
        pricing: {
          currency: "USD",
          input_per_1M_tokens: 3,
          output_per_1M_tokens: 15,
        },
      },
    ],
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(table), { status: 200 })) as typeof fetch;

  it("charges a cache hit as a cache hit, not as a fresh read", async () => {
    /**
     * `inputTokens` INCLUDES `cacheReadTokens` — a real step reported 3,765 in
     * with 3,764 of them cached, meaning one token was actually read fresh.
     * Charging the whole of `input` at the input rate billed every hit as a
     * miss, and a long conversation runs at a 90% cache rate, so the estimate
     * came out several times the invoice.
     */
    const prices = new Prices({ url: "https://example/models", fetchImpl });
    await prices.load();

    const priced = prices.estimate("anthropic/claude-sonnet-5", {
      input: 100_000,
      output: 1_000,
      cacheRead: 90_000,
      cacheWrite: 0,
    });

    // 10k fresh at $3 + 90k cached at $0.30 + 1k out at $15.
    const expected = (10_000 * 3 + 90_000 * 0.3 + 1_000 * 15) / 1_000_000;
    expect(Number(priced!.amount)).toBeCloseTo(expected, 6);

    // And the old arithmetic, for the size of the error: it was 2.6x this.
    const naive = (100_000 * 3 + 1_000 * 15) / 1_000_000;
    expect(naive / Number(priced!.amount)).toBeGreaterThan(2);
  });

  it("charges a cache write on top, because it is not in `input`", async () => {
    const prices = new Prices({ url: "https://example/models", fetchImpl });
    await prices.load();
    const priced = prices.estimate("anthropic/claude-sonnet-5", {
      input: 1_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 1_000,
    });
    // 1k fresh at $3, plus 1k written at 1.25x.
    expect(Number(priced!.amount)).toBeCloseTo((1_000 * 3 + 1_000 * 3.75) / 1_000_000, 6);
  });

  it("gives a provider it has never heard of no discount at all", async () => {
    /**
     * Wrong HIGH is the safe direction for a number someone is deciding by, and
     * inventing a discount for a provider whose terms nobody here has read
     * would be wrong LOW.
     */
    const prices = new Prices({ url: "https://example/models", fetchImpl });
    await prices.load();
    const priced = prices.estimate("claude-sonnet-5", {
      input: 1_000,
      output: 0,
      cacheRead: 900,
    });
    expect(Number(priced!.amount)).toBeCloseTo(3 / 1_000, 6);
  });

  it("prefers a price the operator stated over the one the table sells", async () => {
    /**
     * A `/models` endpoint prices what that endpoint sells. Driving a provider
     * directly makes the table somebody else's resale price for the same model
     * — close enough to look right, wrong enough that the estimate stops
     * matching the invoice.
     */
    const prices = new Prices({
      url: "https://example/models",
      fetchImpl,
      models: { "anthropic/claude-sonnet-5": { input: 30, output: 150 } },
    });
    await prices.load();
    const priced = prices.estimate("anthropic/claude-sonnet-5", {
      input: 1_000,
      output: 0,
    });
    expect(Number(priced!.amount)).toBeCloseTo(30 / 1_000, 6);
  });
});
