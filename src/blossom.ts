/**
 * Putting a file somewhere a reader can fetch it — plain, or encrypted.
 *
 * Blossom addresses a blob by the SHA-256 of its bytes, so an upload is a PUT
 * whose authorisation names the hash the server is about to receive. That is
 * the whole protocol here (BUD-01/02): a kind-24242 event, signed, base64'd,
 * sent as `Authorization: Nostr …`, and never published to a relay.
 *
 * ## Encrypted, and why it is worth the trouble
 *
 * A Nostr message is sealed and wrapped, so a relay learns nothing from it. A
 * plain image in that message is a public URL on a public host, and anyone who
 * sees the URL sees the picture — which quietly undoes the envelope for the one
 * part of the message people actually look at. So the bytes that reach the host
 * are ciphertext: AES-256-GCM under a key the message carries and the host
 * never sees.
 *
 * The format is not invented here. It is the one grimoire already reads —
 * `decryption-key`, `decryption-nonce` and `ox` on an `imeta` tag beside the URL
 * (CORD-02 §6) — down to the details that decide whether a picture appears or a
 * broken icon does:
 *
 * - **The nonce is 16 bytes, not the usual 12.** AES-GCM permits any IV width
 *   and the reader takes the nonce from the tag, so this works either way — but
 *   the other clients on this format mint 16, and a lone 12 would be a
 *   difference with no reason behind it.
 * - **WebCrypto's layout is `ciphertext ‖ 16-byte tag`**, which is what the
 *   reader's `crypto.subtle.decrypt` expects back. Nothing splits them.
 * - **`ox` is the hash of the PLAINTEXT**, and the reader verifies it after
 *   decrypting. It is the only defence against an untrusted host serving
 *   different bytes that happen to decrypt, so it is required rather than
 *   optional — a pointer that cannot be checked is treated as no pointer.
 */

import { createHash, randomBytes, webcrypto } from "node:crypto";
import { basename, extname } from "node:path";
import { readFile } from "node:fs/promises";

import type { ISigner } from "./signer.js";

/** BUD-01's authorisation event. Signed, sent as a header, never relayed. */
export const KIND_BLOSSOM_AUTH = 24242;

/** How long an upload authorisation is good for. */
const AUTH_LIFETIME_SECONDS = 60;

/**
 * The reader's ceiling, mirrored here so an oversized blob fails at the sender.
 *
 * grimoire refuses to decrypt anything past this, so uploading past it produces
 * a message that is delivered, stored, and permanently unreadable — the worst
 * of the three outcomes.
 */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;

export interface Encryption {
  algorithm: "aes-gcm";
  /** AES-256 key, lowercase hex. */
  key: string;
  /** 16-byte GCM nonce, lowercase hex. */
  nonce: string;
  /** SHA-256 of the PLAINTEXT — the reader's integrity check. */
  ox: string;
}

