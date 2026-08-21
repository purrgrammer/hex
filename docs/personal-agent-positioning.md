# What makes a personal agent top, and where Hex actually competes

Study of Hermes Agent (Nous Research) and OpenClaw, mapped onto Hex's design.
Written 2026-08-21. Figures below come from secondary reporting; sources at the end.

## 1. The two incumbents, in one paragraph each

**OpenClaw** (Peter Steinberger, OpenClaw Foundation, non-profit). Local gateway
process as control plane; meets the user in WhatsApp / Telegram / Slack / Discord /
Signal; heartbeat daemon and scheduled tasks make it proactive rather than
request-response; three extension layers — tools, skills, plugin SDK — with ClawHub
as the community marketplace; model-agnostic BYOK; companion device nodes for voice,
canvas, camera, screen. Unknown DM senders are paired explicitly
(`openclaw pairing approve`). ~250k GitHub stars in about 60 days.

**Hermes Agent** (Nous Research, released 2026-02-25). Persistent daemon on your own
infrastructure. Memory in `~/.hermes/`, FTS5 cross-session recall with LLM
summarization, Honcho-style dialectic user modeling. Writes its own skills from
experience and improves them in use, on the agentskills.io open standard, shared via
a Skills Hub. 20+ messaging platforms from one gateway, with cross-platform
continuation. Built-in cron delivering to any platform. Command approval,
authorization, container isolation. Six terminal backends: local, Docker, SSH,
Daytona, Singularity, Modal. `SOUL.md` for personality. August 2026 "Herald"
release added streaming voice, agent-to-agent (A2A v1.0), and cited research.

## 2. The six drivers of adoption

Not a feature list — the things that actually produced the curve.

1. **It lives where the user already is.** No new app. A DM is the whole UI.
2. **It is proactive.** Heartbeat, cron, scheduled delivery. An agent that only
   answers is a chat window; an agent that starts the conversation is a colleague.
3. **It remembers.** Continuity across sessions is what makes it feel personal.
4. **It has an ecosystem.** A skills standard plus a hub converts users into
   contributors. Hermes and OpenClaw both bet on this; agentskills.io is the standard.
5. **It is yours.** Self-hosted, BYOK, local models. Privacy is the marketing.
6. **One concrete demo did the work.** AJ Stuyvenberg's agent negotiating $4,200 off a
   car over days of dealer email is what made people install it. Not the feature matrix.

Hex has none of 1–6 as a product story today, and that is fine, because Hex is not
the same layer. See next.

## 3. Hex does not compete on the runtime, and must not start

The README states the constraint: "Hex runs no agent loop of its own... two
implementations of a turn is one that drifts." Every capability below therefore
splits three ways.

| Capability | Runtime (Eve) | Hex (Nostr layer) | The combination |
| --- | --- | --- | --- |
| Memory | assembles context, summarizes, recalls | encrypted, addressable, replicated memory blobs on relays | memory that follows the key, not the box |
| Self-improvement | writes and refines skills | NIP-34 repos as the distribution channel (`git.*` tools exist) | skills published, patched and reviewed by signed identity |
| Customization | prompt, persona, tools | config + identity, no silent defaults | a persona portable across hosts |
| Proactivity | decides what to do | timers, subscriptions, delivery | scheduled action delivered to a room |
| Channels | none | NIP-17 DMs, NIP-29 groups, Concord | reach without a per-platform integration |
| Auditability | emits turn events | publishes signed transcripts | verifiable agent behavior — nobody else has this |
| Payments | asks | key already exists | an agent that can hold and spend |

The instinct "add memory and self-improvement to Hex" is the wrong instinct. The
right one is: **Eve owns the loop; Hex owns everything that must survive the machine.**

## 4. The advantages that are structurally ours

### 4.1 The key is the identity, and the state is encrypted under it
Both incumbents are `~/.hermes` and `~/.openclaw` — a directory on one laptop. Backup
is the user's problem, moving machines is the user's problem, running the same agent
from a phone and a server is not a thing. Hex already keys its home by pubkey
(`~/.hex/<pubkey>/`) precisely because "two configs for one key are one agent."
Encrypted parameterized replaceable events (kind 30078-shaped, NIP-44 to self) turn
that home into something relays hold. The agent is then a key, not an install.

