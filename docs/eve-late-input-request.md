# A question raised after its turn ends can never be answered

**Runtime:** eve 0.39.1 (`vercel/eve`, `packages/eve`), local dev server.
**Where it bites hex:** any `ask_question` that lands late. The session parks on
the wire, the operator answers, and the answer resolves nothing.

## What happens

`ask_question` fired four minutes after its own turn had already been finalised.
From the session stream of `wrun_01M0G5H4S45K0APBYDNGZ49BX1` (indices as read
from `/eve/v1/session/{id}/stream?startIndex=0`):

```
353  18:30:33.033  message.completed   turn_0  stepIndex 20
354  18:30:33.035  step.completed      turn_0  stepIndex 20
355  18:30:33.047  turn.completed      turn_0
356  18:30:33.049  session.waiting
357  18:34:43.232  reasoning.appended  turn_0  stepIndex 20   <- same step, 4m later
358  18:34:43.415  reasoning.appended  turn_0  stepIndex 20
359  18:34:48.298  step.completed      turn_0  stepIndex 20   <- second completion
360  18:34:48.309  input.requested     turn_0  stepIndex 20   req toolu_01LEv…
361  18:34:48.310  turn.completed      turn_0                 <- second completion
362  18:34:48.311  session.waiting
```

Step 20 completes twice and turn_0 completes twice, minutes apart — it reads
like two generations in flight for one step, the first finalising the turn and
the straggler raising the request.

The request went out on the stream, so every reader shows a live question. No
pending input batch was ever persisted for it. The session state carried into
the step that later received the answer holds only:

```
eve.harness.turnTrace, eve.harness.emission, eve.harness.turnUsage,
eve.agent.handles, eve.harness.reportedSessionUsage
```

No `pendingInputBatch`, in that step or any other step of the run
(`.eve/.workflow-data/steps/wrun_01M0G5H4…-step_*.json`, decompressed).

## What that does to an answer

The answer arrived intact. The step's own input blob holds:

```json
{"inputResponses":[{"requestId":"toolu_01LEvFHnEjYLW5dAevC2pr6V","optionId":"durable"}]}
```

With no pending batch to match, `convertStaleResponsesToUserMessage` treated it
as stale and folded it into the conversation as prose. The display message was
`durable` — the option **id**, which is that function's fallback when the
request cannot be recovered from history — and the model was told "the user
submitted the following response to an earlier interactive prompt… this does not
authorize an earlier action".

So the model reads the answer and carries on, and nothing resolves the request:
no `input.resolved`, ever. The session stays parked to every reader, each new
answer is stale-converted the same way, and the only thing that clears it is a
client that gives up and stops showing the question.

## What we would expect

Either of these closes it:

1. `input.requested` and the pending batch are written together, so a request
   that reaches the stream is always answerable — including one raised after the
   turn it belongs to was finalised.
2. Or a late request that cannot be parked is not published at all, and the
   straggling step's output is discarded with the turn it belonged to.

The failure mode to avoid is the current one: a request that exists on the
stream and nowhere else. A client cannot tell it apart from a real one, and the
answer it collects has nowhere to land.

## What hex does about it meanwhile

Containment only, in `src/eve/serve.ts` and `src/eve/transcript.ts`:

- After the turn an answer starts has ended with no `input.resolved` for it, hex
  closes the request itself and publishes `input_resolved` with what was
  answered (`EveTranscript.settle`, called from `EveServer.reconcile`).
- A `cancel`, `clear` or `reset` closes every question still open on that
  session with outcome `cancelled` (`EveTranscript.abandon`).

Neither makes the answer reach the model as a structured resolution. They stop a
dead question outliving the run that asked it.
