# Operating

Hex is two processes. The gateway (`hex serve`) holds the relay sockets and the
queue; the runtime (`eve dev`) runs the agent loop. They meet over loopback
HTTP, and the endpoint is the whole contract between them.

## Starting them

The runtime first — the gateway tolerates its absence, but a missing runtime
answers nobody.

```bash
ops/detach eve.out.log node_modules/.bin/eve dev
ops/detach ~/.hex/serve.log node dist/cli.js serve ~/.hex/hex.config.json
```

`ops/detach` puts a command in its own session so it outlives the shell. macOS
ships no `setsid`; that is all this is.

## Keeping them up

`ops/` carries a launchd job for each half. They are templates — replace
`HEX_DIR`, `NODE_BIN` and `CONFIG`, then:

```bash
launchctl load -w ~/Library/LaunchAgents/rocks.grimoire.hex.runtime.plist
launchctl load -w ~/Library/LaunchAgents/rocks.grimoire.hex.gateway.plist
```

They restart on different rules, deliberately. The runtime restarts on any exit:
one that stopped cleanly has still stopped answering. The gateway restarts only
on a crash, because a clean exit is somebody stopping it, and two gateways on
one home fight over a lease neither should win.

## What survives what

| Happens                          | What hex does                                                      |
| -------------------------------- | -------------------------------------------------------------------- |
| Runtime restarts (`agent/` edit) | A POST that was refused is retried for ~7s, so the message is not lost |
| Runtime wedges, port still open  | POSTs give up after 30s rather than holding a lane                    |
| Runtime forgets a session        | The head is closed `aborted` instead of read again every restart     |
| Gateway restarts                 | Open sessions are caught up from their stored cursor                 |
| A relay lies or goes quiet       | Deadlines everywhere; a silent relay is never read as a finished one  |

A refused connection is retried because the request never landed. A request that
timed out is **not** retried: it may well have arrived, and a second `send` on a
session that already took the message is a turn the room reads twice.

## Checking on it

```bash
hex whoami        # the signer resolves
hex check         # every relay, per role
curl -s localhost:2000/eve/v1/info | head -c 200   # the runtime answers
```

## The contract suite

Everything else here runs against fakes, and a fake only ever agrees with
whoever wrote it. One did not agree with the runtime, and both suites stayed
green while a bounded read dropped its last event.

So there is an opt-in suite that asks a real runtime:

```bash
HEX_EVE_HOST=http://127.0.0.1:2000 \
HEX_EVE_SESSION=wrun_… \
  npx vitest run src/__tests__/eve-contract.test.ts
```

Skipped when `HEX_EVE_HOST` is absent, which is always in CI. Read-only: opening
a session costs a model call, and a suite that spends money is a suite nobody
runs. Run it after upgrading `eve` — the dependency is a caret on a pre-1.0
framework, and the wire is not covered by any type.
