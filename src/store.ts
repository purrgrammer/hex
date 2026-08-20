/**
 * Everything Hex remembers, in SQLite.
 *
 * A JSON file is not a coordination surface: two processes that both hold it —
 * two `hex eve` runs following two sessions, two agents pointed at one home —
 * read, mutate in memory, and write the whole thing back, and the last writer
 * silently erases the other's cursor. Renaming atomically makes each write
 * survivable; it does nothing about two of them.
 *
 * So: one database per agent, with WAL and a busy timeout, where a write is a
 * row and readers do not block it. `node:sqlite` is in the runtime, so this costs
 * no dependency and no native build.
 *
 * Each agent gets its own directory, named by its pubkey:
 *
 *   ~/.hex/<pubkey>/
 *     data.db      where each published transcript stands
 *
 * Keyed by pubkey rather than by config path because the key IS the identity: two
 * configs for one key are the same agent and should share a memory, and one
 * machine running two agents must never have them share anything.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { TERMINAL_STATUSES } from "./nostr/types.js";

/**
 * Where a published transcript stands.
 *
 * Two cursors, and both have to be durable. `stream_index` is how far into Eve's
 * event stream this publisher has read, so a restart resumes instead of
 * republishing. `seq` and `prev` are the chain on the wire: resuming at `seq` 1
 * would publish a second chain under one session id, which every conforming
 * reader is required to read as a FORK rather than a continuation.
 *
 * `nostr_id` is the 32-byte session id the wire uses, kept apart from Eve's own
 * session id — which is Eve's to shape and not something to hand a relay.
 */
export interface StoredTranscript {
  sessionId: string;
  nostrId: string;
  seq: number;
  prev?: string;
  turn: number;
  status: string;
  /** The event that started this run, kept so a republished head still names it. */
  trigger?: string;
  streamIndex: number;
  startedAt: number;
  endedAt?: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: string;
  /**
   * Requests the runtime is blocked on, by id.
   *
   * Durable because a blocked session outlives the process watching it: held in
   * memory, a restart caught the session up, saw the turn epilogue, and
   * republished a run that is waiting on a person as finished.
   */
  pending?: string[];
  /**
   * The turn whose incoming message has already been published.
   *
   * Durable because the duplicate it prevents usually arrives in a different
   * process: a resumed session re-announces the message that started the turn,
   * under a new event id, and only the turn id is the same.
   */
  saidTurn?: string;
  /**
   * What to call this run, taken from the first thing asked of it.
   *
   * Durable, because the head republishes on every status change and a title
   * that changed after a restart would rename a session out from under whoever
   * was reading it.
   */
  title?: string;
  /**
   * Where the run is happening, so a restart does not lose it.
   *
   * Held only in memory, it survived exactly as long as the process: every head
   * republished after a restart dropped the channel, so a run started over the
   * control plane stopped saying so and a reader went looking for a room that
   * does not exist. It is also what tells a resumed session whether binding a
   * chat room is the right thing to do.
   */
  channel?: { transport: string; id?: string };
  /**
   * Whether this session's OWN definition snapshot was published.
   *
   * On the record rather than in a field, because the head points at a
   * different address depending on it. Held in memory it reset on every
   * restart, so a resumed session republished its head pointing at the agent's
   * standing definition — an event nobody publishes — and the prompt and tool
   * list a reader had been shown vanished. That is the "sometimes it is there
   * and sometimes it is not".
   */
  described?: boolean;
  /**
   * What the run is about, as pointer tags.
   *
   * Durable because the head repeats them on EVERY publish and the head is
   * republished on every status change. Held in memory they survived the first
   * publish and no other: a run started about a repository said so once, and
   * every head after it — the ones a reader actually sees, because a
   * replaceable event keeps only the newest — was about nothing. Every "runs
   * about this repository" list was empty for exactly that reason.
   */
  subjects?: string[][];
  /**
   * How this run's events travel: wrapped to the operator, or also to its group.
   *
   * Decided ONCE, when the session opens, from the room it opened in — and
   * durable for the same reason the subjects beside it are. A session that
   * started wrapped must never acquire a second copy halfway through: there is
   * one chain and one `last-seq`, so a group copy beginning at turn twelve is a
   * transcript with a hole nobody can fill.
   */
  carriage?: "wrapped" | "group";
  /** The NIP-29 group id this run happens in, for its `h` tag. */
  group?: string;
  /** The relay that hosts that group — the only one the group copy goes to. */
  groupRelay?: string;
  /**
   * The running total includes a figure nobody billed.
   *
   * Not persisted: a restart resumes a session whose earlier steps it did not
   * price, and the honest reading of a mixed total is that it is an estimate —
   * which is what the next step will mark it as anyway.
   */
  costEstimated?: boolean;
}

