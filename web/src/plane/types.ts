/**
 * One shape, two planes.
 *
 * This page is served from two places and the difference between them is real:
 * on loopback it talks to the daemon holding the agent's key, and on a static
 * host it talks to relays and the reader signs for themselves. What must NOT
 * differ is what a session looks like once it is on screen — the local record is
 * a tee of the same rumors the operator receives, so both sides can present the
 * identical events and every screen below programs against this interface
 * instead of against a transport.
 *
 * The asymmetry that is real is kept visible rather than hidden: `control` is
 * optional, because a reader with no daemon and no key cannot steer anything,
 * and a UI that offers a button it cannot honour is worse than one that says so.
 */

/** A rumor, flattened. The same fields whether it arrived by HTTP or by relay. */
export interface WireEvent {
  id: string;
  kind: number;
  pubkey: string;
  createdAt: number;
  content: string;
  tags: string[][];
  /** The wire's session id — a head's `d`, everything else's `a`. */
  sessionId?: string;
  seq?: number;
}

/** Where a run stands, as a list row wants it. */
export interface SessionSummary {
  id: string;
  title?: string;
  status: string;
  turn: number;
  seq: number;
  startedAt: number;
  endedAt?: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: string;
  /** Open input requests. A non-empty list means somebody has to answer. */
  pending: string[];
  channel?: { transport: string; id?: string };
  subjects: string[][];
  peer?: string;
  room?: string;
  model?: string;
}

export interface Peer {
  peer: string;
  room: string;
  sessionId: string;
  lastAt: number;
}

export type RelayHealth =
  | { relay: string; state: "ok"; roundTripMs: number }
  | { relay: string; state: "silent" }
  | { relay: string; state: "auth-required" }
  | { relay: string; state: "error"; message: string };

/** What the plane says about itself, and about what it will let you do. */
export interface Hello {
  mode: "local" | "nostr";
  pubkey: string;
  npub: string;
  slug?: string;
  operator?: string;
  eveHost?: string;
  control: boolean;
  relayCheck: boolean;
  profile?: { name?: string; about?: string; picture?: string; bot?: boolean };
  mentions?: string[];
  limits?: { repliesPerRoomPerHour: number };
  relays?: { read: string[]; publish: string[]; dm: string[] };
  transports?: (
    | { type: "nip-29"; groups: { id: string; relay: string }[] }
    | { type: "nip-17"; allow: string[] }
  )[];
  tools?: {
    publish: boolean;
    publishKinds: number[];
    dryRun: boolean;
    blossom: boolean;
    git: boolean;
    bridge: boolean;
  };
  repositories?: unknown[];
}

export type LiveMessage =
  | { type: "event"; event: WireEvent }
  | { type: "delta"; event: WireEvent }
  | { type: "log"; at: number; line: string }
  | { type: "hello"; at: number }
  | { type: "status"; at: number; connected: boolean; detail?: string };

/** What a button asks for. The wire calls this a kind-1779 control event. */
export interface ControlInput {
  command:
    | "start"
    | "respond"
    | "steer"
    | "cancel"
    | "compact"
    | "clear"
    | "reset";
  session?: string;
  text?: string;
  request?: string;
  option?: string;
  turn?: string;
  policy?: "queue" | "steer";
  subjects?: string[][];
}

export interface Plane {
  readonly mode: "local" | "nostr";
  hello(): Promise<Hello>;
  sessions(): Promise<SessionSummary[]>;
  session(id: string): Promise<{ session?: SessionSummary; events: WireEvent[] }>;
  feed(limit?: number): Promise<WireEvent[]>;
  peers(): Promise<Peer[]>;
  checkRelays?(): Promise<RelayHealth[]>;
  control?(input: ControlInput): Promise<void>;
  /** Live messages. Returns the unsubscribe. */
  subscribe(listener: (message: LiveMessage) => void): () => void;
  close(): void;
}
