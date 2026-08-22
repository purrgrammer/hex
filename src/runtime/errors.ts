/**
 * Why a call to the runtime did not succeed — as a type, not as a sentence.
 *
 * The gateway has to tell three failures apart, because it does something
 * different for each: a status the runtime chose, a runtime that was not there
 * to choose one, and a runtime that took the request and never answered. That
 * used to be a regular expression over the error message, which reads a status
 * out of prose and cannot see the difference between "the session is gone" and
 * "nothing is listening on port 2000".
 */

/** The runtime answered, and its answer was a status. */
export class RuntimeHttpError extends Error {
  readonly name = "RuntimeHttpError";

  constructor(
    readonly status: number,
    readonly path: string,
    readonly detail?: string,
  ) {
    super(`eve ${path}: ${status}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Nothing was listening.
 *
 * A refused connection is the one failure that is safe to retry: the request
 * never reached the runtime, so it cannot have half-happened. `eve dev` rebuilds
 * on every change under `agent/`, and each rebuild is a window exactly this
 * shape.
 */
export class RuntimeUnreachableError extends Error {
  readonly name = "RuntimeUnreachableError";

  constructor(
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(`eve ${path}: unreachable — ${describe(cause)}`);
  }
}

/**
 * It took the request and said nothing.
 *
 * NOT retried, and that is the point: a request that timed out may well have
 * landed, and a second `send` on a session that already has the message is a
 * turn the room reads twice. The wedge this exists for was real — a runtime
 * whose event log had corrupted stayed up, accepted connections and never
 * answered, which without a deadline holds a lane open forever.
 */
export class RuntimeTimeoutError extends Error {
  readonly name = "RuntimeTimeoutError";

  constructor(
    readonly path: string,
    readonly afterMs: number,
  ) {
    super(`eve ${path}: no answer in ${afterMs}ms`);
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? `${code} ${cause.message}` : cause.message;
  }
  return String(cause);
}

/**
 * A failure that means the request never landed.
 *
 * Undici reports a refused or reset connection as a `TypeError` whose cause
 * carries the code, so the code is what this reads. A `fetch` that rejects for
 * any other reason is not assumed safe to repeat.
 */
const NEVER_LANDED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function neverLanded(error: unknown): boolean {
  const seen = new Set<unknown>();
  let at: unknown = error;
  while (at instanceof Error && !seen.has(at)) {
    seen.add(at);
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_LANDED.has(code)) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}
