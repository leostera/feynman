---
name: modelling
description: Extract and maintain a behavioural model of a software system (actors, flows, semantic actions, state, invariants, boundaries, measurements, claims) from its code, stored in `.feynman/model.json`. Use when building a repository's model for the first time or updating it after a change.
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
  and own state. Typically process or service boundaries.
- **Messages**: what each actor accepts and emits, and over which transport. Find
  them in route tables, RPC method lists, CLI definitions, and event handlers.
- **Flows**: named paths from a trigger message, through semantic actions (possibly
  across actors), to effects. Flows are the main unit of explanation.
- **State**: data each actor owns, where it lives (memory, disk, database), its
  lifetime, and its single source of truth. Note duplicated state that may drift.
- **State machines**: domain states and legal transitions, often visible as enums
  or variants.
- **Boundaries**: where untrusted or weakly structured data (network, config, CLI,
  files, database rows) is parsed into trusted domain values, and whether effects
  only happen after parsing.
- **Invariants**: properties that must hold. For each, record how it is enforced
  (type, runtime check/assertion, test, or only a comment) and the consequence of
  breaking it.
- **Contracts**: external behaviour that must stay stable: public APIs, wire
  protocols, persisted formats, user-visible behaviour. Note compatibility layers
  and any coexisting implementations, with their removal condition if one is stated.
- **Observability**: for each flow, which logs, spans, and metrics make it
  followable, and whether trace context crosses its boundaries.
- **Measurements**: quantities stated in code, tests, or benchmarks: limits, sizes,
  timeouts, retry counts, concurrency, cache policies.
- **Claims**: statements about the system (for example, "all refunds are manually
  approved"). Each lists the files that support it: code, tests, config, docs.

## Process

### Bootstrap (first time)

1. Respect the repository's `.gitignore`: skip anything git ignores.
2. Survey the README, docs, build graph, and entrypoints.
3. Identify actors and their transports.
4. Enumerate each actor's messages.
5. Trace flows through their semantic actions.
6. Extract state, state machines, boundaries, invariants, and contracts.
7. Attach observability, measurements, and claims.
8. Write `.feynman/model.json` and validate it (see Storage).

### Update (per change)

Input: the existing `.feynman/model.json` and the code diff.
1. Find the elements whose anchored files the diff touches, and any new behaviour.
2. **Edit** those elements, and add or remove elements as needed. Do not regenerate
   the whole model.
3. Follow moved or renamed files and update anchors.
4. Write the updated `.feynman/model.json` and validate it (see Storage).

## Storage

Store the model as JSON at `.feynman/model.json` in the target repository. It must
validate against [`schema.json`](schema.json) (JSON Schema 2020-12), which is the
contract that visualizations rely on. Also check that:
- every `actor`, `target`, `ref`, `boundary`, and `owner` names an existing `id`;
- every anchor path exists in the repository.

Anchors are repository-relative paths, optionally `path#symbol`. Element `id`s are
readable slugs for cross-references within one model and need not be stable.

When the vocabulary changes, update `schema.json` and this skill together.
