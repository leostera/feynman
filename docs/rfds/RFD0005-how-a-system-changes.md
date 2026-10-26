# RFD0005 - How a system changes, commit to commit

- Feature Name: `behaviour-diffs`
- Status: Draft (exploratory)
- Author: `leostera`
- Start Date: `2026-10-26`
- Updated: `2026-10-26`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

A spec is versioned with the code, so two commits give two specs, and everything Feynman
derives from a spec can be compared. This RFD proposes what a comparison shows and in what
order: first a short account of what changed in the system's behaviour, then the evidence
for each part of it, from the rules that broke down to the steps and the code. It is a
first pass at the design, meant to settle what to build before the views are redesigned.

## Motivation

`feynman diff --base main` and the flows page compare each scenario's trace with the same
scenario at another commit, step by step. That answers "did this story change?", but not
the questions people bring to a change:

- **Reviewer:** "What does this PR do to the system?" Today: read every changed flow, each
  as a list of aligned steps, and assemble the answer yourself.
- **Author:** "Did I change anything I did not mean to?" Today: only what a scenario covers;
  a new behaviour the checker reaches but no scenario shows is invisible.
- **Newcomer:** "How did pairing get to how it is now?" Today: nothing across more than two
  commits.

Scenarios are a few stories chosen by the spec's author. The checker explores every
ordering within bounds. A comparison built only on scenarios misses most of what changed.

## Goals

- Lead with a summary a reviewer can read in ten seconds: what changed, in the system's own
  words, with the riskiest change first.
- Show changes nobody wrote a scenario for, using what the checker explored.
- Tie every behavioural change to the code change behind it, when there is one.
- Work for two commits (a PR) and for a series (a history), in the CLI, the view and a PR
  comment.

## Non-goals

- Diffing code. CallDiff and the forge already do that; Feynman links to it.
- Comparing specs of different systems, or detecting renames cleverly in a first version.

## Guide-level explanation

### Five layers of change

From cheapest to compute to most revealing:

1. **Verdicts.** A rule that held and now breaks (with its counterexample), a rule that
   broke and now holds, a rule added or removed, a `✓` that became `~`. This is the first
   line of any summary.
2. **The spec's shape.** Actors, messages, actions, steps, rules and scenarios added,
   removed or changed. A step changes when what it declares (`sends`, `starts`, `when`,
   `sources`) or its code (`run`, by its text) changes.
3. **Scenarios.** Each story's trace at both commits, aligned (as today), summarised as
   sentences: "Pairing now sends `revoked` to the Mac before it answers the person."
4. **Reachable behaviour.** What the checker explored, abstracted so two runs can be
   compared: which steps ran, which messages went from which actor to which, which state
   fields changed in each step, and which (step, message) pairs were possible at all. A set
   difference of those shows behaviour no scenario covers: "The relay can now receive a
   host's `hello` after it was revoked."
5. **Code.** The sources whose code changed between the commits, per step, and steps whose
   code changed but whose spec did not (a sign the spec is now out of date).

### What a reviewer sees

The top of the comparison is a summary:

> **This change breaks one rule and adds a flow.**
> ✗ `viewersSeeTheTruth` now breaks: a revoked Mac can still look online (8 events).
> + Scenario "Revoke a Mac while it is linking".
> ~ Two steps changed: `AxoAccountManager · revoke`, `axod · hello`.
> ! `axod · reconnect`'s code changed, but its step did not: check the spec.

Below it, one section per layer, each item opening its evidence: the counterexample in the
simulator, the two traces side by side, the step's code at both commits.

The system map can carry the same information: actors and links added (green), removed
(red) or whose behaviour changed (amber), with the summary's items pinned to them.

### History

`feynman log [spec]` walks the commits that changed a spec or the code its sources point at,
and prints each one's summary, newest first. The view gets a history page with the same, so
"how did pairing get to how it is now" is a scroll down a list of summaries.

## Reference-level explanation

### Architecture and boundaries

