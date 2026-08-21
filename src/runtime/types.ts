/**
 * What hex needs of the thing that actually runs the model.
 *
 * Everything above this line is Nostr: wraps, seals, heads, turns, transports.
 * Everything below it is one agent runtime's opinion about how a session is
 * opened, spoken to and stopped. They met in the middle for a while — the
 * publisher posted to `/eve/v1/session/:id` by hand and read NDJSON off a URL it
 * built itself — which made "swap the backend" a rewrite rather than a
 * substitution.
 *
 * The verb set is not invented here. It is exactly what a `kind:1779` can say,
 * which is in turn exactly what a runtime worth driving already exposes: open a
 * session, send it something, answer a question it asked, stop it, compact or
 * clear what it remembers, retire it. A driver that cannot do one of the
 * optional ones omits the method, and the caller reports that rather than
 * pretending the instruction landed.
 *
 * `follow` is the load-bearing half. A runtime's stream must be RESUMABLE by
 * index — a consumer that died mid-turn asks for everything past the last index
 * it published — because that durability is what lets a transcript be a
 * publication rather than a copy. A runtime with no such cursor cannot be driven
 * by this package without one being built for it.
 */

/**
 * One event off a runtime's stream, in that runtime's own vocabulary.
 *
 * The ENVELOPE is common — a name and a payload — and every runtime worth
 * driving has one. The vocabulary of names is not, and this deliberately does
 * not pretend otherwise: the publisher still switches on Eve's, and a type
 * claiming a shared vocabulary would be a type that lies. What this buys today
 * is that the transport of those events — the URL, the cursor, the NDJSON — is
 * the driver's business and nobody else's. Normalising the names is the next
 * seam, and a bigger one.
 */
export interface RuntimeEvent {
  type: string;
  data?: unknown;
  meta?: { id?: string; at?: string };
}

/** An event with the cursor a resume would use to ask for the next one. */
export interface IndexedRuntimeEvent {
  index: number;
  event: RuntimeEvent;
}

/** What the runtime is set up as, for the per-session snapshot. */
export interface RuntimeDescription {
  /** The system prompt in force, every static source concatenated in order. */
  instructions?: string;
  model?: { id: string; contextWindow?: number };
  tools: {
    name: string;
    description?: string;
    /** JSON Schema, as the runtime reports it. */
    parameters?: unknown;
  }[];
}

/** An answer to one question the run stopped to ask. */
export interface InputResponse {
  requestId: string;
  optionId?: string;
  text?: string;
}

export interface Runtime {
  /** For logs and for saying which backend refused something. */
  readonly name: string;

  /**
   * Open a session and give it its first message.
   *
   * `context` is what the runtime should know BEFORE it reads that message —
   * who is talking, what they pointed at. Not the system prompt, which is the
   * runtime's own, and deliberately not prepended to the message, which would
   * title every run after the boilerplate and put words in the operator's
   * mouth. A runtime with no such door drops it rather than concatenating.
   */
  open(input: { message: string; context?: string[] }): Promise<string>;

  /**
   * Say something to a running session.
   *
   * `policy` decides the one ambiguous case: a message arriving mid-turn.
   * `queue` waits for the running turn, `steer` cancels it. Queue is hex's
   * default and most runtimes' is the other one, so a driver MUST pass this on
   * rather than letting the runtime decide.
   */
  send(
    session: string,
    message: string,
    options?: { policy?: "queue" | "steer" },
  ): Promise<void>;

  /** Answer the questions a parked run is waiting on, without steering it. */
  respond(session: string, responses: InputResponse[]): Promise<void>;

  /** Stop the running turn, or a named one. */
  cancel(session: string, turn?: string): Promise<void>;

  /** Everything the runtime has emitted since `startIndex`, then live. */
  follow(
    session: string,
    options: { startIndex?: number; signal?: AbortSignal },
  ): AsyncIterable<IndexedRuntimeEvent>;

  /**
   * The index of the last event the stream has stored, without reading it.
   *
   * The only honest answer to "has this session moved while our reader stood
   * still": hex's own cursor is written by that same reader, so comparing them
   * can never disagree. Optional — a runtime that cannot say leaves a dropped
   * follow invisible until the next restart, so a driver should implement it.
   * `undefined` means "could not say", never "nothing there".
   */
  tailIndex?(
    session: string,
    /** Where the asker already is, so a driver need not fetch what it has. */
    from?: number,
  ): Promise<number | undefined>;

  /** Absent when the runtime cannot say. The snapshot is then not published. */
  describe?(): Promise<RuntimeDescription | undefined>;

  /** Summarise the context to fit the window. */
  compact?(session: string): Promise<void>;

  /** Throw the context away rather than summarising it. */
  clear?(session: string): Promise<void>;

  /**
   * Retire the session for good — the id never becomes a session again.
   *
   * The one verb that may leave NOTHING on the stream, so a caller must close
   * the head itself rather than waiting to be told.
   */
  reset?(session: string, reason?: string): Promise<void>;
}