export interface Uploaded {
  url: string;
  /** SHA-256 of what the server actually holds. */
  sha256: string;
  size: number;
  /** The plaintext's type. A ciphertext's own would misreport it. */
  mime: string;
  /** Absent for a plain upload. */
  encryption?: Encryption;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** What a file is, by its extension — servers and readers both ask. */
export function mimeOf(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * A fresh ArrayBuffer-backed copy.
 *
 * WebCrypto wants a real `BufferSource`, and a `Uint8Array` from node's crypto
 * may sit on a `SharedArrayBuffer` as far as the types are concerned.
 */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Encrypt bytes for a reader holding the key.
 *
 * A fresh key AND a fresh nonce per blob. Reusing either across two blobs under
 * AES-GCM is the one mistake the mode does not survive: two ciphertexts under
 * one key/nonce pair leak the XOR of their plaintexts, and the authentication
 * tag stops meaning anything at all.
 */
export async function encrypt(plaintext: Uint8Array): Promise<{
  ciphertext: Uint8Array;
  encryption: Encryption;
}> {
  const key = randomBytes(32);
  const nonce = randomBytes(16);

  const imported = await webcrypto.subtle.importKey(
    "raw",
    buf(key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const sealed = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: buf(nonce) },
    imported,
    buf(plaintext),
  );

  return {
    ciphertext: new Uint8Array(sealed),
    encryption: {
      algorithm: "aes-gcm",
      key: hex(key),
      nonce: hex(nonce),
      ox: sha256(plaintext),
    },
  };
}

/**
 * The `Authorization` header for one upload.
 *
 * Scoped to the exact hash being sent and expiring in a minute, because this
 * event is a bearer token: anything holding it can upload that one blob to that
 * one server, and nothing else, for a minute.
 */
async function authorization(
  signer: ISigner,
  sha: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const event = await signer.signEvent({
    kind: KIND_BLOSSOM_AUTH,
    created_at: now,
    content: "upload",
    tags: [
      ["t", "upload"],
      ["x", sha],
      ["expiration", String(now + AUTH_LIFETIME_SECONDS)],
    ],
  });
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

export interface UploadOptions {
  servers: string[];
  signer: ISigner;
  /** Encrypt before uploading. The host never sees the plaintext. */
  encrypted?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Upload one file, to the first server that takes it.
 *
 * First rather than all: a blob is addressed by its hash, so a second copy adds
 * redundancy and nothing else — and a failure to mirror should not be reported
 * as a failure to upload. Each server's refusal is said out loud, because a
 * silent fallback to the next one hides a server that has stopped working.
 */
export async function upload(
  path: string,
  options: UploadOptions,
): Promise<Uploaded> {
  const plaintext = new Uint8Array(await readFile(path));
  return uploadBytes(plaintext, mimeOf(path), options, basename(path));
}

export async function uploadBytes(
  plaintext: Uint8Array,
  mime: string,
  options: UploadOptions,
  name = "blob",
): Promise<Uploaded> {
  const log = options.log ?? (() => {});
  const send = options.fetchImpl ?? fetch;

  if (options.servers.length === 0)
    throw new Error(
      "no blossom servers configured — set `tools.blossom.servers`",
    );

  const { body, encryption } = options.encrypted
    ? await (async () => {
        const sealed = await encrypt(plaintext);
        return { body: sealed.ciphertext, encryption: sealed.encryption };
      })()
    : { body: plaintext, encryption: undefined };

  if (body.byteLength > MAX_BLOB_BYTES)
    throw new Error(
      `${name} is ${body.byteLength} bytes, over the ${MAX_BLOB_BYTES} ceiling a reader will fetch`,
    );

  const sha = sha256(body);
  const auth = await authorization(options.signer, sha);
  const failures: string[] = [];

  for (const server of options.servers) {
    const base = server.replace(/\/$/, "");
    try {
      const response = await send(`${base}/upload`, {
        method: "PUT",
        headers: {
          Authorization: auth,
          // The CIPHERTEXT's type when encrypted. Announcing `image/png` for
          // bytes no image decoder can read invites a host to reject or, worse,
          // to "helpfully" transcode them.
          "Content-Type": options.encrypted
            ? "application/octet-stream"
            : mime,
        },
        body: body as unknown as BodyInit,
      });

      if (!response.ok) {
        const reason =
          response.headers.get("x-reason") ??
          (await response.text().catch(() => "")).slice(0, 200);
        failures.push(`${base}: ${response.status} ${reason}`);
        log(`[hex] ${base} refused the blob: ${response.status} ${reason}`);
        continue;
      }

      const descriptor = (await response.json()) as {
        url?: string;
        sha256?: string;
        size?: number;
      };
      const url = descriptor.url ?? `${base}/${sha}`;

      /**
       * The server's own hash, checked against ours.
       *
       * A host that stores something other than what was sent hands back a
       * different digest, and every reader verifying `ox` would then fail on a
       * blob this process reported as delivered. Better to fail here.
       */
      if (descriptor.sha256 && descriptor.sha256 !== sha)
        throw new Error(
          `${base} stored ${descriptor.sha256}, not the ${sha} it was sent`,
        );

      log(`[hex] ${base} took ${body.byteLength} bytes as ${sha.slice(0, 12)}…`);
      return {
        url,
        sha256: sha,
        size: body.byteLength,
        mime,
        encryption,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${base}: ${reason}`);
      log(`[hex] ${base} could not be reached: ${reason}`);
    }
  }

  throw new Error(`no blossom server took the blob — ${failures.join("; ")}`);
}

/**
 * The `imeta` tag that makes an uploaded blob readable.
 *
 * NIP-92's shape: one tag, space-joined `key value` pairs. The decryption
 * fields ride here rather than as tags of their own because that is where the
 * reader looks — an `imeta` is bound to ITS url, and a message carrying two
 * attachments must not leave a reader guessing which key belongs to which.
 */
export function imetaTag(uploaded: Uploaded): string[] {
  const parts = [
    `url ${uploaded.url}`,
    `m ${uploaded.mime}`,
    `x ${uploaded.sha256}`,
    `size ${uploaded.size}`,
  ];
  if (uploaded.encryption) {
    parts.push(`encryption-algorithm ${uploaded.encryption.algorithm}`);
    parts.push(`decryption-key ${uploaded.encryption.key}`);
    parts.push(`decryption-nonce ${uploaded.encryption.nonce}`);
    // The plaintext's hash, which is what a reader verifies after decrypting.
    parts.push(`ox ${uploaded.encryption.ox}`);
  }
  return ["imeta", ...parts];
}

/**
 * The flat tags NIP-17 puts on a kind-15 file message.
 *
 * Alongside the `imeta`, not instead of it. NIP-17 defines these — `file-type`,
 * `encryption-algorithm`, `decryption-key`, `decryption-nonce`, `x`, `ox`,
 * `size` — and a client written to the spec reads them; grimoire and the
 * Concord clients read the `imeta`. Sending both costs a few hundred bytes
 * inside an already-sealed message and is the difference between an attachment
 * that renders in one client and one that renders in either.
 *
 * They say the same thing, so nothing is trusted twice: a reader takes whichever
 * it understands, and both name the same URL, key and hashes.
 */
export function fileMessageTags(uploaded: Uploaded): string[][] {
  const tags: string[][] = [
    ["file-type", uploaded.mime],
    ["x", uploaded.sha256],
    ["size", String(uploaded.size)],
  ];
  if (uploaded.encryption) {
    tags.push(["encryption-algorithm", uploaded.encryption.algorithm]);
    tags.push(["decryption-key", uploaded.encryption.key]);
    tags.push(["decryption-nonce", uploaded.encryption.nonce]);
    tags.push(["ox", uploaded.encryption.ox]);
  }
  return tags;
}
