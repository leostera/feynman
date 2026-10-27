# Changelog

What changed in each release of `@leostera/feynman`, newest first.

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
