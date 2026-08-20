NIP-xx
======

Agent Sessions
--------------

`draft` `optional`

## Abstract

Five kinds encode an autonomous agent's work and the operator's hand on it.

Four are written by the agent — an **agent definition**, a **session head**, one **turn** per message, and an ephemeral **delta** while a turn is still being written. The fifth goes the other way: a **session control** event, written by the operator, is how a reader starts a run, answers a question the agent stopped to ask, redirects it, or stops it.

They are rumors, carried as NIP-59 gift wraps to whoever is meant to read them. A turn's shape — a `role` and an ordered list of `parts`, each `text`, `reasoning`, a tool call or its result — is the shape an agent runtime already has, so publishing is a mapping rather than a translation. Nothing here depends on that envelope — a transport that carries the same rumors carries the same session — but this document specifies only the wrapped case, because that is the only one with an implementation behind it.

## Kinds

| kind    | class       | name             | notes |
| ------- | ----------- | ---------------- | ----- |
| `31779` | addressable | Agent Definition | One per `(pubkey, d)`. `d` names what it describes: an agent's slug, or a session id for a snapshot of one run. |
| `31777` | addressable | Session Head     | One per `(pubkey, d)`; `d` is the session id. |
| `1777`  | regular     | Turn             | Append-only. A correction is a new turn, never an overwrite. |
| `1779`  | regular     | Session Control  | Written by the OPERATOR, not the agent. The only kind here that makes an agent act. |
| `21777` | ephemeral   | Delta            | Relays MUST NOT store it. Everything it carries is repeated in the turn that closes it. |

Envelopes are reused unchanged: `kind:1059` wrap with a `kind:13` seal (NIP-59), and `kind:21059` for a delta so the wrap is dropped with its payload.

### Kind allocation

The numbers are a family with `kind:777` (spells) and `kind:30777` (spellbooks). Checks performed before freezing them:

| Registry | Result |
| --- | --- |
| Upstream event-kind table (`nostr-protocol/nips` `README.md`, commit `656cecc7c0a815b6a2b218d3b5d6f078b3f4dbab`) | `1777`, `1779`, `21777`, `31777` and `31779` all unassigned; nothing assigned in `1770`-`1789`, `21770`-`21779` or `31770`-`31789`. |
| nostrbook.dev (`https://nostrbook.dev/kinds/<n>`) | All HTTP 404 — no entry. |

`1778` is deliberately unused. It held a coarse stored "milestone" until that
turned out to restate what the turn beside it already said; what it alone could
carry moved onto the head's `status`. Burned rather than recycled, so a reader
that once saw one never mistakes a later kind for it.

Both registries are advisory and neither reserves numbers, so an unregistered kind may still be in use by an unpublished client.

## Agent Definition — `kind:31779`

Authored by the agent's own key. What the agent was set up with.

`d` names what the definition describes, and there are two useful answers. A
**standing definition** uses the agent's slug and says what the agent is in
general. A **session snapshot** uses a session id and says what applied to one
run — the prompt that produced that transcript, and the tools that were on offer
while it did. An agent whose configuration changes SHOULD publish the snapshot,
because a standing definition read a month later describes an agent that has
since been edited, and a reader has no way to tell.

A snapshot is published once and never updated. One that kept up with its subject
would not be a snapshot. It is its own event rather than tags on the head because
a head is republished on every status change and every turn, sealed and wrapped
once per recipient each time, while a prompt and a set of tool schemas is
kilobytes; the head points at it through `agent`.

**`content` is the system prompt itself** — plain text, nothing wrapping it, so anyone reading the raw event reads what the agent was told. It is published whole or left empty; a half-published prompt reads as the whole one. Everything else is a tag, `v` included, so a later revision of this shape is a version bump rather than a parse fork.

| tag       | value | indexable | req |
| --------- | ----- | --------- | --- |
| `d`       | `<slug>` | yes | yes |
| `v`       | `1` — the revision of this shape | no | yes |
| `name`    | `<string>` | no | yes |
| `picture` | `<url>` | no | no |
| `about`   | `<string>` | no | no |
| `tool`    | `<tool-name>`, `<description>`, `<parameters>` | yes | no |
| `try`     | `<starter prompt>` | no | no |
| `model`   | `<model-id>`, `<context-window>` | no | no |
| `p`       | `<pubkey>` — a recipient this copy was sealed for | yes | no |
| `repo`    | `<name>`, `<url>`, `<path>`, `<description>` | no | no |
| `alt`     | `<string>` ([NIP-31](31.md)) | no | yes |

