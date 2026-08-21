/**
 * One clock, one unit.
 *
 * Every injectable clock in this package returns UNIX SECONDS, because that is
 * what Nostr timestamps are and what every timestamp column here stores. There
 * used to be two units: the store and the runner in seconds, the spool and the
 * publish ledger in milliseconds, each internally consistent and each correct
 * on its own.
 *
 * The hazard is not a module. It is a VALUE crossing between them. A stamp
 * written against one clock and read against another is off by a factor of a
 * thousand, which does not look like an error — it looks like a window that
 * never opens, or one that never closes. That happened: the rate limit's meter
 * was stamped by the store and read against the runner, and an hour-long window
 * became unreachable. The first fix passed its tests while still being wrong.
 *
 * So: timestamps are seconds and are typed as `Clock`. Durations keep their own
 * unit in their NAME — `backoffMs`, `pollMs`, `duplicateWindowMs` — because a
 * duration in milliseconds is a normal thing to write and there is no ambiguity
 * in a name that says so. The two meet only through `secondsFrom`, which is the
 * one place in the package where a unit changes and is easy to grep for.
 */

/** Unix SECONDS. Every injectable clock in this package returns these. */
export type Clock = () => number;

// clock: the injection default, and the only ambient read in the package.
export const systemClock: Clock = () => Math.floor(Date.now() / 1000);

/**
 * A duration in milliseconds, as whole seconds.
 *
 * Rounded UP, so a sub-second gap is still a gap: a backoff of 200ms that
 * became 0 would be no backoff at all, and a retry loop with no backoff is the
 * thing backoff exists to prevent. Zero stays zero — that is a caller asking
 * for no gap, which the tests do deliberately.
 */
export function secondsFrom(ms: number): number {
  return ms <= 0 ? 0 : Math.ceil(ms / 1000);
}
