# RFD0007 - The search, shared among threads

- Feature Name: `parallel-search`
- Status: Implemented
- Author: `leostera`
- Start Date: `2026-10-27`
- Updated: `2026-10-27`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

The checker's breadth-first search runs on several threads: the main thread plus worker
threads, up to one fewer than the machine has cores (7 at most). The worlds are split among
**owners**, one per thread. Each owner expands the worlds it holds, and the main thread
decides, in the order one thread would have taken, which of the new worlds are new states.
Worlds stay on the thread where they were made. Only 64-bit fingerprints and a few findings
cross between threads.

The result is the same however many threads there are, down to the counterexample paths.
On searches of 20,000 to 130,000 states it is 1.9–2.9× faster on 8 performance cores.

## Motivation

The checker was single-threaded. A spec with a few hundred thousand states took tens of
seconds, and nearly all of that was generating successors: running every step from a world,
applying it, and keying the result. Generating successors is about 35–95 µs per state on the
corpus, while deciding whether a successor is new takes 1–2 µs. Generating is the work to
share.

## Goals

- One engine: the same code runs on one thread or many, so tests on one thread cover it.
- The same report on any number of threads: states, verdicts, counterexamples, stuck worlds,
  coverage and reductions.
- Keep everything the single-threaded search did: sleep sets with revisits, the inputs
  reduction, symmetry and its tests, `never` memory, `everyStep`, stuck worlds, liveness with
  closing at the depth bound, seeds, `maxStates` and `timeLimit`.
- No cost on small specs, which are most specs.

## Non-goals

- Distributed checking across machines.
- Parallel random runs, and checking several specs at once. Both are simpler and can come
  later.
- Speeding up a single thread (see the earlier measurements in Rationale).

## Guide-level explanation

Nothing changes in how specs are written. `feynman check` uses worker threads when a search
is big enough to share; `--workers N` (or `check: { workers }` in the config) sets how many,
and `--workers 0` keeps it on the main thread. The summary line says `on 8 threads` when
workers took part.

Workers load the spec by path, since specs hold functions, which cannot be sent between
threads. The CLI hands them the bundle it already made of the spec file. Code that calls
`check` with a spec object and no source runs on the main thread.

## Reference-level explanation

### Owners and the coordinator

An owner (`src/check/owner.ts`) holds nodes: a world, the budget spent getting there (actions
repeated, faults), its depth and root, its sleep set, and the events on the way there when a
`never` property reads them. The coordinator (`src/check/search.ts`) holds, for every node,
its parent, root, depth, faults, which of the parent's options led to it, which owner holds
its world, and whether it is a shadow. It also holds the fingerprint of every state seen
(`src/check/prints.ts`, open addressing over typed arrays).

The search goes one depth level at a time, in rounds:

1. **Prepare.** Each owner keeps the successors the coordinator found new, under the node
   ids it gives them. For each, it reports whether the node is stuck, and (for liveness)
   which predicates hold there. It then wakes the steps a revisit asked for, and hands nodes
   over to even out the frontier.
2. **Expand.** Each owner expands its share of the frontier. For each successor it reports
   its fingerprint, which option of its world it is, flags (failed, fault, sleep set not
   empty), and the properties it breaks, of those not yet known broken. For liveness it also
   reports fair identities and the fair steps possible.
3. **Merge.** The coordinator goes through the successors in frontier order, as one thread
   would, and decides which are new, which land on a known state, which break a property
   first, and which become shadows.
4. **Query**, only when needed. A successor that lands on a state with skipped steps needs
   both sleep sets to work out which to wake. A successor that lands on a renamed twin is
   used to test the symmetry claim: both worlds must have the same next steps. The
   coordinator asks the owners holding them.

Counterexamples are paths of option indices. Each is resolved to choices by the owner holding
the world each step is taken in, then replayed on the main thread.

### Fingerprints

States are remembered by a 64-bit wyhash of their key text, as TLC remembers them. Two
states share a fingerprint with odds of about n²/2⁶⁵, for n states: one in 36 million at a
million states. Step names in sleep sets and fair identities are 52-bit hashes. Those are only ever compared
within one state's sleep set, or among the fair steps of one component, so a collision is
far less likely still.

### Same result on any number of threads

Results depend only on the order of the merge, which is frontier order. That order depends
only on earlier merges, never on which owner holds what. Owners skip reporting what is
already broken, but only where skipping cannot change who broke a property first:

- A step that breaks a step property, or fails, always gets a node, so an owner's first
  report of one is never discarded; after it, the owner skips that property or error.
- An `always` or `never` finding counts only on a new state, which only the coordinator
  knows. Owners keep reporting those until the coordinator says the property broke.

### Sleep sets, level by level