`repo` says what the agent has checked out and WHERE — the path inside its own
sandbox. The path is the load-bearing element: a client offering "start a run on
this repository" must name a directory the agent will recognise, and one it
guessed at produces a prompt the agent silently ignores and a session that looks
like it worked. The elements are positional, with empty strings for what is
absent, so a missing url cannot shift the path into its place. It is not
indexable: an agent's checkouts are not something a relay should let anyone
enumerate by, and a reader holding the definition already holds them.

`model` says what was answering, and its second element is the size of the
window that model was answering in — the number a reader needs to say whether a
run was near the edge of what it could hold. It is positional with an empty
string for an unknown window, for the same reason `repo` is.

The `p` tags are on the definition rather than only on the wrap because a wrap
names one recipient by design and a reader holding one copy cannot tell whether
anyone else got it. They say who the snapshot was meant for, not who may read it
— a definition is not an access list.

`tool` is indexable, so `{"#tool":["nostr.req"]}` finds every agent that can do a thing. Trailing elements are dropped when absent: a bare tool is a two-element tag, a fully described one is four. `<parameters>` is the tool's schema — usually JSON Schema — as a JSON string, which is the price of the content being prose rather than a document. A reader that cannot parse it treats the tool as having no schema rather than discarding the tool.

```json
{
  "kind": 31779,
  "pubkey": "9e1f…agent",
  "content": "You are Hex. Answer with a REQ filter when one will do.",
  "tags": [
    ["d", "hex"],
    ["v", "1"],
    ["name", "Hex"],
    ["about", "Answers questions about Nostr REQs."],
    ["tool", "nostr.req", "Query relays", "{\"type\":\"object\",\"properties\":{\"kinds\":{\"type\":\"array\"}}}"],
    ["try", "what kinds does this relay serve?"],
    ["repo", "grimoire", "https://github.com/purrgrammer/grimoire", "/workspace/grimoire", "The Nostr explorer this agent assists with"],
    ["alt", "Hex — a Nostr agent answering REQ questions"]
  ]
}
```

## Session Head — `kind:31777`

One run's current state. `content` is a human-readable summary and MAY be empty.

| tag        | value | indexable | req |
| ---------- | ----- | --------- | --- |
| `d`        | `<session-id>` — 32 random bytes, hex | yes | yes |
| `title`    | `<string>` | no | yes |
| `status`   | `active`\|`idle`\|`awaiting-input`\|`payment-required`\|`done`\|`error`\|`aborted` | no | yes |
| `p`        | `<pubkey>`, `<relay>`, `operator` — exactly one | yes | yes |
| `p`        | `<pubkey>`, `<relay>`, `observer` | yes | no |
| `e`        | `<event-id>`, `<relay>`, `trigger` — the message that started this run | yes | no |
| `last-seq` | the highest turn `seq` so far — how many EVENTS this session has published | no | yes |
| `turns`    | how many exchanges the run has had | no | no |
| `started`  | `<unix-seconds>` — the real start, unaffected by NIP-59 | no | yes |
| `ended`    | `<unix-seconds>`; present iff `status` is terminal | no | no |
| `model`    | `<model-id>`, `<provider>` | no | no |
| `usage`    | `<in>`, `<out>`, `<cache-read>`, `<cache-write>` | no | no |
| `cost`     | `<amount>`, `<currency>`, `estimated` | no | no |
| `input`    | `<request-id>` — one per request the run is blocked on | no | no |
| `transport` | `nip-17`\|`nip-29`\|`nip-59`\|… — the protocol this run is happening on | no | no |
| `channel`  | the room, in that protocol's own notation | no | no |
| `delta-relay` | `<relay>` — where this session's `21777`s are published | no | no |
| `agent`    | `31779:<pubkey>:<d>` — the definition or snapshot describing this run | no | no |
| `alt`      | `<string>` | no | yes |

