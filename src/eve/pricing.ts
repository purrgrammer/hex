/**
 * What a turn cost, when the provider will not say.
 *
 * Eve reports `usage.costUsd` only when its provider does, and plenty do not —
 * PPQ returns token counts and nothing else, so every transcript published
 * through it carried usage and a blank where the money goes. A reader auditing
 * spend could see how many tokens a session burned and never what it was worth.
 *
 * The tokens and the price are both knowable, so the cost is computable. An
 * OpenAI-shaped `/models` endpoint publishes per-million prices; multiply.
 *
 * It is an ESTIMATE and says so on the wire. It cannot see a cached-input
 * discount, a provider surcharge, a minimum charge, or a promotion — so it is
 * marked, and a reader is told the difference between a number the provider
 * billed and a number this worked out. A figure presented as a bill when it is
 * arithmetic is worse than no figure.
 */

export interface ModelPrice {
  /** USD per one million tokens. */
  input: number;
  output: number;
  currency: string;
}

export interface PricesOptions {
  /** An OpenAI-shaped `/models` endpoint. No default: a guessed URL is a lie. */
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** How long a fetched table is trusted. Prices move slowly. */
  ttlMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** Eve names a model `<provider>/<vendor>/<model>`; the table knows the tail. */
function candidates(modelId: string): string[] {
  const parts = modelId.split("/");
  const all: string[] = [];
  for (let at = 0; at < parts.length; at += 1) all.push(parts.slice(at).join("/"));
  return all;
}

export class Prices {
  private table = new Map<string, ModelPrice>();
  private fetchedAt = 0;
  private inFlight?: Promise<void>;

  constructor(private readonly options: PricesOptions) {}

  private get stale(): boolean {
    return Date.now() - this.fetchedAt > (this.options.ttlMs ?? DEFAULT_TTL_MS);
  }

  /**
   * Fetch the table, at most once at a time.
   *
   * A failure is a log line and an empty table, never a throw: a transcript that
   * stopped publishing because a price list was down would be a far worse bug
   * than a missing cost.
   */
  async load(): Promise<void> {
    if (!this.stale) return;
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const doFetch = this.options.fetchImpl ?? fetch;
      try {
        const response = await doFetch(this.options.url, {
          headers: this.options.token
            ? { authorization: `Bearer ${this.options.token}` }
            : {},
        });
        if (!response.ok) throw new Error(`${response.status}`);
        const body = (await response.json()) as {
          data?: {
            id?: string;
            pricing?: {
              currency?: string;
              input_per_1M_tokens?: number;
              output_per_1M_tokens?: number;
            };
          }[];
        };
        const table = new Map<string, ModelPrice>();
        for (const model of body.data ?? []) {
          const input = model.pricing?.input_per_1M_tokens;
          const output = model.pricing?.output_per_1M_tokens;
          if (!model.id || typeof input !== "number" || typeof output !== "number")
            continue;
          table.set(model.id, {
            input,
            output,
            currency: model.pricing?.currency ?? "USD",
          });
        }
        this.table = table;
        this.fetchedAt = Date.now();
        this.options.log?.(`[hex] ${table.size} model prices loaded`);
      } catch (error) {
        this.options.log?.(
          `[hex] could not read model prices: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Tried, and not again for a while: a dead endpoint must not be dialled
        // once per step for the length of a session.
        this.fetchedAt = Date.now();
      } finally {
        this.inFlight = undefined;
      }
    })();

    return this.inFlight;
  }

  /** What this many tokens of this model come to, or nothing. */
  estimate(
    modelId: string | undefined,
    usage: { input: number; output: number },
  ): { amount: string; currency: string } | undefined {
    if (!modelId) return undefined;
    // Kick a refresh rather than await one: a step must not wait on a price
    // list, and the next step gets the answer.
    if (this.stale) void this.load();
    let price: ModelPrice | undefined;
    for (const id of candidates(modelId)) {
      price = this.table.get(id);
      if (price) break;
    }
    if (!price) return undefined;

    /**
     * Cached input is not discounted here.
     *
     * Eve reports `cacheRead` separately, but a table of two prices cannot say
     * what a cache hit costs — and every provider prices it differently. Input
     * tokens are counted at the input rate, which is the arithmetic the numbers
     * support. Where it is wrong it is wrong HIGH, which is the safe direction
     * for a figure someone is deciding by.
     */
    const amount =
      (usage.input * price.input + usage.output * price.output) / 1_000_000;
    return { amount: amount.toFixed(6), currency: price.currency };
  }
}