Every node in a level is expanded with the sleep set it had when the level began. Revisits
found while merging a level apply before the next one. A node not yet expanded just loses
the woken steps; a node expanded before gets an entry for the woken steps only. The single
thread interleaved this within a level, so node numbers can differ from the old engine's,
but the states reached and the counterexample lengths are the same. The corpus and the
reference explorer check both.

### Workers joining

The main thread's owner works alone until a frontier reaches 256 nodes. Then the workers
start, loading the spec; while they start, the coordinator yields to the event loop once a
round so their replies arrive. When they are ready, the next round's balancing hands them
nodes. A node is handed over by copying its world, budget, sleep set and trail: about 10 µs,
against 35–95 µs to expand it. Only nodes made in the last round move.

### Interfaces

- `check(spec, bounds, seeds, { source, pool, watch })` returns a promise.
  - `source` (`{ module, export?, properties? }`) is where workers load the spec.
  - `pool` keeps worker threads warm across checks; the CLI uses one for every spec and for
    the checks at fewer faults.
  - `watch` sees every state, and keeps the search on the main thread.
- `Bounds.workers` sets the number of worker threads.
- `Report.threads` says how many threads took part.
- `Report.states` counts distinct states. Shadows are not counted.

### Validation

- **Same report on any number of threads.** `test/check/parallel.test.ts` checks that one
  thread and four give equal reports on:
  - lost update, buggy with a fault: a broken property and a stuck world;
  - or-set, with every reduction and symmetry on;
  - two-phase commit, fixed with a fault: liveness with a loop;
  - leader election, buggy: liveness;
  - or-set with a fault, plain.

  A benchmark run also compared full reports on the larger models with 0, 2, 4 and 7
  workers: all were equal.
- **The full corpus, on the new engine.** The reference explorer's state-for-state
  comparison, all 62 cases, and the TLA+ oracles' distinct-state counts against TLC all
  pass.

### Measurements

These are times on 8 performance cores plus 4 efficiency cores, with other work running on
the machine. Each speed-up is the best time over the single-thread time.

| Model | States | 1 thread | 3 threads | 5 threads | 8 threads |
|---|---:|---:|---:|---:|---:|
| lost update, buggy, 1 fault | 22,799 | 505 ms | 266 ms | 266 ms | 375 ms |
| read repair, fixed, 1 fault | 37,309 | 1,524 ms | 703 ms | 1,155 ms | 846 ms |
| or-set, fixed | 39,568 | 2,128 ms | 838 ms | 749 ms | 846 ms |
| or-set, fixed, 1 fault | 129,242 | 6,763 ms | 3,280 ms | 2,616 ms | 2,674 ms |
| the same, with sleep sets and symmetry | 129,242 | 6,761 ms | 2,816 ms | 2,308 ms | 2,288 ms |

That is 1.9–2.9× faster. Memory for the 129k-state search grows from 0.87 GB to 1.2 GB.

On one thread the new engine is within noise of the old one: 2.5–3.0 s for the corpus,
against 2.5–3.0 s. Every corpus case stays on one thread, below the joining threshold.

## Drawbacks

- `check` became asynchronous.
- Fingerprints admit a tiny chance of merging two states. The old engine compared whole keys.
- Specs must load the same way on every thread, and behave the same there: deterministic,
  which specs already had to be.
- Memory: each worker has its own caches, so a big search takes about 40% more.

## Rationale and alternatives

### Proposed design

Fingerprints and successor indices are small, so the threads exchange kilobytes per round,
not worlds. A world is about 0.6–0.9 KB, and copying one between threads costs 8–10 µs.

### Simpler or narrower approach

- **Send every successor's world to the main thread.** Copying would cost as much as
  computing, and most successors are states already seen.
- **Fingerprints alone, without threads.** This was measured first. It was 5–10% slower,
  because the cost is in building key text, not comparing it. Here, fingerprints pay off
  only because they shrink what crosses threads.

### Other alternatives considered

- **Testing symmetry claims less.** That was a 20–29% gain on the corpus, now
  `--symmetry-checks`.
- **Work stealing within a level.** This would help the uneven levels. It needs nodes to
  move mid-round, so it is left for later.

### Do nothing

Big specs stay single-threaded: 2–3× slower than they could be.

## Prior art

- TLC: 64-bit fingerprints, and a breadth-first search with workers sharing one fingerprint
  set and one queue of states. TLC's worlds are values it can share, while ours hold
  functions, which is why worlds stay with their owners here.
- SPIN's swarm and multicore modes, and distributed fingerprint sets in Murφ. Both partition
  states by hash, which needs worlds to move to their owner; that is the cost avoided here.

## Unresolved questions

- Balancing within a level, rather than only between levels.
- How many threads to use by default on machines with efficiency cores: here 4 and 7
  performed about the same.
- Parallel random runs, and checking specs in parallel in `feynman check`.

## Future possibilities

- Liveness judged on a symmetric graph, shared the same way.
- A disk-backed fingerprint set for searches beyond memory.