The last three statuses are terminal; `awaiting-input` and `payment-required` are [NIP-90](90.md)'s values verbatim.

A third element on `cost` marks a figure that was **worked out** from token counts
and list prices rather than billed by a provider — plenty of providers report no
cost at all, and a transcript with usage and a blank where the money goes is no
use to anyone auditing spend. A reader that ignores the third element gets a
number that is approximately right; one that reads it can say so.

`transport` and `channel` say WHERE the run is happening, which a transcript
read away from its conversation cannot otherwise answer. They are two tags
because they answer different questions: the protocol decides whether a reader
can offer to open the room at all, and the channel names the room inside it —
written the way that protocol writes rooms, so a client can act on it rather
than reformat it. A NIP-17 channel is the correspondent's pubkey; a NIP-29 one
is `<relay-host>'<group-id>`, [NIP-29](29.md)'s own notation, in which two groups
sharing an id on different relays are correctly two rooms.

Neither is indexable, deliberately. A single-letter tag would let a relay group
every session an agent ever ran with one person — precisely the association the
gift wrap exists to withhold — and no reader needs to query by it, since a reader
holding the head already holds the session.

`delta-relay` exists because deltas ride `kind:21059`, which a recipient's DM
inbox relay is entitled to refuse — and in practice they do. A publisher that
sends deltas anywhere other than the recipient's own inbox MUST say where, or the
reader watches a status that never moves while the run goes perfectly.

`last-seq` and `turns` are two different numbers and neither substitutes for the
other. `last-seq` counts published events, and one exchange is routinely four or
five of them — the question, the reasoning, two tool calls, the answer. `turns`
counts the exchanges. A client showing "12 turns" from `last-seq` shows a number
three times too large, which is what this tag exists to stop.

`transport` `nip-59` is the case with no room in it: a run started over the
control plane is happening in the wrapped channel itself and nowhere else. A
client MUST NOT offer to open it, and an agent MUST NOT offer a run like this any
tool that posts to a room, because there is none. It is a distinct value rather
than an absent `transport` so that "no room" is a stated fact and not an omission
a reader has to guess the meaning of.

The `agent` tag is present only once the definition it names has actually been
published. A head that points at an address nobody wrote sends every reader to
fetch nothing, and repeatedly — worse than a head that admits it has no
definition to offer. In particular a publisher MUST NOT fall back to its standing
definition when a snapshot failed to send: the standing one describes the agent
in general, and a reader shown it in a snapshot's place is told the prompt in
force was one that was not.

**`input` is what separates a blocked session from a finished one**, and nothing
else does. See *Blocked Sessions*.

**The head takes no `seq`.** It is addressable, so a relay deletes the version it supersedes — a sequence number it had consumed would name an event that is gone, and every later reader would see a hole it can never fill. Wrapped, no relay can replace it either, so a reader keeps the newest `created_at` per `(pubkey, d)`.

Because the head carries running `usage` and `cost`, an agent MAY publish heads and no turns at all: what a session spent then survives without any of what it said.

## Turn — `kind:1777`

One event per message: a user prompt, an assistant reply, or a tool result. `content` is a JSON array of **parts**, in order — the one place structure lives in `content` rather than in tags, because a turn's payload is a sequence, tags are a set, and tool arguments are arbitrary JSON with no honest tag encoding.

```
text        = { "type":"text",        "text": <string>, "truncated"?: <truncation> }
reasoning   = { "type":"reasoning",   "text": <string>, "truncated"?: <truncation> }
tool_call   = { "type":"tool_call",   "id","name", "arguments": <object>|null,
                                      "arguments_digest"?: <sha256> }
tool_result = { "type":"tool_result", "id","name", "ok": <bool>,
                                      "output": <string>|null,
                                      "ref"?: <blob-ref>, "truncated"?: <truncation> }
image       = { "type":"image",       "url","mime", "sha256"? }

input_request  = { "type":"input_request",  "requestId", "prompt",
                   "requestKind"?, "display"?, "allowFreeform"?,
                   "options"?: [ { "id","label","description"?,"style"? } ],
                   "tool"?: { "name", "callId"? } }
input_resolved = { "type":"input_resolved", "requestId", "outcome",
                   "response"?: { "optionId"?, "text"? } }

truncation  = { "bytes", "sha256" }          // of the ORIGINAL
blob-ref    = { "sha256","url","size","mime" }
```

