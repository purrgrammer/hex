# Configuration

One JSON file. Unknown keys are errors and nothing that decides where Hex
publishes has a default — an agent that boots with a typo'd field and answers
nobody looks exactly like a working one.

## Relay roles

Three, and they are not interchangeable.

| Role      | For                                                           |
| --------- | ------------------------------------------------------------- |
| `read`    | lookups — kind 0, metadata                                    |
| `publish` | Hex's own outbox — kind 0, 10002, 10050                       |
| `dm`      | Hex's NIP-17 inbox, and exactly what its kind 10050 announces |

A group message never goes to `publish`. A NIP-29 kind 9 goes to the group's own
relay and nowhere else, because a kind 9 on a foreign relay is not in the group.

## The prompt is not here

There is no `instructions` key. A definition's content is the system prompt
itself — what the agent was told — and the only thing that knows it is the
runtime running the turn. A copy in a config file is a second claim about one
fact, and a second claim drifts.

The prompt lives in `agent/instructions.md`, which the runtime loads. `hex serve`
and `hex eve --announce` both ask the runtime for it. A config that still names
`instructions` is refused rather than ignored.

## Signer

`identity.signer` names an environment variable, a file, or a NIP-46 bunker. A
bunker's client keypair is persisted under `stateDir`, so a restart does not
re-pair.

## Sections that turn something on

All absent by default.

| Section         | Turns on                                                                           |
| --------------- | ---------------------------------------------------------------------------------- |
| `eve.host`      | which runtime to drive                                                             |
| `eve.bridge`    | the loopback port and token for Hex's own tools                                    |
| `eve.pricing`   | an OpenAI-shaped `/models` endpoint, for costing a provider that reports none      |
| `tools.publish` | `nostr.publish`, `nostr.sign` and `nostr.rm`, with `kinds`, `perHour` and `dryRun` |
| `tools.git`     | `git.*`, and `write` for applying a proposal                                       |
| `transcript`    | who reads the published run                                                        |

`eve.pricing` has no default URL: a guessed price list is a made-up number with a
currency on it. What it produces is published marked `estimated`.

## Limits

| Key                            | Default |                                                                                                                                              |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits.repliesPerRoomPerHour` | 20      | Turns, not replies — a turn costs whether or not the answer lands. Counted from the queue, so a restart does not hand the room a fresh hour. |
| `limits.maxConcurrentTurns`    | 4       | Lanes are per (peer, room); without a cap, fifty people at once is fifty sessions. Excess waits and starts as capacity frees.                |

## State

```
~/.hex/<pubkey>/data.db
```

Keyed by pubkey because the key is the identity. `state.home` moves the root.

SQLite via `node:sqlite` — no dependency, no native build — in WAL mode with a
busy timeout. A JSON file cannot do this job: two processes that each read the
whole document, mutate it in memory and write it back leave the last writer
erasing the other's cursor.

Writing is fenced. One process holds an expiring lease on the home; a write from
a generation that no longer holds it is refused rather than merged.

A home may also hold `sessions`, `messages`, `participants` and `worktrees` from
an earlier schema. Hex neither reads nor drops them: deleting an operator's
conversation history to tidy a schema is not a migration this gets to make.

## Retention

Different by purpose, on open.

|                                          |            |
| ---------------------------------------- | ---------- |
| Settled queue rows, delivered spool rows | 7 days     |
| Replay guards, the publish ledger        | 30 days    |
| Publish reservations                     | 10 minutes |

An unsettled queue row never prunes. It is still owed.
