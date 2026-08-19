/**
 * Everything Hex remembers, in SQLite.
 *
 * A JSON file is not a coordination surface: two processes that both hold it —
 * a restart overlapping its predecessor, a `hex ask` run beside the daemon, two
 * agents pointed at one home — read, mutate in memory, and write the whole thing
 * back, and the last writer silently erases the other's conversation. Renaming
 * atomically makes each write survivable; it does nothing about two of them.
 *
 * So: one database per agent, with WAL and a busy timeout, where a write is a
 * row and readers do not block it. `node:sqlite` is in the runtime, so this costs
 * no dependency and no native build.
 *
 * Each agent gets its own directory, named by its pubkey:
 *
 *   ~/.hex/<pubkey>/
 *     data.db      conversations, sessions, what Hex has said
 *     worktrees/   isolated checkouts, for when Hex runs code
 *
 * Keyed by pubkey rather than by config path because the key IS the identity: two
 * configs for one key are the same agent and should share a memory, and one
 * machine running two agents must never have them share anything.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface StoredMessage {
  id: string;
  room: string;
  author: string;
  text: string;
  /** Unix seconds. */
  at: number;
  replyToId?: string;
  /** Whether Hex published it. */
  own?: boolean;
}

export interface StoredSession {
  id: string;
  room: string;
  lastAt: number;
}

/** A checkout one conversation works in, so a restart finds it again. */
/**
 * Where a published transcript stands.
 *
 * The cursor is the reason this table exists. A restart that resumed at `seq` 1
 * would publish a second chain under the same session, and every reader is
 * required to read that as a FORK — so the counter and the id it chains from
 * have to outlive the process. `nostr_id` is the 32-byte session id on the wire,
 * kept apart from Hex's own room-scoped session id, which is not 32 bytes and is
 * not something to hand a relay.
 */
export interface StoredTranscript {
  sessionId: string;
  room: string;
  nostrId: string;
  seq: number;
  prev?: string;
  turn: number;
  status: string;
  /** The event that started this run, kept so a republished head still names it. */
  trigger?: string;
  startedAt: number;
  endedAt?: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: string;
}

export interface StoredWorktree {
  /** The room the checkout belongs to. See `RepoToolsOptions.workspace`. */
  workspace: string;
  repo: string;
  path: string;
  branch: string;
  createdAt: number;
  /**
   * Which backend made it.
   *
   * Recorded because the two are not interchangeable: a worktree's `.git` is a
   * file pointing into the operator's clone, a container's is a real directory,
   * and handing a conversation the wrong one silently gives it an empty checkout
   * with its work somewhere else.
   */
  isolation?: string;
}

export interface AgentHome {
  /** The root every agent lives under, e.g. `~/.hex`. */
  root: string;
  /** This agent's directory, named by its pubkey. */
  dir: string;
  db: string;
  worktrees: string;
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
  const worktrees = join(dir, "worktrees");
  mkdirSync(worktrees, { recursive: true });
  return { root, dir, db: join(dir, "data.db"), worktrees };
}

