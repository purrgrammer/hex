/**
 * Picking a checkout manager and an exec backend together.
 *
 * They are one decision, not two: a container needs a real clone because a
 * worktree's `.git` is a file pointing into the operator's repository, and running
 * on the host wants a worktree because it is cheap and shares their toolchain.
 * Pairing them here means no call site can mix them, which would produce a
 * checkout the backend cannot use and an error nobody could read.
 */

import type { HexConfig, Isolation } from "../config.js";
import type { HexStore } from "../store.js";
import { CloneManager, type Checkout } from "../clone.js";
import { WorktreeManager } from "../worktree.js";
import type { ExecBackend } from "./exec-backend.js";
import { HostBackend } from "./exec-host.js";
import { ContainerBackend } from "./exec-container.js";
import { join } from "node:path";

export interface Runner {
  checkout: Checkout;
  backend: ExecBackend;
}

export interface RunnerOptions {
  config: HexConfig;
  store: HexStore;
  /** `<home>/<pubkey>` — the agent's own directory. */
  home: { dir: string; worktrees: string };
  agent: string;
  log?: (line: string) => void;
}

/**
 * The pair for one isolation, built once per process and shared by every turn.
 *
 * Throws for an isolation the config never described — `parseConfig` already
 * refuses that combination, so reaching here means the two drifted, and guessing
 * would mean running a command somewhere nobody asked for.
 */
export function createRunner(
  isolation: Isolation,
  options: RunnerOptions,
): Runner {
  const { config, store, home, log } = options;

  if (isolation === "host-worktree")
    return {
      checkout: new WorktreeManager({
        store,
        root: home.worktrees,
        repos: config.repos,
        log,
      }),
      backend: new HostBackend(),
    };

  if (!config.container)
    throw new Error(
      "container isolation was asked for with no `container` section in the config",
    );

  const clones = join(home.dir, "clones");
  const caches = join(home.dir, "caches");
  const checkout = new CloneManager({
    store,
    root: clones,
    repos: config.repos,
    log,
  });

  return {
    checkout,
    backend: new ContainerBackend({
      config: config.container,
      agent: options.agent,
      log,
      // The checkout row is the source of truth for where the work lives; the
      // backend only needs the path, and asking the store keeps the two in step.
      mountFor: (request) => request.cwd,
      // Per workspace, not shared: a shared cache is a small channel between two
      // conversations, and a colder install is the cheaper of the two costs.
      homeFor: (request) => join(caches, request.id, "home"),
    }),
  };
}
