/**
 * How deep every property suite runs, in one place.
 *
 * A property passes its baseline through `pbtRuns(base)`, and `HEX_PBT_RUNS`
 * MULTIPLIES it rather than overriding it. Suites differ wildly in per-case
 * cost — a pure `decide()` property runs thousands of cases in the time one
 * store state machine runs dozens — so each carries its own baseline and
 * scaling preserves that ratio instead of flattening everything to one number.
 *
 *   npm test                      # baseline, fast enough to run on every save
 *   HEX_PBT_RUNS=20 npm test      # the nightly stress pass
 *
 * Fault-injection suites — crash, restart, a lease stolen mid-write — carry a
 * separate knob, `HEX_PBT_FAULT_RUNS`, because their rare paths only surface at
 * depth and are worth paying for on a PR gate that will not pay for depth
 * everywhere. Unset, it falls back to `HEX_PBT_RUNS`, so nightly still deepens
 * them.
 *
 * Borrowed from fragua's `test/pbt-runs.ts`, which is where the multiplier idea
 * came from.
 */

function resolveScale(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const scale = Number(raw);
  return Number.isFinite(scale) && scale > 0 ? scale : fallback;
}

const SCALE: number = resolveScale(process.env["HEX_PBT_RUNS"], 1);
const FAULT_SCALE: number = resolveScale(
  process.env["HEX_PBT_FAULT_RUNS"],
  SCALE,
);

/** Scale a property's baseline `numRuns` by `HEX_PBT_RUNS` (never below 1). */
export function pbtRuns(base: number): number {
  return Math.max(1, Math.round(base * SCALE));
}

/**
 * Scale a fault-injection property's baseline by `HEX_PBT_FAULT_RUNS`, falling
 * back to `HEX_PBT_RUNS` when it is unset. Never below 1.
 */
export function pbtFaultRuns(base: number): number {
  return Math.max(1, Math.round(base * FAULT_SCALE));
}
