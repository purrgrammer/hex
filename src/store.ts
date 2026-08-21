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
import { homedir, hostname as osHostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { TERMINAL_STATUSES } from "./nostr/types.js";
import {
  membershipToStored,
  type Membership,
  type StoredMembership,
} from "./concord/membership.js";
// Type-only: the taxonomy belongs to the ingestor, and the store's job is to
// keep rows, not to know what a `message` is.
import type { CanonicalEvent } from "./ingest.js";

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
  carriage?: "wrapped" | "group" | "concord";
  /**
   * The room this run happens in: a NIP-29 group id, or — under the `concord`
   * carriage — a `community:channel` room id. Which it is, is the carriage.
   */
  group?: string;
  /**
   * The relay that hosts that group — the only one the group copy goes to.
   *
   * NIP-29 only. A Concord channel's relays come from the membership, which
   * holds them because the keys and the relays arrive in the same invite.
   */
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

/*
 * Every event this agent published through nostr.publish, so it can tell
 * whether it is about to publish the same thing twice.
 *
 * The runtime re-executes a turn: five turn.started produced eight
 * turn.completed in the run that filed seven issues for four ideas. Each
 * execution composes afresh, so it arrives with a new tool-call id and new
 * prose -- which is why the bridge's call-id dedup and a content hash both
 * miss it. What does not change is what the event is ABOUT: same kind, same
 * repository, same subject.
 *
 * Durable, because a restart mid-turn is exactly when the question gets asked.
 */
CREATE TABLE IF NOT EXISTS published (
  id      TEXT PRIMARY KEY,
  kind    INTEGER NOT NULL,
  -- The "a" tag this event hangs off, or "" -- a repository, usually.
  scope   TEXT NOT NULL,
  -- Normalised subject tag, lowercased and stripped of punctuation.
  subject TEXT NOT NULL,
  sha256  TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS published_lookup ON published (kind, scope, at);

/*
 * A Concord membership: the keys that ARE Hex's belonging to a community.
 *
 * Durable because there is nothing to re-fetch. A NIP-29 group can be rejoined
 * by asking its relay; a Concord community cannot be asked anything — the only
 * copy of what Hex holds is this row, and losing it means losing the room until
 * somebody issues a fresh invite. Which is also why a rotation writes here the
 * moment it is adopted rather than at shutdown: a crash between the two would
 * leave Hex holding an epoch it can no longer derive.
 *
 * The whole membership rides as JSON rather than as columns: it is key material
 * read and written as one thing, and a schema of epochs and priors would be a
 * migration every time CORD-06 grows a field.
 */
CREATE TABLE IF NOT EXISTS concord_memberships (
  community_id TEXT PRIMARY KEY,
  data         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

/*
 * How far each stream has been read, per relay.
 *
 * A Concord channel has no "since the last message" — its events are wraps by a
 * pseudonymous author, and asking for the last hour of one is asking a relay to
 * re-serve ciphertext already stored. The cursor is what makes a restart resume
 * instead of re-ingesting, and it is per RELAY because two relays serving one
 * community are at different points in it.
 */
CREATE TABLE IF NOT EXISTS concord_cursors (
  relay  TEXT NOT NULL,
  stream TEXT NOT NULL,
  since  INTEGER NOT NULL,
  PRIMARY KEY (relay, stream)
);

/*
 * Rumors already ingested, and which of them Hex wrote.
 *
 * Two jobs, and both need to outlive the process. The first is dedupe: four
 * relays serve one wrap and a cursor's overlap replays the boundary, so without
 * this a restart answers the same question twice. The second is the one that
 * makes a conversation a conversation — a reply to something Hex said addresses
 * Hex whether or not it repeats the name, and in memory that recognition lasted
 * exactly as long as the daemon did.
 */
CREATE TABLE IF NOT EXISTS concord_rumors (
  rumor_id TEXT PRIMARY KEY,
  at       INTEGER NOT NULL,
  own      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS concord_rumors_at ON concord_rumors (at);

/*
 * Who may write to this home right now.
 *
 * A row, not a pidfile: acquisition inside BEGIN IMMEDIATE is atomic across
 * processes, and the TTL means a SIGKILL'd holder expires instead of wedging
 * the store. The generation only ever grows — release zeroes expires_at and
 * keeps the row — because it doubles as the fencing token later writes check.
 */
CREATE TABLE IF NOT EXISTS writer_lease (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  generation  INTEGER NOT NULL,
  pid         INTEGER NOT NULL,
  hostname    TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

/*
 * A publish that is in flight: reserved before the relay round-trip, deleted
 * when the ledger records it or the attempt gives up.
 *
 * The ledger alone leaves a window as wide as the relay round-trip: two
 * executions both read a ledger that mentions neither, both publish. The
 * reservation is written in the SAME transaction as the duplicate check, so
 * the second execution's check — in this process or another — sees it. Rows
 * are stamped with the writer generation so a crashed holder's leftovers are
 * recognisable as dead rather than blocking a subject forever.
 */
CREATE TABLE IF NOT EXISTS publish_reservations (
  kind        INTEGER NOT NULL,
  scope       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  reserved_at INTEGER NOT NULL,
  PRIMARY KEY (kind, scope, subject)
);

/*
 * Everything said to this agent, in the order it was accepted.
 *
 * The queue is the handover between hearing and acting: a row is durable
 * before any downstream code observes the event, so a crash mid-turn leaves
 * evidence of what arrived instead of nothing. payload holds CANONICAL
 * fields only — see CanonicalEvent in ingest.ts — because a queue of
 * transport-shaped blobs is one every later reader has to know four protocols
 * to read.
 *
 * claimed_gen/claimed_at are the runner's, which does not exist yet: the
 * columns are here so that landing it is not a migration.
 */
CREATE TABLE IF NOT EXISTS inbound_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  v           INTEGER NOT NULL,
  type        TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  transport   TEXT NOT NULL,
  relay       TEXT,
  room        TEXT NOT NULL,
  peer        TEXT NOT NULL,
  thread      TEXT,
  created_at  INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  claimed_gen INTEGER,
  claimed_at  INTEGER,
  done_at     INTEGER,
  outcome     TEXT
);
CREATE INDEX IF NOT EXISTS inbound_pending ON inbound_events (seq) WHERE done_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inbound_identity ON inbound_events (transport, event_id);

/*
 * What has already been accepted, kept far longer than the queue itself.
 *
 * Two tables rather than one because the retentions differ by an order of
 * magnitude: a queue row is for debugging and a week is plenty, while this is
 * the replay guard and has to comfortably outlast NIP-17's two-day timestamp
 * window — a wrap dated yesterday is re-served on every restart, and without
 * this the same question is answered twice, for money.
 *
 * The id is the RUMOR id for nip-17 and Concord: the wrap is a different
 * envelope on every relay, so deduping on it counts one message four times.
 */
CREATE TABLE IF NOT EXISTS inbound_seen (
  transport TEXT NOT NULL,
  event_id  TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (transport, event_id)
);
CREATE INDEX IF NOT EXISTS inbound_seen_at ON inbound_seen (at);

/*
 * How far each transport has read, per relay and stream.
 *
 * concord_cursors generalised: a NIP-17 inbox and a NIP-29 room ask the same
 * question, and a scheduler will too. Forward-only, for the reason
 * rememberCursor gives.
 */
CREATE TABLE IF NOT EXISTS transport_cursors (
  transport TEXT NOT NULL,
  relay     TEXT NOT NULL,
  stream    TEXT NOT NULL,
  since     INTEGER NOT NULL,
  PRIMARY KEY (transport, relay, stream)
);

/*
 * What this agent still owes the network.
 *
 * The transcript is NOT here: Eve's indexed stream is already a durable
 * outbound queue — the cursor only advances on a publish that landed, and a
 * restart replays what it did not — so a spool beside it would be a second
 * source of truth for the same events. What IS here is everything composed
 * once and then lost on failure: a reply, an ack reaction, and the gift wrap
 * of a transcript event that reached some recipients but not all (the partial
 * case, which advances the cursor and is therefore never replayed).
 *
 * payload carries the whole inbound message (or rumor) as JSON, because a reply
 * is not composable from canonical fields alone — a NIP-29 reply threads onto
 * the raw event — and a row has to be sendable by a process that never saw it.
 */
CREATE TABLE IF NOT EXISTS outbound (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  inbound_seq INTEGER,
  kind        TEXT NOT NULL,
  transport   TEXT NOT NULL,
  relay       TEXT,
  room        TEXT NOT NULL,
  recipient   TEXT,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  claimed_gen INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     INTEGER,
  sent_id     TEXT,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS outbound_pending ON outbound (id) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS outbound_inbound ON outbound (inbound_seq);
`;

/**
 * How long a carried-out control event is remembered.
 *
 * Ten times the two-day read floor, because the cost of remembering too long is
 * a few hundred rows and the cost of forgetting too early is an instruction
 * obeyed twice.
 */
const OBEYED_HORIZON_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long a published event is remembered for the duplicate check.
 *
 * Long enough to outlast any re-execution — those land minutes apart — and
 * short enough that a genuine follow-up next week is nobody's duplicate.
 */
const PUBLISHED_HORIZON_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long an accepted event id is remembered.
 *
 * Fifteen times NIP-17's two-day timestamp window, which is the replay this has
 * to outlast: a restart re-reads the inbox back that far every time.
 */
const INBOUND_SEEN_HORIZON_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long a settled queue row is kept.
 *
 * Only for reading afterwards — "why was that message never answered" is a
 * question with an answer in the `outcome` column. The dedupe guard is
 * `inbound_seen`, so pruning here forgets nothing that matters.
 */
const INBOUND_DONE_HORIZON_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long a delivered outbound row is kept.
 *
 * Same reasoning as the queue's: only for reading afterwards. A row that never
 * went is never pruned — it is still owed, however old.
 */
const OUTBOUND_SENT_HORIZON_SECONDS = 7 * 24 * 60 * 60;

/**
 * A queue row, as it came back out of SQLite.
 *
 * Deliberately NOT a `CanonicalEvent`: `type` is a string here because the row
 * may have been written by a newer version of hex, and a cast would turn "a
 * type this build does not know" into an impossible state the compiler swears
 * cannot happen.
 */
export interface QueuedInbound {
  seq: number;
  v: number;
  type: string;
  id: string;
  route: {
    transport: string;
    relay?: string;
    room: string;
    peer: string;
    thread?: string;
  };
  createdAt: number;
  observedAt: number;
  payload: unknown;
}

/**
 * Something owed to the network, as it goes in.
 *
 * `room` is what the row is about rather than where it goes — a wrap's is the
 * session it belongs to — so an operator reading the spool can see which
 * conversation is stuck.
 */
export interface OutboundSpec {
  /** The queue row this answers, when it answers one. */
  inboundSeq?: number;
  kind: "reply" | "reaction" | "wrap";
  transport: string;
  relay?: string;
  room: string;
  /** Per-recipient for a wrap, so partial delivery retries only who is left. */
  recipient?: string;
  payload: unknown;
}

/**
 * The same row, read back.
 *
 * `kind` is a string here, not the union: a row may have been spooled by a
 * newer hex that can send a kind this one has never heard of.
 */
export interface OutboundRow extends Omit<OutboundSpec, "kind"> {
  id: number;
  kind: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

/** What became of one spooled row. */
export interface OutboundState {
  attempts: number;
  sentAt?: number;
  sentId?: string;
  lastError?: string;
  claimedGen?: number;
}

/** One row of the publish ledger. */
export interface PublishedEvent {
  id: string;
  kind: number;
  /** The `a` tag the event hangs off, or "". */
  scope: string;
  /** Normalised subject — see `normaliseSubject` in `tools/publish.ts`. */
  subject: string;
  sha256: string;
  at: number;
}

/**
 * How long a lease lives without a heartbeat.
 *
 * Long enough that a stalled event loop does not lose a healthy process its
 * lease, short enough that a SIGKILL'd holder frees the store before anyone
 * files a bug about it. Heartbeats should land at a quarter of this.
 */
export const WRITER_LEASE_TTL_SECONDS = 60;

/** How often a holder should call `heartbeat()`. */
export const WRITER_LEASE_HEARTBEAT_SECONDS = 15;

/**
 * How long a publish reservation stays credible.
 *
 * A relay round-trip is seconds; ten minutes is a process that died holding
 * one. Old rows are pruned at open and skipped by the check, so a crash never
 * permanently blocks a subject.
 */
const RESERVATION_HORIZON_SECONDS = 10 * 60;

/** Who holds the writer lease, as the row remembers them. */
export interface WriterLeaseHolder {
  generation: number;
  pid: number;
  hostname: string;
  acquiredAt: number;
  expiresAt: number;
}

/**
 * An exclusive claim on writing to one agent home.
 *
 * An interface rather than a class on purpose: today the token comes from a
 * sqlite row, later it can come from a published, expiring claim on the wire —
 * the generation semantics are identical either way, so code fencing on
 * `generation` never has to know which one it holds.
 */
export interface WriterLease {
  readonly generation: number;
  /**
   * Extend the lease, and say whether it is still ours.
   *
   * False means another process took over — the only correct response is to
   * stop writing and exit loudly, because every write from here on forks
   * state the new holder believes it owns.
   */
  heartbeat(): boolean;
  /** Let it go on a clean shutdown, keeping the generation for the next holder. */
  release(): void;
}

/**
 * Thrown when a write is refused by the fence.
 *
 * Either the writer's generation is no longer the lease's — another process
 * took over — or the write would move a transcript's cursors backwards, which
 * means another writer already moved them forward. Both are the same disease:
 * two writers, one store; the only correct response is to stop writing.
 */
export class FencedWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencedWriteError";
  }
}

/** Thrown when the lease is held by a live process. Names the holder. */
export class LeaseHeldError extends Error {
  constructor(readonly holder: WriterLeaseHolder) {
    const now = Math.floor(Date.now() / 1000);
    const age = Math.max(0, now - holder.acquiredAt);
    const left = Math.max(0, holder.expiresAt - now);
    // A killed holder cannot release, so this is also what a dead pid looks
    // like. Saying the lease expires on its own stops that reading as fatal.
    super(
      `the writer lease on this agent home is held by pid ${holder.pid} ` +
        `on ${holder.hostname} (generation ${holder.generation}, ` +
        `acquired ${age}s ago). If that process is already gone, the lease ` +
        `frees itself in ${left}s — a live holder renews it before then, so ` +
        `nothing needs deleting`,
    );
    this.name = "LeaseHeldError";
  }
}

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
    db.prepare(`DELETE FROM published WHERE at < ?`).run(
      Math.floor(Date.now() / 1000) - PUBLISHED_HORIZON_SECONDS,
    );

    // The Concord dedupe set is a replay guard, not a log: it only has to
    // outlast the window a cursor's overlap can replay.
    db.prepare(`DELETE FROM concord_rumors WHERE at < ?`).run(
      Math.floor(Date.now() / 1000) - OBEYED_HORIZON_SECONDS,
    );

    // Orphaned reservations: stamped by a generation that is no longer the
    // lease's, or older than any honest relay round-trip. A crash between
    // reserve and confirm must not block that subject forever.
    db.prepare(
      `DELETE FROM publish_reservations
        WHERE reserved_at < ?
           OR generation != COALESCE(
                (SELECT generation FROM writer_lease WHERE id = 1), -1)`,
    ).run(Math.floor(Date.now() / 1000) - RESERVATION_HORIZON_SECONDS);

    db.prepare(`DELETE FROM inbound_seen WHERE at < ?`).run(
      Math.floor(Date.now() / 1000) - INBOUND_SEEN_HORIZON_SECONDS,
    );
    // Settled rows only: a pending one is owed work however old it is.
    db.prepare(
      `DELETE FROM inbound_events WHERE done_at IS NOT NULL AND done_at < ?`,
    ).run(Math.floor(Date.now() / 1000) - INBOUND_DONE_HORIZON_SECONDS);
    // Delivered rows only: an owed one stays owed for as long as it takes.
    db.prepare(
      `DELETE FROM outbound WHERE sent_at IS NOT NULL AND sent_at < ?`,
    ).run(Math.floor(Date.now() / 1000) - OUTBOUND_SENT_HORIZON_SECONDS);

    /**
     * Concord's cursors, carried into the general table.
     *
     * Additive and idempotent — an existing `transport_cursors` row wins, so a
     * home that has already moved on is not walked backwards. `concord_cursors`
     * is left where it is: dropping an operator's read position to tidy a
     * schema is not a migration this gets to make.
     */
    db.exec(
      `INSERT OR IGNORE INTO transport_cursors (transport, relay, stream, since)
         SELECT 'concord', relay, stream, since FROM concord_cursors`,
    );

    return new HexStore(db);
  }

  /** Whether this connection is inside `transaction()`. Nesting is refused. */
  private inTransaction = false;

  /**
   * Run several statements as one atomic write.
   *
   * `BEGIN IMMEDIATE` so the write lock is taken up front — two processes
   * cannot both read the same state and both act on it. Nesting THROWS rather
   * than degrading to a savepoint: nothing here needs one, so a nested call is
   * a design error, and hiding it is worse than refusing it.
   */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction)
      throw new Error(
        "nested transaction — nothing in this store needs savepoints, so this is a design error",
      );
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // A connection left inside BEGIN IMMEDIATE wedges every later write.
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  // ── Writer lease ──────────────────────────────────────────────────────────

  /**
   * Take the exclusive right to write to this home, or say who has it.
   *
   * The whole read-decide-write runs in one transaction, so two processes
   * racing for one file cannot both see "expired" and both take generation
   * N+1 — the loser blocks on the lock and then sees the winner's row.
   *
   * `takeover` seizes even a LIVE lease: the generation still bumps, so the
   * displaced holder's next heartbeat reports lost and it exits — which is
   * strictly safer than writing beside it unfenced.
   */
  acquireWriterLease(options?: {
    ttlSecs?: number;
    takeover?: boolean;
  }): WriterLease {
    const ttl = options?.ttlSecs ?? WRITER_LEASE_TTL_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    const generation = this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT generation, pid, hostname, acquired_at, expires_at
             FROM writer_lease WHERE id = 1`,
        )
        .get() as
        | {
            generation: number;
            pid: number;
            hostname: string;
            acquired_at: number;
            expires_at: number;
          }
        | undefined;
      if (row && row.expires_at > now && !options?.takeover)
        throw new LeaseHeldError({
          generation: Number(row.generation),
          pid: Number(row.pid),
          hostname: String(row.hostname),
          acquiredAt: Number(row.acquired_at),
          expiresAt: Number(row.expires_at),
        });
      // Absent or expired: take over. The generation always moves forward,
      // even over an expired or released row — it never repeats.
      const next = (row ? Number(row.generation) : 0) + 1;
      this.db
        .prepare(
          `INSERT INTO writer_lease (id, generation, pid, hostname, acquired_at, expires_at)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             generation = excluded.generation, pid = excluded.pid,
             hostname = excluded.hostname, acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at`,
        )
        .run(next, process.pid, osHostname(), now, now + ttl);
      return next;
    });

    const db = this.db;
    return {
      generation,
      heartbeat(): boolean {
        const at = Math.floor(Date.now() / 1000);
        const changed = db
          .prepare(
            `UPDATE writer_lease SET expires_at = ?
              WHERE id = 1 AND generation = ?`,
          )
          .run(at + ttl, generation).changes;
        return changed > 0;
      },
      release(): void {
        // Expire rather than delete: the row's generation is what makes the
        // next holder's strictly greater.
        db.prepare(
          `UPDATE writer_lease SET expires_at = 0
            WHERE id = 1 AND generation = ?`,
        ).run(generation);
      },
    };
  }

  /** Who holds the lease right now, or nothing if it is free or expired. */
  writerLeaseHolder(): WriterLeaseHolder | undefined {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT generation, pid, hostname, acquired_at, expires_at
           FROM writer_lease WHERE id = 1 AND expires_at > ?`,
      )
      .get(now) as
      | {
          generation: number;
          pid: number;
          hostname: string;
          acquired_at: number;
          expires_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      generation: Number(row.generation),
      pid: Number(row.pid),
      hostname: String(row.hostname),
      acquiredAt: Number(row.acquired_at),
      expiresAt: Number(row.expires_at),
    };
  }

  // ── Concord ───────────────────────────────────────────────────────────────

  /** Every community Hex holds keys for. */
  storedMemberships(): StoredMembership[] {
    const rows = this.db
      .prepare(`SELECT data FROM concord_memberships`)
      .all() as { data: string }[];
    const out: StoredMembership[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data) as StoredMembership);
      } catch {
        // A row that will not parse is not a reason to start with no
        // communities at all: the others still open.
      }
    }
    return out;
  }

  /**
   * Write a membership back.
   *
   * Called on every adopted rotation, not only at join. The window between
   * holding a new epoch and having written it down is the window in which a
   * crash costs the key.
   */
  saveMembership(membership: Membership): void {
    const stored = membershipToStored(membership);
    this.db
      .prepare(
        `INSERT INTO concord_memberships (community_id, data, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(community_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        stored.communityId,
        JSON.stringify(stored),
        Math.floor(Date.now() / 1000),
      );
  }

  /** Forget a community entirely — a leave, or an operator cleaning up. */
  forgetMembership(communityIdHex: string): void {
    this.db
      .prepare(`DELETE FROM concord_memberships WHERE community_id = ?`)
      .run(communityIdHex);
  }

  /**
   * How far a transport has read one stream on one relay.
   *
   * `relay` is part of the key rather than a detail: two relays serving one
   * community are at different points in it.
   */
  transportCursorFor(
    transport: string,
    relay: string,
    stream: string,
  ): number | undefined {
    const row = this.db
      .prepare(
        `SELECT since FROM transport_cursors
          WHERE transport = ? AND relay = ? AND stream = ?`,
      )
      .get(transport, relay, stream) as { since?: number } | undefined;
    return row?.since;
  }

  /**
   * Move a cursor forward, and only forward.
   *
   * `MAX` rather than a plain write because events do not arrive in order: a
   * relay serving stored history after a live event would otherwise walk the
   * cursor backwards and re-ingest everything between.
   */
  rememberTransportCursor(
    transport: string,
    relay: string,
    stream: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO transport_cursors (transport, relay, stream, since)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(transport, relay, stream)
           DO UPDATE SET since = MAX(since, excluded.since)`,
      )
      .run(transport, relay, stream, at);
  }

  /**
   * Concord's cursors, which are `transport_cursors` rows now.
   *
   * Kept as named methods because `ConcordDurability` is the transport's own
   * seam and has no business knowing there are other transports.
   */
  cursorFor(relay: string, stream: string): number | undefined {
    return this.transportCursorFor("concord", relay, stream);
  }

  rememberCursor(relay: string, stream: string, at: number): void {
    this.rememberTransportCursor("concord", relay, stream, at);
  }

  sawRumor(rumorId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM concord_rumors WHERE rumor_id = ?`)
        .get(rumorId),
    );
  }

  isOwnRumor(rumorId: string): boolean {
    const row = this.db
      .prepare(`SELECT own FROM concord_rumors WHERE rumor_id = ?`)
      .get(rumorId) as { own?: number } | undefined;
    return row?.own === 1;
  }

  rememberRumor(
    rumorId: string,
    own: boolean,
    at = Math.floor(Date.now() / 1000),
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO concord_rumors (rumor_id, at, own) VALUES (?, ?, ?)`,
      )
      .run(rumorId, at, own ? 1 : 0);
  }

  // ── Inbound queue ─────────────────────────────────────────────────────────

  /**
   * Accept an event, once.
   *
   * The seen-record and the queue row are written in ONE transaction: as two
   * statements, two deliveries of the same message interleaving between them
   * both read "not yet" and both enqueue. Returns the row's seq, or undefined
   * when this (transport, id) has already been accepted inside the horizon.
   *
   * Never call this inside `transaction()` — nesting is refused on purpose.
   */
  enqueueInbound(event: CanonicalEvent): number | undefined {
    return this.transaction(() => {
      const seen = this.db
        .prepare(
          `INSERT OR IGNORE INTO inbound_seen (transport, event_id, at)
           VALUES (?, ?, ?)`,
        )
        .run(event.route.transport, event.id, event.observedAt);
      if (Number(seen.changes) === 0) return undefined;
      const inserted = this.db
        .prepare(
          `INSERT INTO inbound_events
             (v, type, event_id, transport, relay, room, peer, thread,
              created_at, observed_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.v,
          event.type,
          event.id,
          event.route.transport,
          event.route.relay ?? null,
          event.route.room,
          event.route.peer,
          event.route.thread ?? null,
          event.createdAt,
          event.observedAt,
          JSON.stringify(event.payload),
        );
      return Number(inserted.lastInsertRowid);
    });
  }

  /** Everything still owed work, oldest first. */
  pendingInbound(limit = 500): QueuedInbound[] {
    const rows = this.db
      .prepare(
        `SELECT seq, v, type, event_id, transport, relay, room, peer, thread,
                created_at, observed_at, payload
           FROM inbound_events WHERE done_at IS NULL ORDER BY seq LIMIT ?`,
      )
      .all(limit) as unknown as {
      seq: number;
      v: number;
      type: string;
      event_id: string;
      transport: string;
      relay: string | null;
      room: string;
      peer: string;
      thread: string | null;
      created_at: number;
      observed_at: number;
      payload: string;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      v: row.v,
      // Untrusted: a row written by a newer version may name a type this build
      // has never heard of. The ingestor decides what to do about that.
      type: row.type,
      id: row.event_id,
      route: {
        transport: row.transport,
        relay: row.relay ?? undefined,
        room: row.room,
        peer: row.peer,
        thread: row.thread ?? undefined,
      },
      createdAt: row.created_at,
      observedAt: row.observed_at,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }

  /**
   * Settle one row. `outcome` is `handled`, `duplicate`, `refused`, `ignored`,
   * or `dropped:<reason>`. A row left unsettled is still owed work.
   */
  finishInbound(
    seq: number,
    outcome: string,
    at = Math.floor(Date.now() / 1000),
  ): void {
    this.db
      .prepare(
        `UPDATE inbound_events SET done_at = ?, outcome = ? WHERE seq = ?`,
      )
      .run(at, outcome, seq);
  }

  /**
   * Take one row for the live generation, once.
   *
   * The claim is what makes redelivery safe: a row claimed by a generation that
   * is no longer live is offered again — the process that held it is gone —
   * while a row this generation already claimed is never dispatched twice. Both
   * halves are read and written in one transaction, or two drains of one queue
   * interleave between them and both claim it.
   *
   * False when the row is already settled, or already claimed by this
   * generation.
   */
  claimInbound(
    seq: number,
    generation: number,
    at = Math.floor(Date.now() / 1000),
  ): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE inbound_events SET claimed_gen = ?, claimed_at = ?
             WHERE seq = ? AND done_at IS NULL
               AND (claimed_gen IS NULL OR claimed_gen != ?)`,
        )
        .run(generation, at, seq, generation);
      return Number(result.changes) === 1;
    });
  }

  /** Which generation holds a row, if any — for the operator, and for tests. */
  inboundClaim(seq: number): number | undefined {
    const row = this.db
      .prepare(`SELECT claimed_gen FROM inbound_events WHERE seq = ?`)
      .get(seq) as { claimed_gen?: number | null } | undefined;
    return row?.claimed_gen ?? undefined;
  }

  /** What became of one row — for the operator, and for tests. */
  inboundOutcome(seq: number): string | undefined {
    const row = this.db
      .prepare(`SELECT outcome FROM inbound_events WHERE seq = ?`)
      .get(seq) as { outcome?: string | null } | undefined;
    return row?.outcome ?? undefined;
  }

  /** The queue row one accepted event landed in, if this home has it. */
  inboundSeqFor(transport: string, eventId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT seq FROM inbound_events WHERE transport = ? AND event_id = ?`,
      )
      .get(transport, eventId) as { seq?: number } | undefined;
    return row?.seq ?? undefined;
  }

  // ── Outbound spool ────────────────────────────────────────────────────────

  /**
   * Owe something to the network. Durable before anything is attempted.
   *
   * The insert is the whole point: a reply composed and then handed straight to
   * a transport is lost by any failure between the two, and nothing afterwards
   * knows it was ever owed.
   */
  enqueueOutbound(
    spec: OutboundSpec,
    at = Math.floor(Date.now() / 1000),
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO outbound
           (inbound_seq, kind, transport, relay, room, recipient, payload,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        spec.inboundSeq ?? null,
        spec.kind,
        spec.transport,
        spec.relay ?? null,
        spec.room,
        spec.recipient ?? null,
        JSON.stringify(spec.payload),
        at,
      );
    return Number(inserted.lastInsertRowid);
  }

  /**
   * Everything still owed, oldest first, minus what has been given up on.
   *
   * A row past `maxAttempts` is parked rather than deleted: the send is not
   * happening, and `last_error` is the only thing that says why. Excluded here
   * so one poisoned row cannot hold up the rest of the spool.
   */
  pendingOutbound(maxAttempts: number, limit = 200): OutboundRow[] {
    return this.readOutbound(
      `WHERE sent_at IS NULL AND attempts < ? ORDER BY id LIMIT ?`,
      [maxAttempts, limit],
    );
  }

  /** One row that has not gone yet, whatever its attempts. */
  owedOutbound(id: number): OutboundRow | undefined {
    return this.readOutbound(`WHERE id = ? AND sent_at IS NULL`, [id])[0];
  }

  private readOutbound(
    where: string,
    bind: (number | string)[],
  ): OutboundRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, inbound_seq, kind, transport, relay, room, recipient,
                payload, created_at, attempts, last_error
           FROM outbound ${where}`,
      )
      .all(...bind) as unknown as {
      id: number;
      inbound_seq: number | null;
      kind: string;
      transport: string;
      relay: string | null;
      room: string;
      recipient: string | null;
      payload: string;
      created_at: number;
      attempts: number;
      last_error: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      inboundSeq: row.inbound_seq ?? undefined,
      // Untrusted for the same reason a queue row's type is: a newer hex may
      // spool a kind this build cannot send.
      kind: row.kind,
      transport: row.transport,
      relay: row.relay ?? undefined,
      room: row.room,
      recipient: row.recipient ?? undefined,
      payload: JSON.parse(row.payload) as unknown,
      createdAt: row.created_at,
      attempts: row.attempts,
      lastError: row.last_error ?? undefined,
    }));
  }

  /**
   * Take one row for the live generation and count the attempt.
   *
   * Fenced on the lease, like every other write that reaches a relay: a process
   * whose lease was taken over would otherwise drain the same rows the new
   * holder is draining, and both would send. Counted BEFORE the attempt, so a
   * send that hangs or crashes the process still spends one — a poisoned row
   * that kills its sender must not be retried forever.
   */
  beginOutbound(id: number, generation: number): boolean {
    return this.transaction(() => {
      const live = this.db
        .prepare(`SELECT generation FROM writer_lease WHERE id = 1`)
        .get() as { generation: number } | undefined;
      if (!live || Number(live.generation) !== generation)
        throw new FencedWriteError(
          `refusing to send outbound ${id}: this writer holds generation ` +
            `${generation}, but the lease is at ` +
            `${live ? `generation ${Number(live.generation)}` : "no generation at all"} — ` +
            `another process owns this home now`,
        );
      const result = this.db
        .prepare(
          `UPDATE outbound SET claimed_gen = ?, attempts = attempts + 1
             WHERE id = ? AND sent_at IS NULL`,
        )
        .run(generation, id);
      return Number(result.changes) === 1;
    });
  }

  /** It went. `sentId` is the published event's id. */
  outboundSent(
    id: number,
    sentId: string,
    at = Math.floor(Date.now() / 1000),
  ): void {
    this.db
      .prepare(
        `UPDATE outbound SET sent_at = ?, sent_id = ?, last_error = NULL
           WHERE id = ?`,
      )
      .run(at, sentId, id);
  }

  /** It did not go, and this is what the relay or the transport said. */
  outboundFailed(id: number, error: string): void {
    this.db
      .prepare(`UPDATE outbound SET last_error = ? WHERE id = ?`)
      .run(error.slice(0, 500), id);
  }

  /**
   * Whether an answer to this queue row has already been composed.
   *
   * The idempotency marker a client-supplied key would give us and a relay
   * cannot: a redelivered message whose row already owes — or has already sent
   * — a reply must be settled rather than answered a second time.
   *
   * Replies ONLY. The ack reaction is spooled before the turn even starts, so
   * counting it would make every redelivered message look already answered.
   */
  outboundRepliedTo(inboundSeq: number): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM outbound WHERE inbound_seq = ? AND kind = 'reply'`,
        )
        .get(inboundSeq),
    );
  }

  /** One row, whatever state it is in — for the operator, and for tests. */
  outboundRow(id: number): OutboundState | undefined {
    const row = this.db
      .prepare(
        `SELECT attempts, sent_at, sent_id, last_error, claimed_gen
           FROM outbound WHERE id = ?`,
      )
      .get(id) as
      | {
          attempts: number;
          sent_at: number | null;
          sent_id: string | null;
          last_error: string | null;
          claimed_gen: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      attempts: row.attempts,
      sentAt: row.sent_at ?? undefined,
      sentId: row.sent_id ?? undefined,
      lastError: row.last_error ?? undefined,
      claimedGen: row.claimed_gen ?? undefined,
    };
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
   * runtime was down should be retried by the redelivery of its still-pending
   * queue row at the next start — a relay's own redelivery is gone, stopped by
   * `inbound_seen` — and the scope checks are what make redelivering a command
   * that DID land harmless.
   */
  markObeyed(controlId: string, at = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO obeyed (control_id, at) VALUES (?, ?)`)
      .run(controlId, at);
  }

  /**
   * Check and record in one transaction: true means this caller was first.
   *
   * `wasObeyed` then `markObeyed` as two statements is a check-then-act; two
   * deliveries interleaving between them both read "not yet". The check cannot
   * span the awaited instruction itself — that stays `wasObeyed` up front and
   * this at the point it landed.
   */
  obeyOnce(controlId: string, at = Math.floor(Date.now() / 1000)): boolean {
    return this.transaction(() => {
      if (this.wasObeyed(controlId)) return false;
      this.markObeyed(controlId, at);
      return true;
    });
  }

  /** What this agent published recently, in the scope and kind asked about. */
  publishedSince(kind: number, scope: string, since: number): PublishedEvent[] {
    return this.db
      .prepare(
        `SELECT id, kind, scope, subject, sha256, at FROM published
          WHERE kind = ? AND scope = ? AND at >= ? ORDER BY at DESC`,
      )
      .all(kind, scope, since) as unknown as PublishedEvent[];
  }

  /** Record one, after a relay took it. */
  rememberPublished(event: PublishedEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO published (id, kind, scope, subject, sha256, at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.kind,
        event.scope,
        event.subject,
        event.sha256,
        event.at,
      );
  }

  // ── Publish reservations ──────────────────────────────────────────────────

  /**
   * The live reservation on this subject, if any.
   *
   * Live means stamped by the lease's CURRENT generation and fresher than the
   * horizon — a dead process's leftovers are skipped, not honoured. Reads
   * only; call it inside `transaction()` alongside the duplicate check.
   */
  liveReservation(
    kind: number,
    scope: string,
    subject: string,
  ): { generation: number; reservedAt: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT generation, reserved_at FROM publish_reservations
          WHERE kind = ? AND scope = ? AND subject = ?
            AND reserved_at > ?
            AND generation = (SELECT generation FROM writer_lease WHERE id = 1)`,
      )
      .get(
        kind,
        scope,
        subject,
        Math.floor(Date.now() / 1000) - RESERVATION_HORIZON_SECONDS,
      ) as { generation: number; reserved_at: number } | undefined;
    if (!row) return undefined;
    return {
      generation: Number(row.generation),
      reservedAt: Number(row.reserved_at),
    };
  }

  /**
   * Claim a subject before the relay round-trip.
   *
   * Upserts, because a dead reservation may still occupy the key — the caller
   * checked `liveReservation` in the SAME transaction, so overwriting a dead
   * one is taking over, not racing. No transaction of its own for that reason.
   */
  reservePublish(entry: {
    kind: number;
    scope: string;
    subject: string;
    generation: number;
    at?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO publish_reservations (kind, scope, subject, generation, reserved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, scope, subject) DO UPDATE SET
           generation = excluded.generation, reserved_at = excluded.reserved_at`,
      )
      .run(
        entry.kind,
        entry.scope,
        entry.subject,
        entry.generation,
        entry.at ?? Math.floor(Date.now() / 1000),
      );
  }

  /** Give a subject back: the publish failed, was refused, or was a dry run. */
  releasePublish(
    kind: number,
    scope: string,
    subject: string,
    generation: number,
  ): void {
    this.db
      .prepare(
        `DELETE FROM publish_reservations
          WHERE kind = ? AND scope = ? AND subject = ? AND generation = ?`,
      )
      .run(kind, scope, subject, generation);
  }

  /**
   * A relay took it: retire the reservation and write the ledger row as one.
   *
   * One transaction, because the gap between them is the gap this table
   * exists to close — a reservation deleted before the ledger row lands is a
   * window in which another execution's check sees neither.
   */
  confirmPublish(
    reservation: {
      kind: number;
      scope: string;
      subject: string;
      generation: number;
    },
    event: PublishedEvent,
  ): void {
    this.transaction(() => {
      this.releasePublish(
        reservation.kind,
        reservation.scope,
        reservation.subject,
        reservation.generation,
      );
      this.rememberPublished(event);
    });
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

  /**
   * The whole conversation a session belongs to, peer and room together.
   *
   * What the runner serialises on: a control names a session and a message
   * names a room, and the two have to reach the SAME lane or an instruction and
   * a question about one session run at once — two readers of one stream, which
   * publishes its turns twice.
   */
  conversationForSession(
    sessionId: string,
  ): { peer: string; room: string } | undefined {
    const row = this.db
      .prepare("SELECT peer, room FROM conversations WHERE session_id = ?")
      .get(sessionId) as { peer?: string; room?: string } | undefined;
    return row?.peer === undefined
      ? undefined
      : { peer: row.peer, room: row.room ?? "" };
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
      carriage:
        row.carriage === "group" || row.carriage === "concord"
          ? row.carriage
          : undefined,
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

  /**
   * Write both cursors. Called after every publish, so a crash loses one event.
   *
   * Fenced: the caller states the generation it believes it holds, and the
   * write happens only if the lease agrees — checked INSIDE the transaction,
   * so a takeover between check and write is impossible. The upsert also
   * refuses to move `seq` or `stream_index` backwards: a transcript object
   * reads its row once at construction, so a stale one saving over a newer
   * row is the read-once race, and it forks the chain silently. Now it throws.
   */
  saveTranscript(
    transcript: StoredTranscript,
    fence: { generation: number },
  ): void {
    this.transaction(() => {
      const live = this.db
        .prepare(`SELECT generation FROM writer_lease WHERE id = 1`)
        .get() as { generation: number } | undefined;
      if (!live || Number(live.generation) !== fence.generation)
        throw new FencedWriteError(
          `refusing to write transcript ${transcript.sessionId}: this writer ` +
            `holds generation ${fence.generation}, but the lease is at ` +
            `${live ? `generation ${Number(live.generation)}` : "no generation at all"} — ` +
            `another process owns this home now`,
        );
      const { changes } = this.db
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
           grp = excluded.grp, grp_relay = excluded.grp_relay
         WHERE excluded.seq >= transcripts.seq
           AND excluded.stream_index >= transcripts.stream_index`,
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
          transcript.pending?.length
            ? JSON.stringify(transcript.pending)
            : null,
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
      // The insert always changes a row; a conflict that changed nothing is
      // the monotonic guard refusing to walk a cursor backwards.
      if (changes === 0)
        throw new FencedWriteError(
          `refusing to move transcript ${transcript.sessionId} backwards ` +
            `(to seq ${transcript.seq}, stream_index ${transcript.streamIndex}): ` +
            `the stored row is already ahead, so another writer moved it — ` +
            `this copy of the transcript is stale`,
        );
    });
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
