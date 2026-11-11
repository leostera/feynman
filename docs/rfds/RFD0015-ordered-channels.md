# RFD0015 - Ordered channels

- Feature Name: `ordered`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-11-11`
- Updated: `2026-11-11`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

A message can say it travels on a connection that keeps order:

```ts
const Choose = defineMessage("Choose", { seat }, { over: "websocket", ordered: true });
```

Of the ordered messages one instance sends another, of every kind, a step takes only the
oldest still in flight. A loss takes any of them and leaves the rest in order. Everything else
is as before: messages in flight are a bag, and any may arrive next (RFD0004).

## Motivation

Feynman reorders everything. That is right for separate requests, and wrong for one TCP
connection, one WebSocket, or a queue with one partition and one consumer. A spec of a
system that relies on that order can't say so, and gets counterexamples that can't happen:
the alternating bit protocol, correct on the FIFO links it was designed for, "breaks" in
six events; a client whose writes go over one socket sees its first write win.

Authors work around it with sequence numbers the code does not have, or by reading the
messages ahead of one in a `when`, which the step cannot see. Both model a different system.
P orders messages between two machines, and TLA+ specs keep a sequence per channel. Feynman
should be able to say what they say.

## Goals

- One declaration on the message, in the system's terms: it goes over a connection that
  keeps order.
- The semantics of a lossy FIFO channel: order kept, any message may be lost.
- The same worlds as the reference explorer, TLC and P on the same systems.
- No cost to specs without ordered messages.

## Non-goals

- Connections that drop and reconnect, where messages on the new one overtake the old's.
  A spec says that with two instances, or a message that is not ordered.
- Duplication on an ordered channel. TCP does not duplicate; queues that redeliver do not keep
  order either. `duplicate` and `ctx.forward()` on an ordered message are errors.
- Order across channels, or causal order.

## Reference-level explanation

### Semantics

- A **channel** is a sender and a receiver: two instances, as a connection is between two
  processes. All ordered messages from one to the other share it, whatever their kind.
- An ordered message is **behind** when an older ordered message on its channel is still in
  flight. Older means sent earlier: pending ids grow with every send.
- A step on a message that is behind can't take it, unless the step says `outOfOrder: true`.
  `lose` does: a loss takes any message, and leaves the rest in order.
- `ctx.forward()` of an ordered message is an error: back in flight, it would arrive behind
  the ones sent after it. `duplicate` is built on it. A step that must wait says so with a
  `when`, and the channel waits behind it (head-of-line blocking).
- A crash that orphans calls (RFD0009) changes them where they are, so they keep their place.
- Fairness is unchanged. A message that is behind is not enabled, so weak fairness does not
  ask for its delivery until it reaches the front.

### Where it lives

- `Message.ordered`, `MessageInfo.ordered`, `Pending.ordered` (set on send), and
  `TransitionInfo.outOfOrder`.
- The engine: `aheadOf(world, pending)`. `stepsTaking` leaves only `outOfOrder` steps for a
  message that is behind, and `fire` refuses the rest. The reference explorer, random runs,
  the playground and scenarios all go through it.
- The integer core keeps messages in send order already. `choicesOf` marks each channel as it
  meets its first message, and offers only `outOfOrder` steps for later ones. A reset's
  changes replace messages where they are (`Effect.replaces`).
- Fingerprints add, for each channel, a hash of its messages in order, summed over channels,
  which are in no order (`queueLanes`). Under symmetry, each renaming hashes the renamed
  lines in the same order. Specs without ordered messages skip it, and keep the incremental
  fingerprint; with them, a child's fingerprint is worked out from its vector.
- World keys (keys.ts) make one line per channel, in order.

### Invariants

- Two worlds with the same messages in flight, in different orders on some channel, are
  different states; in different orders only across channels, or only among messages that
  are not ordered, they are one.
- The vector's message order is the engine's pending order on every channel.

### Rollout and validation

- `test/check/ordered.test.ts`: reordering against keeping order, a loss of the message
  behind, channels per pair, forward and duplicate refused, a scenario refused, a crash
  that orphans a call ahead of a plain message, symmetry, world keys, and the declaration
  errors. Each search also matches the reference explorer, world for world and state for
  state.
- The fuzzer orders the messages in 40% of its seeds. The reference explorer's world key keeps
  each channel's order its own way, and the fuzzer now also checks the checker's state count
  against the worlds it reached. Ignoring order, letting messages overtake, and one channel
  for all are each caught.
- Oracles: `ordered-writes` against TLC, in which [a,b,a] and [b,a,a] are the same bag in
  two orders; a checker that ignores order fails it. The alternating bit protocol with one
  bit, on a link that reorders (broken) and an ordered one (holds, with a loss), against TLC
  and P. P's model routes through its own ordered network.
- Book: chapter 8, steps 6 and 7.

## Drawbacks

- A message's order is part of its definition, so a spec where one message goes over a
  connection and over a request needs two messages.
- Specs with ordered messages lose the incremental fingerprint, and pay for hashing each
  child's vector.

## Rationale and alternatives

- **Order on the channel, not the message kind.** TCP orders everything on a connection: a
  per-kind FIFO would let a `Commit` overtake the `Prepare` before it.
- **Order on the actor pair, declared once.** A connection carries some messages and not
  others (HTTPS beside a WebSocket), and the message is where the spec says how it travels
  (`over`).
- **A loss only of the oldest.** Real connections lose whatever was in flight when they drop;
  any-message loss is the lossy FIFO channel of the literature, which includes it.
- **Put forwarded messages back at the front.** It would keep order, but `duplicate` would
  then make a copy arrive twice in a row at its place, which no FIFO network does.

## Prior art

P's per-machine-pair FIFO queues; TLA+ channels as sequences (`Append`, `Head`, `Tail`);
Lynch's lossy FIFO channels; SPIN's buffered channels.

## Future possibilities

- A connection as a value, so a reconnect can start a new channel between the same instances.
- A count of how often an ordered channel's head blocks the rest, for performance specs.