/** How many messages and sessions a home keeps before the oldest are dropped. */
const MAX_MESSAGES = 20_000;
const MAX_SESSIONS = 2_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id       TEXT PRIMARY KEY,
  room     TEXT NOT NULL,
  last_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_room_last ON sessions (room, last_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  room       TEXT NOT NULL,
  author     TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  reply_to   TEXT,
  own        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_session_at ON messages (session_id, at);
CREATE INDEX IF NOT EXISTS messages_at ON messages (at);

CREATE TABLE IF NOT EXISTS participants (
  session_id TEXT NOT NULL,
  pubkey     TEXT NOT NULL,
  PRIMARY KEY (session_id, pubkey)
);
CREATE INDEX IF NOT EXISTS participants_pubkey ON participants (pubkey);

CREATE TABLE IF NOT EXISTS transcripts (
  session_id TEXT PRIMARY KEY,
  room       TEXT NOT NULL,
  nostr_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  prev       TEXT,
  turn       INTEGER NOT NULL,
  status     TEXT NOT NULL,
  trigger    TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  in_tokens  INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost       TEXT
);
CREATE INDEX IF NOT EXISTS transcripts_status ON transcripts (status);

CREATE TABLE IF NOT EXISTS worktrees (
  workspace  TEXT NOT NULL,
  repo       TEXT NOT NULL,
  path       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  isolation  TEXT NOT NULL DEFAULT 'host-worktree',
  PRIMARY KEY (workspace, repo)
);
`;

export class HexStore {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Open (or create) an agent's database.
   *
   * WAL so a reader never blocks the writer — the daemon writes while `hex ask`
   * or a second process reads. `busy_timeout` so a concurrent write waits its
   * turn instead of throwing SQLITE_BUSY at whoever lost the race.
   */
  static open(path: string): HexStore {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    // The worktree table was briefly keyed by session before it was keyed by
    // room. Dropped rather than migrated: the rows only map a conversation to a
    // directory, and the directories are still on disk for the operator to keep
    // or remove. Cheap, and it runs once.
    const legacy = db
      .prepare("SELECT name FROM pragma_table_info('worktrees') WHERE name = ?")
      .get("session_id");
    if (legacy) db.exec("DROP TABLE worktrees");
    db.exec(SCHEMA);

    // Additive, and guarded rather than versioned: the table predates the second
    // backend, and a row with no backend recorded came from the only one there
    // was. Same one-time cost and same precedent as the drop above.
    const hasIsolation = db
      .prepare("SELECT name FROM pragma_table_info('worktrees') WHERE name = ?")
      .get("isolation");
    if (!hasIsolation)
      db.exec(
        "ALTER TABLE worktrees ADD COLUMN isolation TEXT NOT NULL DEFAULT 'host-worktree'",
      );
    return new HexStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** Did Hex publish this? Survives a restart, unlike an in-memory set. */
  isOwn(id: string): boolean {
    const row = this.db
      .prepare("SELECT own FROM messages WHERE id = ?")
      .get(id) as { own?: number } | undefined;
    return row?.own === 1;
  }

  /**
   * The checkout this session works in, if it has one.
   *
   * In the database rather than inferred from what is on disk: a directory that
   * happens to exist proves nothing about which conversation owns it, and two
   * processes deciding that from `readdir` would both claim the same one.
   */
  worktreeFor(workspace: string, repo: string): StoredWorktree | undefined {
    const row = this.db
      .prepare(
        "SELECT workspace, repo, path, branch, created_at, isolation FROM worktrees WHERE workspace = ? AND repo = ?",
      )
      .get(workspace, repo) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      workspace: String(row.workspace),
      repo: String(row.repo),
      path: String(row.path),
      branch: String(row.branch),
      createdAt: Number(row.created_at),
      isolation:
        row.isolation === undefined ? undefined : String(row.isolation),
    };
  }

  /** Claim a checkout for a session. Never overwritten; the first one wins. */
  recordWorktree(worktree: StoredWorktree): void {
    this.db
      .prepare(
        `INSERT INTO worktrees (workspace, repo, path, branch, created_at, isolation)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        worktree.workspace,
        worktree.repo,
        worktree.path,
        worktree.branch,
        worktree.createdAt,
        worktree.isolation ?? "host-worktree",
      );
  }

  transcriptFor(sessionId: string): StoredTranscript | undefined {
    const row = this.db
      .prepare(`SELECT * FROM transcripts WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      room: String(row.room),
      nostrId: String(row.nostr_id),
      seq: Number(row.seq),
      prev: row.prev == null ? undefined : String(row.prev),
      turn: Number(row.turn),
      status: String(row.status),
      trigger: row.trigger == null ? undefined : String(row.trigger),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
      inTokens: Number(row.in_tokens),
      outTokens: Number(row.out_tokens),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      cost: row.cost == null ? undefined : String(row.cost),
    };
  }

  /** Sessions with a head that never reached a terminal status. */
  openTranscripts(): StoredTranscript[] {
    return (
      this.db
        .prepare(
          `SELECT session_id FROM transcripts WHERE status NOT IN ('done', 'error', 'aborted')`,
        )
        .all() as { session_id: string }[]
    )
      .map((row) => this.transcriptFor(row.session_id))
      .filter((t): t is StoredTranscript => !!t);
  }

  /** Write the cursor. Called after every publish, so a crash loses one event. */
  saveTranscript(transcript: StoredTranscript): void {
    this.db
      .prepare(
        `INSERT INTO transcripts (
           session_id, room, nostr_id, seq, prev, turn, status, trigger,
           started_at, ended_at, in_tokens, out_tokens, cache_read, cache_write,
           cost
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           seq = excluded.seq, prev = excluded.prev, turn = excluded.turn,
           status = excluded.status, ended_at = excluded.ended_at,
           in_tokens = excluded.in_tokens, out_tokens = excluded.out_tokens,
           cache_read = excluded.cache_read, cache_write = excluded.cache_write,
           cost = excluded.cost`,
      )
      .run(
        transcript.sessionId,
        transcript.room,
        transcript.nostrId,
        transcript.seq,
        transcript.prev ?? null,
        transcript.turn,
        transcript.status,
        transcript.trigger ?? null,
        transcript.startedAt,
        transcript.endedAt ?? null,
        transcript.inTokens,
        transcript.outTokens,
        transcript.cacheRead,
        transcript.cacheWrite,
        transcript.cost ?? null,
      );
  }

  getMessage(id: string): StoredMessage | undefined {
    const row = this.db
      .prepare(
        "SELECT id, room, author, text, at, reply_to, own FROM messages WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? toMessage(row) : undefined;
  }

  /**
   * Write a message and fold it into its session, in one transaction.
   *
   * One statement per row rather than a rewritten document: two processes can do
   * this at the same time and neither loses the other's work.
   */
  record(sessionId: string, message: StoredMessage): void {
    const insertSession = this.db.prepare(
      `INSERT INTO sessions (id, room, last_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_at = MAX(last_at, excluded.last_at)`,
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO messages (id, session_id, room, author, text, at, reply_to, own)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    const insertParticipant = this.db.prepare(
      "INSERT INTO participants (session_id, pubkey) VALUES (?, ?) ON CONFLICT DO NOTHING",
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      insertSession.run(sessionId, message.room, message.at);
      insertMessage.run(
        message.id,
        sessionId,
        message.room,
        message.author,
        message.text,
        message.at,
        message.replyToId ?? null,
        message.own ? 1 : 0,
      );
      // Hex is in every session it speaks in; only humans decide continuity, so
      // only their pubkeys make a session theirs to continue.
      if (!message.own && message.author)
        insertParticipant.run(sessionId, message.author);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The session a replied-to message belongs to, if it is in this room. */
  sessionForReply(room: string, replyToId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT session_id FROM messages WHERE id = ? AND room = ? LIMIT 1",
      )
      .get(replyToId, room) as { session_id?: string } | undefined;
    return row?.session_id;
  }

  /** The most recent session in this room that `author` has spoken in. */
  recentSessionFor(
    room: string,
    author: string,
    since: number,
  ): string | undefined {
    const row = this.db
      .prepare(
        `SELECT s.id FROM sessions s
         JOIN participants p ON p.session_id = s.id
         WHERE s.room = ? AND p.pubkey = ? AND s.last_at >= ?
         ORDER BY s.last_at DESC LIMIT 1`,
      )
      .get(room, author, since) as { id?: string } | undefined;
    return row?.id;
  }

  /** A session's newest `limit` messages, oldest first. */
  history(
    sessionId: string,
    limit: number,
    excludeId?: string,
  ): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, room, author, text, at, reply_to, own FROM messages
         WHERE session_id = ? AND id IS NOT ?
         ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(sessionId, excludeId ?? null, limit) as Record<string, unknown>[];
    return rows.map(toMessage).reverse();
  }

  /**
   * Drop the oldest rows once the database outgrows its bounds.
   *
   * Called at startup rather than on every write: the cost is one scan when the
   * agent boots, and nothing during a conversation.
   */
  prune(
    maxMessages = MAX_MESSAGES,
    maxSessions = MAX_SESSIONS,
  ): { messages: number; sessions: number } {
    const messages = this.db
      .prepare(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM messages ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(maxMessages);
    const sessions = this.db
      .prepare(
        `DELETE FROM sessions WHERE id IN (
           SELECT id FROM sessions ORDER BY last_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(maxSessions);
    // A session's participants are meaningless once the session is gone.
    this.db.exec(
      "DELETE FROM participants WHERE session_id NOT IN (SELECT id FROM sessions)",
    );
    return {
      messages: Number(messages.changes),
      sessions: Number(sessions.changes),
    };
  }

  /** Row counts, for `hex check` and the startup line. */
  counts(): { messages: number; sessions: number } {
    const messages = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages")
      .get() as { n: number };
    const sessions = this.db
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get() as { n: number };
    return { messages: Number(messages.n), sessions: Number(sessions.n) };
  }
}

function toMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    room: String(row.room),
    author: String(row.author),
    text: String(row.text),
    at: Number(row.at),
    replyToId: row.reply_to === null ? undefined : String(row.reply_to),
    own: Number(row.own) === 1,
  };
}
