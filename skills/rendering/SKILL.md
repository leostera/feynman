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
2. **TiddlyWiki-style navigation.** Every model element is a small card ("tiddler")
   with a stable URL fragment. References between elements are links; opening one
   adds its card to the page instead of replacing it, so the reader keeps context.
3. **Views over one model.** Diagrams are views of the model, never separate data.
   Where several notations fit (sequence diagram vs. swimlane, list vs. graph), offer
   all of them and let the reader switch; remember the reader's preference.
4. **Descriptive.** Show what the model says, including uncertainty: claim status,
   epistemic status, and unverified or contradicted claims are visible, not hidden.
5. **Grounded.** Every card shows its anchors so a reader can jump to the code.
6. **Looks good by default.** Build the UI with Kumo (`@cloudflare/kumo`,
   https://kumo-ui.com): use its components, semantic colour tokens
   (`bg-kumo-*`, `text-kumo-*`), and light/dark mode via `data-mode`. Do not use raw
   Tailwind colours.

## Views (v0)

- **Overview**: what the system is, its actors, and counts of each element kind.
- **System**: actors and the transports between them.
- **Flows**: each flow as a sequence diagram or a swimlane, plus its steps as a list
  with properties, sub-flows, and boundaries.
- **State**: owned data, lifetimes, and state machines.
- **Invariants and boundaries**: what must hold, how it is enforced, where data
  becomes trusted.
- **Claims**: grouped by status, each linked to its evidence.
- **Measurements**: limits, timeouts, and rates, grouped by kind.

## Process

1. Validate the model against `skills/modelling/schema.json`.
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
- `src/navigation.tsx`: the story river (open cards, URL fragment) and reader preferences.
- `src/cards.tsx`: one card per element kind, plus index cards.
- `src/diagrams/`: sequence diagram, swimlane, and system graph (ECharts).

Committed files must not contain organisation-specific registry or service URLs.