### 4.2 Agent-to-agent is free
Hermes shipped A2A v1.0 in August as a bolted-on protocol. Nostr already *is* an
agent bus: signed identity, kind 0 for discovery and capability advertisement, DMs
and groups for the channel, the social graph for reputation. Hex gets the newest
headline feature of the competitor as a property of the transport it already speaks.

### 4.3 Skills distribute over NIP-34
`git.issues`, `git.patches`, `git.state`, `git.proposals`, `git.merge` are already
here. A skills repo on Nostr is censorship-resistant, signed by its maintainer, and
forkable — with issues and patches on the same wire. Adopt the agentskills.io format
verbatim; do not invent a competing one. The differentiator is the registry, not the
file format: ClawHub and Skills Hub are somebody's server, a NIP-34 repo is not.

### 4.4 Payments
An agent that holds a key can hold money. Zaps, NWC, cashu, x402. Neither incumbent
has any native answer, and every "agent buys things for me" demo currently ends at a
human with a card. This is the sharpest wedge available and it costs one tool
namespace.

### 4.5 Signed transcripts are a category nobody else is in
Every published turn is attributable, ordered, and verifiable by a third party. That
is the answer to "what did my agent actually do", and to "prove this agent did the
work" between strangers. Auditability is a compliance story, an agent-marketplace
story, and a trust story simultaneously.

### 4.6 Security is a differentiator, with evidence
February 2026: SecurityScorecard observed 40,214 internet-exposed OpenClaw instances,
35.4% flagged vulnerable; Infosecurity reported 12,812 exposed instances susceptible
to RCE. The "ClawJacked" flaw (Oasis Security) let a malicious website brute-force and
hijack a local instance; patched in 2026.2.26. Add command injection, SSRF, path
traversal, and indirect prompt injection through email signatures, calendar invites,
GitHub issues.

Hex's existing posture is the counter-story, and it is already written in the code:
writing tools absent unless configured; no silent relay defaults, unknown keys are
errors; the session id is never the model's to choose; a durable publish ledger that
refuses a repeated proposal; the secret key never inline; NIP-46 bunker so the
identity key need not live on the host running the agent; kind 0 declares `bot: true`.
Say this out loud in the README's first screen. "The agent's key does not have to be
on the machine the agent runs on" is a sentence neither competitor can write.

## 5. Toolsets and config policy — the part that decides whether it is safe

Both projects converged on the same three ideas independently. Hex should read that
convergence as a spec, not as inspiration.

### 5.1 OpenClaw

**Tools in nine categories:** runtime (`exec`, `process`, `terminal`,
`code_execution`), files (`read`, `write`, `edit`, `apply_patch`), human input
(`ask_user`), web (`web_search`, `x_search`, `web_fetch`), browser (`browser`),
operator UI (`screen`), messaging (`message`), sessions/agents (`sessions_*`,
`subagents`, `agents_list`), automation (`cron`, `heartbeat_respond`).

**Three distinct layers, and the distinction is load-bearing:** a *tool* is a callable
function; a *skill* is an instruction pack (`SKILL.md`) that teaches a workflow and
adds no capability; a *plugin* packages tools, skills, providers and lifecycle with
code and credentials. Only the third is a supply-chain risk, which is exactly why
they are separate nouns.

**Policy filters before the model call.** "If policy removes a tool, the model does
not receive that tool's schema for the turn." Filtering inputs are global config,
per-agent config, channel permissions, provider restrictions, sandbox state, plugin
availability. The model is never asked to decline; it is never offered.

**Exec approvals are a separate, host-local file** — `~/.openclaw/exec-approvals.json`,
with state in `~/.openclaw/state/openclaw.sqlite`: `defaults.security` of
`deny | allowlist | full`, `ask` of `off | on-miss | always`, an `ask-fallback`, per-agent
allowlist patterns, and an `autoAllowSkills` posture. Managed by
`openclaw exec-policy --host auto|sandbox|gateway|node`. Two layers must both permit:
the requested policy in the agent's config (`tools.exec.*`) *and* the approvals policy
on the machine that would run the command. The operator of the host retains a veto the
agent's own config cannot overrule.