`arguments: null` with a digest means the call was too large to carry; the digest still names which call it was. `output: null` with a `ref` means the result was too large to inline.

`input_request` is a question the run stopped to ask, carried in full because a
reader that cannot see the options cannot answer, and one that cannot answer
watches the session stay stuck. `input_resolved` records what became of it, so a
transcript read afterwards is not left hanging. Whether a request is STILL open is
not a property of a turn — turns are history — and lives on the head's `input`.

`cancelled` is not a finish reason any model reports, because the model did not
finish — somebody stopped it. It is distinguished from `error` because a run
ended on purpose and a run that broke are different events in the life of a
session, and folding them together loses the only part a reader is asking about.

**Some turns record what happened TO a conversation** rather than what was said
in it: the context was summarised, the context was thrown away, the run was
stopped before it answered. They are ordinary turns with `role` `tool` and a
`text` part saying so in a sentence, and they exist because the turns after them
cannot be read correctly without them — an agent that has forgotten the first
half of its own transcript is not the agent the reader thinks they are watching.

This is the division of labour between `1779` and `1777`, and it is worth stating
plainly: **a control event is an intent, a turn is a fact.** The operator's `1779`
records what was asked for and by whom; the turn records what became of it, is
written by the agent, and is written whether the effect was asked for or arose on
its own — an automatic compaction under window pressure and one an operator
ordered are the same event to everyone downstream, and a publisher SHOULD NOT
claim to know which it was.

Not every command earns a turn. One does when a later reader needs it to
interpret what follows, and not otherwise: `respond` and `steer` already appear
as the `user` turn they produce, and a `reset` has nothing after it to interpret,
so the head's terminal status is its whole record.

**The list of part types is open.** Those seven are the ones this revision defines and the ones a client should implement; an agent MAY emit others. A client MUST keep a part whose `type` it does not recognise, render what it can around it, and MUST NOT discard the turn — a turn from a later revision is still most of a turn.

| tag     | value | indexable | req |
| ------- | ----- | --------- | --- |
| `a`     | `31777:<agent>:<session>`, `<relay>` — the only session pointer | yes | yes |
| `seq`   | counter, from 1 | no | yes |
| `prev`  | id of the event at `seq - 1`; omitted only at `seq` 1 | no | yes |
| `turn`  | logical turn index; an assistant reply and its tool results share it | no | yes |
| `role`  | `user`\|`assistant`\|`tool` | no | yes |
| `p`     | `<pubkey>`, `<relay>`, `<role>` — as on the head | yes | yes |
| `subagent` | `<call-id>`, `<child-session-id>`, `<name>` — a child session this turn started | no | no |
| `stop`  | `end_turn`\|`max_tokens`\|`tool_use`\|`content_filter`\|`cancelled`\|`error`; assistant only | no | no |
| `model` | `<model-id>`, `<provider>`; assistant only | no | no |
| `usage` | `<in>`, `<out>`, `<cache-read>`, `<cache-write>` | no | no |
| `cost`  | `<amount>`, `<currency>`, `estimated` | no | no |
| `tool`  | one per distinct tool in `content` | yes | no |
| `alt`   | plain-text rendering — what a client that cannot parse the parts shows | no | yes |

```json
{
  "kind": 1777,
  "pubkey": "9e1f…agent",
  "created_at": 1755500118,
  "content": "[{\"type\":\"text\",\"text\":\"Found it. Running the tests.\"},{\"type\":\"tool_call\",\"id\":\"tc_01\",\"name\":\"Bash\",\"arguments\":{\"command\":\"npm test\"}}]",
  "tags": [
    ["a", "31777:9e1f…agent:3a7c…4e5f", "wss://relay.example"],
    ["seq", "46"], ["prev", "0c93…"], ["turn", "12"],
    ["role", "assistant"],
    ["p", "1a2b…human", "wss://relay.example", "operator"],
    ["stop", "tool_use"],
    ["model", "claude-opus-5", "anthropic"],
    ["usage", "18432", "921", "16000", "2432"],
    ["cost", "0.084", "USD"],
    ["tool", "Bash"],
    ["alt", "Assistant: found it. Calling Bash."]
  ]
}
```

