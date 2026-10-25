# RFD0001 - Extracted behavioural model

- Feature Name: `extracted-behavioural-model`
- Status: Superseded by [RFD0002](RFD0002-feynman-specs.md)
- Author: `leostera`
- Start Date: `2026-10-25`
- Updated: `2026-10-25`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

This is a snapshot RFD. It records the first iteration of Feynman as implemented at
`e48fd61`, so that the decisions and lessons survive its replacement. It proposes
nothing.

## Summary

An agent extracts a behavioural model of a whole repository: journeys, actors,
components, flows, protocols, state, invariants, claims, and limits. The model is stored
as one JSON file per element under `.feynman/model/`, and each element is anchored to
the code it comes from. A Pi extension drives the extraction through three phases and
checks coverage, so that every file is read or set aside. A deterministic renderer turns
the model into a self-contained HTML explainer.

## Motivation

People need to understand how a system behaves, and how a change affects that
behaviour, without reading all of its code. The model sits between "data in, money out"
and the code itself. It is written for people, who read the rendered explainer rather
than the JSON.

## Guide-level explanation

In Pi, `/feynman-explain` (or `/feynman-extract` without rendering) starts an extraction
at HEAD, including uncommitted work. It takes an optional path to a repository.

1. **Phase 1, actors.** A shallow survey of the repository, producing the actor map and
   the journeys:
   - the people;
   - the processes the repository ships, with `host` for one that runs inside another;
   - the external services that shape the outcome.
2. **Phase 2, flows.** For each group of connected actors, the agent reads the listed
   files in full, tests included, and writes the flows that run through them. Each flow
   step is anchored to `path#symbol`.
3. **Phase 3, depth.** Feynman lists gaps: unanchored steps, unexplained connections,
   and anchors that call-tree measurement cannot find. The agent fixes only those.

When the agent stops, Feynman checks coverage and validity, and says what comes next.
At the end, it measures the components, computes a call tree under each anchored step
with CallDiff, records each element's sources, and renders the explainer.

The explainer opens on "How it works": each journey with its stages, the flows behind
each stage, and the steps of each flow with their call stacks. Reference pages list the
actors, components, flows, protocols, state, invariants, claims, and limits.

## Reference-level explanation

**Packages:**

| Package | Role |
|---|---|
| `@feynman/model` | Schemas (one per kind), types, checks, coverage ledgers, snapshots, anchors, measurement, call trees through a Node worker running CallDiff. The `feynman-model` CLI. |
| `@feynman/modeler` | The runtime-agnostic extraction driver: phases, gaps, messages, read evidence. |
| `@feynman/pi-feynman` | A thin Pi adapter: the `feynman_extract`, `feynman_status`, and `feynman_skip` tools, and the `/feynman-extract` and `/feynman-explain` commands. |
| `@feynman/renderer` | React and Kumo views, built into one HTML file. |

**Storage.** Each file under `.feynman/model/` is named by the element's kebab-case id:

```
journeys/  actors/  components/  flows/  protocols/
state/  state-machines/  invariants/  claims/  limits/
coverage/<batch>.json   meta.json
```

- `coverage/` is written by the extension, never by the agent.
- `.feynman/config.json` holds `exclude` pathspecs.
- Each element records `sources` as git blob ids, so that an update knows which
  elements to re-examine.

**Coverage.** A file counts as covered once it has passed through the agent's context:
either every line has been read, or it has been set aside as development, vendored, or
generated with a note. Reads are recorded automatically. A bootstrap covers every file
in the snapshot. An update covers the changed files, plus the files of every element
whose sources changed.

**Invariants of the implementation:**

- Facts live in the model, never in the renderer.
- Rendering is deterministic.
- Every write to a model file is validated when it happens.
- Extraction runs in one agent and one session, without subagents.

## Lessons

- **"How it works" was most of the value:** journeys, flows, anchored steps, and call
  stacks. The reference pages could be derived from code with little effort.
- **Speed was bound by output.** Time tracked output tokens closely, at about 77 tokens
  per second. Two changes cut a run from 21 to 8 minutes: validating each file when it
  was written, and limiting phase 3 to listed gaps. Asking for journeys and anchors took
  it back to 23 minutes. The extraction wrote what it was asked for, so the prompt had
  to ask for less: "what a newcomer needs".
- **Mechanical work should stay mechanical.** Call trees, sizes, and sources cost no
  tokens and were the most trusted parts.
- **Agents fill gap checks literally.** A rule that every flow must involve two actors
  produced invented targets.
- **Whole-repository extraction is the wrong unit for most questions.** People wanted
  to understand one part on demand, or one change, not to wait for a full model first.
- **Reading is not understanding.** Agents asked for an interactive explainer of one
  topic produced simulators. People found those far easier to understand, and they
  surfaced behaviour the model never captured. That led to
  [RFD0002](RFD0002-feynman-specs.md).
