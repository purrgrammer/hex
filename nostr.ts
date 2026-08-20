/**
 * The plane you get when this page is served from anywhere else.
 *
 * There is no server to ask. The daemon is a process on somebody's home machine
 * behind a router, holding relay sockets open — and those sockets are the way
 * in. A transcript is already published as gift wraps addressed to the operator,
 * so a browser holding the operator's key can read exactly what the machine
 * would have shown it, and a command is exactly the kind-1779 event the daemon
 * already knows how to obey.
 *
 * Which is why this is not a "remote API": there isn't one, and adding one would
 * mean punching a hole through the router for a second authorisation model to
 * disagree with the first. The signature IS the authorisation, checked by the
 * daemon against the operator its own session head names.
 *
 * What this reads:
 *   1059  wrapped, stored  — heads, turns, definitions, control echoes
 *   21059 wrapped, ephemeral — deltas, which are liveness and nothing else
 *
 * Everything is opened locally by the reader's key. Nothing here decrypts on a
 * server, because there is no server.
 */

import { RelayPool } from "applesauce-relay";
import { unlockGiftWrap, type Rumor } from "applesauce-common/helpers";
import { sealRumor } from "applesauce-common/operations/gift-wrap";
import { PrivateKeySigner } from "applesauce-signers";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrEvent } from "nostr-tools";

import type {
  ControlInput,
  Hello,
  LiveMessage,
  Peer,
  Plane,
  SessionSummary,
  WireEvent,
} from "./types.ts";
import {
  KIND_AGENT_DEFINITION,
  KIND_DELTA,
  KIND_SESSION_CONTROL,
  KIND_SESSION_HEAD,
  KIND_TURN,
  sessionFromHead,
  sessionOf,
  tag,
} from "./wire.ts";

const KIND_GIFT_WRAP = 1059;
const KIND_GIFT_WRAP_EPHEMERAL = 21059;

/**
 * How far back the wrap filter reaches.
 *
 * NIP-59 randomises a wrap's timestamp backwards by up to two days, so a filter
 * that asks for "since an hour ago" drops messages sent this second. Two days of
 * slack is the protocol's own number, not a guess.
 */
const WRAP_SKEW_SECONDS = 2 * 24 * 60 * 60;

/** What the browser must be told before it can read anything. */
export interface NostrPlaneOptions {
  /** The reader's own key — the operator the transcripts are addressed to. */
  pubkey: string;
  /** Signs, and decrypts wraps. A read-only account can do neither. */
  signer: {
    getPublicKey(): Promise<string> | string;
    signEvent(template: unknown): Promise<NostrEvent>;
    nip44?: {
      encrypt(pubkey: string, text: string): Promise<string> | string;
      decrypt(pubkey: string, text: string): Promise<string> | string;
    };
  };
  /** The agent being watched. */
  agent: string;
  /** Where its wraps land — the operator's own inbox relays. */
  relays: string[];
  /** How far back to read on connect, in seconds. */
  lookbackSeconds?: number;
}

export class NostrPlane implements Plane {
  readonly mode = "nostr" as const;

  private readonly pool = new RelayPool();
  private readonly listeners = new Set<(message: LiveMessage) => void>();
  /** Everything opened so far, newest wins per id. The remote plane's store. */
  private readonly events = new Map<string, WireEvent>();
  /** Heads are replaceable: one per session, and only the newest is true. */
  private readonly heads = new Map<string, WireEvent>();
  private readonly opened = new Set<string>();
  private subscription?: { unsubscribe(): void };
  private started = false;

  constructor(private readonly options: NostrPlaneOptions) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  async hello(): Promise<Hello> {
    // The definition is the agent describing itself, and it arrives on the same
    // stream as everything else — so this is what is known SO FAR, refreshed by
    // the stream rather than fetched.
    const definition = [...this.events.values()].find(
      (event) => event.kind === KIND_AGENT_DEFINITION,
    );
    return {
      mode: "nostr",
      pubkey: this.options.agent,
      npub: this.options.agent,
      slug: definition ? tag(definition, "d") : undefined,
      operator: this.options.pubkey,
      // A remote reader can steer, and cannot configure: `hex check` dials
      // relays from the machine, and there is no machine here.
      control: true,
      relayCheck: false,
      profile: definition
        ? {
            name: tag(definition, "name"),
            about: tag(definition, "about"),
            picture: tag(definition, "picture"),
          }
        : undefined,
      relays: { read: [], publish: [], dm: this.options.relays },
    };
  }

