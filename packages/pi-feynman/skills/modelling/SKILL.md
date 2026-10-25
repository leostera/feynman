---
name: modelling
description: Extract and maintain a behavioural model of a software system (actors, flows, protocols, state, invariants, claims, limits) from its code, stored as a directory of small JSON files in `.feynman/model/`. Use when building a repository's model for the first time or updating it after a change.
---

# Modelling

Status: draft. Update this skill as the design evolves.

## Purpose

Agents change code faster than humans can review it. Reading every line is not
useful, but understanding how the system's **behaviour** changes is. The model is
the thing we read, and compare before and after a change, to understand that.

The model sits between two extremes:
- too abstract: "data in, money out";
- too concrete: the code itself.

## Principles

1. **Never hand-written.** Agents extract and maintain the model.
2. **Anchored to files.** Each element lists the files (and symbols where useful)
   that relate to it, so an agent can find them again even after code moves.
   Do not use stable IDs; file anchors are enough.
3. **Accurate, not reproducible.** Repeated extractions may differ, and that is
   fine. What matters is that the model is accurate and helps a reader understand
   the system.
4. **Descriptive, not prescriptive.** Say what the system does, not whether it is good.
5. **Semantic level.** Model semantic actions, not control flow (see Granularity).
6. **Extraction only.** This skill covers building and updating the model.
   Rendering and presentation are separate concerns.

## Granularity

Ignore functions, helpers, and control flow (`if`, loops, string building). Capture
the **semantic actions** that happen and their properties, for example:
- runs a database transaction over these actions;
- sends an email; calls an external API; spawns a process;
- reads/writes this data from the database or disk;
- publishes/consumes a message; acquires a lock; caches a value.

How an action is implemented does not matter. That it happens, in what order, and
with what guarantees (transactional, idempotent, retried, bounded) does.

## What to extract

