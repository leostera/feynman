# Examples

Small, well-known distributed systems as Feynman specs. Each comes buggy and fixed, with the
verdicts the checker must reach worked out by hand in the file's header: which property
breaks, and the length of the shortest counterexample.

| Spec | The bug | What it exercises |
| --- | --- | --- |
| `payments.ts` | Retries without idempotency debit twice, with no fault at all | timers racing the network, durable state |
| `two-phase-commit.ts` | A coordinator deciding on the first vote; 2PC blocking on a lost vote | symmetry, action inputs, faults |
| `lease-lock.ts` | A stalled lock holder's write lands after the next holder's | the clock (`ctx.now`), fencing tokens |
| `cache.ts` | A stale fill overtaking an invalidation | `eventually`, a lost message versions cannot fix |
| `leader-election.ts` | Adopting the last leader heard instead of the highest | a false symmetry claim the checker must refute |
| `job-queue.ts` | Redelivery doing a job's side effect twice | `never` over the trace, guarded transitions |

`test/examples.test.ts` checks every case five ways: the plain search finds exactly what was
worked out by hand; counterexamples replay; the reductions and symmetry reach the same
verdicts with counterexamples as short; and random runs alone find every bug. When a
verdict here disagrees with the header, find out who is wrong before changing either: so
far it has been the spec three times and the checker twice.
