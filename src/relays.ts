/**
 * Every websocket Hex owns.
 *
 * One `RelayPool` per process, created here. The rules below are lifted from
 * grimoire's `src/lib/relay-subscription.ts`, where each of them was a shipped
 * bug first — the code is duplicated rather than imported because this package
 * must not reach into the app, and the reasons are repeated so the copy cannot
 * drift back into the broken shape.
 */

import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
import { firstValueFrom, Observable, of, timer } from "rxjs";
import { catchError, map, takeUntil, tap, toArray } from "rxjs/operators";
import type { Filter, NostrEvent } from "nostr-tools";

/**
 * Hard ceiling on a one-shot request, enforced with `takeUntil` and NOT with
 * applesauce's `timeout` option: applesauce applies `timeout({ first })`
 * upstream of its EVENT filter, and a relay emits an OPEN the instant the REQ is
 * written, which satisfies `first` and disarms the timeout permanently. A relay
 * that connects and then answers `auth-required` sends no EVENT, EOSE, CLOSED or
 * ERROR at all, so nothing else ever completes the stream.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

export interface HexRelays {
  pool: RelayPool;
  eventStore: EventStore;
  close(): void;
}

/** The process's single pool and store. */
export function createRelays(): HexRelays {
  const pool = new RelayPool();
  const eventStore = new EventStore();
  return {
    pool,
    eventStore,
    close: () => pool.close(),
  };
}

export interface RequestOptions {
  timeoutMs?: number;
}

/**
 * Fetch stored events and resolve with whatever arrived.
 *
 * Resolves on the deadline if the relays never finish, and keeps what did land —
 * a silent relay must not be able to pin a caller forever.
 */
export async function requestEvents(
  relays: HexRelays,
  urls: string[],
  filters: Filter[],
  options?: RequestOptions,
): Promise<NostrEvent[]> {
  const collected: NostrEvent[] = [];
  const bound = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return firstValueFrom(
    relays.pool
      // Always pass the store: applesauce defaults to a throwaway in-memory one,
      // so omitting it silently drops everything a later read expects to find.
      .request(urls, filters, { eventStore: relays.eventStore })
      .pipe(
        takeUntil(timer(bound)),
        tap((event) => collected.push(event)),
        toArray(),
        catchError((error) => {
          console.warn(`[hex] request did not complete cleanly: ${error}`);
          return of(collected);
        }),
      ),
    { defaultValue: collected },
  );
}

/** The newest event matching a filter, or null. */
export async function requestNewest(
  relays: HexRelays,
  urls: string[],
  filter: Filter,
  options?: RequestOptions,
): Promise<NostrEvent | null> {
  const events = await requestEvents(
    relays,
    urls,
    [{ ...filter, limit: 1 }],
    options,
  );
  return (
    events.reduce<NostrEvent | null>(
      (newest, event) =>
        !newest || event.created_at > newest.created_at ? event : newest,
      null,
    ) ?? null
  );
}

export interface PublishOutcome {
  relay: string;
  ok: boolean;
  message?: string;
}

/** Publish to every relay and report each one's answer separately. */
export async function publishTo(
  relays: HexRelays,
  urls: string[],
  event: NostrEvent,
): Promise<PublishOutcome[]> {
  const responses = await Promise.all(
    urls.map(async (url): Promise<PublishOutcome> => {
      try {
        const response = await relays.pool.relay(url).publish(event);
        return { relay: url, ok: response.ok, message: response.message };
      } catch (error) {
        return {
          relay: url,
          ok: false,
          message: describeError(error),
        };
      }
    }),
  );
  return responses;
}

/**
 * A readable reason from whatever the websocket threw.
 *
 * `ws` rejects with an `ErrorEvent`, which is not an `Error`, so `String(error)`
 * on it yields the literally useless `[object ErrorEvent]`.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as {
      message?: unknown;
      type?: unknown;
      error?: unknown;
    };
    if (typeof record.message === "string" && record.message)
      return record.message;
    // An ErrorEvent's own message is often empty; the cause it wraps is not.
    if (record.error !== undefined && record.error !== error)
      return describeError(record.error);
    if (typeof record.type === "string" && record.type) return record.type;
  }
  return String(error);
}

export type RelayHealth =
  | { relay: string; state: "ok"; roundTripMs: number }
  /** Connected, accepted the REQ, then said nothing. Not the same as empty. */
  | { relay: string; state: "silent" }
  /** Reachable, but nothing is served until Hex NIP-42 authenticates. */
  | { relay: string; state: "auth-required" }
  | { relay: string; state: "error"; message: string };

/**
 * Can Hex talk to this relay at all?
 *
 * A `limit: 0` REQ asks for nothing and should be answered with an immediate
 * EOSE, so this measures the round trip and nothing else. Silence is reported as
 * silence: a relay that never answers is not a relay with no events.
 */
export async function checkRelay(
  relays: HexRelays,
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now: () => number = () => Date.now(),
): Promise<RelayHealth> {
  const startedAt = now();
  const relay = relays.pool.relay(url);

  try {
    const answered = await firstValueFrom(
      relay
        // No reconnect: a health check reports what it found, it does not retry
        // past its own deadline.
        .request([{ kinds: [1], limit: 0 }], { reconnect: false })
        .pipe(
          toArray(),
          map(() => true),
          takeUntil(timer(timeoutMs)),
        ),
      { defaultValue: false },
    );

    // A relay holding a challenge answered the connection but not the REQ:
    // that is an auth gate, not a broken relay, and the operator needs to know
    // which one it is before wondering why Hex reads nothing there.
    if (!answered)
      return relay.challenge
        ? { relay: url, state: "auth-required" }
        : { relay: url, state: "silent" };
    return { relay: url, state: "ok", roundTripMs: now() - startedAt };
  } catch (error) {
    const message = describeError(error);
    if (message.includes("auth-required"))
      return { relay: url, state: "auth-required" };
    return { relay: url, state: "error", message };
  }
}

/**
 * Check a set of relays, once each.
 *
 * The deduplication is load-bearing, not an optimization: a pool hands out ONE
 * `Relay` per URL, so two concurrent checks of the same relay share a socket and
 * the second one's REQ can land while the first is tearing its connection down —
 * which reported a live relay as ERROR under one role and `ok` under another.
 * Roles overlap by design, so the same URL arrives here more than once.
 */
export async function checkRelays(
  relays: HexRelays,
  urls: string[],
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Map<string, RelayHealth>> {
  const unique = [...new Set(urls)];
  const checks = await Promise.all(
    unique.map((url) => checkRelay(relays, url, timeoutMs)),
  );
  return new Map(unique.map((url, index) => [url, checks[index]!]));
}

/** A subscription that only yields events — no EOSE, which v6 pools never emit. */
export function subscribe(
  relays: HexRelays,
  urls: string[],
  filters: Filter[],
): Observable<NostrEvent> {
  return relays.pool.subscription(urls, filters, {
    eventStore: relays.eventStore,
  });
}
