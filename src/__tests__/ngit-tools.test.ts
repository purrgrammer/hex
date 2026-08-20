import { describe, expect, it } from "vitest";

import { NgitTools } from "../tools/ngit-tools.js";
import {
  GIT_MERGE_TOOL,
  GIT_PROPOSAL_TOOL,
  GIT_PROPOSALS_TOOL,
} from "../tools/types.js";

const CHECKOUTS = { hex: "/Users/nobody/hex" };

describe("NgitTools", () => {
  it("offers nothing when no checkout is named", () => {
    // There is no repository to act in, so the tools would refuse every call.
    // Offering one that always fails costs the model a turn to find out.
    expect(new NgitTools({ checkouts: {} }).list()).toEqual([]);
  });

  it("keeps merging behind its own permission", () => {
    /**
     * `ngit` signs a merge with the operator's key from the checkout's git
     * config, so a merge this publishes says a human did it. Reading proposals
     * says nothing in anybody's name, which is why they are separate.
     */
    const reading = new NgitTools({ checkouts: CHECKOUTS });
    expect(reading.list().map((spec) => spec.name)).toEqual([
      GIT_PROPOSALS_TOOL,
      GIT_PROPOSAL_TOOL,
    ]);

    const writing = new NgitTools({ checkouts: CHECKOUTS, write: true });
    expect(writing.list().map((spec) => spec.name)).toContain(GIT_MERGE_TOOL);
  });

  it("refuses to merge when writing is off, rather than trying and failing", async () => {
    const tools = new NgitTools({ checkouts: CHECKOUTS });
    const result = await tools.call(GIT_MERGE_TOOL, {
      repo: "hex",
      id: "abcdef",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("separate permission");
  });

  it("acts only in a checkout it was pointed at", async () => {
    /**
     * The reason checkouts are named rather than discovered. A tool that went
     * looking for git directories would find every repository on the machine
     * and act on ones it was never given.
     */
    const tools = new NgitTools({ checkouts: CHECKOUTS, write: true });
    const result = await tools.call(GIT_PROPOSALS_TOOL, {
      repo: "something-else",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no checkout called");
    expect(result.output).toContain("hex");
  });

  it("says a configured checkout is missing rather than running there", async () => {
    const tools = new NgitTools({ checkouts: CHECKOUTS });
    const result = await tools.call(GIT_PROPOSALS_TOOL, { repo: "hex" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("does not exist");
  });

  it("refuses an id that is not one", async () => {
    // These become process arguments. `execFile` runs no shell, so this is not
    // the last line of defence — but a wrong id deserves a reason, not an
    // obscure refusal from ngit.
    const tools = new NgitTools({ checkouts: { hex: process.cwd() } });
    for (const id of ["", "not-hex", "../../etc/passwd", "abc"]) {
      const result = await tools.call(GIT_PROPOSAL_TOOL, { repo: "hex", id });
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/not an event id|name the proposal/);
    }
  });
});