- `src/spec`: `diffSpecs(base, head)` (layer 2) and `diffRuns` (layer 3, exists).
- `src/check`: an abstraction of an exploration, `Footprint` (layer 4), recorded as the
  search runs, and `diffFootprints`. Verdict comparison (layer 1) uses the two reports.
- `src/code`: changed sources between commits (layer 5; the lock already hashes them).
- `src/cli`: `feynman diff` gains the summary and `--format markdown` for a PR comment;
  `feynman log` is new. Both build the base spec from a worktree, as `diff` does today.
- `src/view`: a comparison page that leads with the summary; the flows page redesign
  builds on it.

### Data model and interfaces

```ts
interface Change {
  layer: "verdict" | "shape" | "scenario" | "reachable" | "code";
  kind: "added" | "removed" | "changed" | "broke" | "fixed";
  /** One sentence, in the spec's words. */
  text: string;
  /** What it is about, to pin it on the map and open its evidence. */
  about: { actor?: string; step?: string; message?: string; rule?: string; scenario?: string };
  /** How much a reviewer should care: a broken rule first, a reworded description last. */
  weight: number;
}

interface Footprint {
  steps: Set<string>;            // "Actor·key"
  flows: Set<string>;            // "From→To·message"
  writes: Map<string, Set<string>>; // "Actor·key" → state fields it changed
  enabled: Set<string>;          // "Actor·key·message": a message that could arrive at a step
}
```

The summary is the list of `Change`s, sorted by weight, the first few as sentences.

### Compatibility and migration

`feynman diff` keeps its output as a section under the summary. Nothing in specs changes.

### Rollout and validation

1. Layers 1, 2 and 5: cheap and deterministic; build them first, with the summary.
2. Layer 3's sentences.
3. Layer 4, measured on the examples: does every bug fix in `examples/` (buggy → fixed) show
   up as the right reachable change? That pair is a ready-made test corpus: the "commit"
   that fixes each bug is known.
4. The view, then the PR comment.

## Drawbacks

- Reachable behaviour depends on bounds: a footprint is what the checker reached, not all
  there is. Two runs must use the same bounds, and the summary says when they stopped early.
- Sentences generated from traces can read badly. They must use the spec's own labels and
  descriptions, and fall back to plain structure rather than guess.

## Rationale and alternatives

### Proposed design

Summary first, evidence underneath, because reviewers decide where to look from the
summary. Layers ordered by risk, because a broken rule matters more than a renamed label.

### Simpler or narrower approach

Only verdicts and scenario traces (layers 1 and 3). It is most of what exists already, and
still misses behaviour no scenario shows.

### Other alternatives considered

- **Diffing the whole state graph.** Exact but enormous, and it changes completely when any
  state field changes. Footprints abstract away from states on purpose.
- **Model-based test generation** (traces that pass at one commit and fail at the other):
  powerful but slow; a possible layer later.

### Do nothing

Keep per-scenario trace diffs, and leave reviewers to assemble the story.

## Prior art

- Semantic diff tools (difftastic) for code structure; CallDiff for call trees.
- Behavioural regression in model checking: comparing reachable transition systems.
- Changelogs written for users, which say what changed in behaviour, not in files.

## Unresolved questions

### Before acceptance

- Is the summary generated entirely from structure, or does an agent write it from the
  structured changes (deterministic facts, human sentence)?
- Which footprint is small enough to diff and still catch real changes? The examples'
  buggy/fixed pairs should decide.
- Where does history live: computed on demand from git, or recorded per commit (a
  `.feynman/history` the CLI appends to)?

### During implementation

- Matching renamed actors and steps across commits (by sources, as a later refinement).
- How the map shows changes without hiding the system.

### Out of scope

- Diffing different systems' specs.

## Future possibilities

- A PR bot that posts the summary and a link to the built comparison page.
- On feynman.leostera.dev, a history for every published simulator.
- With RFD0004, traces are pure event sequences, which makes layer 3 cleaner.
