---
name: rendering
description: Render a Feynman model (`.feynman/model/`, see the modelling skill) into a self-contained HTML file that explains how a system works through several views. Use when producing or updating the human-facing artifact for a model.
---

# Rendering

People read the rendered model, never the JSON. It should build understanding in
small, mostly visual steps, from the actors down to the files behind any element.

## Principles

1. **One self-contained file.** All code, styles, and the model inlined; opens
   offline with a double-click. The same model renders to the same bytes.
2. **An app shell over an inventory.** A top bar (system, commit with its age and
   position relative to main, a badge for uncommitted changes), a left navigation
   of element kinds and flows, one page at a time. Pages are dense, without card
   frames; their sections are tabs, with diagrams above them. Every page has a
   URL fragment (`#/actors/<id>`, `#/flows/<id>`), so links and history work.
3. **Views over one model.** Diagrams are views of the model, never separate data.
   Where several notations fit (sequence or swimlane), offer each and remember the
   reader's choice.
4. **Descriptive and grounded.** Show uncertainty (claim and epistemic status)
   rather than hiding it, and link every anchor to its source when the model has
   a `fileUrl`.
5. **Data, not inference.** When a view needs a fact, add it to the model and its
   schema; never guess it in the renderer.
6. **Kumo.** Build with `@cloudflare/kumo` components and semantic tokens
   (`bg-kumo-*`, `text-kumo-*`), light and dark via `data-mode`; no raw Tailwind
   colours.

## Views

- **Actors** (the home page): the actor graph (people as figures, colour by where
  they run, external actors hollow), then tabs for first-party actors with their
  share of code, external actors, and interacting pairs. An actor page: flows and
  its role in each, protocols, owned state, claims, limits, components, anchors.
- **Components**: the dependency graph and each component's actors and code.
- **Flows**: trigger and outcome, then steps as a sequence diagram, swimlane, or
  list, with components, sub-flows, and protocols.
- **Protocols**: transport, framing, server and clients, messages by kind with
  fields and results, parsing, limits, and the flows that use it.
- **State** and state machines; **invariants** with each enforcement path drawn as
  a call stack; **claims** by status with evidence; **limits** by kind.

## Process

1. Validate: `bun run model check <model-dir> <repository>`.
2. Render: `/feynman-render` in Pi, or `bun run render <model-dir> <out.html>` in
   the Feynman repository (relative to `packages/renderer/`).
3. Look at it, for example with headless Chrome:
   `chrome --headless=new --window-size=1440,1000 --screenshot=out.png "file://<out.html>#/flows/<id>"`.

## Implementation

`packages/renderer/` is a Vite, React, and Kumo app bundled into one HTML file
with `vite-plugin-singlefile`; the model is embedded as
`<script type="application/json" id="feynman-model">`.

- `src/model.ts`: the model types (from `@feynman/model`), routes, and the index.
- `src/App.tsx`: the shell. `src/router.tsx`: routes and reader preferences.
- `src/ui.tsx`: page structure, tables (`Rows`), and shared blocks.
- `src/pages/`: one module per element kind. `src/diagrams/`: ECharts diagrams.

Committed files must not contain organisation-specific registry or service URLs.