**`policy.jsonc` is an enterprise conformance layer over the settings, not a second
config.** Rules over channels, MCP servers, providers, SSRF posture, ingress, gateway
exposure, sandbox, secrets. `scopes.<name>` with `agentIds` selectors overlays stricter
rules additively. Unsupported keys fail validation rather than being ignored.

**Pairing:** DM-capable channels pair unknown senders by default;
`openclaw pairing approve` admits one. Inbound messages are documented as untrusted input.

### 5.2 Hermes

**60+ tools over 6–7 terminal backends,** named `category_action` (`read_file`,
`write_file`, `search_files`) with platform prefixes (`ha_`, `yb_`, `spotify_`).

**Toolsets, in three tiers:** core (`file` = read/write/patch), composite (`debugging`
= file + terminal + web), platform (`hermes-cli`, `hermes-discord`, `hermes-webhook`).
Platform toolsets are the security boundary: most messaging platforms inherit
`hermes-cli`, `hermes-discord` adds moderation tools, and `hermes-webhook` is cut to a
"safe subset — only web search, extraction, vision analysis, and clarification."
**The channel determines the capability.** Each MCP server generates an `mcp-<server>`
toolset at runtime. Toggled via `hermes tools` (curses UI), `--toolsets web,file,terminal`,
or `/tools enable homeassistant` in session.

**Config:** `~/.hermes/config.yaml`, with a strict split — secrets in `.env`,
everything else in YAML, `${VAR}` substitution, and resolution order CLI > config.yaml >
.env > built-in defaults. Also in that home: `auth.json`, `SOUL.md`, `memories/`,
`skills/`, `sessions/`. Commands: `hermes config get|set|edit|check`.

**Guards that are directly relevant to Hex:**
`memory.write_approval`, `skills.write_approval`, `skills.guard_agent_created` (scan
agent-written skills for dangerous patterns), `agent.max_turns`,
`agent.run_budget_seconds`, `tool_output.max_bytes|max_lines|max_line_length`,
`file_read_max_chars`, and Docker with `--cap-drop ALL`, `no-new-privileges`,
`--pids-limit 256`, `docker_network: false` for an air gap.

**And one that names Hex's hardest problem:** `agent.gateway_turn_lease_timeout`.
Hermes runs a **turn lease** on the gateway, plus `session_stall_timeout`. The lease
pattern §7 argues Hex needs is already the incumbent's answer for one host; Hex's
version has to work across hosts that share a key and never talk directly.

### 5.3 What Hex should take, and what it already has

Hex's existing posture is closer to correct than either, on the axes that matter:
absent-by-default sections, unknown keys are errors, no silent defaults, per-kind
allowlists in `tools.publish.kinds`, `perHour` and `dryRun`, and a key that can live in
a NIP-46 bunker off the host. Keep all of it. Adopt six things:

1. **Filter before the model call.** State it explicitly and test it: a tool the policy
   removed is a tool whose *schema* the turn never sees. This matters more for Hex than
   for either incumbent, because Hex hands its tools to a runtime it does not own —
   the bridge is the enforcement point and it must refuse, not just the config.
2. **Capability follows the channel.** `hermes-webhook`'s cut-down set is the pattern.
   A DM from the operator, a NIP-29 group, and a stranger's DM must not resolve to the
   same toolset. Hex knows the requesting pubkey on every call; make the toolset a
   function of (room, requester), not of the config file alone.
3. **Two-layer authority, host veto on top.** OpenClaw's split between the agent's
   requested policy and the host's approvals file is the right shape for an agent whose
   config can travel over Nostr. If encrypted config replicates (§4.1), a host-local
   policy file that config cannot override is what stops a replicated config — or a
   compromised one — from widening its own permissions on arrival. **Design this before
   shipping replicated config, not after.**
4. **Name the three layers separately.** Tool / skill / plugin. Skills over NIP-34 (§4.3)
   should be instruction packs that add no capability — that is what makes a signed but
   unaudited skill from a stranger merely wrong rather than fatal. If a Nostr-distributed
   artifact can ship code, it is a plugin and needs a different trust story.
5. **Ask modes and approvals belong on the wire.** `off | on-miss | always` maps cleanly onto
   the kind-1779 control event that already exists: an approval request published to the
   operator, answered from the pubkey the session head names. Hex has an approval channel
   the incumbents had to build a UI for.
