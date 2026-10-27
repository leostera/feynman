# RFD0006 - Temporal properties, with fairness

- Feature Name: `temporal-properties`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-10-27`
- Updated: `2026-10-27`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

Properties say what must hold of every step and of every infinite behaviour, the way TLA+
does, instead of what one fixed "left alone" run does. A spec states invariants of states
(`always`), of steps (`everyStep`) and of paths (`never`); and liveness as `eventually`,
`leadsTo`, `infinitelyOften` and `eventuallyAlways`. Which infinite behaviours count is set
by fairness: messages in flight and timers are weakly fair by default, a transition can be
marked weakly or strongly fair, and actions people take are never fair. The checker judges
liveness on the explored state graph, by looking for fair cycles that avoid the goal, and a
liveness counterexample is a path and a loop that repeats forever. The checker also reports,
without being asked, any world where the system is stuck: nothing can happen, and the spec
does not call final.

## Motivation

1. **`eventually` judges one schedule, not the system.** Today a liveness property holds if,
   from every reachable world, the system *left alone* gets there: the first enabled guard
   by name, else the least message in flight, else the oldest timer (`soloChoices` in
   `src/check/judge.ts`). That one run can loop where no fair behaviour would, which is a
   false alarm, or succeed where another fair schedule loops forever, which is a missed bug.
   Translating `DiningPhilosophers` from tlaplus/Examples one to one gave the same 58 states
   as TLC and the same safety verdicts, but:

   | | TLC | Feynman |
   | --- | --- | --- |
   | `NoStarvation`, strong fairness (as written) | holds | philosophers 2 to 5 starve |
   | `NoStarvation`, weak fairness | violated | philosophers 2 to 5 starve |

   Left alone always lets philosopher 1 eat first, so it eats forever. And because Feynman
   has no fairness, the two specs, which differ exactly in what TLA+ says about starvation,
   get the same answer.
2. **Real liveness properties have more shapes than one.** "Every request is answered"
   (leads to), "nobody starves" (infinitely often), "the replicas converge and stay
   converged" (eventually always), "the protocol terminates" (eventually, from the start).
   Of the 240 models in tlaplus/Examples, 73 check temporal properties; those that are not
   refinement appear to use these four shapes (to be confirmed while translating them).
3. **Properties of steps need ghost state today.** "A replica never goes back to an older
   version" needed a `highest` field that only the invariant reads
   (`examples/read-repair.ts`). It is a property of each step: compare before and after.
4. **Stuck systems go unreported.** A world where nothing can happen is reported only if
   some property happens to fail there. The buggy dining philosophers deadlock, each holding
   one fork; the checker finds it only because a property about meals fails.
5. **It unlocks wild oracles.** With fairness that maps one to one onto TLA+'s `WF` and `SF`,
   specs from tlaplus/Examples can be translated and compared with TLC on states, safety and
   liveness, which removes the main weakness of the current oracles: one author wrote both
   sides.

## Goals

- Liveness verdicts that agree with TLC on the same system and fairness.
- Four liveness operators, step invariants, and an automatic stuck check.
- Fairness that defaults to what a reader expects of a system and can be stated per step.
- Counterexamples a reader can follow: a path, then a loop that repeats forever.

## Non-goals

- Arbitrary LTL formulas, `until`, and `next` (`X` is not meaningful when other actors can
  step in between; `until` is a step invariant plus a leads-to).
- Refinement ("this spec implements that one"). It is the most common remaining `PROPERTY`
  in tlaplus/Examples, and a later RFD.
- Liveness on unfinished searches. A loop that runs into the depth bound proves nothing.
- Changing scenarios: `settle()` keeps its left-alone run, for showing.

## Guide-level explanation

### Properties

```ts
spec.defineProperties({
  // Of every reachable state.
  moneyAddsUp: { description: "…", always: (w) => w.the(Account).state.balance + w.the(Account).state.paidOut === 100 },
  // Of every step: the world before it, the world after, and the event.
  neverGoesBack: { description: "…", everyStep: (before, after) => after.all(Replica).every((r) => r.state.version >= before.instance(r.id).state.version) },
  // Of every path so far.
  doneOnce: { description: "…", never: (trace) => trace.count((e) => e.sent(Effect)) > 1 },

  // From the start, this happens at least once.
  terminates: { description: "…", eventually: (w) => w.the(Coordinator).state.decided },
  // Every time `whenever` holds, `then` follows.
  answered: { description: "…", leadsTo: { whenever: (w) => w.the(Client).state.asking, then: (w) => !w.the(Client).state.asking } },
  // This keeps happening, forever.
  nobodyStarves: { description: "…", infinitelyOften: (w) => w.all(Philosopher).every(…) },
  // From some point on, this always holds.
  converges: { description: "…", eventuallyAlways: (w) => sameValue(w.all(Replica)) },
});
```

Liveness properties are about infinite behaviours. A behaviour never has to end: when the
system stops, it stays where it is forever, so a property about the future is judged there
too. `eventually: done` fails if the system can stop before it is done.

### Fairness

A liveness property only means something once it is clear which behaviours count. A
behaviour where a message stays in flight forever, never lost and never delivered, is not
one a reader has in mind. Fairness rules such behaviours out:

| Step | Fair by default | Meaning |
| --- | --- | --- |
| Delivering a message in flight | weakly | it arrives, unless a fault loses it |
| Firing a timer that is set | weakly | it fires, unless cancelled or its instance restarts |
| A guarded transition (`when`) | weakly | if it stays possible, it happens |
| An action | never | people may stop acting at any point |
| A fault (loss, restart) | never | faults are bounded and adversarial |

A transition can say otherwise:

```ts
takeFork: { when: (s) => …, fair: "strong", run(s) { … } },
```

**Weakly fair**: a step that stays possible from some point on is eventually taken.
**Strongly fair**: a step that is possible again and again, even if not continuously, is
eventually taken. `fair: false` makes a transition unfair. These are TLA+'s `WF_vars(A)`
and `SF_vars(A)`, one to one.

### Bounded actions and why loops are made of system steps

The checker bounds how often each instance takes each action (`repeats`), and the counts
are part of a state. A loop therefore never contains an action: every infinite behaviour is
some actions, then the system on its own forever. That is the intent of today's "left
alone", stated precisely: once people stop, does the system get there under every fair
schedule?

### Stuck worlds

A world is **stuck** when nothing can happen: no action is possible (ignoring the `repeats`
bound, which is the checker's, not the system's), no guard holds, and nothing is pending.
The checker reports every stuck world that the spec does not call final, as a finding of its
own, like an error:

```text
✗ stuck: Plato holds fork one and waits for fork two; Kant holds fork two and waits for
  fork one. Nothing can happen. (5 events)
```

A system that is meant to finish says which worlds are final:

```ts
spec.defineFinalState({ description: "every job is acknowledged", when: (w) => w.the(Broker).state.unacked.size === 0 });
```

### Counterexamples

A liveness counterexample is a path to a loop, and the loop:

```text
✗ nobodyStarves: philosopher 2 never eats
  1–4  …
  then, forever:
  5    Plato takes fork one
  6    Plato takes fork two
  7    Plato eats and puts both forks down
```

The playground plays the path, then the loop, marked as repeating. When the system stops
instead of looping, the loop is that one world, staying put.

## Reference-level explanation

### Semantics

A behaviour is an infinite sequence of worlds, each step an event of the spec; a finite
path is extended by staying in its last world forever (stuttering). Properties mean:

| Property | Holds when, for every fair behaviour from an initial world | TLA+ |
| --- | --- | --- |
| `always: P` | every world satisfies P | `[]P` |
| `everyStep: R` | every step (w, e, w′) satisfies R | `[][R]_vars` |
| `never: T` | no prefix satisfies T | past-time safety |
| `eventually: Q` | some world satisfies Q | `<>Q` |
| `leadsTo: { whenever: P, then: Q }` | every world satisfying P is followed, at it or later, by one satisfying Q | `P ~> Q` |
| `infinitelyOften: Q` | worlds satisfying Q occur infinitely often | `[]<>Q` |
| `eventuallyAlways: Q` | from some point on, every world satisfies Q | `<>[]Q` |

A behaviour is fair when every step marked weakly fair that is enabled in all worlds from
some point on is taken infinitely often, and every step marked strongly fair that is enabled
infinitely often is taken infinitely often. A step is identified by its instance and its
key, and, for a delivery, by the message in flight: delivering one message is not delivering
another.

### Judging liveness

After exploring, the checker builds the graph of explored worlds and every edge between them
(including edges into worlds seen before, which the search does not keep today). Each
liveness property becomes a search for an **accepting fair loop**:

| Property | Accepting: a reachable loop, or a stuck world, … |
| --- | --- |
| `eventually: Q` | … reached from an initial world through ¬Q worlds, all of it ¬Q |
| `leadsTo` | … reached from a world satisfying P ∧ ¬Q through ¬Q worlds, all of it ¬Q |
| `infinitelyOften: Q` | … all of it ¬Q (this is `true ~> Q`) |
| `eventuallyAlways: Q` | … containing a ¬Q world |

and the loop must be fair. The search is the standard one (Emerson and Lei):

1. Restrict the graph to the worlds the property allows in the loop, and split it into
   strongly connected components (Tarjan).
2. A component is fair if every weakly fair step enabled in all its worlds is taken on some
   edge inside it, and every strongly fair step enabled in any of its worlds is taken inside
   it. A component that is unfair only for strong fairness may contain a fair part: remove
   the worlds where an untaken strongly fair step is enabled, split again, and repeat.
3. A stuck world is a fair loop of one world: nothing is enabled, so nothing is owed.
4. The counterexample is the shortest path to the component, then a cycle through it that
   takes every step fairness requires.

Faults are not fair steps, but they are edges: a behaviour may lose a message (within the
budget) and then loop. The fault budget is part of a world's key, so a loop never contains
a fault either.

### Bounds and the verdict

A component that contains a world at the depth bound, whose successors were not explored,
cannot be judged. If no accepting fair loop is found, but some candidate component touches
the frontier, the property is **unfinished**, not holding. The `Verdict` type already has
`unfinished` (`src/cli/verdict.ts`).

A world at the depth bound whose every step lands on a world already found has nothing past
it: the checker computes those steps too, and the world joins the graph. A space the bound
does not cut is then judged in full, as TLC would; only a space that keeps growing (retries
piling up copies in flight) stays unfinished.

Of the bad fair parts, the counterexample enters the one cheapest to reach: fewest faults,
then fewest steps, counting the search's path to where the region starts. The loop starts
by staying put and adds a detour only for each fair step it still owes, so it stays short.

### Reductions and symmetry

- The sleep sets that skip orders (`reduce`) drop edges a fair loop may need. Liveness
  properties are judged on a search without them; the checker runs it only when a spec has
  liveness properties, and safety keeps the reduced search.
- Symmetry folds renamings of a world into one. The folded graph preserves a property only
  if the property is itself symmetric; `nobodyStarves` is, "philosopher 2 eats" is not.
  Liveness is judged without symmetry at first (see Unresolved questions).

### Stuck worlds and final states

A world is stuck when `choices` (`src/spec/engine.ts`) returns no action whose `when` holds,
no guard, and nothing pending. The `repeats` bound is ignored: a world where every action
has used its repeats is not stuck, only unexplored. A stuck world that does not satisfy the
spec's final-state predicate (none, by default) is a finding, with the path to it. It is
reported as `stuck`, beside errors and broken properties, and fails `check`.

### Data model and interfaces

- `InvariantDef` (`src/spec/dsl.ts`) gains `everyStep`, `eventually` (from the start),
  `leadsTo`, `infinitelyOften` and `eventuallyAlways`; `after` + `eventually` is removed.
  `defineInvariants` becomes `defineProperties`.
- Transitions gain `fair?: "weak" | "strong" | false`.
- `defineFinalState({ description, when })` on the spec.
- `PropertyResult.counterexample` gains `loop: Event[]`; `then` (the left-alone tail) is
  removed. Reports gain `stuck: { events: Event[] }[]`.
- The checker keeps every edge, as pairs of node indices with the choice taken, and every
  enabled fair step per node, only when the spec has liveness properties.

### Compatibility and migration

Feynman is 0.x; this is a clean break, written up in the CHANGELOG's Migrating section.

- `after: P, eventually: Q` becomes `leadsTo: { whenever: P, then: Q }`.
- `eventually: Q` without `after` meant "left alone, from every world, Q", closest to
  `infinitelyOften: Q` or `leadsTo`; each use is rewritten by what it means.
- Specs that finish add `defineFinalState`. In the examples, two-phase commit, leader
  election, the alternating bit, raft vote, Chang–Roberts, the barrier, the quorum, log
  replication, the idempotent consumer and read repair all reach worlds where nothing can
  happen, and each is either a final state or a finding.
- `defineInvariants` is renamed to `defineProperties` outright, with no alias.

### Validation

1. The reference explorer (`test/check/reference.ts`) gains a naive liveness judge: every
   reachable lasso up to a small size, enumerated, checked for fairness directly from the
   definition. The checker must agree on every corpus case.
2. Wild oracles: specs from tlaplus/Examples with temporal properties, translated one to
   one (variables as one actor's state, actions as guarded transitions, `WF`/`SF` as
   `fair`). They must agree with TLC on distinct states, safety and liveness. First:
   `DiningPhilosophers` with strong and with weak fairness, `chang_roberts`, `ewd840`,
   `SpecifyingSystems/Liveness/LiveHourClock`, `allocator/SimpleAllocator`, `Prisoners`.
3. The existing oracles' liveness properties (the job queue's `jobsFinish`) are added to
   their TLA+ models as temporal properties, which TLC checks.

## Drawbacks

- Liveness costs a second search without reductions, and memory for every edge (TLC
  generates 174 steps for the dining philosophers' 58 states, so roughly 3 edges a state).
- Fairness is one more concept for a spec writer, though the defaults mean most specs never
  mention it.
- Loops are harder to read than a path. The playground needs a way to show "forever".
- Every spec with `eventually` changes.

## Rationale and alternatives

### Proposed design

It is what TLC does, restricted to the shapes specs use, so verdicts can be compared with
TLC directly, and the algorithm is a well-understood one over a graph the checker already
explores.

### Simpler or narrower approach

Keep left alone, and judge `eventually` on every schedule of system steps rather than one:
"from every world, all ways of leaving it alone get there". Without fairness that is too
strong (a message that is never delivered fails everything), and with fairness it is this
design.

### Other alternatives considered

- **Full LTL through Büchi automata** (SPIN, TLC's tableau): any formula, at the cost of a
  product construction and formulas readers find hard. The four operators cover the specs.
- **Random walks with fair schedulers** (P's approach, hot states at the end of long runs):
  finds liveness bugs often, proves nothing, and P's own oracles here needed it bounded.
- **Bounded liveness** ("Q within k steps"): easy, but a different property, and k is
  arbitrary.

### Do nothing

Keep a liveness check that is neither sound nor complete, and that cannot express the
difference between weak and strong fairness.

## Prior art

- TLA+ and TLC: `[]`, `<>`, `~>`, `WF`, `SF`; liveness checked on the state graph after
  exploration.
- SPIN: never claims, weak fairness, acceptance cycles found by nested depth-first search.
- P: hot and cold monitor states, judged under a fair scheduler on long runs.
- Emerson and Lei, "Modalities for model checking" (1987), and Couvreur's on-the-fly SCC
  algorithm, for fair-cycle detection with strong fairness.

## Unresolved questions

### Before acceptance

Decided in review: a system that may stop says so with `defineFinalState`; any other stuck
world is a finding. `defineInvariants` is renamed outright (0.x, no compatibility). Guards
are weakly fair by default. `everyStep` gets the world views before and after, and the event.

### During implementation

- Symmetric liveness: judge a property that is symmetric as a whole (`forEach` an actor's
  instances, like `\A p \in P : []<>Eating(p)`) on the folded graph.
- How the playground shows a loop. Done: the check page lists the loop after the path, and
  "Open in playground" plays the path and one round of the loop.
- Whether `settle()` should follow fairness instead of its fixed order.
- Checking stuck worlds against TLC: the TLA+ oracles bound actions with `Repeats`, so TLC
  sees a deadlock where the bound runs out; Feynman does not count that as stuck.

### Out of scope

- Refinement mappings.
- Timed or bounded liveness.

## Future possibilities

- Refinement: check that a spec implements a smaller one, through a mapping of states,
  which is most of the remaining wild `PROPERTY` lines.
- Translating TLA+ specs to Feynman mechanically, for oracles beyond the hand-picked ones.
