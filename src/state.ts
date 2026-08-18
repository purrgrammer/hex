/**
 * What Hex remembers across restarts.
 *
 * A kind 9 has no local mirror, so everything the agent knows about a room lives
 * in memory — which meant a restart lost the thread: replies to Hex's own older
 * messages stopped being recognised as addressed to it, and a conversation
 * resumed as a stranger's first sentence.
 *
 * One JSON file, written atomically. Small on purpose: this is continuity, not a
 * database, and everything in it is bounded so an agent left running for a month
 * does not grow a file nobody trims.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One exchange: the messages that belong together, oldest first. */
export interface StoredSession {
  id: string;
  room: string;
  /** Pubkeys that have spoken in it, so a follow-up from them continues it. */
  participants: string[];
  /** Message ids in the session, oldest first. */
  messages: string[];
  /** Unix seconds of the last message recorded. */
  lastAt: number;
}

export interface StoredMessage {
  id: string;
  room: string;
  author: string;
  text: string;
  at: number;
  replyToId?: string;
  /** Whether Hex published it. */
  own?: boolean;
}

export interface HexState {
  version: 1;
  sessions: Record<string, StoredSession>;
  messages: Record<string, StoredMessage>;
}

const EMPTY: HexState = { version: 1, sessions: {}, messages: {} };

/** How many messages the file keeps, oldest evicted first. */
const MAX_MESSAGES = 5_000;
/** How many sessions, likewise. */
const MAX_SESSIONS = 500;
/** Writes are coalesced: a busy room otherwise rewrites the file per message. */
const FLUSH_DELAY_MS = 500;

export class StateStore {
  private state: HexState = structuredClone(EMPTY);
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private dirty = false;

  constructor(private readonly path: string) {}

  /**
   * Load what is on disk.
   *
   * A missing file is a first run. A CORRUPT file is a warning and a fresh start
   * rather than a crash loop: the contents are a convenience, and refusing to
   * boot over them would trade a small loss for a total one.
   */
  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = JSON.parse(text) as HexState;
      if (parsed.version !== 1 || typeof parsed.sessions !== "object")
        throw new Error("unrecognised state file");
      this.state = {
        version: 1,
        sessions: parsed.sessions ?? {},
        messages: parsed.messages ?? {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT")
        console.warn(
          `[hex] ignoring unreadable state at ${this.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      this.state = structuredClone(EMPTY);
    }
  }

  get data(): HexState {
    return this.state;
  }

  /** Mark dirty and schedule a write. */
  touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }

  /**
   * Write the file, atomically.
   *
   * Temp file then rename, because a process killed mid-write would otherwise
   * leave truncated JSON — which `load` would discard, silently forgetting every
   * conversation to save one.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    // Serialise: two overlapping writes can rename out of order.
    this.writing = (this.writing ?? Promise.resolve()).then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      this.trim();
      const temp = `${this.path}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temp, JSON.stringify(this.state), "utf8");
        await rename(temp, this.path);
      } catch (error) {
        // Losing continuity is survivable; crashing the agent over it is not.
        console.warn(
          `[hex] could not write state to ${this.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    return this.writing;
  }

  /** Drop the oldest of everything until the file is a sensible size again. */
  private trim(): void {
    const messages = Object.values(this.state.messages);
    if (messages.length > MAX_MESSAGES) {
      const keep = new Set(
        messages
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_MESSAGES)
          .map((message) => message.id),
      );
      for (const id of Object.keys(this.state.messages))
        if (!keep.has(id)) delete this.state.messages[id];
    }

    const sessions = Object.values(this.state.sessions);
    if (sessions.length > MAX_SESSIONS) {
      const keep = new Set(
        sessions
          .sort((a, b) => b.lastAt - a.lastAt)
          .slice(0, MAX_SESSIONS)
          .map((session) => session.id),
      );
      for (const id of Object.keys(this.state.sessions))
        if (!keep.has(id)) delete this.state.sessions[id];
    }
  }
}

/** Where state lives when the config does not say. Beside the config. */
export function defaultStatePath(baseDir: string): string {
  return join(baseDir, "hex-state.json");
}