## Session Control — `kind:1779`

Written by the **operator**, not the agent: the only kind here that makes an agent
act rather than describing what it did. That inversion is the whole reason this
section is careful.

One kind carrying a `command` tag rather than a kind per verb, for the same reason
a turn carries `role` rather than one kind per role. The usual argument for
splitting — that a relay can filter on kind — buys nothing when the channel is
wrapped and no relay can see any of it, and the verb set grows.

| tag       | value | indexable | req |
| --------- | ----- | --------- | --- |
| `a`       | `31777:<agent>:<session>` — the session this acts on | yes | yes |
| `p`       | `<agent>` — the key that must act | yes | yes |
| `command` | `start`\|`respond`\|`steer`\|`cancel`\|`compact`\|`clear`\|`reset` | no | yes |
| `request` | the request id being answered; required for `respond` | no | no |
| `turn`    | the turn being stopped, when `cancel` means a specific one | no | no |
| `option`  | the chosen option's id, when the question offered any | no | no |
| `policy`  | `queue`\|`steer` — what a message sent mid-turn does | no | no |
| `a`/`e`/`p`/`r`/`i` | what the run is to be ABOUT, as on a head | yes | no |
| `alt`     | `<string>` | no | yes |

`content` is free text: the answer for a `respond`, the message for a `steer`,
empty otherwise. Prose goes in `content` — the one place this family always puts
it.

```json
{
  "kind": 1779,
  "pubkey": "7fa5…operator",
  "content": "",
  "tags": [
    ["a", "31777:9e1f…agent:3a7c…4e5f"],
    ["p", "9e1f…agent"],
    ["command", "respond"],
    ["request", "req_01J8…"],
    ["option", "approve"],
    ["alt", "Session control: respond"]
  ]
}
```

`policy` decides the one ambiguous act in the set: a message that arrives while a
turn is running. `queue` waits for the running turn and then delivers; `steer`
cancels it and starts again. **`queue` is the default**, which inverts what most
runtimes do on their own — and deliberately. Cancelling is right in a room, where
a message mid-turn means "not that, this". It is wrong from a session view, where
the operator is watching the work happen and adding to it, and throwing away a
turn that is minutes into a build because they had a second thought is the
expensive reading of an ambiguous act. A client that means "stop and do this
instead" says so.

The subject tags are the same ones a head carries and mean the same thing: what
the run is about. On a `start` they are how a client says it — a pointer, not a
sentence in the message hoping the model notices. Because a control event already
carries an `a` for the session and a `p` for the agent, a reader collecting
subjects MUST exclude those two; everything else `a`, `e`, `p`, `r` or `i`
([NIP-22](22.md)'s scope vocabulary, with `i` for external ids per
[NIP-73](73.md)) is a subject.

There is deliberately **no `pause`**. A run parks because something asked it a
question, not because it was told to wait, and a verb that cannot be honoured is
worse than one that does not exist.

Three rules matter more than the verb list.

**Authorisation.** An agent MUST honour a control event only from the pubkey its
own head names as `operator`, and MUST check that where it decodes rather than
where it acts, so that no later call site can forget to ask. A control event for
another agent is ignored; one from a stranger is refused, and an implementation
SHOULD say so out loud, because that is somebody trying.

**Scope, against replay.** A relay hands the same wrap over more than once. Every
command names what it acts on — `respond` a request, `cancel` a turn — and an
agent MUST ignore a command whose target has already settled. A bare `cancel`
redelivered an hour later would otherwise stop a turn that had nothing to do with
it.

**No acknowledgement event.** The head's status changing *is* the receipt:
`awaiting-input` becomes `active` when an answer lands. A reader already watches
the head, and a second event saying what the first one already shows is a second
thing to keep consistent.

Unknown commands are ignored rather than refused, exactly as unknown part types
and unknown statuses are: it is a newer client talking.

## Starting a Run

Two ways, and they are for two different callers.