export interface AgentHome {
  /** The root every agent lives under, e.g. `~/.hex`. */
  root: string;
  /** This agent's directory, named by its pubkey. */
  dir: string;
  db: string;
}

/** `~/.hex` unless the config says otherwise. `~` is expanded. */
export const DEFAULT_HOME = join(homedir(), ".hex");

export function expandHome(path: string, baseDir?: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (isAbsolute(path) || !baseDir) return resolve(path);
  return resolve(baseDir, path);
}

/**
 * Where this agent keeps things, created if missing.
 *
 * The directories are made here rather than lazily, so a permission problem
 * surfaces at startup with a path in the message instead of at the first message
 * anyone sends.
 */
export function agentHome(root: string, pubkey: string): AgentHome {
  const dir = join(root, pubkey);
  mkdirSync(dir, { recursive: true });
  return { root, dir, db: join(dir, "data.db") };
}

/**
 * Two tables: where each published transcript stands, and which runtime session
 * belongs to which correspondent.
 *
 * A home written by an older version also holds `sessions`, `messages`,
 * `participants` and `worktrees`, from when this package ran its own agent loop.
 * They are left where they are rather than dropped — deleting an operator's
 * conversation history to tidy a schema is not a migration this gets to make.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS transcripts (
  session_id  TEXT PRIMARY KEY,
  nostr_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  prev        TEXT,
  turn        INTEGER NOT NULL,
  status      TEXT NOT NULL,
  trigger     TEXT,
  stream_index INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  in_tokens   INTEGER NOT NULL DEFAULT 0,
  out_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost        TEXT,
  pending     TEXT,
  said_turn   TEXT,
  title       TEXT,
  channel     TEXT,
  described   INTEGER,
  subjects    TEXT,
  carriage    TEXT,
  grp         TEXT,
  grp_relay   TEXT
);
CREATE INDEX IF NOT EXISTS transcripts_status ON transcripts (status);
CREATE INDEX IF NOT EXISTS transcripts_nostr_id ON transcripts (nostr_id);

/*
 * Which session a correspondent is currently in — per ROOM, not per person.
 *
 * Keyed on the person alone, one human talking to Hex in a group and in a
 * direct message shared a single conversation: the group question continued the
 * DM's session and would have been answered in the wrong place. Watched happen —
 * a group message sat behind a long DM run for ten minutes and never started a
 * session of its own.
 */
CREATE TABLE IF NOT EXISTS conversations (
  peer       TEXT NOT NULL,
  room       TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  last_at    INTEGER NOT NULL,
  PRIMARY KEY (peer, room)
);

/*
 * Questions Hex asked in a room, and what answering one resolves.
 *
 * Durable, not in memory, and for once the reason is the whole point of the
 * feature: a parked run waits indefinitely for a person who may answer tomorrow,
 * and a restart in between is the ordinary case rather than the edge one. Held
 * in memory, the reply that finally arrives would be read as an ordinary
 * message — which STEERS the run and leaves the question open, so the agent
 * asks again and the person answers again, forever.
 */
