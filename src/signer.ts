/**
 * Hex's key, from config.
 *
 * Two shapes, both from day one: a local secret key, and a NIP-46 bunker where
 * the key lives elsewhere. The secret never appears in the config file itself —
 * it is named by env var or by a file path.
 */

import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  NostrConnectSigner,
  PrivateKeySigner,
  type ISigner,
} from "applesauce-signers";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { SignerConfig } from "./config.js";
import type { HexRelays } from "./relays.js";

export type { ISigner };

export interface ResolvedSigner {
  signer: ISigner;
  pubkey: string;
  /** How the key was obtained, for `hex whoami` output. */
  source: string;
  close(): Promise<void>;
}

/** Permissions a bunker must grant. Kinds Hex signs, and nothing wider. */
export const BUNKER_SIGN_KINDS = [0, 7, 9, 9021, 10002, 10050, 1059, 13];

/** How long to wait for a remote signer to answer the connect. */
export const BUNKER_CONNECT_TIMEOUT_MS = 30_000;

/** Reject a promise that outlives its deadline, with a message that says so. */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(message.replace("%d", String(timeoutMs)))),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readNsecFromEnv(name: string): Promise<string> {
  const value = process.env[name];
  if (!value || value.trim() === "")
    throw new Error(
      `identity.signer.env names $${name}, which is unset or empty`,
    );
  return value.trim();
}

async function readNsecFromFile(
  path: string,
  baseDir: string,
): Promise<string> {
  const full = resolve(baseDir, path);
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch (error) {
    throw new Error(
      `identity.signer.file could not be read (${full}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const value = text.trim();
  if (!value) throw new Error(`identity.signer.file is empty (${full})`);
  return value;
}

/**
 * The bunker client keypair, persisted.
 *
 * A fresh client key is a fresh pairing request every boot, which means a human
 * approving Hex again after every restart. The file is written 0600 because it
 * authorizes signing requests.
 */
async function loadClientKey(stateDir: string): Promise<PrivateKeySigner> {
  const path = join(stateDir, "bunker-client-key");
  try {
    const hex = (await readFile(path, "utf8")).trim();
    if (hex) return PrivateKeySigner.fromKey(hexToBytes(hex));
  } catch {
    // No key yet: fall through and mint one.
  }

  const key = generateSecretKey();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytesToHex(key), "utf8");
  await chmod(path, 0o600);
  return new PrivateKeySigner(key);
}

/**
 * Resolve the configured signer.
 *
 * `baseDir` is the config file's directory — a relative `file` or `stateDir` in
 * the config means "next to the config", not "wherever hex was invoked from".
 */
export async function resolveSigner(
  config: SignerConfig,
  options: {
    baseDir: string;
    relays: HexRelays;
    /** Deadline for a remote signer's answer. Tests pass a short one. */
    connectTimeoutMs?: number;
  },
): Promise<ResolvedSigner> {
  if (config.type === "nsec") {
    const secret =
      "env" in config
        ? await readNsecFromEnv(config.env)
        : await readNsecFromFile(config.file, options.baseDir);

    let signer: PrivateKeySigner;
    try {
      signer = PrivateKeySigner.fromKey(secret);
    } catch (error) {
      throw new Error(
        `identity.signer does not hold a valid nsec or hex key: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    return {
      signer,
      pubkey: await signer.getPublicKey(),
      source:
        "env" in config
          ? `nsec from $${config.env}`
          : `nsec from ${config.file}`,
      close: async () => {},
    };
  }

  // NIP-46. The signer talks over the relays named in the bunker URI, on the
  // process's own pool.
  NostrConnectSigner.pool = options.relays.pool;
  const clientKey = await loadClientKey(
    resolve(options.baseDir, config.stateDir),
  );
  const bunker = NostrConnectSigner.parseBunkerURI(config.uri);

  // `fromBunkerURI` awaits a response from the remote signer and has NO timeout
  // of its own — a bunker whose app is closed (the normal state of one hosted on
  // a phone) leaves every command hanging with nothing printed, and no hint
  // whether the config, the relay or the signer is at fault.
  const signer = await withDeadline(
    NostrConnectSigner.fromBunkerURI(config.uri, {
      signer: clientKey,
      permissions:
        NostrConnectSigner.buildSigningPermissions(BUNKER_SIGN_KINDS),
    }),
    options.connectTimeoutMs ?? BUNKER_CONNECT_TIMEOUT_MS,
    `the remote signer did not answer within %dms (relays: ${bunker.relays.join(", ")}) — is the bunker app open?`,
  );

  return {
    signer,
    pubkey: await signer.getPublicKey(),
    source: `bunker (${NostrConnectSigner.parseBunkerURI(config.uri).relays.join(", ")})`,
    close: async () => {
      await signer.close();
    },
  };
}