**A message with nothing above it.** An agent opens a session for a message that
threads onto nothing and continues one for a message that replies — a rule the
transport already needs for its own sake, since a new subject inheriting an hour
of unrelated context is the failure it prevents. Anything that can send a private
message or post in a group can therefore start a run, and most runs start this
way. There is nothing to implement.

**A `start` control event**, for a caller that has no room to send a message in.
A session view is the case that forced it: a client offering "run this again" or
"look at this repository" is not in a conversation with the agent, and composing
a chat message to itself in order to be in one produces a run whose transcript
begins with a sentence no human wrote and which is nevertheless attributed to
one.

A `start` carries three things a message cannot:

- **The session id, chosen by the client.** The `a` tag names an address that
  does not exist yet, and the agent adopts it. That is what lets the client watch
  the address from the moment it asks, rather than sending a request into the
  wrapped channel and scanning everything that comes back for something that
  looks like an answer to it. The `d` element MUST be 32 random bytes as hex; an
  agent MUST reject anything else, because a client-chosen name is a name in a
  space the agent shares with every other client.
- **Subjects as pointers.** `a`, `e`, `p`, `r` and `i` tags say what the run is
  about, and the agent puts them in front of the model as resolved context. This
  replaces the older advice to name the repository in the message as words, which
  was a workaround for having no field and produced exactly the failure it was
  meant to avoid: a sentence the model may or may not act on, in text the
  operator did not write.
- **The opening instruction**, in `content`, which becomes the run's first `user`
  turn as if it had been sent.

`start` is the scope rule's own instance: its target is the session, and a
session settles by existing. An agent MUST refuse a `start` naming an address it
has already published — that is a redelivered wrap, not a second run — and a
client that wants a second run picks a second id.

A run started this way has no room. Its head SHOULD carry `transport` `nip-59`
and no `channel`, and the agent MUST NOT offer it any tool that posts to a room,
because there is nowhere for the output to go and a tool that fails on every call
is worse than one that was never offered. The transcript is the whole of the
delivery.

`reset` is the other end of the same life. It retires a session for good: the id
never becomes a session again, and the head goes terminal — `aborted`, since a
retired run did not finish what it was doing. Unlike every other verb it may
leave no trace on the runtime's own stream, so a publisher MUST close the head
itself rather than waiting to be told.

## Blocked Sessions

A run that stops to ask a question is neither working nor finished, and this is
the part a client is most likely to get wrong — because a runtime's own boundary
events usually cannot tell the difference. In the implementation this NIP is
written from, a parked turn emits exactly what a completed turn emits, with
identical payloads. **A publisher MUST NOT infer that a session ended from a
runtime's end-of-turn signal alone.**

What separates them is the head's `input` tags, and nothing else. A request is
open from the moment it is asked until the moment it is resolved, the status is
`awaiting-input` for as long as any is open, and a terminal status still wins —
a run that ended is not waiting for anybody. A publisher MUST keep that set
durably: held only in memory, a restart re-reads the stream, sees the end-of-turn
signal, and republishes a session waiting on its operator as done.

`payment-required` is the other blocked state and is **not** answerable through
`1779`. It means a sign-in the agent cannot perform for itself; a human has to
open a URL, and the runtime resolves it on its own once they do. A publisher
SHOULD carry the challenge so the reader knows where to go. A reader SHOULD NOT
offer to answer it.

## Delta — `kind:21777`

What tells a reader the agent is working before the turn lands. `content` is the raw appended fragment: prose for `text`, the model's own words for `reasoning`, the tool call's arguments as they stream for `tool` (with `tool-id` naming the call), and empty for `heartbeat`, which asserts only that the agent is alive.

| tag       | value | indexable | req |
| --------- | ----- | --------- | --- |
| `a`       | `31777:<agent>:<session>` | yes | yes |
| `turn`    | the turn being streamed | no | yes |
| `part`    | counter local to the turn, from 1, reset at turn start | no | yes |
| `delta`   | `text`\|`reasoning`\|`tool`\|`heartbeat` | no | yes |
| `tool-id` | required when `delta` is `tool` | no | cond |
| `p`       | `<pubkey>`, `<relay>`, `<role>` | yes | yes |

