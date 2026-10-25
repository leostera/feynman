// The agent-facing operations, described once so every runtime adapter exposes
// them the same way. Adapters translate these into their own tool definitions.
import { SKIP_OUTCOMES } from "./extraction.ts";

export const TOOLS = {
  extract: {
    name: "feynman_extract",
    label: "Feynman: extract",
    description:
      "Start (or resume) extracting the Feynman model of the current repository at HEAD: a first snapshot when there is no model, or an update from the modelled commit. Returns what to do; afterwards, coverage is checked whenever you stop.",
    snippet: "Start or resume extracting the Feynman model of this repository",
  },
  skip: {
    name: "feynman_skip",
    label: "Feynman: skip",
    description:
      "Set aside files that are not part of how the system behaves, so they need not be read in full: files about developing it (CI, build and release scripts, workspace setup, project websites, contributor docs; not tests, which check behaviour and are read), copies of third-party code, and generated output. A directory ending in `/` covers everything under it. Everything else is recorded automatically once you have read it in full.",
    snippet: "Set aside development, vendored, or generated files for the Feynman model",
    params: {
      paths: "Repository-relative files, or directories ending in `/`",
      outcome:
        "development: how the system is developed, built, or published, not how it behaves (tests are not development). vendored: a copy of someone else's code. generated: output of a tool in or outside this repository.",
      note: "What it is for or where it comes from, e.g. `publishes the npm packages`, `lockfile written by bun install`, `copy of xterm.js 5.3`",
    },
    outcomes: SKIP_OUTCOMES,
  },
  status: {
    name: "feynman_status",
    label: "Feynman: status",
    description:
      "Show where the Feynman extraction stands: its phase, how many files are read, the current group of actors to read or what the model still lacks, and any validation problems.",
    snippet: "Check Feynman model coverage and validity",
    params: { missing: "List every unread path instead" },
  },
} as const;
