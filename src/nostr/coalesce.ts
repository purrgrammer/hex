/**
 * Delta coalescing (NIP-xx: Agent Sessions).
 *
 * A model emits tokens far faster than a relay should see events. This buffers
 * them per (turn, kind) and flushes on time, size, or a boundary — a tool call,
 * the end of a turn, an error. Timers are injected so it is testable and so the
 * Node copy in `packages/hex` needs no browser globals.
 */

import type { DeltaKind } from "./types.js";

export const DELTA_FLUSH_MS = 750;
export const DELTA_FLUSH_BYTES = 512;
export const DELTA_MAX_BYTES = 2048;
/** Past this many deltas in one turn, drop to a heartbeat every 5s. */
export const DELTA_MAX_PER_TURN = 200;
export const HEARTBEAT_MS = 5000;

export interface CoalescedDelta {
  turn: number;
  part: number;
  delta: DeltaKind;
  text: string;
  /** Which call a `tool` delta belongs to. Required for that kind, absent otherwise. */
  toolId?: string;
}

export interface CoalescerOptions {
  emit: (delta: CoalescedDelta) => void;
  /** Injected so tests do not wait and Node does not need `window`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  flushMs?: number;
  flushBytes?: number;
  maxBytes?: number;
  maxPerTurn?: number;
}

interface Buffer {
  kind: DeltaKind;
  text: string;
  toolId?: string;
}

export class DeltaCoalescer {
  private buffer: Buffer | null = null;
  private timer: unknown = null;
  private turn = 0;
  private part = 0;
  private emitted = 0;
  private lastHeartbeat = Number.NEGATIVE_INFINITY;

  private readonly options: Required<Omit<CoalescerOptions, "emit">> & {
    emit: CoalescerOptions["emit"];
  };

  constructor(options: CoalescerOptions) {
    this.options = {
      emit: options.emit,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer:
        options.clearTimer ?? ((handle) => clearTimeout(handle as never)),
      flushMs: options.flushMs ?? DELTA_FLUSH_MS,
      flushBytes: options.flushBytes ?? DELTA_FLUSH_BYTES,
      maxBytes: options.maxBytes ?? DELTA_MAX_BYTES,
      maxPerTurn: options.maxPerTurn ?? DELTA_MAX_PER_TURN,
    };
  }

  /** A new turn resets `part` — deltas are ordered inside their turn, not across. */
  startTurn(turn: number): void {
    this.flush();
    this.turn = turn;
    this.part = 0;
    this.emitted = 0;
    this.lastHeartbeat = Number.NEGATIVE_INFINITY;
  }

  push(kind: DeltaKind, text: string, atMs = 0, toolId?: string): void {
    if (!text) return;

    // Switching kind flushes the other buffer first, so text and reasoning never
    // interleave within a part. A different tool is a different subject and
    // flushes for the same reason.
    if (this.buffer && (this.buffer.kind !== kind || this.buffer.toolId !== toolId))
      this.flush();

    if (this.emitted >= this.options.maxPerTurn) {
      this.heartbeat(atMs);
      return;
    }

    if (!this.buffer) this.buffer = { kind, text: "", toolId };
    this.buffer.text += text;

    if (this.buffer.text.length >= this.options.maxBytes) {
      this.flush();
      return;
    }
    if (this.buffer.text.length >= this.options.flushBytes) {
      this.flush();
      return;
    }
    this.arm();
  }

  /** Any boundary — tool call, done, error, abort — flushes immediately. */
  boundary(): void {
    this.flush();
  }

  flush(): void {
    this.disarm();
    const buffer = this.buffer;
    this.buffer = null;
    if (!buffer || !buffer.text) return;

    const text =
      buffer.text.length > this.options.maxBytes
        ? buffer.text.slice(0, this.options.maxBytes)
        : buffer.text;

    this.part += 1;
    this.emitted += 1;
    this.options.emit({
      turn: this.turn,
      part: this.part,
      delta: buffer.kind,
      text,
      ...(buffer.toolId ? { toolId: buffer.toolId } : {}),
    });
  }

  private heartbeat(atMs: number): void {
    if (atMs - this.lastHeartbeat < HEARTBEAT_MS) return;
    this.lastHeartbeat = atMs;
    this.part += 1;
    this.options.emit({
      turn: this.turn,
      part: this.part,
      delta: "heartbeat",
      text: "",
    });
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = this.options.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.options.flushMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.options.clearTimer(this.timer);
    this.timer = null;
  }
}
