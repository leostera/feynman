---
name: rendering
description: Render a Feynman model (`.feynman/model.json`, see the modelling skill) into a self-contained, TiddlyWiki-style HTML file that explains how a system works through several views. Use when producing or updating the human-facing artifact for a model.
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
   detail pages have sections with an "On this page" rail on the right. Every page
   has a stable URL fragment (`#/actors`, `#/actors/<id>`, `#/flows/<id>`, …), so
   links, back/forward, and bookmarks work.
3. **Views over one model.** Diagrams are views of the model, never separate data.
   Where several notations fit (sequence diagram vs. swimlane, list vs. graph), offer
   all of them and let the reader switch; remember the reader's preference.
4. **Descriptive.** Show what the model says, including uncertainty: claim status,
   epistemic status, and unverified or contradicted claims are visible, not hidden.
5. **Grounded.** Every page shows its anchors, linked to the source at the modelled
   commit when the model has a `fileUrl`.
6. **Data, not inference.** When a view needs a fact (provenance, code footprint,
   what a claim is about), add it to the model and its schema rather than guessing
   it in the renderer.
7. **Looks good by default.** Build the UI with Kumo (`@cloudflare/kumo`,
   https://kumo-ui.com): use its components, semantic colour tokens
   (`bg-kumo-*`, `text-kumo-*`), and light/dark mode via `data-mode`. Do not use raw
   Tailwind colours.

## Modes

- **Current state**: the inventory of the system at the modelled commit.
- Further modes (for example, a change between two models) are to be defined.

## Views (v0)

- **Overview**: what the system is, an inventory of each element kind, the system
  graph, and the claims that need attention.
- **Actors**: first-party actors (with their share of repository code) separated
  from external ones (third-party and ambient). An actor page lists the flows it
  initiates, takes part in, or receives from; its messages; the state it owns;
  claims about it; its code; and its anchors.
- **Flows**: each flow as a sequence diagram or a swimlane, plus its steps as a list
  with properties, sub-flows, and boundaries.
- **State**: owned data, lifetimes, and state machines.
- **Invariants and boundaries**: what must hold, how it is enforced, where data
  becomes trusted.
- **Claims**: grouped by status, each linked to its evidence.
- **Measurements**: limits, timeouts, and rates, grouped by kind.

## Process

1. Validate the model: `node tools/check-model.mjs <model.json> <repository>`.
2. Render it (paths are relative to `renderer/`):
   `bun run render ../examples/axo/model.json ../examples/axo/index.html`.
3. Check the output visually, for example with headless Chrome:
   `chrome --headless=new --screenshot=out.png --window-size=1440,1400 "file://<out.html>#flow:<id>"`.
   Every card is addressable by fragment (`#overview:system`, `#flow:<id>`,
   `#index:claims`, comma-separated to open several).

## Implementation

`renderer/` is a Vite + React + Kumo app (bun workspace) bundled into a single HTML
file with `vite-plugin-singlefile`. The model is embedded as
`<script type="application/json" id="feynman-model">`. The renderer relies only on
the schema, never on a particular system.

- `src/model.ts`: schema types and the cross-reference index.
- `src/router.tsx`: fragment routes and persisted reader preferences.
- `src/App.tsx`: the shell (top bar, navigation, page area).
- `src/pages/`: index and detail pages per element kind.
- `src/ui.tsx`: shared page structure and content blocks.
- `src/diagrams/`: sequence diagram, swimlane, and system graph (ECharts).

Committed files must not contain organisation-specific registry or service URLs.
