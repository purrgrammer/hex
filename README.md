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
