# RFD0008 - The integer core

- Feature Name: `integer-core`
- Status: Draft
- Author: `leostera`
- Start Date: `2026-10-28`
- Updated: `2026-10-28`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

The checker's search runs on integers. A world is a short `Int32Array` of interned ids, and
every local step runs through the engine once. After that, the step is replayed from a cache
as integer edits. Fingerprints are sums of per-part hashes, updated per step. This is the
**integer core** (`src/check/integer.ts`). It is now the checker's engine, and it gives the
classic search's report exactly. On one thread it is 5–13× faster than the classic search
with its reductions, and 4–5× faster than the classic search on four threads.

This RFD records what was built. It proposes the rest:

- make the integer core parallel;
- delete the classic search and its reductions;
- settle how symmetry treats the action budget.

## Motivation

The classic search spent about 99% of its time on machinery and about 1% in spec code. The
machinery was copying, freezing, writing out and hashing whole worlds of JS objects. Yet
99.5–99.9% of handler calls repeat a local step made before: the same instance, in the same
state, taking the same step with the same argument (research note
`personal/feynman/checker-performance`; `bench/local-steps.ts`).

TLC takes about 3.0 s on or-set-fault, where the classic search took 4.8 s on one thread.
Explicit-state checkers that go fast intern their states and keep fingerprints, not worlds
(TLC, LTSmin's tree compression, SPIN). The integer core does the same in TypeScript.

## Goals

- The same report as the classic search without reductions, on every spec. That means the
  same states, verdicts, counterexamples (event by event), liveness loops, stuck worlds,
  errors and coverage, and the same symmetry folding, twin checks and refutation.
- Every feature of the checker on one engine: `always`, `never` with memory, step
  properties, liveness with closing at the depth bound, symmetry, scenario seeds whose
  instances differ, `maxStates`, `timeLimit` and `watch`.
- Then the parallel search of RFD0007, on the integer core, with a result that does not
  depend on the number of threads.

## Non-goals

- Changing what a state is. The key stays the classic one (keys.ts): an unordered bag of
  messages, timers oldest first, sorted object keys, and the budget and `never` memory.
- Rust or WASM. They are the next step, once the representation has settled (see Future
  possibilities).

## Guide-level explanation

Nothing changes in how specs are written, or in what `feynman check` reports. Searches are
faster. `engine: "classic"` in `check()`, or `FEYNMAN_ENGINE=classic`, runs the classic
search until it is deleted.

## Reference-level explanation

### What is built (implemented)

**The vector.** A world's vector is laid out as:

`[state id per instance | faults | actions taken per (instance, action) | fresh id | rng | memory | message count | message ids | timer ids]`

- Instance states are interned by their key line (`id=json`, as keys.ts writes it). Pending
  entries are interned by keys.ts `pendingText`. `fresh` and `never` memory are interned as
  text.
- Messages are kept in the order they were sent, and so are timers. Choices then come in the
  classic order (`pendingInOrder`), and the first counterexample found is the same one.
  Messages count as a bag only in the fingerprint.
- There is one layout per set of root instances (by sorted id, as the classic key sorts
  instances). Root fingerprints are tagged with their layout. Scenario seeds that spawn
  instances get a layout of their own.

**The step cache.** It is keyed by:

- the instance's state id;
- the list of its own timers (start, cancel and restart read them);
- the step with its argument: a message or timer by its intern id, or an action with its
  inputs.

It stores the new state id, the message and timer ids removed and added, and the trace step
(actor, key, error, sent). Some steps depend on more than the key. A step that reads another
instance's state, or hands out fresh ids or random numbers, is run through the engine every
time; the engine's `Observation` says which steps do.

**Fingerprints** use two 32-bit lanes. Each is a sum of a hash per part: each header
position with its value, each message in the bag, and one hash of the timer order. A child's
fingerprint is the parent's, with the changed parts taken out and put back. Its vector is
built only when the fingerprint is new, or when a step property or symmetry needs it.

**Nodes** keep a parent, a choice name, faults and depth, and nothing else. Paths are
replayed on real worlds when a report asks for them. A choice is named by its content
(instance, key, inputs, or a pending entry's intern id), so it can be found again in a
world whose pending ids differ.

**Properties:**

- **`always`** is judged on each new state.
- **`never`** memory (owner.ts `memoryOf`) goes in its header slot. A path's trace steps
  come up the parent links, as the classic trails do.
- **Step properties** are judged on materialised worlds. A step property broken on the way
  to a known state gets a shadow node, as `Search.land` gives one.

**Liveness.** The integer core keeps:

- the edges;
- the fair steps enabled in each expanded node;
- which liveness predicates hold in each state.

It closes the nodes at the depth bound as `Search.close` does, and resolves lasso steps on
replayed worlds. `judgeLiveness` reads it through the same `Graph`.

**Symmetry.**

- *The fingerprint.* Up to symmetry, a fingerprint is the least, over the renamings, of the
  renamed world's fingerprint. The renamed world maps state and pending ids to their
  renamed key lines, cached per renaming. The budget and memory stay as they are, as the
  classic key has them. Renamed twins share one set of renamed worlds, so they share the
  least one.
- *Twin checks.* These run inline on the first `symmetryChecks` twins met, in the order met,
  with the shared `successorsPrint`. A refuted claim searches again without symmetry.

**Reductions.** The integer core does without sleep sets and the inputs reduction. With the
step cache, the work they save is cheap, and it is faster without them than the classic
search with them.

### Same result as the classic search

`test/check/integer.test.ts` runs every case below through both engines and compares the
whole reports, except the clock:

- every corpus case;
- every corpus case with symmetry on;
- every corpus case from its scenario seeds (five examples have seeds with other instances);
- 80 generated specs from the fuzzer (`never`, step properties and liveness, half of them
  with symmetry on).

The oracles hold the integer core to TLC and P. All 107 TLA+ and wild oracles pass, and all
97 P oracles pass. The full suite (787 tests) passes with the integer core as the default.

### Measurements

These were measured back to back on one machine with its load at 4–5, using `bench/models.ts`
bounds with safety properties.

| model | states | classic, reduced | classic, 4 threads | integer, 1 thread |
|---|---:|---:|---:|---:|
| or-set-fault | 129,242 | 4,918 ms | 1,959 ms | 449 ms |
| read-repair | 37,309 | 1,384 ms | 779 ms | 123 ms |
| or-set | 39,568 | 1,114 ms | | 136 ms |
| leader-election | 35,694 | 782 ms | | 105 ms |
| lost-update | 22,799 | 379 ms | | 74 ms |
| two-phase-commit | 6,126 | 136 ms | | 18 ms |

With symmetry on, the integer core is 1–4.6× faster. Its symmetric fingerprint is
recomputed in full for each child, over every renaming. That is the next thing to profile.

### Proposed: one search, on threads

The integer core is single-threaded. Parallelism is what the classic search still has and
the integer core lacks. The design keeps RFD0007's shape:

- an owner per thread;
- worlds stay where they were made;
- the coordinator decides which successors are new, in frontier order, so the result does
  not depend on the number of threads.

The part that does not carry over is identity. Intern ids are per thread, so a fingerprint
made of them means nothing on another thread. The change:

1. **Content-hashed parts.** Each interned value keeps a 64-bit hash of its key text,
   computed once when it is interned. Fingerprints sum those hashes rather than the ids, so
   a fingerprint is the same on every thread. The cost is one hash per intern miss: about
   2,500 misses against 500,000 hits on or-set-fault.
2. **Owners** each hold their own interners and step cache. They expand frontier entries
   and send back fingerprints, choice indexes, flags and findings (RFD0007's `Expansion`),
   with no worlds.
3. **Moving nodes** between owners sends the vector as key lines, re-interned on arrival.
   That costs more than RFD0007's world moves only by the text. It happens only when
   balancing, which RFD0007 already limits.
4. **Liveness edges, twin checks and path replays** stay on the coordinator. They need only
   fingerprints, parent links and replay, as now.

### Proposed: delete the classic search

Once the integer core is parallel, the classic search has nothing left to give. Deleting it
removes:

- `search.ts`, `owner.ts`, sleep sets with revisits, and the inputs reduction;
- the `reduce` bound;
- `engine`;
- `Report.reductions.orders` and `.inputs`.

`symmetric` and `refuted` stay. The tests that compared the reductions with the plain search
go too:

- in `examples.test.ts`, the reduced-search and folded-search comparisons;
- in the fuzzer, the sleep-set checks;
- in `check.test.ts`, the reduction tests.

The integer core keeps its two independent judges: the reference explorer
(`test/check/reference.ts`) in the fuzzer, and TLC and P.

## Drawbacks

- Symmetric searches gain less, until the symmetric fingerprint is made incremental or
  cheaper.
- Until the classic search is deleted, there are two engines to keep in step. The
  both-engines test makes drift loud, but it is still two.
- Nodes keep no worlds, so anything that needs a node's world replays its path. That costs
  O(depth). It happens only for reports, twin checks and lasso steps.

## Rationale and alternatives

### Proposed design

Interning and a step cache attack the 99% of the time spent on machinery, and keep the
engine as the only thing that runs spec code. Matching the classic search exactly let every
existing test and oracle judge the change.

### Simpler or narrower approach

- **Cache steps inside the classic search.** Most of the cost is copying and keying whole
  worlds. A step cache does not remove that.
- **Keep the classic search for threads only.** That means two engines for good, and the
  integer core on one thread is already faster than the classic search on four.

### Other alternatives considered

- **Rust or WASM first.** That would port a representation still being found. Get the
  representation right in TypeScript, then port the integer loop.
- **SMT or symbolic checking (Apalache).** Not a fit for specs that are JS handlers.

### Do nothing

The checker stays several times slower than TLC on the same models.

## Prior art

- **TLC:** fingerprints only, with the states written to disk; parallel workers share one
  fingerprint set.
- **LTSmin:** tree compression of state vectors, and `--cache` for transition groups, which
  is the step cache's idea.
- **SPIN:** state vectors and bitstate hashing.
- **Stateright:** fingerprints of Rust values, with symmetry by representative.

## Unresolved questions

- **Should symmetry rename the action budget?** The classic key renames the world, but not
  the budget of actions taken per instance. Classes of states are then not closed under
  renaming, and the count depends on exploration order. Lost-update with symmetry has
  11,848 states with the classic sleep sets and 13,613 without them; the integer core
  matches the latter. Renaming the budget would make the folding exact and order-free, but
  it changes state counts.
- **How should a fingerprint collision be reported,** if ever? (The classic search does not
  report them either.)
- **When should workers join?** RFD0007's threshold (256 frontier entries) was tuned for the
  classic search, whose steps cost 30–90 µs. Integer steps cost 1–4 µs, so it will need
  tuning again.

## Future possibilities

- **An incremental symmetric fingerprint:** a canonical slot order kept per class, rather
  than every renaming per child.
- **The integer loop in Rust or WASM,** calling into JS only on a step-cache miss.
- **Bitstate (SPIN) or disk-backed fingerprint sets** for searches past memory.
