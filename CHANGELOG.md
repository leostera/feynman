# Changelog

What changed in each release of `@leostera/feynman`, newest first. A release that changes
how specs are written has a **Migrating** section: what to change in a spec, before and
after.

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
