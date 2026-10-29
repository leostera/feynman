# RFD0009 - Calls that fail

- Feature Name: `calls`
- Status: Draft
- Author: `leostera`
- Start Date: `2026-10-29`
- Updated: `2026-10-29`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

A message can be declared a **call**, with `call<P>({ name: "write" })` in place of `message`. When the
checker loses a call, or loses the reply to one, the message no longer vanishes silently.
Instead, the caller gets the call's **failure**, a transition keyed by `spec.failed(Write)`.
That is what happens to code that makes an RPC or a `fetch`: the call throws.

The caller can't tell a lost request from a lost reply, and neither can its transition. A
failure after a lost reply means the callee *did* apply the call. So the transition the
caller writes to retry is exactly where "the retry applies it twice" bugs live. Feynman
explores both cases, within the same `--faults` budget.

## Motivation

Today, every message the checker loses is lost silently, and the sender hears nothing. That
models a datagram, a message queue or a stream. It doesn't model the most common way
services talk to each other: RPC, `fetch`, and Durable Object stubs. There, a failure always
reaches the caller, as an exception, an error status or a closed connection.

In practice, the gap shows up as a counterexample that ends with someone waiting forever.
One session modelling a key-routed Durable Object library hit it in both of its specs:

1. **Spec 1.** `callsFinish`, "a pending call eventually completes", was broken by one lost
   call that nothing resent. The agent replaced it with an `always` property that held
   almost by construction.
2. **Spec 2.** A lost write left the client waiting, and the checker reported the world as
   stuck. The agent declared every quiet world final. Its description admitted the gap: "in
   the code the caller gets an RPC error and retries".

Both workarounds hid the behaviour the specs were about. Spec 2 had a `noDoubleApply`
property, and the retry after a lost *reply* is the path that could break it. That path was
never explored, because the spec had no way to say "the call failed".

There is a workaround today, and it is now in the skill:
- put a timer on the caller, set with the send and cancelled by the answer;
- let the timer retry, as the code does.

It models a timeout, not a failure:
- **It fires with no fault.** The timer can fire while the request is still on its way, so
  the failure path is "needs no faults". Every counterexample through it says so, and the
  fewest-faults search can't tell normal operation from a lost call.
- **It is easy to get wrong.** The "cancelled by the answer" part is boilerplate on every
  call.
- **The reply can still arrive after the retry.** That's real for timeouts, but not for a
  call that threw because its reply was lost: that reply will never arrive.

## Goals

- A spec can say that a message is a call, and how its caller handles the call's failure.
- Losing a call, or its reply, delivers one failure to the caller. It counts as one fault,
  as a silent loss does today.
- The caller can't tell which of the two was lost.
- A world where a call is waiting can only end with the call's reply or its failure, as in
  the code.
- Both engines, the TLA+ and P oracles and the fuzzer cover calls. The integer core and the
  classic search keep giving identical reports.
- Counterexamples and the playground show the failure as its own event in the call's flow.

## Non-goals

- **Timeouts.** A call that takes too long is still a timer on the caller. This RFD is about
  failures the code is told about.
- **Distinguishing error kinds** (overloaded, reset, a 500). A failure is one event. A spec
  that cares about the kind can still model it in the callee, with its own reply.
- **Replies sent in a later step** (a handler that awaits a sub-call before answering). See
  Unresolved questions.
- **Reliable delivery.** A way to say "this message is never lost" is a separate change. See
  Rationale and alternatives.

## Guide-level explanation

### Declaring a call

A call is declared with `call` where a message would use `message`. It takes the same
options, so the messages list says which of them are calls:

```ts
import { call, defineSpec, message } from "@leostera/feynman";

messages: {
  Write: call<{ key: Key }>({ name: "write", over: "rpc" }),
  Ok: message<{ key: Key; value: number }>({ name: "ok", tone: "reply" }),
},
```

The callee handles `Write` as before and answers with `ctx.reply(Ok, …)`. The caller handles
`Ok` as before. It also handles the failure, which is keyed by `spec.failed(Write)` and
carries the payload of the call that failed:

```ts
transitions: {
  [Ok]: { description: "Gets the answer.", run: (s) => void (s.pending = null) },
  [spec.failed(Write)]: {
    description: "The call throws; the client retries it.",
    sources: ["src/client.ts#Client.call"],
    sends: [Write],
    run(s, failure, ctx) {
      ctx.send(ctx.the(Store), Write, failure.payload);
    },
  },
},
```

`failure` is `{ payload, to }`: what was sent, and to whom. There is no "lost" or "reply
lost" field, because the code has none.

### What the checker does

Within `--faults N`, for every call in flight, the checker also tries:

- **Losing the request.** The callee never sees it, and the caller gets the failure.
- **Losing the reply.** The callee has run, and its state changed, but the caller gets the
  failure instead of `Ok`.