6. **Budgets and output caps.** `max_turns`, `run_budget_seconds`, `tool_output.max_bytes`.
   Hex already has `perHour` and `limits.repliesPerRoomPerHour`; extend the same
   discipline to cost and tool output, since Hex is the layer holding the money (§4.4).

One thing to reject: Hermes's `all` / `*` wildcard toolset. It contradicts
absent-by-default, and it is how an operator ends up with `nostr.publish` enabled
without having decided to.

## 6. The gaps, ranked against the six drivers

1. **Proactivity — absent.** Hex answers when addressed. No timers, no cron, no
   heartbeat. This is the single largest product gap and it is squarely Hex's layer:
   a scheduler that opens a session and delivers the result to a room. Driver #2.
2. **Reach — narrow.** Nostr DMs and groups only. That is 0 platforms of the 20 the
   competitors list. Nostr-native is the identity story, but a Telegram/Signal bridge
   is what gets a non-Nostr user to run this. Driver #1.
3. **Memory portability — designed, not built.** §4.1 is a proposal, not code.
4. **Skills distribution — half built.** `git.*` reads; nothing packages, indexes or
   installs a skill. Driver #4.
5. **Onboarding.** `cp hex.config.example.json` against `npx openclaw`. Driver #5's
   audience is not going to hand-edit relay roles.
6. **A demo.** There is no $4,200 car story for Hex. The natural candidate uses what
   only Hex can do: an agent that is paid in a room, does the work, publishes the
   signed transcript as the receipt, and settles. Driver #6.

## 7. The hard problem in "run it from several places"

This is not free storage. It is distributed coordination, and the last five commits in
this repo are about exactly the failure it invites: publish fences, and two overlapping
executions no longer both publishing or both reading.

Split state by class before building anything:

**Safely replicable** — identity, config, persona, memory blobs, skill index. Last
write wins is acceptable; encrypted replaceable events are enough. Ship this first.

**Single-writer, must be fenced** — transcript `seq`/`prev` cursors, the dedupe
ledger, the publish ledger, `startIndex`. The README already names the failure:
resuming at `seq` 1 under one session id publishes a second chain that "every
conforming reader must read as a fork." Two hosts sharing one key and both resuming
is that failure, on purpose. Multi-location needs a lease: a published, expiring
claim on a session, honoured by every Hex holding that key, with the existing fence as
the local enforcement point. Design the lease before advertising the capability.

Corollary: SQLite in `~/.hex/<pubkey>/` stays the working set. Nostr is the
replication and recovery layer, not the hot path.

## 8. Order of work

1. Scheduler + proactive delivery. Largest gap, cleanly Hex's layer.
2. Host-local policy file with veto over replicated config, and toolset resolution by
   (room, requester) enforced at the bridge (§5.3.1–3). Prerequisite for step 3.
3. Encrypted replicable state, class-1 only (identity, config, persona, memory blobs).
4. Session lease, then class-2 state, then say "run it anywhere" in public.
5. Skills over NIP-34 using the agentskills.io format: package, index, install —
   instruction packs only, no code, until a plugin trust story exists.
6. Payments namespace.
7. One bridge to a mainstream channel.
8. One demo that only this architecture can produce, and the security page that the
   40,214 number writes for us.

## Sources

- https://github.com/openclaw/openclaw
- https://openclaw.ai/
- https://www.digitalocean.com/resources/articles/what-is-openclaw
- https://www.lennysnewsletter.com/p/openclaw-the-complete-guide-to-building
- https://hermes-agent.nousresearch.com/docs/
- https://hermes-agent.org/
- https://www.aibuilderclub.com/blog/hermes-nous-research-self-improving-agent
- https://thehackernews.com/2026/03/openclaw-ai-agent-flaws-could-enable.html
- https://www.ibm.com/think/x-force/what-openclaw-reveals-about-agentic-ai-security-risks
- https://www.digitalocean.com/resources/articles/openclaw-security-challenges
- https://docs.openclaw.ai/tools
- https://docs.openclaw.ai/cli/policy
- https://docs.openclaw.ai/cli/approvals
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference
