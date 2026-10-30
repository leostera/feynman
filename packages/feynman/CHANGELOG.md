# Changelog

What changed in each release of `@leostera/feynman`, newest first. A release that changes
how specs are written has a **Migrating** section: what to change in a spec, before and
after.

## 0.13.0

### Migrating

Specs need no change: everything here is new, or the checker reporting more. A few things
behave differently around them:

- **`feynman run` with several scenarios prints one line each**, not every trace. A script
  or an agent that read the traces from it needs `--all`, or `--scenario NAME` for one.
- **A search may stop at the memory limit**, 50% of the machine's memory by default, where it
  used to run on (and was often killed). Raise it with `--memory-limit GB`, or
  `check.memoryLimit` (in megabytes) in `feynman.config.ts`. `--json`'s `stoppedBy` can now
  be `"memoryLimit"`, and the line under an unfinished verdict reads differently: match on
  `--json`, not on that text.
- **Code that builds a `Spec` by hand** (not with `defineSpec`) must add `rules: []`,
  `without: []` and `withoutRules`. Spreading a spec (`{ ...spec, properties }`) keeps them.
- **Types come from `dist/types`.** A project that type-checks its specs now checks them
  against declaration files, not Feynman's source, and needs no `allowImportingTsExtensions`
  for it. Nothing to change, unless a `paths` entry pointed `@leostera/feynman` at its `src/`.
- **Adopting rules:** a constant flipped by hand to see a property break (`const
  PENDING_RULE = true`), or a copy of the spec without a safeguard, becomes a rule:

  ```ts
  // Before
  const PENDING_RULE = true;
  if (PENDING_RULE && state.pending.length) return void state.waiting.push(msg);

  // After
  const pendingRule = spec.defineRule({ name: "pendingRule", description: "A read waits behind an unconfirmed push." });
  if (pendingRule.on && state.pending.length) return void state.waiting.push(msg);
  // and on the properties it protects:
  ackedPushesAreVisible: { description: "…", always: (w) => …, needs: [pendingRule] },
  ```

  Then `feynman check` proves the rule is needed, and `--without pendingRule` replaces the
  copy.

### Rules that are needed

- A spec can name the rules of its design, the parts that exist to keep a property true
  (RFD0010): `const key = spec.defineRule({ name: "idempotencyKey", description: "…" })`,
  read as `key.on` where it applies. A property that depends on it says `needs: [key]`, a
  reference the type checker follows, not a string.
- `feynman check` also checks the design without each rule, and expects every property that
  needs it to break: `✓ idempotencyKey  needed: without it, chargedOnce breaks (5 events)`.
  When one still holds, the check fails (`✗`): the rule does nothing, or the property is too
  weak to see what it prevents. That search stops as soon as every such property broke.
  `--no-rules` skips it; `--json` and the explorer's Checks panel show the verdicts.
- `feynman check --without RULE` (and `feynman run --without RULE`) look at the design
  without a rule, with its counterexamples and `--as-scenario`: no more copying a spec to
  flip a flag. The retried-call example declares its idempotency key as a rule.

### When a search does not finish

- A search stopped by a limit says how far it got in full: a safety property that held "held
  on every path of up to 6 event(s)", rather than "in the 300,000 states explored". `--json`
  gives `heldUpTo`.
- It also says what its states differ in, most first: "Session.outcomes (1,359 values),
  HostDO.sockets (46 values) …; up to 7 message(s) in flight at once", and whether to bound a
  growing field or cut the orders in flight. `--json` gives `variety` and `mostInFlight`.
- A memory limit: the search stops past `--memory-limit GB` (`check.memoryLimit`, in
  megabytes; 50% of the machine's memory by default) and keeps its verdicts, instead of being
  killed by the system with nothing reported.

### Using Feynman from a project

- The package ships declaration files (`dist/types`), so a project that type-checks its specs
  with its own `tsconfig` no longer type-checks Feynman's source (TS5097 without
  `allowImportingTsExtensions`, errors under `noUncheckedIndexedAccess`).
- `feynman run` with several scenarios prints how each ended, a line each; `--scenario NAME`
  or `--all` print traces.
- APIs from before time became the order of events say what replaced them: `s.wait`,
  `s.settle(duration)`, and type errors on `ctx.now` and `ctx.clock`.

### Fixes

- A spec with `symmetric: true` actors that answers a call crashed the check with "JSON Parse
  error: Unrecognized token '|'" (new in 0.12.0): a reply to a call is now keyed so symmetry
  can rename it.
- When Feynman itself crashes (a JavaScript error thrown from its own source), it says so,
  shows where, and asks for a report, instead of printing the bare message.

## 0.12.0

### Calls that fail

- `call<P>({ name })` declares a message whose failure reaches its caller, as an RPC, a
  `fetch` or a Durable Object stub throws (RFD0009). The checker can lose it, or the reply
  its handler sends with `ctx.reply`, and either way the caller gets the call's failure:
  `[spec.failed(Charge)]: { run(state, failure, ctx) { … } }`, with `failure.payload` and
  `failure.to`. The caller cannot tell which was lost, so a retry after a lost reply runs the
  call twice: the duplicates a silent loss never reaches.
  - A failure costs one fault, as a loss does, and it cannot be lost itself. A restart of the
    caller drops the failures on their way to it.
  - An actor that sends a call must handle its failure, a call has one reply, and that reply
    is not a call: each is an error.
  - Scenarios deliver a failure by the call's name: `s.deliver(client, "failed:Charge")`.
    In the playground, "Fail the call" replaces "Lose it" on a call and on its reply.
- A new example, `retried-call.ts`: a client that retries a payment when the call to the bank
  fails charges twice when the answer is lost, and an idempotency key fixes it. TLC and P
  agree with the checker on it.

### Checking

- A counterexample that ends with someone waiting on a lost message (a liveness verdict where
  nothing fair can happen, or a stuck world) says who waits for what, and what to model
  instead: a `call` when the code is told (an RPC or fetch that throws), otherwise a timer
  that retries; `--faults 0` if it cannot be lost. It is a finding, not a reason to weaken
  the property or call every quiet world final.
- Type errors are said again at the end of `feynman check`'s report, so its last lines (a
  `tail`) show that the results come from code that does not compile.

### Writing specs

- A timer or guarded transition whose `run` takes a message, `run(state, msg, ctx)`, is an
  error when the spec is defined: it receives no message, and its run is `(state, ctx)`. It
  used to fail when it first ran, on `ctx` being undefined.
- The skill: calls, why a final state of `w.quiet` alone hides deadlocks, and pointing
  sources at methods rather than classes.

### Fixes

- A source naming a generic function or method is found: `src/client.ts#Client.call` for
  `async call<M extends Keys<T>>(…)`, and `#wrap` for `const wrap = <T,>(value: T) => …`.
  Type parameters nested inside a function's own type parameters used to hide it ("is not
  defined"), and the "did you mean" list came up empty too.

## 0.11.0

### Checking

- The search runs on an integer core (`src/check/integer.ts`; RFD0008).
  - **Worlds** are short integer vectors of interned instance states, messages and timers.
  - **Local steps** (one instance, in one state, taking one step, with one argument) run
    through the engine once, and are then replayed from a cache.
  - **Fingerprints** are updated per step. Only fingerprints and parent links are kept, so
    counterexamples are replayed on real worlds.
- It is 5–13× faster than the old search on one thread, and 2–6× faster than the old search
  on 8 threads. It uses a quarter or less of the memory.
  - On a production spec of 2.8 million states, a check that took 581 s on one thread (147 s
    on 8) now takes 40 s.
  - The same spec needs 11 GB at peak, down from 38 GB.
- It does everything the old search did except split the work among threads:
  - every kind of property: `always`, `never`, `everyStep`, and liveness on the graph it
    keeps;
  - symmetry and its twin checks;
  - scenario starts, including ones whose setup spawns instances;
  - errors, stuck worlds, coverage, `maxStates` and `timeLimit`.
- Its reports are the same as the old search's, down to every counterexample and loop, on
  every example and on generated specs. The TLA+ and P oracles hold it to TLC and P.
- A property's answer is worked out once for each set of instance states it can see, and
  then reused. Most states differ only in what is in flight, so specs with costly properties
  gain the most.
- With symmetry on, checks are 3–7.6× faster than before.

### API

- `check(spec, bounds, seeds, { engine })` takes `"integer"` (the default) or `"classic"`,
  the old search. `FEYNMAN_ENGINE=classic` sets the default, for example to run a suite
  through the old search.
- `bounds.reduce` (sleep sets and the inputs reduction) and `--workers` / `bounds.workers`
  now apply only to the classic search. `report.reductions.orders` and `.inputs` are 0 with
  the integer core.

### Fixes

- `feynman check` no longer says "skipped 0 step(s)" when only symmetry has something to
  report.
- The fuzzer now holds the integer core to the old search, from scenario starts too.
  Generated specs may now spawn instances in a scenario's setup.

## 0.10.0

### Writing specs

- A scenario can start in a world it sets up, rather than replaying how the system got
  there: `setup(w) { w.set(Ledger, { … }); w.spawn(Git, "Alice", { … }) }`. Fields are laid
  over each instance's `initialState`, and typed against its state. The flow and the
  playground start after it; the checker explores from it as well as from where the scenario
  ends, and reports a property the set-up world breaks against the scenario. `--as-scenario`
  writes a counterexample found from a scenario's world as a `setup`, when nothing is in
  flight there. Counterexamples say where they start, `{ scenario, at: "start" | "end" }`
  in `--json`. Two scenarios with one name are an error.
- `s.settle({ until: (w) => … })` runs a scenario left alone until the world gets there, to
  step in at that moment (a restart, a drop) without delivering each message by hand. It is
  an error if the system settles first.
- An unfinished liveness verdict says why and what to change: "held to depth 14, but paths
  that had not got there yet were cut off at that depth", then "raise --depth
  (check.depth in feynman.config.ts)". When the search stopped at a limit, it names that limit.
- A step whose `run` returns a new state object, or is `async`, is a spec error: state
  changes in place, and the returned state used to be dropped silently.
- An actor without a `zone` says so, instead of failing on `raw.zone.name`.
- `feynman version` (and `--version`, `-v`).
- The skill: how scenarios change state (only through events) and how to share setup
  between them; zones for the system's parts and concerns, and when to use a ring or a grid;
  the shipped source as the API reference.

### Migrating

- An actor's `look` is now `display`, and the `Look` type is `Display`:
  `display: { icon: "server", status: (s) => …, rows: (s) => … }`. Playground files
  receive `display` where they received `look`.
- `--json` counterexamples say where they start as `from: { scenario, at: "start" | "end" }`
  rather than a scenario name.
- Two scenarios with one name are an error.

### Fixes, found by fuzzing

- A world where a path starts (the initial world, or where a scenario ends) is judged too: an
  `always` property it breaks is reported with no steps, as TLC does, not one step later or
  not at all.
- Liveness verdicts no longer depend on `never` properties. What a `never` property remembers
  of the path made a loop come back to a different state each time round, so liveness
  counterexamples through it could not close and the verdict was "unfinished". A spec with
  both is now checked in two searches; the safety one keeps its reductions.
- A step that fails (a spec error) breaks no property: the error is the finding. Random runs
  and the search disagreed on this before.
- Worker threads could fail to find the spec's bundle (Bun's resolver, when several threads
  import a new file at once); each bundle gets a directory of its own.

### Faster

- About 1.5× faster on one thread: states are written and copied without
  `JSON.stringify` replacers or `structuredClone`, and fingerprinted from cached hashes of
  their parts. or-set with a fault (129k states): 6.8 s at 0.9.0, 4.4 s on one thread now,
  1.5 s on 8.

## 0.9.0

### Liveness, as in TLA+

- New liveness properties: `eventually`, `leadsTo: { whenever, then }`, `infinitelyOften`
  and `eventuallyAlways`. They hold in every fair behaviour, as in TLA+, not on one run of
  the system left alone. Messages, timers and guards are weakly fair; a step can say
  `fair: "strong"` or `fair: false`. Actions and faults are never fair.
- A liveness counterexample is a path and then a loop it repeats forever, shown by check,
  `--json` (`loop`), `--as-scenario` and the playground. Where a loop could lie past the
  depth bound, the verdict is unfinished.
- `everyStep: (before, after, event) => boolean` judges each step.
- Stuck worlds: where nothing can happen, check reports it and fails, unless the spec calls
  that world final with `spec.defineFinalState({ description, when })`.
- Sets and maps in state are compared by what they hold.
- `--symmetry-checks N` (or `check: { symmetryChecks }` in the config): how many merged
  states a symmetry claim is tested on, 2000 by default; 0 trusts it. The tests take a large
  share of a symmetric search.
- Checking is about 3× faster on symmetric specs: renamed state keys are cached.

### A search shared among threads

- Big searches run on worker threads besides the main thread (RFD0007): 1.9–2.9× faster from
  20,000 states up, with the same result, down to the counterexamples, however many threads
  there are. `--workers N` (or `check: { workers }`) sets how many, one fewer than the cores
  by default, up to 7; 0 keeps the search on one thread. Small searches stay on one thread.
- States are remembered by 64-bit fingerprints, as TLC does: two states share one with odds
  of about one in 36 million at a million states.
- The state count is of distinct states only.

### Migrating

- `spec.defineInvariants` is now `spec.defineProperties`.
- `eventually` with `after` becomes `leadsTo`:

  ```ts
  // before
  settles: { description, after: (w) => pending(w), eventually: (w) => !pending(w) },
  // after
  settles: { description, leadsTo: { whenever: (w) => pending(w), then: (w) => !pending(w) } },
  ```

- A spec whose system finishes adds `spec.defineFinalState` for where it ends; otherwise
  check reports its end as stuck.

## 0.8.0

### Reading check's results

- `feynman check --brief` prints one line per property, and for each counterexample its
  length and the faults it needs, without the trace.
- `--only P,Q` checks and shows only those properties.
- `--json` prints the whole result as JSON: verdicts, counterexamples with their events,
  scenario failures, sources.
- `--only P --as-scenario` prints P's counterexample as `spec.defineScenario` code that
  replays it step by step.

### Telling likely bugs from unlikely ones

- Each counterexample uses the fewest faults (lost messages, restarts) that break the
  property within the bounds. Check searches again with fewer faults to find it, and says
  when a shorter path needs more: "needs no faults" means it happens in normal operation.
- A property can be marked `known: "why, or the issue"`: a bug found and not fixed yet.
  Check reports it, and scenarios that break it, without failing; once it holds, check
  fails until the mark is removed.

### Scenarios

- `s.deliver(who, message, payload?)` delivers a message in flight now, ahead of the rest;
  `s.drop(who, message, payload?)` loses one; `s.step(who, transition)` runs a guarded
  transition. With them a scenario can take any path the checker can.

### Sources

- A `path#symbol` that is not defined names the close symbols the file does define: "did
  you mean src/relay.ts#Relay.redeem?"

### Build

- `feynman build` minifies the explorer and the spec modules, and writes `.gz` and `.br`
  variants next to the page for static hosts.
- `--out` takes a directory too (one that exists, or a path ending in `/`), and writes
  `index.html` in it.

### Skill

- When a counterexample appears: sort it into spec mistake, intended behaviour or finding,
  judge how likely a finding is from the faults it needs and production evidence, and keep
  one that stays as `known`.
- Write more specs rather than bigger ones.

## 0.7.0

### Examples

Six coordination systems, each buggy and fixed, with verdicts worked out by hand and
independent TLA+ and P models that agree with the checker:

- `write-skew.ts`: two on-call doctors each check that the other stays, then both leave.
- `dining-philosophers.ts`: each philosopher starts with a different fork; deadlock.
- `ricart-agrawala.ts`: equal timestamps let both nodes into the critical section. Writing
  the fix, the checker found two more ways in once nodes restart: a clock that goes back,
  and an answer to an old request counted for a new one.
- `token-ring.ts`: a resent token crossing a slow first copy gives two holders.
- `chang-roberts.ts`: leading on beating a smaller id, rather than on one's own id coming
  back round, elects two leaders.
- `barrier.ts`: a coordinator counting arrivals, not workers, opens early when one restarts
  and arrives again.

## 0.6.0

### Fixed

- `feynman dev` starts on a port that is free on both loopback addresses. `localhost` is
  `::1` and `127.0.0.1`, and a second `feynman dev` used to bind the one the first had left
  and report the same port.

### Examples

- Three new systems, each buggy and fixed, with verdicts worked out by hand and independent
  TLA+ and P models:
  - `alternating-bit.ts`: the alternating bit protocol over a network that reorders. One bit
    is enough only on a link that keeps order; a retry's stale copy passes for the next item.
  - `raft-vote.ts`: a node that forgets its vote on restart votes twice in a term, and two
    nodes lead.
  - `outbox.ts`: an announcement queued in memory is lost when the shop restarts between
    storing an order and announcing it.
- The lease lock gains TLA+ and P models.
- Every example and its oracles are one entry in `test/examples/corpus.ts`.
- The TLC oracles run again: they had been comparing against nothing on machines whose
  `java` is the macOS stub. A TLC error other than a violation now fails the oracle rather
  than passing for "holds".

## 0.5.0

### Changed

- The playground plays by itself by default, at ¼× speed.
- The play bar is bigger, with Play/Pause standing out.

## 0.4.0

### Added

- The playground lays the diagram out top to bottom when the room beside the side pane is
  narrow. A button by the zoom controls picks auto, left to right, or top to bottom; the
  choice is kept in the URL (`?layout=`).
- `feynman build` reports every phase of every spec, timed: bundles and their sizes,
  sources (naming missing ones), call traces and their problems, functions, and the check's
  verdict.

### Changed

- Browser modules are bundled with Vite; Bun only bundles specs the CLI runs.

### Fixed

- The diagram fits beside the floating controls instead of under them.
- A crash when a pan ended before React applied its last move.

## 0.3.0

### Added

- A Code view of the timeline: each event's inputs and messages, the code its sources point
  at, and the functions that code reaches, all highlighted.
- Shareable playground URLs: `#/playground/<spec>/<scenario>`, with speed, camera and custom
  state.
- Copy Timeline and Copy Scenario.

### Changed

- `feynman dev` runs on Vite's dev server, and checks and call trees run on a worker so the
  page stays responsive while they finish.

## 0.2.0

The first release on npm as `@leostera/feynman`.

- Specs have no clock: time is the order of events (RFD0004).
- `feynman build` writes the explorer as one self-contained HTML file.
- The explorer: a playground that plays the system and waits when it cannot go on, flows as
  a tree of specs, scenarios and flows, a settings page (theme, auto-play, reduced motion),
  and zones that arrange their instances in a stack, row, grid or ring.
