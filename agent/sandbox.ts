import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

/**
 * The repositories Hex is asked about — including its own.
 *
 * Cloned rather than mounted, because the sandbox is a container and this
 * machine's checkouts are not in it — verified, not assumed: a probe run of
 * `hostname; pwd; ls /Users/bandarra` came back `3034bbfd3ef3`, `/workspace`,
 * and "No such file or directory". Nothing under `~` is reachable from a tool
 * call, which is also why `~/.hex/.env` and the agent's own nsec are not.
 *
 * Both are public, so no credential enters the sandbox to clone them.
 */
const REPOSITORIES = [
  {
    directory: "grimoire",
    url: "https://github.com/purrgrammer/grimoire.git",
    /** The Nostr explorer this agent is the assistant for. */
    branch: "main",
  },
  {
    directory: "fragua",
    url: "https://github.com/purrgrammer/fragua.git",
    /** The workflow engine next door; asked about often enough to be here. */
    branch: "main",
  },
  {
    directory: "hex",
    url: "https://github.com/purrgrammer/hex.git",
    /**
     * This agent's own source, so it can be asked to change itself.
     *
     * It carries the spec as well as the daemon, which is the point: a
     * question about why a session head looks the way it does is answerable
     * from `spec/nip-agent-sessions.md` in the same checkout as the code that
     * has to satisfy it.
     */
    branch: "main",
  },
];

/** Where the clones live, and where `bash` already starts. */
const ROOT = "/workspace";

/**
 * Bumped by hand when the bootstrap itself changes.
 *
 * NOT derived from either repository's HEAD, which is the obvious thing to do
 * and the wrong one: both are actively developed, so a key that tracked them
 * would rebuild the container template several times a day, and a template
 * rebuild is minutes of work to save seconds of `git fetch`. Freshness is
 * `onSession`'s job — see below. This key exists only so that changing the
 * clone list here takes effect.
 */
const BOOTSTRAP_VERSION = "2";

export default defineSandbox({
  description: "grimoire, fragua and hex's own source, checked out and kept current",

  /**
   * Pinned rather than left to `defaultSandbox()`.
   *
   * The default picks the best backend it can find — Vercel when hosted, then
   * Docker, then microsandbox, then just-bash. That last one runs on the HOST,
   * with this machine's home directory and this agent's secret key in reach, so
   * a change of environment could silently move the agent from a container to
   * the laptop. `deny-all` is not an option: the clones need the network.
   */
  backend: () => docker({ networkPolicy: "allow-all" }),

  revalidationKey: () => BOOTSTRAP_VERSION,

  /**
   * Clone once, into the template every session starts from.
   *
   * `--filter=blob:none` rather than `--depth 1`: grimoire's history is 169 MB
   * and fragua's 87 MB, and a blobless clone fetches neither, while still
   * leaving every commit reachable — so `git log`, `git blame` and `git show`
   * work on the full history and only the file contents they touch are fetched
   * on demand. A shallow clone would be smaller and would make all three lie.
   */
  bootstrap: async ({ use }) => {
    const sandbox = await use();

    for (const repository of REPOSITORIES) {
      const result = await sandbox.run({
        command: `git clone --filter=blob:none --branch ${repository.branch} ${repository.url} ${repository.directory}`,
        workingDirectory: ROOT,
      });
      if (result.exitCode !== 0)
        throw new Error(
          `could not clone ${repository.directory}: ${result.stderr.trim()}`,
        );
    }
  },

  /**
   * Bring each clone up to date at the start of every session.
   *
   * This is where freshness comes from, not the template. A question about code
   * written this morning has to be answered against this morning's code, and a
   * fetch over a blobless clone is a few seconds while a template rebuild is
   * minutes.
   *
   * Failure here is deliberately not fatal. Offline, or with GitHub down, an
   * agent that answers from a checkout an hour old is useful and an agent that
   * refuses to start is not — so a fetch that fails leaves the previous state
   * in place and the session runs.
   */
  onSession: async ({ use }) => {
    const sandbox = await use();

    await Promise.all(
      REPOSITORIES.map((repository) =>
        sandbox.run({
          command: `git fetch --filter=blob:none origin ${repository.branch} && git reset --hard origin/${repository.branch}`,
          workingDirectory: `${ROOT}/${repository.directory}`,
        }),
      ),
    );
  },
});