CREATE TABLE IF NOT EXISTS questions (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  asked_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS questions_session ON questions (session_id);

/*
 * Control events already carried out.
 *
 * Durable for the same reason the questions table is, and discovered the same way: a
 * restart re-obeyed a stop the operator had pressed before it. The NIP-17 read
 * floor is two days below the start time, deliberately loose because NIP-59
 * randomises a wrap's timestamp backwards and a strict floor would drop
 * messages sent now — so
 * every restart is handed the whole two-day window again, and an in-memory
 * guard has forgotten all of it.
 *
 * Pruned on open rather than never: this is a replay guard, not a log, and the
 * horizon only has to outlast the window a relay could hand back.
 */
CREATE TABLE IF NOT EXISTS obeyed (
  control_id TEXT PRIMARY KEY,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS obeyed_at ON obeyed (at);
`;

/**
 * How long a carried-out control event is remembered.
 *
 * Ten times the two-day read floor, because the cost of remembering too long is
 * a few hundred rows and the cost of forgetting too early is an instruction
 * obeyed twice.
 */
const OBEYED_HORIZON_SECONDS = 30 * 24 * 60 * 60;

export class HexStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Open (or create) an agent's database.
   *
   * WAL so a reader never blocks the writer — a second process following another
   * session writes while this one does. `busy_timeout` so a concurrent write
   * waits its turn instead of throwing SQLITE_BUSY at whoever lost the race.
   */
  static open(path: string): HexStore {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    /**
     * A column added after homes existed in the wild.
     *
     * `CREATE TABLE IF NOT EXISTS` leaves an older table exactly as it was, so a
     * new column has to be added to it explicitly. Checked rather than attempted
     * and swallowed: an error nobody reads is how a schema silently diverges.
     */
    const columns = (
      db.prepare(`PRAGMA table_info(transcripts)`).all() as { name: string }[]
    ).map((column) => column.name);
    if (!columns.includes("pending"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN pending TEXT`);
    if (!columns.includes("said_turn"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN said_turn TEXT`);
    if (!columns.includes("title"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN title TEXT`);
    if (!columns.includes("channel"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN channel TEXT`);
    if (!columns.includes("described"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN described INTEGER`);
    if (!columns.includes("subjects"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN subjects TEXT`);
    if (!columns.includes("carriage"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN carriage TEXT`);
    if (!columns.includes("grp"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN grp TEXT`);
    if (!columns.includes("grp_relay"))
      db.exec(`ALTER TABLE transcripts ADD COLUMN grp_relay TEXT`);

    /**
     * An older `conversations` had `peer` as its whole primary key.
     *
     * Rebuilt rather than altered, because SQLite cannot change a primary key
     * in place — and this table is a cache of "which session is this person
     * currently in", so the rows are cheap to keep and cheaper to lose. The
     * existing ones are carried over into the empty room, which is what a
     * direct message used before rooms were part of the key.
     */
    const conversationKey = (
      db.prepare(`PRAGMA table_info(conversations)`).all() as { name: string }[]
    ).map((column) => column.name);
    if (!conversationKey.includes("room")) {
      db.exec(`ALTER TABLE conversations RENAME TO conversations_by_peer`);
      db.exec(SCHEMA);
      db.exec(
        `INSERT OR IGNORE INTO conversations (peer, room, session_id, last_at)
           SELECT peer, '', session_id, last_at FROM conversations_by_peer`,
      );
      db.exec(`DROP TABLE conversations_by_peer`);
    }

    db.prepare(`DELETE FROM obeyed WHERE at < ?`).run(
      Math.floor(Date.now() / 1000) - OBEYED_HORIZON_SECONDS,
    );

    return new HexStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** Whether this exact control event has already been carried out. */
  wasObeyed(controlId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM obeyed WHERE control_id = ?`)
        .get(controlId),
    );
  }

  /**
   * Record that one was carried out.
   *
   * Called only AFTER the instruction landed. A command that failed because the
   * runtime was down should be retried by the next relay's redelivery, not
   * dropped forever, and the scope checks are what make redelivering a command
   * that DID land harmless.
   */
  markObeyed(controlId: string, at = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO obeyed (control_id, at) VALUES (?, ?)`)
      .run(controlId, at);
  }

  /**
   * The runtime session a correspondent is talking to, if any.
   *
   * In the database rather than in memory, and the reason is not tidiness: held in
   * memory, a restart forgot who was talking about what, so the next message
   * opened a NEW session — the person's history gone, the old session left idle
   * forever with nobody to close it, and the reader shown two unrelated runs for
   * one conversation.
   */
  conversationFor(peer: string, room: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT session_id FROM conversations WHERE peer = ? AND room = ?",
      )
      .get(peer, room) as { session_id?: string } | undefined;
    return row?.session_id;
  }

  /**
   * Who a session belongs to — the reverse of `conversationFor`.
   *
   * A control event names a session, and answering one needs the ROOM: a turn
   * an operator steered into life still has to speak to somebody.
   */
  peerForSession(sessionId: string): string | undefined {
    const row = this.db
      .prepare("SELECT peer FROM conversations WHERE session_id = ?")
      .get(sessionId) as { peer?: string } | undefined;
    return row?.peer;
  }

  /** Remember it, or move this correspondent to a different session. */
  rememberConversation(
    peer: string,
    room: string,
    sessionId: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO conversations (peer, room, session_id, last_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(peer, room) DO UPDATE SET
           session_id = excluded.session_id, last_at = excluded.last_at`,
      )
      .run(peer, room, sessionId, at);
  }

  /**
   * Remember that this room message asked this request.
   *
   * Keyed on the message Hex posted, because that is the only handle the other
   * side has: they reply to what they can see, and the `e` tag on that reply is
   * what comes back.
   */
  rememberQuestion(
    messageId: string,
    sessionId: string,
    requestId: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO questions (message_id, session_id, request_id, asked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           session_id = excluded.session_id, request_id = excluded.request_id`,
      )
      .run(messageId, sessionId, requestId, at);
  }

  /** What a reply to this message is answering, if anything. */
  questionAsked(
    messageId: string,
  ): { sessionId: string; requestId: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id, request_id FROM questions WHERE message_id = ?`,
      )
      .get(messageId) as
      { session_id?: string; request_id?: string } | undefined;
    if (!row?.session_id || !row.request_id) return undefined;
    return { sessionId: row.session_id, requestId: row.request_id };
  }

  /** Forget a session's questions once they are answered or the run is over. */
  forgetQuestions(sessionId: string): void {
    this.db
      .prepare(`DELETE FROM questions WHERE session_id = ?`)
      .run(sessionId);
  }

  transcriptFor(sessionId: string): StoredTranscript | undefined {
    const row = this.db
      .prepare(`SELECT * FROM transcripts WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      nostrId: String(row.nostr_id),
      seq: Number(row.seq),
      prev: row.prev == null ? undefined : String(row.prev),
      turn: Number(row.turn),
      status: String(row.status),
      trigger: row.trigger == null ? undefined : String(row.trigger),
      streamIndex: Number(row.stream_index),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
      inTokens: Number(row.in_tokens),
      outTokens: Number(row.out_tokens),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      cost: row.cost == null ? undefined : String(row.cost),
      pending: parsePending(row.pending),
      saidTurn: row.said_turn == null ? undefined : String(row.said_turn),
      title: row.title == null ? undefined : String(row.title),
      channel: parseChannel(row.channel),
      described: row.described === 1,
      subjects: parseSubjects(row.subjects),
      carriage: row.carriage === "group" ? "group" : undefined,
      group: row.grp == null ? undefined : String(row.grp),
      groupRelay: row.grp_relay == null ? undefined : String(row.grp_relay),
    };
  }

  /**
   * The run behind a published session id.
   *
   * Two ids name one session and neither side knows the other's: the runtime has
   * its own, and the wire carries 32 random bytes chosen here so that a runtime's
   * id — which may be guessable, or meaningful — never becomes a public name. An
   * instruction arriving from a reader names the wire's, and the runtime must be
   * addressed by its own, so the translation happens here.
   */
  transcriptForNostrId(nostrId: string): StoredTranscript | undefined {
    const row = this.db
      .prepare(`SELECT session_id FROM transcripts WHERE nostr_id = ?`)
      .get(nostrId) as { session_id: string } | undefined;
    return row ? this.transcriptFor(String(row.session_id)) : undefined;
  }

  /** Sessions whose head never reached a terminal status. */
  openTranscripts(): StoredTranscript[] {
    return (
      this.db
        .prepare(
          // The one list of terminal statuses, not a fourth copy of it.
          `SELECT session_id FROM transcripts WHERE status NOT IN (${TERMINAL_STATUSES.map(
            () => "?",
          ).join(", ")})`,
        )
        .all(...TERMINAL_STATUSES) as { session_id: string }[]
    )
      .map((row) => this.transcriptFor(row.session_id))
      .filter((t): t is StoredTranscript => !!t);
  }

  /** Write both cursors. Called after every publish, so a crash loses one event. */
  saveTranscript(transcript: StoredTranscript): void {
    this.db
      .prepare(
        `INSERT INTO transcripts (
           session_id, nostr_id, seq, prev, turn, status, trigger, stream_index,
           started_at, ended_at, in_tokens, out_tokens, cache_read, cache_write,
           cost, pending, said_turn, title, channel, described, subjects,
           carriage, grp, grp_relay
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           seq = excluded.seq, prev = excluded.prev, turn = excluded.turn,
           status = excluded.status, trigger = excluded.trigger,
           stream_index = excluded.stream_index, ended_at = excluded.ended_at,
           in_tokens = excluded.in_tokens, out_tokens = excluded.out_tokens,
           cache_read = excluded.cache_read, cache_write = excluded.cache_write,
           cost = excluded.cost, pending = excluded.pending,
           said_turn = excluded.said_turn, title = excluded.title,
           channel = excluded.channel, described = excluded.described,
           subjects = excluded.subjects, carriage = excluded.carriage,
           grp = excluded.grp, grp_relay = excluded.grp_relay`,
      )
      .run(
        transcript.sessionId,
        transcript.nostrId,
        transcript.seq,
        transcript.prev ?? null,
        transcript.turn,
        transcript.status,
        transcript.trigger ?? null,
        transcript.streamIndex,
        transcript.startedAt,
        transcript.endedAt ?? null,
        transcript.inTokens,
        transcript.outTokens,
        transcript.cacheRead,
        transcript.cacheWrite,
        transcript.cost ?? null,
        transcript.pending?.length ? JSON.stringify(transcript.pending) : null,
        transcript.saidTurn ?? null,
        transcript.title ?? null,
        transcript.channel ? JSON.stringify(transcript.channel) : null,
        transcript.described ? 1 : null,
        transcript.subjects?.length
          ? JSON.stringify(transcript.subjects)
          : null,
        transcript.carriage ?? null,
        transcript.group ?? null,
        transcript.groupRelay ?? null,
      );
  }
}

/**
 * The pending list, defensively.
 *
 * A column added later is null on every row written before it, and a hand-edited
 * database is a database. Anything that will not parse into a list of strings is
 * read as "nothing pending" — which errs towards a session that looks finished
 * rather than one that is stuck asking a question nobody can see.
 */
function parsePending(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const ids = parsed.filter((id): id is string => typeof id === "string");
    return ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

/** The stored channel, or nothing. A row written before the column existed. */
/**
 * The subject tags, defensively.
 *
 * Anything that is not an array of string arrays reads as no subjects, which
 * errs towards a head that says nothing about what it is about rather than one
 * carrying a malformed tag a relay would reject.
 */
function parseSubjects(value: unknown): string[][] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const tags = parsed.filter(
      (tag): tag is string[] =>
        Array.isArray(tag) && tag.every((part) => typeof part === "string"),
    );
    return tags.length ? tags : undefined;
  } catch {
    return undefined;
  }
}

function parseChannel(
  value: unknown,
): { transport: string; id?: string } | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const transport = (parsed as { transport?: unknown }).transport;
    if (typeof transport !== "string" || !transport) return undefined;
    const id = (parsed as { id?: unknown }).id;
    return { transport, ...(typeof id === "string" && id ? { id } : {}) };
  } catch {
    return undefined;
  }
}
