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
  pending     TEXT
);
CREATE INDEX IF NOT EXISTS transcripts_status ON transcripts (status);

CREATE TABLE IF NOT EXISTS conversations (
  peer       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  last_at    INTEGER NOT NULL
);
`;

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

    return new HexStore(db);
  }

  close(): void {
    this.db.close();
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
  conversationFor(peer: string): string | undefined {
    const row = this.db
      .prepare("SELECT session_id FROM conversations WHERE peer = ?")
      .get(peer) as { session_id?: string } | undefined;
    return row?.session_id;
  }

  /** Remember it, or move this correspondent to a different session. */
  rememberConversation(peer: string, sessionId: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO conversations (peer, session_id, last_at) VALUES (?, ?, ?)
         ON CONFLICT(peer) DO UPDATE SET
           session_id = excluded.session_id, last_at = excluded.last_at`,
      )
      .run(peer, sessionId, at);
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
    };
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
           cost, pending
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           seq = excluded.seq, prev = excluded.prev, turn = excluded.turn,
           status = excluded.status, trigger = excluded.trigger,
           stream_index = excluded.stream_index, ended_at = excluded.ended_at,
           in_tokens = excluded.in_tokens, out_tokens = excluded.out_tokens,
           cache_read = excluded.cache_read, cache_write = excluded.cache_write,
           cost = excluded.cost, pending = excluded.pending`,
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
