/**
 * A pointer a model cannot compute, computed here.
 *
 * `nevent` was advertised in the publish result and always `undefined`, so
 * JSON.stringify dropped it. A model with a delivered patch and a room to
 * announce it in wrote the bech32 itself — which is not something you can
 * predict character by character. One real patch was announced with an nevent
 * whose checksum did not verify, pointing at nothing.
 */

import { describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";

import { pointerFor } from "../tools/publish.js";

const AUTHOR = "a".repeat(64);
const ID = "b".repeat(64);

const event = (kind: number, tags: string[][] = []): NostrEvent =>
  ({
    id: ID,
    pubkey: AUTHOR,
    kind,
    tags,
    content: "",
    created_at: 1,
    sig: "",
  }) as NostrEvent;

describe("pointerFor", () => {
  it("returns an nevent that actually decodes, carrying kind and author", () => {
    const { nevent } = pointerFor(event(1617), ["wss://relay.ngit.dev"]);
    const decoded = nip19.decode(nevent);
    expect(decoded.type).toBe("nevent");
    const data = decoded.data as nip19.EventPointer;
    expect(data.id).toBe(ID);
    expect(data.kind).toBe(1617);
    expect(data.author).toBe(AUTHOR);
    expect(data.relays).toEqual(["wss://relay.ngit.dev"]);
  });

  it("adds an naddr for an addressable event, using its d tag", () => {
    const { naddr } = pointerFor(event(30617, [["d", "grimoire"]]), []);
    expect(naddr).toBeDefined();
    const data = nip19.decode(naddr!).data as nip19.AddressPointer;
    expect(data.identifier).toBe("grimoire");
    expect(data.kind).toBe(30617);
    expect(data.pubkey).toBe(AUTHOR);
  });

  it("gives a regular event no naddr", () => {
    expect(pointerFor(event(1), []).naddr).toBeUndefined();
  });

  it("survives an addressable event with no d tag", () => {
    const { naddr } = pointerFor(event(30617), []);
    expect((nip19.decode(naddr!).data as nip19.AddressPointer).identifier).toBe(
      "",
    );
  });

  it("keeps at most three relay hints, so the pointer stays pasteable", () => {
    const many = ["wss://a.dev", "wss://b.dev", "wss://c.dev", "wss://d.dev"];
    const data = nip19.decode(pointerFor(event(1), many).nevent)
      .data as nip19.EventPointer;
    expect(data.relays).toHaveLength(3);
  });
});
