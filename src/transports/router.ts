/**
 * Every configured transport at once, as one.
 *
 * `serve` used to build exactly one — the NIP-17 one — and quietly ignore the
 * rest of the config. An operator who had listed a NIP-29 group got a daemon
 * that started cleanly, said nothing about the group, and never answered in it.
 * Nothing was broken; the code to open it was simply never called, which is the
 * worst shape a missing feature can take because it looks like a working one.
 *
 * The fan-in is the easy half. The half that matters is fanning back OUT: a
 * reply has to leave by the door the message came in, and only the message
 * knows which door that was. So every outbound call is routed on
 * `inbound.room.transport`, and a room from a transport this router does not
 * hold is refused with a sentence rather than answered into the wrong protocol.
 */

import { merge, type Observable } from "rxjs";

import type { Inbound, Transport, TransportName } from "./types.js";

export class TransportRouter implements Transport {
  /**
   * The name of the first transport, for the one caller that wants a label.
   *
   * A router has no protocol of its own, which `Transport` has no way to say.
   * Nothing routes on this.
   */
  readonly name: TransportName;

  private readonly byName: Map<TransportName, Transport>;

  constructor(private readonly transports: Transport[]) {
    if (transports.length === 0)
      throw new Error("a router with no transports can neither hear nor speak");
    this.name = transports[0]!.name;
    this.byName = new Map(
      transports.map((transport) => [transport.name, transport]),
    );
  }

  /** Every transport's stream, interleaved. Order across them is arrival order. */
  start(): Observable<Inbound> {
    return merge(...this.transports.map((transport) => transport.start()));
  }

  /**
   * The transport that owns a room, or a refusal naming what went wrong.
   *
   * Throwing rather than picking a default: answering a NIP-29 message over
   * NIP-17 would deliver a group's answer as a private message to nobody in
   * particular, which is a worse failure than not answering.
   */
  private own(to: Inbound): Transport {
    const transport = this.byName.get(to.room.transport);
    if (!transport)
      throw new Error(
        `nothing here speaks ${to.room.transport}, so there is no way to answer that`,
      );
    return transport;
  }

  async reply(
    to: Inbound,
    text: string,
    tags?: string[][],
    options?: { createdAt?: number },
  ): Promise<string> {
    return this.own(to).reply(to, text, tags, options);
  }

  /**
   * Present only if SOMETHING can react, and a no-op for the rooms that cannot.
   *
   * `react` is optional on `Transport`, and a router that always declared it
   * would promise a reaction in a protocol that has none. Declared here because
   * at least one transport has it; the per-room check is below.
   */
  async react(
    to: Inbound,
    emoji: string,
    options?: { createdAt?: number },
  ): Promise<string> {
    const transport = this.own(to);
    if (!transport.react)
      throw new Error(`${to.room.transport} has no reactions`);
    return transport.react(to, emoji, options);
  }

  async history(
    room: Inbound["room"],
    limit: number,
    options?: { includeOwn?: boolean },
  ): Promise<Inbound[]> {
    const transport = this.byName.get(room.transport);
    if (!transport?.history) return [];
    return transport.history(room, limit, options);
  }

  async describeRoom(
    room: Inbound["room"],
  ): Promise<Record<string, unknown> | undefined> {
    const transport = this.byName.get(room.transport);
    return transport?.describeRoom?.(room);
  }

  async fetchById(room: Inbound["room"], id: string): Promise<Inbound | null> {
    const transport = this.byName.get(room.transport);
    if (!transport?.fetchById) return null;
    return transport.fetchById(room, id);
  }

  stop(): void {
    for (const transport of this.transports) transport.stop();
  }
}
