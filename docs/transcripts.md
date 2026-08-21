# Transcripts

Every run is published as events: a turn per message, an ephemeral delta while a
turn is still being written, and a head that says where the run stands. The
shape is [Agent Sessions](../spec/nip-agent-sessions.md).

`transcript` is absent by default. An agent that starts mailing its
conversations because it was upgraded has leaked one nobody asked it to send.

```json
"eve": { "host": "http://127.0.0.1:2000" },
"transcript": { "to": ["npub1…"], "slug": "hex", "deltas": true }
```

## Two cursors

The runtime's `startIndex` says how far this consumer has read, so a restart
resumes rather than republishes. `seq`/`prev` are the chain on the wire, kept in
the `transcripts` table.

Losing the second is the worse failure: resuming at `seq` 1 under one session id
publishes a second chain, which every conforming reader must read as a fork.

Both are fenced on the writer lease. A write from a generation that no longer
holds the home is refused, so two processes sharing a key cannot both advance one
chain.

## Where a copy goes

The operator's copy is always gift-wrapped, whatever room the run started in — a
transcript is for whoever owns the agent.

A run in a group also belongs to the group. Hex publishes each event to the relay
hosting the group, carrying the group's `h` tag, and nowhere else. That relay is
the group's access control and the only party that knows who the group is for.
Publishing to Hex's own relays instead would route around the decision the group
already made.

The `h` tag goes on the rumor before it is sealed, so the wrapped copy and the
group copy are one event with one id.

A NIP-29 relay accepts a fixed set of kinds and the common implementations do not
include these, so the group copy is refused and the transcript reaches the
operator only. Hex stops the group copy at the first refusal rather than skipping
an event and carrying on — a chain that is visibly short is readable, one with a
hole in it is not.

## Linking an answer to its run

An answer in a room carries `["a", "31777:<agent>:<session>"]`. A client that
knows the NIP offers the transcript from the answer; one that does not ignores an
unknown `a` tag.

## Control

An operator can start, answer, steer, stop, compact or clear a session with a
kind-1779 event, honoured only from the pubkey the session's head names as
operator.

Sessions left mid-flight by a killed process are caught up at startup. A head
that says `active` forever is a lie no reader can detect.
