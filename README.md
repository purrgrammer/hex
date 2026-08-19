# nostr-hex

Hex is the Nostr layer of an agent: one config file, one key, several wire
protocols — NIP-29 relay groups, NIP-17 private messages, Concord communities
next. It carries an agent's identity, its relays, its rules about when to speak,
and its transcript. **The agent itself runs elsewhere.** [Eve](https://eve.dev)
holds the model, the context, the tools and the sandbox; `hex eve` follows one of
its sessions and publishes it.

It is a **long-running process** — it holds relay websockets open — so it belongs
on a host that can keep one alive, not in a serverless function.

## Quick start

```bash
cp hex.config.example.json hex.config.json   # then edit it
export HEX_NSEC=nsec1…
hex whoami                                   # who does this config sign as?
hex check                                    # is every relay reachable, per role?
hex announce                                 # publish kind 0 / 10002 / 10050
```

## Config

Three relay roles, and they are not interchangeable:

| Role | What it is for |
| --- | --- |
| `read` | lookups — kind 0, metadata |
| `publish` | Hex's own outbox — kind 0, 10002, 10050 |
| `dm` | Hex's NIP-17 inbox, and exactly what its kind 10050 announces |

A group message never goes to `publish`: a NIP-29 kind 9 is published to the
group's own relay and nowhere else, because a kind 9 on a foreign relay is not in
the group.

Nothing has a relay default: an agent that boots with a typo'd field and then
answers nobody looks exactly like a working one, so unknown keys are errors and
there are no silent defaults for anything that decides where Hex publishes.

Hex declares itself a bot: kind 0 carries NIP-24's `bot: true` unless the config
says otherwise. A reader deserves to know a reply came from a machine.

The secret key is never inline: `identity.signer` names an env var or a file, or
points at a NIP-46 bunker whose client keypair is persisted under `stateDir` so a
restart does not re-pair.

## Commands

- `hex whoami` — resolve the signer, print pubkey and npub. Publishes nothing.
- `hex check` — validate the config, dial every relay in every role, report each
  one. A relay that accepts the request and then says nothing is reported as
  SILENT, which is not the same as having no events.
- `hex announce [--dry-run]` — publish kind 0, 10002 and 10050 from config,
  skipping any whose published copy already matches. Idempotent.
- `hex join [--auto] [--dry-run]` — request to join the configured NIP-29 groups
  (kind 9021, sent only to each group's own relay). `--auto` limits it to groups
  marked `autoJoin`. A group whose member or admin list already names Hex is
  skipped, so this is safe to repeat.
- `hex dm <npub> "message"` — send one private message, unprompted.
- `hex eve <session-id> [--host <url>] [--dry-run]` — follow an Eve session's
  event stream and publish it as a transcript (NIP-xx: Agent Sessions): a turn
  per step, deltas as it goes, a head that says where the session stands. Needs a
  `transcript` section naming who reads it, because publishing is never a
  default. `--dry-run` prints the rumors instead of wrapping them, which is how
  the mapping gets checked against a real host with no relay involved.

## Publishing a transcript

`transcript` is absent by default and that is deliberate: an agent that starts
mailing its conversations because it was upgraded has leaked one nobody asked it
to send.

```json
"eve": { "host": "http://127.0.0.1:2000" },
"transcript": { "to": ["npub1…"], "slug": "hex", "deltas": true }
```

Two cursors are durable, and Eve pays for one of them. Its `startIndex` says how
far this consumer has read, so a restart resumes rather than republishes;
`seq`/`prev` are the chain on the wire, kept in the `transcripts` table. Losing
the second is the worse failure — resuming at `seq` 1 publishes a second chain
under one session id, which every conforming reader must read as a fork.

## Tools

Named `<namespace>.<action>`, the same registry convention the in-app assistant
uses, because it is the same Hex:

| Tool | What it does |
| --- | --- |
| `chat.respond` | Say something in the room. The only way to be heard. |
| `chat.react` | One emoji on the message. Offered only if the transport has reactions. |
| `grimoire.help` | A NIP's text or a kind's definition, from the NIPs repository. |
| `nostr.req` | A NIP-01 filter against relays. Read-only, capped. |
| `nostr.resolve` | A bech32 entity turned into the person or event it names. |

The ids carry the dot; the wire carries an underscore, since OpenAI-shaped
function names cannot contain one. Nothing here signs, publishes, spends or
follows except `chat.*`, which publishes exactly one chat message.

`grimoire.help` earns its place: asked from memory, the model called kind 9 an
MLS event. Asked with the tool, it reads the spec and cites the NIP.

## How a turn is delivered

Delivery is a **tool call**, not a return value. A runtime is handed a tool host
bound to one message in one room, and speaks by calling `chat.respond`. Whatever
it writes outside a tool call is private thinking that nobody hears.

That is what keeps this transport-agnostic: `respond` is the same tool in a NIP-29
group, in a DM, or on a Concord plane, and Hex routes it to whichever backend owns
the room. Every call is attributable to a room and a requesting pubkey.

What the caller is told back is the truth: `delivered as <id>`, or
`not delivered: <why>`. A relay that refused is a refusal the model can read and
react to, and `delivered` is a fact about the transport rather than a claim by the
model.

## Durability

Each agent gets a home named by its pubkey:

```
~/.hex/<pubkey>/
  data.db      where each published transcript stands
```

Keyed by pubkey because the key is the identity: two configs for one key are one
agent and should share a memory, two agents on one machine must share nothing.
`state.home` moves the root.

Storage is SQLite — `node:sqlite`, so no dependency and no native build — in WAL
mode with a busy timeout. A file was not enough: two processes that each hold a
JSON document read it, mutate it in memory, and write the whole thing back, and
the last writer erases the other's cursor. Writing atomically makes one write
survivable and does nothing about two. Two `hex eve` processes following two
sessions of one agent are now two connections rather than a lost chain.

A home written by an older version also holds `sessions`, `messages`,
`participants` and `worktrees`, from when this package ran its own agent loop.
They are left where they are: deleting an operator's conversation history to tidy
a schema is not a migration this gets to make.

`packages/hex/deploy/` has a launchd plist for macOS — `KeepAlive` on non-zero
exit, `RunAtLoad`, and `caffeinate -i -s` wrapping the process so the machine
stays awake exactly as long as Hex runs.

## When Hex speaks

It answers only when addressed: p-tagged, or named by one of `mentions` on a word
boundary. A bare token like `hex` matches `@hex` too; a token written `@hex`
matches only that form.

Four other rules, each of which exists because the alternative is a bot that
misbehaves quietly:

- Never its own message — a reply comes straight back through the same
  subscription.
- Never the same message twice, however many relays deliver it.
- Never a message dated before the process started (minus a small grace), so a
  restart does not answer a week of backfill at once.
- One reply in flight per room, and `limits.repliesPerRoomPerHour` per room. A
  turn that published nothing does not spend that budget.

A runtime that returns nothing is silence, which is a legitimate answer. A runtime
or relay that FAILS is logged as a failure — never dressed up as having nothing to
say.

## Status

Identity, relays, both transports and the transcript publisher work. The agent
loop this package used to carry — its own model calls, session tracking, context
assembly, worktrees and container isolation — was **removed** rather than kept in
parallel: Eve does all of it, and two implementations of a turn is one that drifts.
What remains is what Eve has no opinion about, which is Nostr.

Known limits: the dedupe set is in memory, so a restart can re-answer a DM that
arrived in the last hour; and nothing yet drives Eve *from* a Nostr message —
`hex eve` follows a session someone else started.
