---
name: modelling
description: Extract and maintain a behavioural model of a software system (actors, components, flows, protocols, state, invariants, claims, limits) from its code, stored as a directory of small JSON files in `.feynman/model/`. Use when building a repository's model for the first time or updating it after a change.
---

# Modelling

The model explains how a system **behaves**, so people can understand it, and how
a change affects it, without reading the code. It sits between "data in, money
out" and the code itself.

## Principles

1. **Extracted, never hand-written.** Agents build and maintain it from the code.
2. **Anchored to files.** Each element names the files (and symbols or lines) it
   comes from, so it can be found again after code moves. No stable ids.
3. **Accurate, not reproducible.** Two extractions may differ; both must be true.
4. **Descriptive.** Say what the system does, not whether it is good.
5. **Semantic actions, not control flow.** "Runs a transaction", "sends an email",
   "spawns a process", "writes this file", "acquires a lock": what happens, in what
   order, with what guarantees (transactional, idempotent, retried, bounded).
   Ignore functions, helpers, branches, and loops.
6. **Behaviour, not development.** First decide what the system is: what ships,
   and what runs when it is used. Files about developing it (CI, build, release
   and publishing scripts, tooling, project websites, contributor docs) are set
   aside as `development` and never become elements. Code that runs when the
   system is used is part of it, wherever it lives. **Tests are behaviour**: read
   them, and turn what they check into invariants, claims, and limits.

## What to extract

- **Actors** have a runtime identity: people, the processes this repository ships
  (a CLI, a daemon, a server, a browser page, a plugin), and the programs and
  services they call. Start from whoever uses the system and follow what it talks
  to (`talksTo`). Each has a `kind` (`person`, `program`, `service`), a
  `provenance` (`first-party`: code in this repository; `third-party`; `ambient`:
  the platform, such as the OS or the user's shell), and `runsOn` (`local`,
  `browser`, `remote`, `cloud`, with provider and platform when known). A plugin is
  its own first-party actor beside its third-party host. Machines are where actors
  run, not actors.
- **Components** are units of first-party code (packages, modules, libraries),
  never actors. Each lists its `footprint.paths`, the `actors` it runs in, and the
  components it `dependsOn`. Every first-party actor has at least one.
- **Flows** are the jobs the system does for its actors: a trigger, semantic steps
  from actor to `target` (with the `component` doing the work and the `protocol`
  spoken), and an `outcome`. "Build a model" and "accept an upload" are flows;
  loading a plugin or installing dependencies is not. Failure, retry, and recovery
  paths are flows too. Flows are the main unit of explanation.
- **Protocols** are the shapes data has entering, leaving, or resting in the
  system: APIs, socket protocols, event streams, files, database schemas. Enough
  to draw them without the code: each message (call, record, event, route, table)
  with fields, types, bounds, and results; transport, framing, version; `server`
  and `clients`; where untrusted input is parsed (`parsing`); schema files
  (`definitions`); how shapes coexist across versions (`compatibility`).
- **State** is data an actor owns: where it lives, its lifetime, its source of
  truth, and copies that may drift. **State machines** are domain states and
  legal transitions.
- **Invariants** are what the system makes sure always holds: `enforcement`
  (`compile-time`, `runtime`, `test-time`, `documented`); `enforcedAt`, the call
  path from each trigger to the check, outermost frame first, skipping frames that
  only forward; the `tests` that exercise it; the consequence of breaking it.
- **Claims** are what we believe about the system ("terminal bytes never leave the
  host"), with evidence and the elements they are `about`, including beliefs the
  code contradicts.
- **Limits** are bounds: sizes, counts, timeouts, intervals, rates. One per bound,
  anchored to the line that sets it, `about` what it applies to.

## Process

One agent extracts the whole model in one session: the developer's, through
`/feynman-extract` or `/feynman-explain`. Never hand it to a subagent or a
background process; following the code across files is what the model records.

Every file the extraction covers passes through context, because reading only
what looks important is how models miss behaviour. Files read in full are
recorded automatically; the rest are set aside with `feynman_skip` as
`development`, `vendored`, or `generated`, with a note. Patches and build rules
around vendored code are first-party and read.

The extension drives three phases and says what each still lacks:

1. **Actors.** Survey everything shallowly, then write `meta.json`, the actors,
   `talksTo`, and the components with footprints.
2. **Flows.** Read groups of connected actors in full, one at a time, and write
   the flows through them, with what you meet on the way, each element complete
   when first written. Fix the actor map when the code disagrees.
3. **Depth.** Fix what the extension lists as still thin, then stop.

Feynman checks each model file as it is written, and coverage, validity, and gaps
at every stop. Don't run checks, measurements, tests, or scripts over the model
yourself, and don't change the schemas; say in your last message what they could
not express.

A bootstrap covers every file in the snapshot. An update covers the files changed
since the modelled commit plus the files of every element whose `sources` changed;
re-examine those elements and **edit** them, rather than regenerating the model.
With uncommitted changes, the model describes the working tree.

## Storage

```
.feynman/
  config.json           optional: { "exclude": ["examples/"] }, git pathspecs outside the system
  model/
    meta.json
    actors/<id>.json      components/<id>.json   flows/<id>.json   protocols/<id>.json
    state/<id>.json       state-machines/<id>.json
    invariants/<id>.json  claims/<id>.json       limits/<id>.json
    coverage/<batch>.json written by the extension, never by hand
```

- An element's id is its kebab-case file name, not repeated inside the file.
- Each file validates against its JSON Schema in `packages/model/schema/` of the
  Feynman repository; rendering relies on them. Change schemas and this skill
  together.
- References use bare ids where the kind is fixed (`actor`, `target`, `owner`,
  `server`, `clients`, `from`, `talksTo`, a component's `actors`; `component`,
  `dependsOn`; `ref` for a flow; `protocol`), and `about` uses paths such as
  `flows/pi-recovery`.
- Anchors are repository-relative: `path`, `path#symbol`, `path:10-42`,
  `path:10:5-42:2`, or `{ "file", "symbol", "span": { "start": { "line", "column" }, "end": … } }`.
  Lines are 1-based and inclusive. Prefer a symbol; add a span for a few lines
  inside a larger body (a guard, a SQL statement, a lock scope).
- `sources` (content hashes) and footprint counts are written by `measure`, never
  by hand.
- Exclude only what is outside the system, never to finish faster.

## Tools

In Pi: `feynman_extract` starts or resumes, `feynman_skip` sets files aside,
`feynman_status` shows where things stand; `/feynman-stop` and `/feynman-render`.

Command line, in the Feynman repository (`bun run model <command>`):

- `index <model-dir> [<kind>…]`: one line per element.
- `coverage <repository> <model-dir> [--missing]`: files still uncovered.
- `check <model-dir> [<repository>]`: schemas, references, and anchors.
- `measure <repository> <model-dir> [--main <ref>]`: links, dates, footprints, `sources`.
