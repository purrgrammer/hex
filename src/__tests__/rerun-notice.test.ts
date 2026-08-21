/**
 * Saying out loud that the runtime ran a turn twice.
 *
 * The containment — the publish ledger, the settle on a dropped follow — keeps
 * a re-executed turn from doing visible damage. None of it removes the cause,
 * which lives in a setting in the runtime's own environment that this package
 * cannot make for it. So when the signature appears, it is named while somebody
 * is looking, rather than found again months later in a log.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EveTranscript, type RumorSink } from "../eve/transcript.js";
import type { EveEnvelope } from "../eve/types.js";
import { HexStore, agentHome } from "../store.js";

const AGENT = "9".repeat(64);
const OPERATOR = "1".repeat(64);

const quiet: RumorSink = {
  publishRumor: async () => ({ delivered: [OPERATOR], undeliverable: [] }),
};

/**
 * Each ending is its own event: a re-executed turn is a fresh execution, with
 * a fresh trace and fresh event ids. An identical id would be a duplicate
 * delivery of one event, which is a different thing and already handled.
 */
let minted = 0;
const completed = (turnId: string) =>
  ({
    type: "turn.completed",
    data: { turnId },
    meta: { id: `evt_${(minted += 1)}` },
  }) as unknown as EveEnvelope;

describe("a turn that ends twice", () => {
  let home: string;
  let store: HexStore;
  let said: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rerun-"));
    store = HexStore.open(agentHome(home, AGENT).db);
    said = [];
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const transcript = (sessionId: string) =>
    new EveTranscript(
      {
        agentPubkey: AGENT,
        slug: "hex",
        recipients: [OPERATOR],
        store,
        sink: quiet,
        setTimer: () => 0,
        clearTimer: () => {},
        log: (line) => said.push(line),
      },
      sessionId,
    );

  it("names the setting that causes it", async () => {
    const run = transcript("wrun_TWICE");
    await run.handle(completed("turn_0"));
    expect(said.some((line) => line.includes("more than once"))).toBe(false);

    await run.handle(completed("turn_0"));
    const warning = said.find((line) => line.includes("more than once"));
    expect(warning).toBeDefined();
    expect(warning).toContain("WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS=0");
    expect(warning).toContain("WORKFLOW_LOCAL_BODY_TIMEOUT_MS=0");
  });

  it("says it once, not once per redelivery", async () => {
    const run = transcript("wrun_NOISY");
    for (let at = 0; at < 5; at += 1) await run.handle(completed("turn_0"));
    expect(said.filter((line) => line.includes("more than once"))).toHaveLength(1);
  });

  it("says nothing when each turn ends once", async () => {
    const run = transcript("wrun_CLEAN");
    for (const turn of ["turn_0", "turn_1", "turn_2"])
      await run.handle(completed(turn));
    expect(said.some((line) => line.includes("more than once"))).toBe(false);
  });
});