**A delta takes no `seq`.** Deltas evaporate at the relay; a number one had consumed would be a permanent hole. A `part` discontinuity means the reader discards that turn's partial buffer and waits for the turn.

An agent SHOULD coalesce deltas into fragments of at least 50 ms or 32 characters, MUST NOT emit one over 4 KiB, and MUST NOT emit one per token.

## Linking an Answer to Its Transcript

An agent that answers in a chat — a `kind:14` private message, a `kind:9` group message — SHOULD carry `["a", "31777:<agent>:<session>"]` on that message. A client that knows this NIP can then offer the transcript from the answer; one that does not ignores an unknown `a` tag, and the message renders as it always did.

This is the whole integration surface for an agent that already publishes plain chat messages: one tag, nothing else changed.

## Ordering

NIP-59 randomises a wrap's `created_at` up to two days back and a seal's up to an hour. Only the rumor's `created_at` is the agent's clock, and it is unsigned — a hint, not a proof. Order rests on `seq`, which is inside the sealed payload and covered by the seal's signature.

1. **Sort by `seq`.** Only `kind:1777` carries one.
2. **Tie-break** on equal `seq`: lower `created_at`, then smaller event `id`. A duplicate `seq` SHOULD be surfaced — it is the visible signature of a replayed or forged event.
3. **Never sort by `created_at` across the wrap boundary.** A rumor more than 900 seconds in the future is displayed with its receipt time and flagged.
4. **Chain check.** `prev` names the event at `seq - 1`. A mismatch means the stream **forked**; a client MUST NOT silently merge the branches.

A gap is any missing `seq` below the head's `last-seq`. A client MUST render it explicitly rather than closing the hole, and MUST NOT block rendering on it. Inner tags are invisible to relays, so a gap that survives a refetch of the wrap window is permanent and the client says so. This NIP deliberately mints no indexable counter: it would leak progress to a relay that can read nothing else.

## Carriage

The agent builds the rumor, seals it in a `kind:13` NIP-44-encrypted to each recipient and signed by its own key, and wraps the seal in a `kind:1059` — or `21059` for a delta — signed by a fresh throwaway key, `p`-tagged to the recipient, `created_at` randomised. One wrap per recipient, each under its own key.

Recipient relays come from their `kind:10050`, else the NIP-65 inbox; a recipient with neither is undeliverable and MUST be reported, not skipped. The agent SHOULD self-wrap so it can re-read its own transcript.

A relay sees a `1059` from a key that exists for one event: not the kind, the session, the agent, the sequence, or that this is an agent at all.

## Publishing in the Clear

An agent MAY publish a session unencrypted — the same events, signed by the same key, to its own NIP-65 write relays. The session id, the `seq` chain and the head are unchanged, so a reader holding both copies sees one session rather than two, and an `naddr` for the head is a shareable address anyone can resolve.

There is one chain and one `last-seq`, so a public copy MUST carry the whole of it. Publishing some turns and not others leaves gaps a reader is required to render as gaps, which is worse than a transcript that was never public.

Two properties to state plainly, because a publisher cannot undo either: the events are permanent — [NIP-09](09.md) is a request, not a delete — and the transcript contains whatever the agent was told, including the operator's own words.

**A run in a group belongs to the group.** A wrapped transcript answers "who may
read this" with a list of names, which is right for a private message and wrong
for a room: the question was visible to everyone in it and the answer to one
person, who had not asked it.

The answer is not to publish it in the open. An agent answering in a
[NIP-29](29.md) group SHOULD also publish each of its events to **the relay that
hosts the group**, carrying the group's `h` tag — and nowhere else. That relay is
the group's access control, and it is the only party that knows who the group is
for. A private group stays private with nothing here reasoning about it; a public
one is readable by whoever the group is readable by. Publishing the same events
to the agent's own relays instead would route around the decision the group
already made.

The `h` tag goes on the rumor **before it is sealed**, so the wrapped copy and
the group copy are one event with one id. A relay carrying the wrap sees nothing
— the tag is inside the seal — and a reader holding both copies sees one session,
by the merge rule above. Tagging only the group copy would produce two events at
one `seq`, which this NIP tells a client to treat as the signature of a forgery.

