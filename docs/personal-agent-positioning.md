# Where Hex competes

Hermes Agent (Nous Research) and OpenClaw are the incumbents. Both are a local
gateway meeting the user in existing messaging apps, both are proactive, both
remember, both have a skills hub, both are self-hosted and BYOK. Hex has none of
that as a product story, and that is fine, because Hex is not that layer.

## The split

Hex runs no agent loop. Two implementations of a turn is one that drifts. So
every capability divides:

| | Runtime | Hex | Together |
| --- | --- | --- | --- |
| Memory | assembles, summarizes, recalls | encrypted blobs on relays | memory that follows the key, not the box |
| Skills | writes and refines them | NIP-34 repos as the channel | signed, forkable, patchable by strangers |
| Persona | prompt and tools | config and identity | portable across hosts |
| Proactivity | decides what to do | timers, subscriptions, delivery | scheduled work delivered to a room |
| Channels | none | NIP-17, NIP-29, Concord | reach with no per-platform integration |
| Auditability | emits turn events | publishes signed transcripts | verifiable behaviour |
| Payments | asks | holds a key | an agent that can spend |

**The runtime owns the loop. Hex owns everything that must survive the machine.**

## What is structurally ours

**The key is the identity.** Both incumbents live in a directory on one laptop.
Backup and moving machines are the user's problem. Hex keys its home by pubkey
because two configs for one key are one agent. Encrypted replaceable events turn
that home into something relays hold: the agent becomes a key, not an install.

**Agent-to-agent is free.** Hermes shipped A2A as a bolted-on protocol. Nostr
already is an agent bus — signed identity, kind 0 for discovery, DMs and groups
for the channel, the social graph for reputation.

**Skills over NIP-34.** A skills repo on Nostr is signed by its maintainer and
forkable, with issues and patches on the same wire. Adopt the agentskills.io
format verbatim. The differentiator is the registry, not the file format: a hub
is somebody's server, a NIP-34 repo is not.

**Payments.** An agent holding a key can hold money — zaps, NWC, cashu, x402.
Neither incumbent has a native answer, and every "agent buys things for me" demo
ends at a human with a card. Sharpest wedge available, and it costs one tool
namespace.

**Signed transcripts are a category nobody else is in.** Every turn is
attributable, ordered and verifiable by a third party. That answers "what did my
agent actually do" and "prove this agent did the work" at once.

**Security is a differentiator, with evidence.** SecurityScorecard counted 40,214
internet-exposed OpenClaw instances, 35.4% flagged vulnerable. Hex's counter is
in the code: writing tools absent unless configured, unknown keys are errors, the
session id is never the model's to choose, a ledger that refuses a repeated
proposal, and NIP-46 so the identity key need not live on the host running the
agent. That last sentence is one neither competitor can write.

## What to take from them

Hex's config posture is already closer to correct on the axes that matter:
absent-by-default sections, unknown keys as errors, per-kind allowlists,
`perHour`, `dryRun`. Six things worth adopting:

1. **Filter before the model call.** A tool the policy removed is a tool whose
   schema the turn never sees. This matters more here than for either incumbent,
   because Hex hands its tools to a runtime it does not own — the bridge is the
   enforcement point and must refuse, not just the config.
2. **Capability follows the channel.** A DM from the operator, a group message
   and a stranger's DM must not resolve to the same toolset. Hex knows the
   requesting pubkey on every call; make the toolset a function of
   (room, requester), not of the config file alone.
3. **Two-layer authority, host veto on top.** If config replicates over Nostr, a
   host-local policy file that config cannot override is what stops a replicated
   — or compromised — config widening its own permissions on arrival. Design this
   before shipping replicated config.
4. **Name the three layers separately.** A tool is a callable function; a skill
   is an instruction pack that adds no capability; a plugin ships code. Only the
   third is a supply-chain risk, which is why they are separate nouns. Skills
   over NIP-34 stay instruction packs until a plugin trust story exists.
5. **Approvals on the wire.** `off | on-miss | always` maps onto the kind-1779
   control event that already exists: a request published to the operator,
   answered from the pubkey the session head names. Hex has an approval channel
   the incumbents had to build a UI for.
6. **Budgets and output caps.** Extend the discipline already in
   `repliesPerRoomPerHour` to cost and tool output.

Reject the wildcard toolset. It contradicts absent-by-default, and it is how an
operator ends up with `nostr.publish` enabled without having decided to.

## Gaps, ranked

1. **Proactivity.** Hex answers when addressed. No timers, no cron, no
   heartbeat. Largest gap, squarely Hex's layer.
2. **Reach.** Nostr only. Nostr-native is the identity story; a bridge to a
   mainstream channel is what gets a non-Nostr user to run this.
3. **Memory portability.** Designed, not built.
4. **Skills distribution.** `git.*` reads; nothing packages, indexes or installs.
5. **Onboarding.** Editing a config file against `npx openclaw`.
6. **A demo.** The candidate uses what only Hex can do: an agent paid in a room,
   doing the work, publishing the signed transcript as the receipt, and settling.

## Running it from several places

Not free storage — distributed coordination. Split state by class first.

**Safely replicable** — identity, config, persona, memory blobs, skill index.
Last write wins is acceptable; encrypted replaceable events are enough.

**Single-writer, must be fenced** — transcript cursors, the dedupe ledger, the
publish ledger, `startIndex`. Two hosts sharing one key and both resuming publish
a second chain under one session id, which every conforming reader reads as a
fork. Multi-location needs a published, expiring claim on a session, honoured by
every Hex holding that key, with the local lease as the enforcement point. Design
the lease before advertising the capability.

SQLite stays the working set. Nostr is the replication and recovery layer, not
the hot path.

## Order of work

1. Scheduler and proactive delivery.
2. Host-local policy file with veto, and toolset resolution by (room, requester)
   enforced at the bridge. Prerequisite for 3.
3. Encrypted replicable state — the safely-replicable class only.
4. Session lease, then the fenced class, then say "run it anywhere" in public.
5. Skills over NIP-34 in the agentskills.io format: package, index, install.
6. Payments namespace.
7. One bridge to a mainstream channel.
8. One demo only this architecture can produce, and the security page the 40,214
   number writes for us.

## Sources

- https://github.com/openclaw/openclaw · https://docs.openclaw.ai/tools · https://docs.openclaw.ai/cli/policy
- https://hermes-agent.nousresearch.com/docs/ · https://hermes-agent.nousresearch.com/docs/reference/toolsets-reference
- https://thehackernews.com/2026/03/openclaw-ai-agent-flaws-could-enable.html
- https://www.ibm.com/think/x-force/what-openclaw-reveals-about-agentic-ai-security-risks
