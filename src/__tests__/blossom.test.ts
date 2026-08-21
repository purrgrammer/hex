import { describe, it, expect } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { generateSecretKey } from "nostr-tools/pure";
import { PrivateKeySigner } from "applesauce-signers";

import {
  KIND_BLOSSOM_AUTH,
  encrypt,
  fileMessageTags,
  imetaTag,
  uploadBytes,
  type Uploaded,
} from "../blossom.js";

const signer = new PrivateKeySigner(generateSecretKey());
const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * grimoire's reader, reimplemented rather than imported.
 *
 * The app cannot be imported from here, and paraphrasing its behaviour would
 * test this package against its own assumptions. So the steps are copied from
 * `src/lib/concord/image.ts` verbatim in shape — take the key and nonce out of
 * the tag as HEX, decrypt AES-GCM over `ciphertext ‖ tag`, then verify the
 * result against `ox`. If hex's writer ever drifts from that, this fails here
 * instead of rendering a broken image in someone's inbox.
 */
async function readAsGrimoireWould(
  ciphertext: Uint8Array,
  tag: string[],
): Promise<Uint8Array> {
  const field = (name: string) =>
    tag
      .slice(1)
      .find((part) => part.startsWith(`${name} `))
      ?.slice(name.length + 1);

  const key = field("decryption-key");
  const nonce = field("decryption-nonce");
  const ox = field("ox");
  if (!key || !nonce || !ox)
    throw new Error("imeta carries no readable encrypted pointer");

  const imported = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(key, "hex"),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plain = new Uint8Array(
    await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(nonce, "hex") },
      imported,
      // Node types the buffer as ArrayBufferLike, which SharedArrayBuffer also
      // satisfies; WebCrypto wants the narrower one.
      ciphertext as unknown as ArrayBuffer,
    ),
  );

  const hash = createHash("sha256").update(plain).digest("hex");
  if (hash !== ox)
    throw new Error(`decrypted to ${hash}, which is not the ${ox} promised`);
  return plain;
}

/** A Blossom server that stores what it is given and reports its hash. */
function fakeBlossom(options: { fail?: boolean } = {}) {
  const stored: { sha: string; body: Uint8Array; auth: string }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    if (options.fail)
      return {
        ok: false,
        status: 413,
        headers: new Headers({ "x-reason": "too big" }),
        text: async () => "too big",
      };
    const body = new Uint8Array(init?.body as ArrayBuffer);
    const sha = createHash("sha256").update(body).digest("hex");
    stored.push({
      sha,
      body,
      auth: String(
        (init?.headers as Record<string, string> | undefined)?.Authorization,
      ),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        url: `${String(url).replace("/upload", "")}/${sha}`,
        sha256: sha,
      }),
    };
  }) as unknown as typeof fetch;
  return { impl, stored };
}

describe("blossom", () => {
  it("hands the host bytes it cannot read, and a reader everything it needs", async () => {
    /**
     * The failure this prevents is not an error — it is a picture. A message is
     * sealed and wrapped so a relay learns nothing, and then a plain image in it
     * is a public URL on a public host: anyone who sees the URL sees the
     * picture, and the envelope is undone for the one part of the message
     * people actually look at.
     */
    const original = bytes("the screenshot nobody else should see");
    const server = fakeBlossom();

    const uploaded = await uploadBytes(
      original,
      "image/png",
      {
        servers: ["https://blossom.example"],
        signer,
        encrypted: true,
        fetchImpl: server.impl,
      },
      "shot.png",
    );

    // What the host holds is not the file.
    const held = server.stored[0]!;
    expect(held.body).not.toEqual(original);
    // Ciphertext plus AES-GCM's 16-byte authentication tag.
    expect(held.body.byteLength).toBe(original.byteLength + 16);

    // And what a reader holding the message gets back IS the file.
    const read = await readAsGrimoireWould(held.body, imetaTag(uploaded));
    expect(read).toEqual(original);
  });

  it("refuses to report success when the host stored something else", async () => {
    // A host that keeps different bytes hands back a different digest, and
    // every reader verifying `ox` would then fail on a blob this process
    // already called delivered. Better to fail at the sender.
    const liar = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        url: "https://blossom.example/dead",
        sha256: "0".repeat(64),
      }),
    })) as unknown as typeof fetch;

    await expect(
      uploadBytes(bytes("hello"), "text/plain", {
        servers: ["https://blossom.example"],
        signer,
        fetchImpl: liar,
      }),
    ).rejects.toThrow(/stored 0{64}/);
  });

  it("authorises the exact blob, and nothing else", async () => {
    // The auth event is a bearer token: whatever holds it can upload that one
    // blob to that one server, and only for as long as it says.
    const server = fakeBlossom();
    const uploaded = await uploadBytes(bytes("public notice"), "text/plain", {
      servers: ["https://blossom.example"],
      signer,
      fetchImpl: server.impl,
    });

    const header = server.stored[0]!.auth;
    expect(header.startsWith("Nostr ")).toBe(true);
    const event = JSON.parse(
      Buffer.from(header.slice("Nostr ".length), "base64").toString(),
    ) as { kind: number; tags: string[][] };

    expect(event.kind).toBe(KIND_BLOSSOM_AUTH);
    expect(event.tags).toContainEqual(["t", "upload"]);
    expect(event.tags).toContainEqual(["x", uploaded.sha256]);
    expect(event.tags.some(([name]) => name === "expiration")).toBe(true);
  });

  it("says which servers refused rather than failing silently", async () => {
    const server = fakeBlossom({ fail: true });
    await expect(
      uploadBytes(bytes("x"), "text/plain", {
        servers: ["https://one.example", "https://two.example"],
        signer,
        fetchImpl: server.impl,
      }),
    ).rejects.toThrow(/one\.example.*413.*two\.example.*413/s);
  });

  it("leaves a plain upload plain, and says nothing about decryption", async () => {
    // Not everything is private. A blob meant to be public should not carry a
    // key that implies otherwise.
    const server = fakeBlossom();
    const original = bytes("a public picture");
    const uploaded = await uploadBytes(original, "image/png", {
      servers: ["https://blossom.example"],
      signer,
      fetchImpl: server.impl,
    });

    expect(server.stored[0]!.body).toEqual(original);
    expect(uploaded.encryption).toBeUndefined();
    const tag = imetaTag(uploaded);
    expect(tag.some((part) => part.startsWith("decryption-key"))).toBe(false);
  });

  it("never reuses a key or a nonce", async () => {
    /**
     * The one mistake AES-GCM does not survive. Two ciphertexts under one
     * key/nonce pair leak the XOR of their plaintexts, and the authentication
     * tag stops meaning anything at all.
     */
    const first = await encrypt(bytes("one"));
    const second = await encrypt(bytes("one"));
    expect(first.encryption.key).not.toBe(second.encryption.key);
    expect(first.encryption.nonce).not.toBe(second.encryption.nonce);
    // Same plaintext, same hash — that much must agree.
    expect(first.encryption.ox).toBe(second.encryption.ox);
  });

  it("mints the nonce width the readers on this format use", async () => {
    // AES-GCM permits any IV width and the reader takes it from the tag, so a
    // different width would still work — and would be a difference with no
    // reason behind it. 16 bytes, as armada and Vector mint.
    const { encryption } = await encrypt(bytes("x"));
    expect(encryption.nonce).toHaveLength(32);
    expect(encryption.key).toHaveLength(64);
  });
});

describe("imetaTag", () => {
  it("writes the pairs grimoire's parser reads", () => {
    // `["imeta", "url …", "m …"]` — space-joined pairs, one tag. A shape this
    // package invented would parse to nothing and render a broken image.
    const uploaded: Uploaded = {
      url: "https://blossom.example/abc",
      sha256: "a".repeat(64),
      size: 10,
      mime: "image/png",
      encryption: {
        algorithm: "aes-gcm",
        key: "b".repeat(64),
        nonce: "c".repeat(32),
        ox: "d".repeat(64),
      },
    };
    expect(imetaTag(uploaded)).toEqual([
      "imeta",
      "url https://blossom.example/abc",
      "m image/png",
      `x ${"a".repeat(64)}`,
      "size 10",
      "encryption-algorithm aes-gcm",
      `decryption-key ${"b".repeat(64)}`,
      `decryption-nonce ${"c".repeat(32)}`,
      `ox ${"d".repeat(64)}`,
    ]);
  });
});

describe("fileMessageTags", () => {
  it("says the same thing NIP-17 says, beside the imeta that says it too", () => {
    /**
     * Both, not one. NIP-17 defines these flat tags and a client written to the
     * spec reads them; grimoire and the Concord clients read the `imeta`.
     * Sending both costs a few hundred bytes inside an already-sealed message,
     * and is the difference between an attachment that renders in one client
     * and one that renders in either.
     */
    const uploaded: Uploaded = {
      url: "https://blossom.example/abc",
      sha256: "a".repeat(64),
      size: 10,
      mime: "image/png",
      encryption: {
        algorithm: "aes-gcm",
        key: "b".repeat(64),
        nonce: "c".repeat(32),
        ox: "d".repeat(64),
      },
    };

    const tags = fileMessageTags(uploaded);
    expect(tags).toContainEqual(["file-type", "image/png"]);
    expect(tags).toContainEqual(["x", "a".repeat(64)]);
    expect(tags).toContainEqual(["decryption-key", "b".repeat(64)]);
    expect(tags).toContainEqual(["decryption-nonce", "c".repeat(32)]);
    expect(tags).toContainEqual(["ox", "d".repeat(64)]);

    // The two must agree, or a client reading one and a client reading the
    // other disagree about which bytes the message is about.
    const imeta = imetaTag(uploaded);
    const fromImeta = (name: string) =>
      imeta
        .slice(1)
        .find((part) => part.startsWith(`${name} `))
        ?.slice(name.length + 1);
    const fromFlat = (name: string) =>
      tags.find(([tagName]) => tagName === name)?.[1];
    for (const field of ["decryption-key", "decryption-nonce", "ox", "x"])
      expect(fromFlat(field)).toBe(fromImeta(field));
  });

  it("says nothing about decryption for a public file", () => {
    const tags = fileMessageTags({
      url: "https://blossom.example/abc",
      sha256: "a".repeat(64),
      size: 10,
      mime: "image/png",
    });
    expect(tags.some(([name]) => name.startsWith("decryption"))).toBe(false);
  });
});
