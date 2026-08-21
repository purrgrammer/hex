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

| Role      | What it is for                                                |
| --------- | ------------------------------------------------------------- |
| `read`    | lookups — kind 0, metadata                                    |
| `publish` | Hex's own outbox — kind 0, 10002, 10050                       |
| `dm`      | Hex's NIP-17 inbox, and exactly what its kind 10050 announces |

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

Four sections govern what `serve` can do, and all four are absent by default:

| Section         | What it turns on                                                              |
| --------------- | ----------------------------------------------------------------------------- |
| `eve.host`      | which runtime to drive                                                        |
| `eve.bridge`    | the loopback port and token for Hex's own tools                               |
| `eve.pricing`   | an OpenAI-shaped `/models` endpoint, for costing a provider that reports none |
| `tools.publish` | `nostr.publish`, `nostr.sign` and `nostr.rm`, with `kinds`, `perHour` and `dryRun` |

`eve.pricing` has no default URL, because a guessed price list is a made-up
number with a currency on it. What it produces is published marked `estimated`,
since a figure presented as a bill when it is arithmetic is worse than no figure.

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
- `hex serve [--host <url>] [--no-reply]` — answer private messages by running
  them through Eve, publishing each run as a transcript as it happens. This is
  the whole loop: a DM arrives, a session opens, the transcript is published with
  the message that started it named on its head, and the answer comes back in the
  conversation. `--no-reply` publishes the session and says nothing in chat,
  which is only useful with a client that reads transcripts.

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

| Tool            | What it does                                                           |
| --------------- | ---------------------------------------------------------------------- |
| `chat.respond`  | Say something in the room. The only way to be heard.                   |
| `chat.react`    | One emoji on the message. Offered only if the transport has reactions. |
| `chat.who`      | Who you are talking to, as an npub.                                    |
| `chat.history`  | The conversation so far, your own replies included.                    |
| `nostr.help`    | A NIP's text or a kind's definition, from the NIPs repository.         |
| `nostr.req`     | A NIP-01 filter against relays. Read-only, capped.                     |
| `nostr.resolve` | A bech32 entity turned into the person or event it names.              |
| `nostr.publish` | Sign an event and put it on relays. Off unless configured.             |
| `nostr.sign`    | Sign an event and hand it back unsent. Same bounds as publishing.      |
| `nostr.rm`      | Ask relays to forget events Hex signed. Its own only, and a request.   |
| `git.issues`    | A NIP-34 repository's issues.                                          |
| `git.patches`   | Its patches.                                                           |
| `git.state`     | Its branches and tags, as the maintainer last announced them.          |
| `git.proposals` | Open proposals in a local checkout, via ngit.                          |
| `git.proposal`  | One proposal in full.                                                  |
| `git.merge`     | Apply one, if `tools.git.write` allows it.                             |

The ids carry the dot; the wire carries an underscore, since OpenAI-shaped
function names cannot contain one.

`chat.who` and `chat.history` exist because a runtime is handed one message and
told nothing else. Without them "check my recent posts" became a query for kind 1
across the whole network, answered from strangers, and anything referring to
earlier was repeated or invented.

A proposal is filed once. `nostr.publish` keeps a durable ledger of the patches,
pull requests and issues it has sent, and refuses one that repeats a recent
proposal to the same repository — same bytes, same subject, or the same opening.
The runtime re-executes a turn, and each execution composes afresh, so a
duplicate arrives with a new call id and rephrased prose that no call-level
dedup can see. The refusal names the event already published; `nostr.rm`
retracts it if the wrong one landed.

The writing tools are absent unless `tools.publish.enabled` is set. Signing and
publishing carry the same bounds — a signed event is one relay call from being
published by whoever holds it — and some kinds are refused unless the operator
names them in `tools.publish.kinds`: kinds 0, 3, 10002 and 10050 replace what the
agent already has, and a new 10050 silently redirects every private message sent
to it; kind 5 asks relays to delete what it names; kinds 4, 13, 1059 and 21059 are
built by the transports with the right seal and throwaway key, and a hand-rolled
one leaks exactly what the envelope hides.

### Where the tools run

Eve runs the agent in its own process, so a tool it calls executes there — and
these cannot. `chat.respond` answers one message, in the room it arrived in,
signed by a key only this process holds. So the call comes back: a loopback HTTP
bridge binds each live session to the tool host for the message being answered,
and the runtime's tool definitions are a `fetch` that knows a session id.

The bridge listens on 127.0.0.1 with a shared token, and the **session id is
never the model's to choose** — it comes from the runtime's own session context.
An id a model could name is an answer it could address into someone else's
conversation. Calls dedupe on the runtime's call id, because a step interrupted
mid-execution is re-run and a resent message is not idempotent.

`nostr.help` earns its place: asked from memory, the model called kind 9 an
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
mode with a busy timeout. A JSON file cannot do this job: two processes that each
read the whole document, mutate it in memory and write it back leave the last
writer erasing the other's cursor, and writing atomically makes one write
survivable while doing nothing about two. Two `hex eve` processes following two
sessions of one agent are two connections, not a lost chain.

A home may also hold `sessions`, `messages`, `participants` and `worktrees`.
Hex does not read or write them, and does not drop them either: deleting an
operator's conversation history to tidy a schema is not a migration this gets to
make.

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

Identity, relays, both transports and the transcript publisher work. Hex runs no
agent loop of its own — no model calls, no session tracking, no context assembly,
no container isolation. A runtime does all of that, and two implementations of a
turn is one that drifts. Hex is what the runtime has no opinion about, which is
Nostr.

`hex serve` drives Eve from a Nostr message and publishes the run as it happens:
tools over the loopback bridge, deltas as they stream, per-turn cost, and a
per-session snapshot of the prompt and tools the run had. An operator can answer,
steer, stop, compact or clear a session with a kind-1779 control event, which is
honoured only from the pubkey the session's head names as operator.

A reply continues the run it threads onto; a message that threads onto nothing
starts a new one. Sessions left mid-flight by a killed process are caught up at
startup, because a head that says `active` forever is a lie no reader can detect.

Known limits: the dedupe set is in memory, so a restart can re-answer a DM that
arrived in the last hour; child sessions of a subagent are named on the turn that
spawned them but never followed; and cost is computed from a price list when the
provider reports none, which cannot see cache discounts and errs high.
