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

### Bootstrap (first time)

1. Respect the repository's `.gitignore`: skip anything git ignores.
2. Survey the README, docs, build graph, and entrypoints.
3. Identify actors and where they run.
4. Extract the protocols between them, and the files and schemas they persist.
5. Trace flows through their semantic actions.
6. Extract state, state machines, and invariants with their enforcement paths.
7. Record claims and limits.
8. Write the files, measure, and validate (see Tools).

Large systems can be split across agents: one per subsystem, protocol, or group
of flows, each writing its own files. Agree on actor ids first, since other
elements refer to them.

### Update (per change)

Input: the existing `.feynman/model/` and the code diff.
1. Run `tools/index-model.mjs` for an overview, then find the elements whose
   anchored files the diff touches, and any new behaviour. Load only those files.
2. **Edit** those elements, and add or remove elements as needed. Do not regenerate
   the whole model.
3. Follow moved or renamed files and update anchors.
4. Write the changed files, measure, and validate (see Tools).

## Storage

The model is a directory, `.feynman/model/` in the target repository, with one
file per element so that no agent has to hold the whole model at once:

```
.feynman/model/
  meta.json
  actors/<id>.json      flows/<id>.json        protocols/<id>.json
  state/<id>.json       state-machines/<id>.json
  invariants/<id>.json  claims/<id>.json       limits/<id>.json
```

An element's id is its file name (a readable kebab-case slug) and is not repeated
inside the file. Ids are unique within a kind, need not be stable, and renaming
one means moving its file. Fields that name a specific kind use a bare id
(`actor`, `target`, `owner`, `server`, `clients`, `from` name actors; `ref` names
a flow; `protocol` names a protocol). `about` can name any kind, so it uses the
path without `.json`: `flows/pi-recovery`, `protocols/pi-bridge`.

Each file must validate against its schema in [`schema/`](schema/) (JSON Schema
2020-12; shared definitions in `schema/common.json`). Together they are the
contract that rendering relies on.

Anchors are repository-relative paths, narrowed by symbol, by span, or both:
- shorthand strings: `path`, `path#symbol`, `path:10-42`, `path:10:5-42:2`;
- objects: `{ "file": "path", "symbol": "name", "span": { "start": { "line": 10, "column": 5 }, "end": { "line": 42 } } }`.

Lines and columns are 1-based and inclusive, at the modelled commit. Prefer a
symbol when one exists, and add a span when the behaviour is a few lines inside
a larger body (a guard, a SQL statement, a lock scope).

When the vocabulary changes, update `schema/` and this skill together.

## Tools

Mechanical facts come from tools, not from the agent:

- `node tools/index-model.mjs <model-dir> [<kind>…]` prints one line per element,
  for finding what exists without loading every file.
- `node tools/measure.mjs <repository> <model-dir> [--main <ref>]` fills source links
  (`url`, `commitUrl`, `fileUrl`), the commit date, the commit's position relative to
  main, and file and line counts for the repository and each actor's footprint.
  Counts are taken at the modelled commit and skip `meta.source.footprint.excludes`.
- `node tools/check-model.mjs <model-dir> [<repository>]` validates every file
  against its schema and checks cross-references. With a repository, it checks
  that every anchor exists at the modelled commit and that spans fall inside
  their files.