  async sessions(): Promise<SessionSummary[]> {
    await this.start();
    return [...this.heads.values()]
      .map(sessionFromHead)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async session(
    id: string,
  ): Promise<{ session?: SessionSummary; events: WireEvent[] }> {
    await this.start();
    const head = this.heads.get(id);
    return {
      session: head ? sessionFromHead(head) : undefined,
      events: [...this.events.values()]
        .filter((event) => sessionOf(event) === id)
        .sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  async feed(limit = 100): Promise<WireEvent[]> {
    await this.start();
    return [...this.events.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * Who has been talking to the agent, as far as its transcripts admit.
   *
   * A remote reader has no conversations table — that is the daemon's own
   * bookkeeping — so this is derived from the runs themselves: a head names the
   * room it happened in. It is a weaker list than the local one, and reporting
   * it as the same list would be a lie about what a phone can know.
   */
  async peers(): Promise<Peer[]> {
    await this.start();
    const peers = new Map<string, Peer>();
    for (const head of this.heads.values()) {
      const channel = tag(head, "channel");
      const transport = tag(head, "transport");
      if (!channel) continue;
      const key = `${transport ?? ""}:${channel}`;
      const at = Number(tag(head, "started") ?? head.createdAt);
      const existing = peers.get(key);
      if (!existing || existing.lastAt < at)
        peers.set(key, {
          peer: transport === "nip-17" ? channel : "",
          room: transport === "nip-17" ? "" : channel,
          sessionId: tag(head, "d") ?? "",
          lastAt: at,
        });
    }
    return [...peers.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * A command, signed by the reader and wrapped to the agent.
   *
   * Built exactly as `buildSessionControl` builds it on the other side — the
   * daemon checks the SEAL's author against the operator on the session head, so
   * anything else is refused, and refusing is the point.
   */
  async control(input: ControlInput): Promise<void> {
    const session = input.session ?? randomHex(32);
    const tags: string[][] = [
      ["a", `${KIND_SESSION_HEAD}:${this.options.agent}:${session}`],
      ["p", this.options.agent],
      ["command", input.command],
    ];
    if (input.request) tags.push(["request", input.request]);
    if (input.turn) tags.push(["turn", input.turn]);
    if (input.option) tags.push(["option", input.option]);
    if (input.policy) tags.push(["policy", input.policy]);
    for (const subject of input.subjects ?? [])
      if (subject[0] && subject[1]) tags.push(subject);
    tags.push(["alt", `Session control: ${input.command}`]);

    const rumor = {
      kind: KIND_SESSION_CONTROL,
      pubkey: this.options.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: input.text ?? "",
    };

    const seal = await sealRumor(
      this.options.agent,
      this.options.signer as never,
    )(rumor as never);
    const key = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: KIND_GIFT_WRAP,
        // Backdated within the protocol's own window: a wrap dated exactly now
        // tells a relay when the conversation happened, which is the one thing
        // the envelope exists to hide.
        created_at:
          Math.floor(Date.now() / 1000) -
          Math.floor(Math.random() * WRAP_SKEW_SECONDS),
        content: nip44Encrypt(
          JSON.stringify(seal),
          getConversationKey(key, this.options.agent),
        ),
        tags: [["p", this.options.agent]],
      },
      key,
    );

    const outcomes = await Promise.allSettled(
      this.options.relays.map((relay) =>
        this.pool.relay(relay).publish(wrap),
      ),
    );
    const landed = outcomes.some(
      (outcome) => outcome.status === "fulfilled" && outcome.value?.ok !== false,
    );
    if (!landed)
      throw new Error(
        "no relay accepted the command — it did not reach the agent",
      );
    this.emit({
      type: "status",
      at: Date.now(),
      connected: true,
      detail: `${input.command} sent`,
    });
  }

  // ── The stream ────────────────────────────────────────────────────────────

  subscribe(listener: (message: LiveMessage) => void): () => void {
    this.listeners.add(listener);
    void this.start();
    return () => this.listeners.delete(listener);
  }

  /**
   * One subscription for the whole page, opened once.
   *
   * Both wrap kinds on one filter: a stored transcript and an ephemeral delta
   * arrive on the same socket and open with the same key, and two subscriptions
   * would be two of everything — including two copies of every event that both
   * relays in a list hand over.
   */
  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const since =
      Math.floor(Date.now() / 1000) -
      (this.options.lookbackSeconds ?? 30 * 24 * 60 * 60) -
      WRAP_SKEW_SECONDS;

    this.subscription = this.pool
      .subscription(this.options.relays, [
        {
          kinds: [KIND_GIFT_WRAP, KIND_GIFT_WRAP_EPHEMERAL],
          "#p": [this.options.pubkey],
          since,
        },
      ])
      .subscribe({
        next: (event: NostrEvent | string) => {
          if (typeof event === "string") return; // EOSE
          void this.open(event);
        },
        error: (error: unknown) =>
          this.emit({
            type: "status",
            at: Date.now(),
            connected: false,
            detail: error instanceof Error ? error.message : String(error),
          }),
      });

    this.emit({ type: "status", at: Date.now(), connected: true });
  }

  /**
   * Open one wrap, if it is ours and we have not already.
   *
   * Four relays deliver the same wrap four times; the id is what makes that one
   * event. A wrap that will not open is normal and silent — an inbox holds mail
   * for keys this browser does not have.
   */
  private async open(wrap: NostrEvent): Promise<void> {
    if (this.opened.has(wrap.id)) return;
    this.opened.add(wrap.id);

    let rumor: Rumor;
    try {
      rumor = await unlockGiftWrap(wrap, this.options.signer as never);
    } catch {
      return;
    }

    // Only this agent's own transcript. A wrap from anyone else is somebody
    // else's mail that happens to share an inbox.
    if (rumor.pubkey !== this.options.agent) return;

    const known = [
      KIND_AGENT_DEFINITION,
      KIND_SESSION_HEAD,
      KIND_TURN,
      KIND_DELTA,
      KIND_SESSION_CONTROL,
    ];
    if (!known.includes(rumor.kind)) return;

    const event: WireEvent = {
      id: rumor.id,
      kind: rumor.kind,
      pubkey: rumor.pubkey,
      createdAt: rumor.created_at,
      content: rumor.content,
      tags: rumor.tags,
    };
    event.sessionId = sessionOf(event);

    if (rumor.kind === KIND_DELTA) {
      // Ephemeral by protocol: shown while it streams, never kept. The turn that
      // closes it repeats every word, so nothing is lost by forgetting it.
      this.emit({ type: "delta", event });
      return;
    }

    if (rumor.kind === KIND_SESSION_HEAD) {
      const id = tag(event, "d");
      if (id) {
        const held = this.heads.get(id);
        // A replaceable event: an older copy from a slower relay is not news.
        if (held && held.createdAt > event.createdAt) return;
        this.heads.set(id, event);
      }
    } else {
      this.events.set(event.id, event);
    }

    this.emit({ type: "event", event });
  }

  private emit(message: LiveMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  close(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.started = false;
  }
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
