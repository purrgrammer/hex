# nostr-hex

Hex is an agent that holds conversations on Nostr. One config file, one key,
several wire protocols: NIP-29 relay groups first, NIP-17 private messages and
Concord communities next.

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

Nothing has a relay default. There is no default brain either — a config with no
`brain` fails to start, because an agent that boots and then answers nobody looks
exactly like a working one. `"brain": {"type": "echo"}` is the deliberate
exception, for smoke tests.

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
  marked `autoJoin`, which is what `hex run` will do at startup. A group whose
  member or admin list already names Hex is skipped, so this is safe to repeat.
- `hex run [--dry-run] [--brain echo]` — announce, join every `autoJoin` group,
  then listen. A message that addresses Hex gets a 👀 reaction while the model
  thinks and a threaded kind 9 when it answers. Runs until interrupted.

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

## How a turn works

Delivery is a **tool call**, not a return value. The runtime hands the brain a
tool host bound to one message in one room; the brain may think, may call tools,
and speaks by calling `respond`. Whatever it writes outside a tool call is
private thinking that nobody hears.

That is what keeps the agent transport-agnostic: `respond` is the same tool in a
NIP-29 group, in a DM, or in `hex ask` — the runtime routes it to whichever
backend owns the room. It is also the seam a sandboxed coding agent will use, so
every call is attributable to a room and a requesting pubkey from the start.

What the brain is told back is the truth: `delivered as <id>`, or
`not delivered: <why>`. A relay that refused is a refusal the model can read and
react to, and `delivered` is a fact about the transport rather than a claim by
the model.

Two guards worth knowing: one answer per turn (a second `respond` is refused, not
published), and `maxSteps` round trips per turn. A model that answers in prose
without calling the tool has its text delivered anyway and the fallback says so in
the log — set `brain.toolChoice: "required"` to make the tool path certain, or
`deliverPlainText: false` to make the contract strict.

## Conversations

A mention opens a conversation; Hex's answer continues it; a reply to that answer
is the next turn of the same exchange. Two things make that work:

- **A reply to something Hex said addresses Hex**, with no name and no p-tag.
  Nobody repeats a bot's name in their second sentence.
- **The context is the thread**, walked back through reply tags — not the room's
  last N lines. Unrelated chatter between a question and its answer is noise the
  model would have to reason around. A message that starts a conversation gets the
  room's recent window instead, since there is no thread yet.

Own-message recognition is session-scoped: after a restart, a follow-up has to
name Hex again.

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

A brain that returns nothing is silence, which is a legitimate answer. A brain or
relay that FAILS is logged as a failure — never dressed up as having nothing to
say.

## Status

NIP-29 works end to end. NIP-17 and Concord are the next transports; the
`ToolHost` seam for a sandboxed coding agent is defined and unimplemented.