The choice is made once, when the session opens. There is one chain and one
`last-seq`, so a group copy that begins at turn twelve is a transcript with a
hole nobody can fill.

Note for implementers: a NIP-29 relay accepts a fixed set of kinds, and at the
time of writing the common implementations do not include these. Until they do,
an agent's group copy is refused and its transcript reaches the operator only.
An agent SHOULD stop the group copy at the first refusal rather than skipping the
event and carrying on — a chain that is visibly short is readable, one with a
hole in it is not — and MUST NOT let that refusal stop the wrapped copy.

**Only the author can do this.** The seal rule below makes forwarding impossible on purpose: a sharer who re-seals someone else's rumors signs the new seal, and a conforming reader rejects every one. Sharing a transcript you did not author means asking whoever did to publish it.

## Identity and Trust

An agent has **one persistent key**, with a `kind:0` carrying `"bot": true` ([NIP-24](24.md)). The same key signs every head, turn and seal across every session, so an agent is followable and its history is attributable.

Binding an agent to its operator is two-way, and both halves are required: the agent names its operator on the head and every turn, and the human `p`-tags each agent key in a [NIP-51](51.md) `kind:30000` set with `["d","agents"]`. One half alone is an unverified claim and MUST be rendered as such.

Anyone can publish a `1777` carrying any `a` tag; relays index tags, they do not police them. A client MUST therefore:

- **Check the author.** Discard any `1777`/`21777` whose `pubkey` is not the pubkey inside its own `a` address.
- **Check the seal.** The wrap's signature proves nothing — it is a throwaway key by design. The seal's signature is the authorship proof; reject a seal whose author is not the rumor's author.
- **Reject a second address.** Relays index every `a` tag, so an event carrying two is returned by a REQ for either. Accept exactly one.
- **Bound the counters.** `seq`, `turn`, `part` and `last-seq` are attacker-supplied decimal strings, and `last-seq` bounds a walk over a stream's sequence numbers. Refuse a counter beyond a sane ceiling and cap how many missing numbers you will enumerate; otherwise one event is a remote out-of-memory.
- **Treat an orphan as an orphan.** A turn whose head is unknown is labelled as one.

## Size

An event SHOULD stay under 64 KiB and MUST stay under 256 KiB; a wrapped copy is ~1.4× the rumor. A publisher MUST NOT emit an event it knows exceeds the limit; how it gets under is its own business.

Whatever it does MUST be visible. A shortened part carries `truncated` describing the **original** and ends with the marker `…[truncated]`, which a client MUST render. An oversize tool result MAY be referenced instead: `output: null` plus a `ref` whose `sha256` is over the plaintext and is authoritative, and which a client that fetches the blob MUST verify. On a private stream the blob SHOULD be encrypted before upload, since the host would otherwise hold exactly the plaintext the wrap was protecting.

A turn that quietly lost half its content reads as a whole one, which is worse than a short one.

## What a Minimal Client Must Implement

Read: subscribe `{"kinds":[1059],"#p":[<self>]}`, decrypt the wrap, decrypt the seal, check the seal's author against the rumor's, then check the rumor's author against its `a` address. Sort turns by `seq`, render `alt` when `content` will not parse, and compare what you hold against the head's `last-seq`. Treat a head carrying `input` tags as waiting rather than finished. Deltas and `21059` are optional.

Publish: a persistent key with a `kind:0`, one `31777` head kept current, and one `1777` per message carrying `a`/`seq`/`prev`/`turn`/`role`/`p`/`alt`. Definitions, deltas and blob refs are all optional. A publisher that can be blocked MUST keep its open requests on the head, durably.

Control is optional to send and **mandatory to authorise**: an agent that reads
`1779` at all MUST check the author against its own head's `operator` before
honouring it — and, for a `start`, against whatever it uses to decide who may
talk to it at all, since there is no head yet to name an operator.

An agent that does not read `1779` cannot be started, steered or stopped except
by talking to it, which is a coherent thing to be: everything in the four
agent-written kinds still works, and a client that finds no way to control a
session says so rather than offering buttons that do nothing.

A client MUST NOT require deltas to render a session, nor blob fetching to render a turn, nor a definition to render either.