Each costs one fault. Without faults, a call behaves exactly like a message today.

A caller that declares no failure transition for a call it sends is a spec error when the
spec is defined: "Client sends write, a call: handle its failure with
[spec.failed(Write)]". Every RPC caller has an answer for an exception, even if that answer
is "give up". The spec should say which.

### What readers see

A counterexample through a lost reply reads:

```text
   2  Store (Store)  write  {"key":"R"}  from Client
      Applies the write.
      rows.R: 0 → 1
      → Client: ok {"key":"R","value":1}
   3  Client (Client)  write failed  {"key":"R"}  to Store
      The ok to Client was lost: the call throws.
      The call throws; the client retries it.
      → Store: write {"key":"R"}
   4  Store (Store)  write  {"key":"R"}  from Client
      rows.R: 1 → 2
      ✗ breaks noDoubleApply
```

In the playground, the failure is an event in the call's flow, drawn as a refused message
from the callee back to the caller. The playground's fault controls gain "fail the call" on
a call in flight, and on its reply.

## Reference-level explanation

### Data model

- **`call<P>(def)`** is exported next to `message`, with the same options. It returns a
  `MessageDef<P>` marked as a call, and the registry entry keeps `call: true` next to `over`
  and `tone`. Everything that takes a message takes a call: `sends`, `ctx.send`, transitions
  keyed by it, `trace.count`.
- **`spec.failed(key)`** returns the transition key `failed:<message key>`.
  - `TransitionsFor` accepts `failed:${MessageKey}` keys, with
    `run(state, failure: { payload: PayloadOf<M, P>; to: Instance }, ctx)`.
  - It rejects a key for a message that is not a call, with the same kind of error as an
    unknown message.
- **Pending deliveries** gain an optional `call: { id, caller, message, payload }`:
  - the request carries it;
  - so does the reply its handler sends through `ctx.reply`.

  `id` is the call's identity: the pending id of the request, which the world already
  allocates.
- **A failure is a new pending kind**, `{ kind: "failure", to: caller, call }`. It is
  delivered like a message, fairly, and it shows in the world's in-flight list.
- **The integer core.** Failures get their own intern table (failure keys are distinct from
  message keys). A pending failure is one more kind of entry in the message section of the
  vector, so the layout doesn't change. Because the call tag is part of a pending entry's
  key, a request that is a call and one that is not are different entries.

### Semantics

- **A call's handler replies at most once.** A second `ctx.reply` in a call's handler is a
  spec error. A handler that doesn't reply ends the call: there is no reply to lose, so
  after it runs, the call cannot fail.
- **Losing.** `lose(pending)` on a pending with `call` set removes it and adds the failure
  for its caller, in one event (`kind: "lose"`, as today). That keeps `faultsIn` and the
  fewest-faults search unchanged. The event's description names what was lost and that the
  call throws.
- **Failures are never lost.** They happen in the caller's own process. `lose` doesn't offer
  them, and they don't count as a fault.
- **A restart of the caller drops its failures**, as it drops its timers. The promise that
  would have thrown is gone, along with its memory.
- **A restart of the callee** leaves requests in flight to it, as today. A spec that wants
  "the callee restarted mid-call" can restart it before the request is delivered, then lose
  the request. That is two faults, and honest about it.
- **Liveness.** A pending failure is delivered fairly, like any message. So with a failure
  transition that retries, `leadsTo` from "waiting" to "answered" can hold even under
  faults, provided the retry is fair. A failure transition that gives up makes the property
  break with a clear loop.

### Invariants

- With `--faults 0`, a spec with calls has exactly the states and verdicts it would have
  with `call: false`.
- Every loss of a call, or of a call's reply, leads to exactly one failure for that call's
  caller, unless the caller restarts first.
- A caller never receives both the reply and the failure of one call.
- Both engines give the same report: whole-report equality in `test/check/integer.test.ts`
  and the fuzzer.

### Compatibility and migration

Nothing changes for a spec without a `call`. Feynman is v0, so `call` lands without a
flag. The skill's timer workaround (from the change that added the lost-message hint) is
replaced by `call` in the "Faults" bullet.

### Rollout and validation

1. **Engine:** the classic search, then the integer core. `integer.test.ts` holds them to
   each other on a corpus with calls.
2. **Fuzzer:** generated specs mark some request messages as calls, with a failure
   transition that retries, gives up or ignores. `sameReport` covers them.
3. **Oracles.** Two new examples, as a buggy/fixed pair: a client that retries a call that
   isn't idempotent (buggy: double apply), and one with an idempotency key (fixed).
   - **TLA+:** `LoseCall(m)` removes the message and adds a failure to the caller's inbox,
     within the fault budget. The distinct-state count must match exactly.
   - **P:** the `Network` machine sends a failure event to the caller instead of announcing
     `eLost`, for calls. It must agree on every verdict.