- **Actors**: things that receive messages (HTTP, RPC, email, CLI, UI events, …)
  and own state. Typically process or service boundaries. Give each a
  **provenance**:
  - `first-party`: implemented in this repository;
  - `third-party`: external software or a service the system depends on;
  - `ambient`: provided by the platform or environment (OS services, the user's shell).

  When in-repo code runs inside an external program (a plugin or extension), model
  it as its own first-party actor next to the third-party host. For first-party
  actors, list the repository paths that implement them in `footprint.paths`,
  without overlapping other actors. Record where every actor runs in `runsOn`:
  `local` (the user's machine), `browser`, `remote` (servers the system operates),
  or `cloud` (managed services), with the `provider` and `platform` when known.
- **Flows**: named paths from a trigger, through semantic actions (possibly
  across actors), to effects. Flows are the main unit of explanation. A step that
  sends or parses data in a modelled protocol names it in `protocol`.
- **Protocols**: the shapes data must have to enter, leave, or rest inside the
  system: RPC and HTTP APIs, socket protocols, event streams, files the system
  reads or writes, and database schemas. Record enough to draw the shape without
  reading code: each message (call, record, event, route, or table) with its
  fields, types, and bounds, and each call's result. Also record transport,
  framing, version, who serves and who uses it, where untrusted input is parsed
  into trusted values (`parsing`), machine-readable definitions in the repository
  (`definitions`), and how old and new shapes coexist (`compatibility`). Find them
  in typed request/response structs, schema files, route tables, and SQL.
- **State**: data each actor owns, where it lives (memory, disk, database), its
  lifetime, and its single source of truth. Note duplicated state that may drift.
- **State machines**: domain states and legal transitions, often visible as enums
  or variants.
- **Invariants**: properties the system makes sure always hold. Record:
  - `enforcement`: `compile-time` (types make violations unrepresentable),
    `runtime` (code checks or restores it), `test-time` (tests exercise it), or
    `documented` (only comments or docs state it);
  - `enforcedAt`: for each trigger that can establish or break it (startup, an
    RPC method, a timer, a child exiting), the call path from the entry point to
    the code that enforces it, outermost frame first. Follow the real calls; skip
    frames that only forward arguments;
  - the tests that exercise it, and the consequence of breaking it.
- **Claims**: statements believed about the system (for example, "terminal bytes
  never leave the host"), with the evidence, how it was established, and the
  elements it is `about`. Invariants are what the code enforces; claims are what
  we believe, including beliefs the code contradicts.
- **Limits**: bounds the system imposes: sizes, counts, timeouts, intervals,
  rates. One file per bound, anchored to the constant or check that sets it
  (with its line), and `about` the actors, protocols, or flows it applies to.

## Process

The model describes the system as a whole, so build it from the outside in:
first the actors, then the flows between connected actors, then the precise
details. Every file the extraction is responsible for must still pass through
context at some point, because reading only the files that look important is how
models miss behaviour (a patch to a dependency, a script that installs a service,
a config that changes a limit). Files read in full are recorded in coverage
ledgers (see Storage); the extraction is not done until every file is read or
skipped as vendored or generated, the model is valid, and it is no longer thin.

One agent does the whole extraction in one session, following the code across
files the way it would to understand the system, rather than reviewing files one
at a time in isolation. Connections between files are much of what the model
records. Run it in the session where the system is being developed (with
`/feynman-extract`), so the model and the work share one context. Never hand the
extraction to a separate agent, subagent, or background process.

### Bootstrap (first snapshot)

Responsible for: **every file git tracks at the commit**, that is, every file the
repository does not ignore, except paths excluded in `.feynman/config.json`.

1. **Actors.** Survey the whole repository before reading anything in depth:
   the tree, manifests, READMEs, entrypoints, configuration; skim widely. Write
   `meta.json` and every actor: first-party components with footprints covering
   their code, and the external people, services, platforms, and programs they
   interact with. Each actor's `talksTo` lists the actors it communicates with.
   This map is done when every actor is connected and the system is summarised.
2. **Flows.** Work through groups of connected actors one at a time, reading
   their code in full, and write the flows that run through them, step by step
   from actor to actor. Add protocols, state, invariants, and limits met on the
   way, and correct the actor map when the code disagrees. Files outside every
   footprint come last.
3. **Depth.** With everything read, revise the model as a whole: every flow step
   with its actor, target, and protocol; failure and recovery flows; protocol
   messages with fields and returns; invariants with their call paths and tests;
   claims with evidence; limits with where they are set; state machines.

The model is thin while a flow involves a single actor, two actors talk with no
flow or protocol showing how, a first-party actor takes part in no flow, a
protocol does not name its server and clients or lists no messages, or a
runtime-enforced invariant has a call path of one frame.

Vendored copies of third-party code may be recorded as a whole directory with
outcome `vendored`, once you have confirmed that is what they are and noted the
origin. Lockfiles and other tool output are `generated`, with their source named.
Patches, wrappers, and build rules around them are first-party and are read.

### Update (diff snapshot)

Responsible for: **every file added, modified, or renamed** between the previously
modelled commit and the new one, and **every element derived from a changed file**.
Each element records `sources`, the content hash (git blob id) of every file it
anchors, so elements whose files changed are known exactly, even when history was
rewritten.

1. Make sure the first snapshot exists: `.feynman/model/` with a `meta.json` whose
   commit is an ancestor of the new commit. If not, bootstrap instead.
2. Set `meta.extraction` to `update`, `meta.source.base.commit` to the previously
   modelled commit, and `meta.source.commit` to the new one. Remove the ledgers
   for the old commit (history keeps them).
3. List the changed files (coverage `--missing`) and get an overview of the
   model (`index`).
4. Read the changed files group by group (phase 2, limited to them) and
   re-examine the outdated elements listed for them; **edit** them, and add or
   remove elements as needed. Do not regenerate the whole model. For deleted or
   moved files, update the anchors that pointed at them.
5. Revise for depth (phase 3), then measure, validate, and run coverage.

## Storage

The model is a directory, `.feynman/model/` in the target repository, with one
file per element so that no agent has to hold the whole model at once:

```
.feynman/model/
  meta.json
  actors/<id>.json      flows/<id>.json        protocols/<id>.json
  state/<id>.json       state-machines/<id>.json
  invariants/<id>.json  claims/<id>.json       limits/<id>.json
  coverage/<batch>.json
```

An element's id is its file name (a readable kebab-case slug) and is not repeated
inside the file. `sources` is written by tools (`measure`), never by hand: the git
blob id of each file the element anchors, as the file is on disk (committed or not). Ids are unique within a kind, need not be stable, and renaming
one means moving its file. Fields that name a specific kind use a bare id
(`actor`, `target`, `owner`, `server`, `clients`, `from`, `talksTo` name actors; `ref` names
a flow; `protocol` names a protocol). `about` can name any kind, so it uses the
path without `.json`: `flows/pi-recovery`, `protocols/pi-bridge`.

`.feynman/config.json` (optional, next to the model directory) configures how the
repository is modelled. `exclude` lists git pathspecs that are not part of the
system being modelled, such as generated examples or fixtures checked in for other
purposes:

```json
{ "exclude": ["examples/"] }
```

Excluded files are never required for coverage and are not counted in code
footprints. Exclude only what is genuinely outside the system; it is a statement
about scope, not a way to finish faster.

Coverage ledgers record what each extraction pass covered, at which commit: one
file per batch, listing every file with its outcome: `read` (read in full,
recorded automatically), `vendored`, or `generated` (with a note naming the
origin). Older ledgers may say `modelled` or `no-behaviour`. Ledgers are not
rendered.

Each file must validate against its schema in `packages/model/schema/` of the
Feynman repository (JSON Schema 2020-12; shared definitions in `common.json`). Together they are the
contract that rendering relies on.

Anchors are repository-relative paths, narrowed by symbol, by span, or both:
- shorthand strings: `path`, `path#symbol`, `path:10-42`, `path:10:5-42:2`;
- objects: `{ "file": "path", "symbol": "name", "span": { "start": { "line": 10, "column": 5 }, "end": { "line": 42 } } }`.

Lines and columns are 1-based and inclusive, at the modelled commit. Prefer a
symbol when one exists, and add a span when the behaviour is a few lines inside
a larger body (a guard, a SQL statement, a lock scope).

When the vocabulary changes, update the schemas and this skill together.

## Tools

Mechanical facts come from tools, not from the agent.

### In Pi, with the `pi-feynman` package (an adapter over `@feynman/modeler`)

- `feynman_extract` starts or resumes an extraction at HEAD: a bootstrap when
  there is no model, otherwise an update from the modelled commit (it sets
  `meta.source.base`, and drops ledgers for the old commit). Tracked files must
  match HEAD.
- Files read in full with `read` (continuing truncated output with offsets) are
  recorded automatically; searching or listing does not count. Ledgers cannot be
  written any other way.
- `feynman_skip` records vendored or generated files or trees, with a note
  naming their origin, so they need not be read.
- `feynman_status` shows the phase, coverage, the current group or what the
  model lacks, and model problems.
- Whenever the agent stops, the extension checks where the extraction stands,
  moves to the next phase when the current one is done, and asks the agent to
  continue (with the next group of actors in phase 2) until every file is read,
  the model is valid, and it is no longer thin; then it measures the model. `/feynman-stop`
  stops this; `/feynman-render` renders the model to `.feynman/index.html`.

### From the command line

`node packages/model/bin/feynman-model.ts <command>` in the Feynman repository
(or `bun run model <command>`):

- `index <model-dir> [<kind>…]` prints one line per element, for finding what
  exists without loading every file.
- `coverage <repository> <model-dir> [--missing]` computes the files this
  extraction is responsible for (all tracked files for a bootstrap, the changed
  files for an update; never `.feynman/` itself), compares them with the ledgers
  for the modelled commit, and fails while any are unreviewed. `--missing` lists
  them one per line.
- `check <model-dir> [<repository>]` validates every file against its schema and
  checks cross-references. With a repository, it checks that every anchor exists
  at the modelled commit and that spans fall inside their files.
- `measure <repository> <model-dir> [--main <ref>]` fills source links (`url`,
  `commitUrl`, `fileUrl`), the commit date, the commit's position relative to
  main, file and line counts for the repository and each actor's footprint, and
  every element's `sources`.
