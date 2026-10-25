---
name: rendering
description: Render a Feynman model (`.feynman/model/`, see the modelling skill) into a self-contained HTML file that explains how a system works through several views. Use when producing or updating the human-facing artifact for a model.
---

# Rendering

Status: draft. Update this skill as the design evolves.

## Purpose

Nobody reads the model JSON. People read the rendered artifact. It should help a
reader build understanding in small steps, mostly visually, and let them move
from an overview down to the files behind any element.

## Principles

1. **One self-contained file.** A single `.html` with all code, styles, and the model
   inlined. No network access needed; double-click to open; easy to move around.
2. **An app shell over an inventory.** A top bar (system, source commit with a link,
   its age and position relative to main, view mode), a left navigation of every
   element kind, and one page at a time in the centre. Index pages are tables;
   detail pages have sections with an "On this page" rail on the right. Index pages
   show the table directly, with at most a one-line summary above it. Every page
   has a stable URL fragment (`#/actors`, `#/actors/<id>`, `#/flows/<id>`, …), so
   links, back/forward, and bookmarks work.
3. **Views over one model.** Diagrams are views of the model, never separate data.
   Where several notations fit (sequence diagram vs. swimlane, list vs. graph), offer
   all of them and let the reader switch; remember the reader's preference.
4. **Descriptive.** Show what the model says, including uncertainty: claim status,
   epistemic status, and unverified or contradicted claims are visible, not hidden.
5. **Grounded.** Every page shows its anchors, linked to the source at the modelled
   commit when the model has a `fileUrl`.
6. **Data, not inference.** When a view needs a fact (provenance, where an actor
   runs, a protocol's fields, an invariant's call path), add it to the model and
   its schema rather than guessing it in the renderer.
7. **At rest, minimal.** Show what is needed to understand the system as built.
   Drop sections that would only list anchors without saying anything.
8. **Looks good by default.** Build the UI with Kumo (`@cloudflare/kumo`,
   https://kumo-ui.com): use its components, semantic colour tokens
   (`bg-kumo-*`, `text-kumo-*`), and light/dark mode via `data-mode`. Do not use raw
   Tailwind colours.

## Modes

- **Current state**: the inventory of the system at the modelled commit.
- Further modes (for example, a change between two models) are to be defined.

## Views (v0)

- **Overview**: what the system is, an inventory of each element kind, the actor
  graph, and the claims that need attention.
- **Actors**: a table (first-party actors with their share of code, then external
  ones) or a graph (one edge per interacting pair, coloured by where each actor
  runs, external actors hollow). An actor page lists where it runs, its flows, the
  protocols it serves or uses, the state it owns, claims and limits about it, its
  code, and its anchors.
- **Flows**: each flow as a sequence diagram or a swimlane, plus its steps as a list
  with properties, sub-flows, and the protocols they speak.
- **Protocols**: each protocol's transport, framing, owner and clients, then its
  messages grouped by kind (calls, routes, records, events, tables) with fields,
  types, bounds, and results; where input is parsed; its limits; and the flows
  that use it.
- **State**: owned data, lifetimes, and state machines.
- **Invariants**: a table of name, statement, and enforcement (compile-time,
  runtime, test-time, documented). An invariant page draws each enforcement path
  as a call stack from its trigger to the enforcing frame, linked to the source.
- **Claims**: grouped by status, each linked to its evidence.
- **Limits**: grouped by kind, each linked to the constant that sets it.

## Process

1. Validate the model: `bun run model check <model-dir> <repository>`.
2. Render it: `/feynman render` in Pi, or from the Feynman repository
   `bun run render <model-dir> <out.html>` (relative paths resolve from
   `packages/renderer/`). The build bundles the directory with `@feynman/model`
   (collections sorted by id), so the output is byte-identical for the same model.
3. Check the output visually, for example with headless Chrome:
   `chrome --headless=new --screenshot=out.png --window-size=1440,1000 "file://<out.html>#/flows/<id>"`.

## Implementation

`packages/renderer/` is a Vite + React + Kumo app (bun workspace) bundled into a single HTML
file with `vite-plugin-singlefile`. The model directory is bundled into one object
and embedded as
`<script type="application/json" id="feynman-model">`. The renderer relies only on
the schema, never on a particular system.

- `src/model.ts`: schema types and the cross-reference index.
- `src/router.tsx`: fragment routes and persisted reader preferences.
- `src/App.tsx`: the shell (top bar, navigation, page area).
- `src/pages/`: index and detail pages per element kind.
- `src/ui.tsx`: shared page structure and content blocks.
- `src/diagrams/`: sequence diagram, swimlane, and system graph (ECharts).

Committed files must not contain organisation-specific registry or service URLs.
