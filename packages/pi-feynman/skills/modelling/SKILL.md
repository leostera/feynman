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

Every extraction accounts for every file it is responsible for. Reading only the
files that look important is how models miss behaviour (a patch to a dependency,
a script that installs a service, a config that changes a limit). Record what you
reviewed in coverage ledgers (see Storage), and do not finish until coverage
passes and the model is valid.

One agent does the whole extraction in one session, following the code across
files the way it would to understand the system, rather than reviewing files one
at a time in isolation. Connections between files are much of what the model
records. Run it in the session where the system is being developed (with
`/feynman-extract`), so the model and the work share one context. Never hand the
extraction to a separate agent, subagent, or background process.

### Bootstrap (first snapshot)

Responsible for: **every file git tracks at the commit**, that is, every file the
repository does not ignore, except paths excluded in `.feynman/config.json`.

1. Survey the README, docs, build graph, and entrypoints.
2. Identify actors and where they run.
3. Follow the code from the entrypoints: protocols, flows and their semantic
   actions, state, state machines, invariants with their enforcement paths,
   claims, and limits. Write and refine elements as understanding grows.
4. Record files as reviewed once the model reflects them, with their outcome.
5. Check what is still unreviewed and keep going until coverage passes; then
   measure and validate (see Tools).

Vendored copies of third-party code may be listed as a whole directory with
outcome `vendored`, once you have confirmed that is what they are and noted the
origin. Lockfiles and other tool output are `generated`, with their source named. Patches, wrappers, and build rules around them are first-party and are
reviewed file by file. Generated trees are listed the same way, as `generated`,
when the files they are generated from are reviewed.

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
4. Read every changed file and re-examine the outdated elements listed for it;
   **edit** them, and add or remove elements as needed. Do not regenerate the whole model. For deleted
   or moved files, update the anchors that pointed at them.
5. Record each changed file in a ledger, then measure, validate, and run coverage.

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
(`actor`, `target`, `owner`, `server`, `clients`, `from` name actors; `ref` names
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

Coverage ledgers record what each extraction pass reviewed, at which commit:
one file per batch, listing every reviewed file with its outcome: `modelled`
(the model reflects what it contributes), `no-behaviour` (read; nothing to model),
`vendored`, or `generated`. Ledgers are not rendered.

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
- `feynman_reviewed` records files as reviewed, with their outcome. `modelled`
  and `no-behaviour` files must have been read in full with `read` in this
  session (searching or listing does not count), and `modelled` files must be
  anchored by some element. `vendored` and `generated` files and trees need a
  note naming their origin instead. Ledgers cannot be written any other way.
- `feynman_status` shows coverage and model problems.
- Whenever the agent stops, the extension checks coverage and validity, and asks
  it to continue until both pass; then it measures the model. `/feynman-stop`
  stops this; `/feynman-render` renders the model to `.feynman/index.html`.

### From the command line

`node packages/model/bin/feynman-model.mjs <command>` in the Feynman repository
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
