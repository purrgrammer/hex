# Tools

Named `<namespace>.<action>`. The ids carry the dot; the wire carries an
underscore, since OpenAI-shaped function names cannot contain one.

| Tool | |
| --- | --- |
| `chat.respond` | Say something in the room. The only way to be heard. |
| `chat.react` | One emoji on the message. Offered only if the transport has reactions. |
| `chat.who` | Who you are talking to, as an npub. |
| `chat.history` | The conversation so far, Hex's own replies included. |
| `nostr.help` | A NIP's text or a kind's definition, from the NIPs repository. |
| `nostr.req` | A NIP-01 filter against relays. Read-only, capped. |
| `nostr.resolve` | A bech32 entity turned into the person or event it names. |
| `nostr.publish` | Sign an event and put it on relays. |
| `nostr.sign` | Sign an event and hand it back unsent. |
| `nostr.rm` | Ask relays to forget events Hex signed. Its own only, and a request. |
| `git.issues` `git.patches` `git.state` | A NIP-34 repository, read. |
| `git.proposals` `git.proposal` | Open proposals in a local checkout, via ngit. |
| `git.merge` | Apply one, if `tools.git.write` allows it. |

`chat.who` and `chat.history` exist because a runtime is handed one message and
told nothing else. Without them, "check my recent posts" becomes a query for kind
1 across the whole network, answered from strangers.

## Delivery is a tool call

Not a return value. A runtime is handed a tool host bound to one message in one
room and speaks by calling `chat.respond`. Whatever it writes outside a tool call
is private thinking nobody hears.

That is what keeps this transport-agnostic: `respond` is the same tool in a
group, in a DM, or in a Concord channel, and Hex routes it to whichever backend
owns the room.

What the caller is told back is the truth — `delivered as <id>`, or
`not delivered: <why>`. A relay that refused is a refusal the model can read and
react to, and `delivered` is a fact about the transport rather than a claim by
the model.

## Where they run

The runtime runs the agent in its own process, so a tool it calls executes there
— and these cannot. `chat.respond` answers one message, in the room it arrived
in, signed by a key only Hex holds.

So the call comes back. A loopback HTTP bridge binds each live session to the
tool host for the message being answered, and the runtime's tool definitions are
a `fetch` that knows a session id.

The bridge listens on 127.0.0.1 with a shared token, and **the session id is
never the model's to choose** — it comes from the runtime's own session context.
An id a model could name is an answer it could address into someone else's
conversation. Calls dedupe on the runtime's call id, because a step interrupted
mid-execution is re-run and a resent message is not idempotent.

## Writing bounds

Absent unless `tools.publish.enabled` is set. Signing and publishing carry the
same bounds — a signed event is one relay call from being published by whoever
holds it.

Some kinds stay refused until the operator names them in `tools.publish.kinds`:

| Kinds | Why |
| --- | --- |
| 0, 3, 10002, 10050 | Replace what the agent already has. A new 10050 silently redirects every private message sent to it. |
| 5 | Asks relays to delete what it names. |
| 4, 13, 1059, 21059 | Built by the transports with the right seal and throwaway key. A hand-rolled one leaks exactly what the envelope hides. |

A proposal is filed once. `nostr.publish` keeps a durable ledger of the patches,
pull requests and issues it has sent and refuses one that repeats a recent
proposal to the same repository — same bytes, same subject, or the same opening.
A runtime re-executes a turn and each execution composes afresh, so a duplicate
arrives with a new call id and rephrased prose that no call-level dedup can see.
The refusal names the event already published; `nostr.rm` retracts it if the
wrong one landed.

## Runtime setup

Eve's local workflow queue delivers a turn over HTTP and waits for the handler,
with a 30-second ceiling on headers and body. A turn that thinks for longer makes
the delivery throw and the queue redeliver — re-executing the turn's inline
steps, tool calls and all. Set these where Eve runs:

```
WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS=0
WORKFLOW_LOCAL_BODY_TIMEOUT_MS=0
```

Eve's own session timeout is the backstop.