4. **Views:** the failure event in the timeline, the flows and the Code view, and the
   playground's "fail the call".
5. **The skill:** "Faults" says when a message is a call (RPC, `fetch`, a Durable Object
   stub, a request on a connection that closes) and shows the retry pattern. The lost-message
   hint names `call` when the lost message isn't already a call.

## Drawbacks

- **More states.** Every call in flight gains a second way to fail (its reply) within the
  fault budget. Specs with many calls grow at `--faults 1`, though by less than the timer
  workaround, which can fire at any point with no fault at all.
- **A new pending kind** through the engine, both search cores, fingerprints, the views and
  the oracles. It's a cross-cutting change, even if each part is small.
- **One more decision per message.** A spec author must choose call or not. A wrong choice
  in either direction hides behaviour, though choosing "call" when it isn't one only adds
  failure paths.

## Rationale and alternatives

### Proposed design

Put the failure on the message, and handle it as a transition. That's where the code puts
it: the call site's `catch`. It keeps the failure an event that readers can see and that
properties can count (`trace.count`). Losing a reply has to be possible, because that is
where at-least-once bugs live.

### Simpler or narrower approach

**Keep the timer workaround, and document it** (done already, in the skill). It costs
nothing, but models a timeout rather than a failure. Failure paths need no faults, so the
fewest-faults ordering of counterexamples loses its meaning for every spec that uses it. It
also can't express that a reply which was lost will never arrive.

**A message that is never lost** (`lossy: false`). It's useful on its own, for in-process
queues, but it removes the failure path instead of modelling it. The double-apply bug
disappears from the search.

### Other alternatives considered

- **A flag on the message,** `message({ name: "write", call: true })` or `fails: true`. It
  works, but a call is a different kind of message, with a failure and at most one reply.
  Its own constructor says so where messages are declared, and keeps `message`'s options
  about how a message looks. `over: "rpc"` was rejected too: `over` is free text for
  readers, and shouldn't change behaviour.
- **`ctx.call(target, Write, payload)` instead of a message flag.** The sender chooses per
  send. It's more flexible, but the same message would sometimes be a call and sometimes
  not, and the callee's `ctx.reply` would need to know which. Rejected for now; it could
  come later if real specs need it.
- **A failure that says what was lost.** It's simpler to implement, but it lets the spec
  branch on information the code doesn't have. That would hide exactly the bugs this RFD
  is for.
- **Calls as two-phase steps,** where the caller blocks until the reply. That's closer to
  `await`, but it changes the event model: specs have no blocking today, and RFD0004
  depends on that.

### Do nothing

Agents keep meeting "waiting forever" counterexamples. They either weaken the property or
call every quiet world final, as the session above did twice. Specs of RPC systems miss the
retry-after-lost-reply path. That path is one of the commonest causes of duplicates in
production.

## Prior art

- **Jepsen** records an operation whose outcome the client doesn't know as *indeterminate*
  (`:info`). Its checkers have to allow both outcomes. A lost reply is exactly that, and
  Jepsen's experience is that most anomalies in client libraries come from how they retry
  indeterminate operations.
- **TLA+ specs** usually model a lossy channel with an explicit `Lose` action, and a failed
  RPC as a message from an "environment" to the caller. Our oracles will do the same, which
  keeps the state counts comparable.
- **P** makes sends reliable and models failure with explicit nondeterminism (failure
  injectors). The `Network` machine in the P oracles already plays that role.
- **Erlang's `gen_server:call`** turns a dead callee or a timeout into an exit in the
  caller. That's a failure the caller handles, not silence.

## Unresolved questions

### Before acceptance

- **The missing handler.** Should a call without a failure handler be an error (proposed)
  or a warning? An error is stricter, but every existing RPC spec gets louder the day it
  adopts `call`.

### During implementation

- **Replies sent in a later step.** A handler that awaits a sub-call and answers afterwards
  has no `ctx.reply` in its own step. One option is a call handle the callee keeps in its
  state, `ctx.answer(handle, Ok, …)`, tagged like a reply. Decide once there's a spec that
  needs it.
- **The playground's fault controls.** Where "fail the call" lives, given the existing
  drop control.

### Out of scope

- Error kinds and retry policies (backoff, `retryable`). Specs model those in their failure
  transitions.

## Future possibilities

- `lossy: false` for messages that are never lost.
- Per-call budgets: "this call may fail at most once", for specs where the fault budget is
  too coarse.
- A `feynman check` note when a spec's message is sent `over: "https"` or `"rpc"` but isn't
  a call: likely a model that loses requests silently where the code would throw.
