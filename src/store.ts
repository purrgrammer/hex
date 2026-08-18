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

/** A checkout one session works in, so a restart finds it again. */
export interface StoredWorktree {
  sessionId: string;
  repo: string;
  path: string;
  branch: string;
  createdAt: number;
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

CREATE TABLE IF NOT EXISTS worktrees (
  session_id TEXT NOT NULL,
  repo       TEXT NOT NULL,
  path       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, repo)
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
    db.exec(SCHEMA);
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
  worktreeFor(sessionId: string, repo: string): StoredWorktree | undefined {
    const row = this.db
      .prepare(
        "SELECT session_id, repo, path, branch, created_at FROM worktrees WHERE session_id = ? AND repo = ?",
      )
      .get(sessionId, repo) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      repo: String(row.repo),
      path: String(row.path),
      branch: String(row.branch),
      createdAt: Number(row.created_at),
    };
  }

  /** Claim a checkout for a session. Never overwritten; the first one wins. */
  recordWorktree(worktree: StoredWorktree): void {
    this.db
      .prepare(
        `INSERT INTO worktrees (session_id, repo, path, branch, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        worktree.sessionId,
        worktree.repo,
        worktree.path,
        worktree.branch,
        worktree.createdAt,
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
