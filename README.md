# Hex

**An agent that lives on Nostr.** Send it a private message or mention it in a
group, and it answers there. Every run is published as signed events, so what it
did is readable afterwards — and verifiable by anyone.

Hex is the Nostr half of an agent: one key, one config, three transports, and a
durable queue between the room and the work. The loop runs in a runtime beside
it — `agent/` in this repo defines that agent; `src/` is the gateway. Hex is what
the runtime has no opinion about.

```bash
export HEX_NSEC=nsec1…
cp hex.config.example.json hex.config.json
hex check          # every relay, per role
hex announce       # kind 0, 10002, 10050
hex serve          # answer messages
```

Requires Node 24 or newer. It is a long-running process — it holds relay
websockets open — so it belongs on a host that can keep one alive.

## What it does

|               |                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------- |
| **Reaches**   | NIP-17 private messages · NIP-29 relay groups · Concord communities                         |
| **Answers**   | one session per thread, one turn at a time, metered per room                                |
| **Publishes** | signed transcripts — a turn per message, live deltas, a head that says where the run stands |
| **Controls**  | start, answer, steer, stop, compact or clear a session over kind 1779                       |
| **Survives**  | a killed process, a relay that lies, a message served four times                            |

## Addressing

Two ways to reach it, both deliberate acts by the sender:

- a `p` tag naming Hex — what a client's mention picker writes
- a reply in a thread Hex is already answering in

A `p` tag on a threaded event does not count. NIP-10 and NIP-22 put the parent's
and the root's author on every reply, so once Hex has spoken in a thread, every
message between two humans under it carries its pubkey.

## Identity

One persistent key. `kind:0` carries NIP-24's `bot: true` — a reader deserves to
know a reply came from a machine.

The secret key is never inline. `identity.signer` names an environment variable
or a file, or points at a NIP-46 bunker, so the key need not live on the host
running the agent.

Each agent gets a home named by its pubkey:

```
~/.hex/<pubkey>/data.db
```

Two configs for one key are one agent and share a memory; two agents on one
machine share nothing. One writer at a time, enforced by an expiring lease.

## Commands

|                       |                                                        |
| --------------------- | ------------------------------------------------------ |
| `hex whoami`          | resolve the signer, print pubkey and npub              |
| `hex check`           | validate the config and dial every relay in every role |
| `hex announce`        | publish kind 0, 10002 and 10050 from config            |
| `hex join`            | request to join the configured NIP-29 groups           |
| `hex concord`         | accept waiting invites, list communities and channels  |
| `hex send` · `hex dm` | say something unprompted                               |
| `hex eve <session>`   | follow one runtime session and publish it              |
| `hex serve`           | answer messages, publishing each run as it happens     |
| `hex stop`            | retire sessions and close their heads                  |
| `hex rm`              | ask relays to forget events Hex published              |

## Tools

|                                          |                                                 |
| ---------------------------------------- | ----------------------------------------------- |
| `chat.respond` `chat.react`              | speak in the room, acknowledge a message        |
| `chat.who` `chat.history`                | who is asking, and what was said before         |
| `nostr.help` `nostr.req` `nostr.resolve` | read the spec, query relays, resolve an entity  |
| `nostr.publish` `nostr.sign` `nostr.rm`  | write to Nostr — off unless configured          |
| `git.*`                                  | NIP-34 issues, patches, state, proposals, merge |

Writing tools are absent unless `tools.publish` says so, and some kinds stay
refused until the operator names them. A proposal is filed once: a durable ledger
refuses a repeat of the same subject to the same repository.

## Limits

Absent-by-default everywhere else, but these carry values, because "no limit" is
not a safe default for anything that spends money.

|                                |                                                        |
| ------------------------------ | ------------------------------------------------------ |
| `limits.repliesPerRoomPerHour` | 20 — counted on disk, so a restart does not reset it   |
| `limits.maxConcurrentTurns`    | 4 — excess waits in its lane rather than being dropped |

## Layout

|          |                                                        |
| -------- | ------------------------------------------------------ |
| `src/`   | the gateway — transports, queue, runner, spool, tools  |
| `agent/` | the agent itself — prompt, tool wiring, sandbox, model |
| `ops/`   | launchd jobs for the two processes, and a detach helper |
| `spec/`  | the NIP this implements                                |

The runtime is a devDependency, so installing Hex does not install an agent
loop. `agent/` is run by that runtime, not built by this package.

## Docs

- [Configuration](docs/configuration.md) — relay roles, sections, signer, state
- [Operating](docs/operating.md) — the two processes, supervision, the contract suite
- [Tools](docs/tools.md) — the bridge, publishing bounds, runtime setup
- [Transcripts](docs/transcripts.md) — what is published, and where
- [Agent Sessions](spec/nip-agent-sessions.md) — the NIP this implements
- [Positioning](docs/personal-agent-positioning.md) — what Hex is and is not

## Status

Identity, relays, all three transports, tools and the transcript publisher work.
Hex runs no agent loop of its own — no model calls, no context assembly, no
sandbox. Two implementations of a turn is one that drifts.

Not here yet: scheduled or proactive runs, state replicated across hosts, a
skills registry, payments.

Known limits: a child session started by a subagent is named on the turn that
spawned it but never followed; cost is computed from a price list when the
provider reports none, which cannot see cache discounts and errs high.

## License

MIT
