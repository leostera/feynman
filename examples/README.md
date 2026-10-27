# Examples

Small, well-known distributed systems as Feynman specs. Each comes buggy and fixed, with the
verdicts the checker must reach worked out by hand in the file's header: which property
breaks, and the length of the shortest counterexample.

Each file's default export is the buggy variant, so checking it shows the checker find the
bug; `fixed` is exported beside it. From the repository root:

```sh
bun run feynman check lease-lock   # ✗ fenced, with the 10-event trace that breaks it
bun run feynman dev                # every example in the simulator
```

| Spec | The bug | What it exercises |
| --- | --- | --- |
| `payments.ts` | Retries without idempotency debit twice, with no fault at all | timers racing the network, durable state |
| `two-phase-commit.ts` | A coordinator deciding on the first vote; 2PC blocking on a lost vote | symmetry, action inputs, faults |
| `lease-lock.ts` | A stalled lock holder's write lands after the next holder's | a lease as an `expire` timer racing a stall, fencing tokens |
| `cache.ts` | A stale fill overtaking an invalidation | `eventually`, a lost message versions cannot fix |
| `leader-election.ts` | Adopting the last leader heard instead of the highest | a false symmetry claim the checker must refute |
| `job-queue.ts` | Redelivery doing a job's side effect twice | `never` over the trace, guarded transitions |
| `alternating-bit.ts` | The alternating bit protocol over a network that reorders: a stale copy passes for the next item | retransmission timers, a protocol correct only on FIFO links |
| `outbox.ts` | An announcement queued in memory, lost when the shop restarts after storing the order | guarded transitions draining durable state, restarts |
| `raft-vote.ts` | A vote not kept on disk: a node restarts, votes again in the same term, and two nodes lead | durable state, restarts |
| `write-skew.ts` | Two doctors each check the other is on call, then both leave | check-then-act across messages, an atomic conditional write |
| `dining-philosophers.ts` | Each philosopher starts with a different fork: each holds one and waits for the other | requests that queue, a deadlock as a safety property |
| `ricart-agrawala.ts` | Equal timestamps counted as "not mine first": both nodes answer each other and both go in | Lamport clocks, deferred answers; the fix also needs a durable clock and answers that name their request |
| `token-ring.ts` | A resent token crossing a slow first copy: two nodes hold the one token | a ring, resends until acknowledged, counting hand-overs |
| `chang-roberts.ts` | Leading on beating a smaller id instead of on one's own id coming back: two leaders | ring election by comparing ids |
| `barrier.ts` | A coordinator counting arrivals, not workers: one restarts, arrives again, and the barrier opens early | durable state, restarts, counting by identity |
| `primary-backup.ts` | The primary acknowledges a write before the backup has it | replies sent before the step that makes them true |
| `read-your-writes.ts` | Reading from a follower that has not caught up: the client misses its own write | session guarantees, requests held until state catches up |
| `quorum.ts` | Writing to two replicas of three and reading from one: R + W = N, and a read misses a finished write | quorum intersection, messages to every instance |
| `chain-replication.ts` | Reading from the head, then the tail: a value goes back in time | monotonic reads, an input that picks the instance to ask |
| `log-replication.ts` | A follower appending whatever entry arrives: the second overtakes the first and the logs differ | ordering by index, catching up by asking |
| `lww-register.ts` | Last-writer-wins without a tie-break: two writes stamped alike, kept in different orders, and the replicas never agree | convergence as a safety property, total orders; a lost write needs anti-entropy |
| `g-counter.ts` | A counter merged by its larger total: increments made at the same time are lost | state-based CRDTs, merges that keep what both sides know |
| `or-set.ts` | A replicated set racing an add against a remove; the textbook OR-Set fix, which assumes causal delivery, still breaks when a remove overtakes its add | operation-based CRDTs, tombstones, what a protocol assumes of delivery |
| `idempotent-consumer.ts` | A consumer that remembers the jobs it did only in memory: a restart and a redelivery charge twice | at-least-once delivery, idempotency keys, durable state, timers |
| `switch.ts` | "On" twice, through a world that is back where it started | what a `never` property remembers of the path |

`test/examples/examples.test.ts` checks every case five ways: the plain search finds exactly what was
worked out by hand; counterexamples replay; the reductions and symmetry reach the same
verdicts with counterexamples as short; and random runs alone find every bug. When a
verdict here disagrees with the header, find out who is wrong before changing either: so
far it has been the spec three times and the checker twice.

## Oracles

`oracles/*.tla` are independent TLA+ models of the same systems, written to Feynman's
semantics: the network is a bag and any message in it may go next, a fault loses one or
restarts an instance, and each instance takes each action at most `Repeats` times. Systems
that never run out of things to do get a `steps` counter, bounded by `Depth`, and a `VIEW`
that leaves it out, so TLC merges states as the checker does: the first time, at the
smallest depth.

`test/examples/tla.oracle.ts` runs TLC on every configuration and checks that the checker reaches
the same distinct states (its worlds projected onto the TLA+ variables: no ids),
the same verdict on every invariant, and counterexamples just as short. It needs Java and
`tla2tools.jar` (the TLA+ Toolbox has one; or set `TLA_TOOLS_JAR`), and is skipped without.

### P

`oracles/p/` models some of the systems in P (see `test/examples/corpus.ts`). P delivers each machine's messages in order, so every message goes through a
`Network` machine that holds a bag and delivers (or, within the fault budget, loses) any
message in it; timers may fire at any moment once set, as the checker's may; a `Chaos`
machine restarts an instance at any moment, within the same budget. Properties are
monitors over announced events. P's checker runs seeded schedules rather than every state, so
`test/examples/p.oracle.ts` compares verdicts only: P breaks the property (with the property's
own assertion) exactly when the checker does. It needs .NET 8 and `dotnet tool install
--global P`, and is skipped without.

Run both kinds with `bun run oracles` (about two minutes); `bun run test` leaves them out.
