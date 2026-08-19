/**
 * Handing the agent a way to publish a file.
 *
 * The awkward part is where the bytes are. Every tool in this package runs in
 * HEX's process, on the host, because that is where the key is — while `bash`,
 * `read_file` and the rest run inside the runtime's sandbox. So a screenshot the
 * agent just wrote to `/workspace/out.png` is on the other side of a container
 * boundary from the thing that would upload it, and a tool taking a PATH would
 * read the host's filesystem instead, which is both wrong and worse than wrong.
 *
 * So the content travels: base64, in the call. That is expensive and it is
 * bounded because of it — a few hundred kilobytes is a diagram or a screenshot,
 * and anything larger is a file the agent should be telling someone about rather
 * than carrying through a model's context window.
 *
 * **Encryption is the default, and asymmetric on purpose.** A file uploaded from
 * a DM is encrypted, because that conversation is sealed and a plain URL in it
 * undoes the envelope for the one part anybody looks at. A file posted to a
 * public group is NOT, because encrypting it hides the picture from exactly the
 * people it is for. The tool decides from the room it was bound to; a model
 * asking for the other behaviour has to say so.
 */

import { imetaTag, upload as uploadBlob, MAX_BLOB_BYTES } from "../blossom.js";
import type { ISigner } from "../signer.js";
import { uploadBytes } from "../blossom.js";
import {
  UPLOAD_TOOL,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
} from "./types.js";

/** Base64 inflates by a third, and a model's context pays for all of it. */
const MAX_ENCODED = 1_500_000;

export interface BlossomToolsOptions {
  servers: string[];
  signer: ISigner;
  /** What to do when the caller does not say — set from the room. */
  encryptByDefault: boolean;
  perHour?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

const DEFAULT_PER_HOUR = 20;

export class BlossomTools {
  /** When each upload happened, so the cap is a rolling hour and not a total. */
  private readonly recent: number[] = [];

  constructor(private readonly options: BlossomToolsOptions) {}

  list(): ToolSpec[] {
    return [
      {
        name: UPLOAD_TOOL,
        description:
          "Upload a file and get a URL for it. Give the bytes as base64. Encrypted by default in a private conversation, so only the people in it can read the file; not encrypted in a public room, where encrypting it would hide it from everyone it is for.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The file's bytes, base64-encoded.",
            },
            filename: {
              type: "string",
              description: "What to call it, e.g. `diagram.png`.",
            },
            mime: {
              type: "string",
              description:
                "The file's type, e.g. `image/png`. Guessed from the filename when omitted.",
            },
            encrypted: {
              type: "boolean",
              description:
                "Override the default. Encrypting a file posted publicly hides it from everyone.",
            },
          },
          required: ["content", "filename"],
        },
        prompt:
          "Use blossom.upload to share a file you produced. It returns a URL and, when encrypted, the tags a message needs for anyone to read it — pass those to chat.respond rather than pasting the URL alone, or the recipient gets a URL serving bytes they cannot open.",
      },
    ];
  }

  handles(name: string): boolean {
    return name === UPLOAD_TOOL;
  }

  async call(call: ToolCall): Promise<ToolResult> {
    if (!this.handles(call.name))
      return { ok: false, output: `no tool called ${call.name}` };

    const args = call.arguments ?? {};
    const encoded = typeof args.content === "string" ? args.content : "";
    const filename =
      typeof args.filename === "string" && args.filename.trim()
        ? args.filename.trim()
        : "";

    if (!encoded) return { ok: false, output: "there is nothing to upload" };
    if (!filename)
      return { ok: false, output: "a file needs a name to be uploaded under" };
    if (encoded.length > MAX_ENCODED)
      return {
        ok: false,
        output: `that is ${encoded.length} base64 characters, over the ${MAX_ENCODED} this tool carries — write it somewhere and describe it instead`,
      };

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(encoded, "base64"));
      // Buffer.from is famously forgiving: it returns a short buffer for
      // garbage rather than throwing, so an empty result is the only signal
      // that what arrived was not base64 at all.
      if (bytes.byteLength === 0) throw new Error("decoded to nothing");
    } catch (error) {
      return {
        ok: false,
        output: `that content is not base64: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (bytes.byteLength > MAX_BLOB_BYTES)
      return {
        ok: false,
        output: `${filename} is ${bytes.byteLength} bytes, over what a reader will fetch`,
      };

    const spent = this.spend();
    if (!spent.ok) return { ok: false, output: spent.reason };

    const encrypted =
      typeof args.encrypted === "boolean"
        ? args.encrypted
        : this.options.encryptByDefault;

    try {
      const uploaded = await uploadBytes(
        bytes,
        typeof args.mime === "string" && args.mime
          ? args.mime
          : mimeFor(filename),
        {
          servers: this.options.servers,
          signer: this.options.signer,
          encrypted,
          fetchImpl: this.options.fetchImpl,
          log: this.options.log,
        },
        filename,
      );

      /**
       * The URL AND the tag, together.
       *
       * An encrypted blob's URL on its own is a link to bytes nobody can open,
       * so handing back only the URL is handing back a broken image with extra
       * steps. The `imeta` is what makes it readable, and saying so in the
       * result is the only way the model learns to pass it on.
       */
      return {
        ok: true,
        output: JSON.stringify(
          {
            url: uploaded.url,
            encrypted,
            size: uploaded.size,
            imeta: imetaTag(uploaded),
            note: encrypted
              ? "Encrypted. Send the url in your message AND pass this imeta tag, or the recipient sees a link to bytes they cannot read."
              : "Public. Anyone with the url can read this file.",
          },
          null,
          2,
        ),
      };
    } catch (error) {
      // The truth, so the model can react to it rather than assume it worked.
      return {
        ok: false,
        output: `not uploaded: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** A rolling hour, so a confused loop cannot fill a host with junk. */
  private spend(): { ok: true } | { ok: false; reason: string } {
    const limit = this.options.perHour ?? DEFAULT_PER_HOUR;
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    while (this.recent.length > 0 && this.recent[0]! < hourAgo)
      this.recent.shift();
    if (this.recent.length >= limit)
      return {
        ok: false,
        reason: `${limit} uploads this hour is the limit — say what you would have sent instead`,
      };
    this.recent.push(now);
    return { ok: true };
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
};

function mimeFor(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export { uploadBlob };
