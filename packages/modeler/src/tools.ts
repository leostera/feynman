// The agent-facing operations, described once so every runtime adapter exposes
// them the same way. Adapters translate these into their own tool definitions.
import { SKIP_OUTCOMES } from "./extraction.ts";

export const TOOLS = {
  extract: {
    name: "feynman_extract",
    label: "Feynman: extract",
    description:
      "Start or resume extracting the Feynman model of this repository at HEAD: a first snapshot, or an update from the modelled commit. Returns what to do; coverage is checked whenever you stop.",
    snippet: "Start or resume extracting the Feynman model of this repository",
  },
  skip: {
    name: "feynman_skip",
    label: "Feynman: skip",
    description:
      "Set aside files that are not part of how the system behaves, so they need not be read: development files (CI, build and release scripts, tooling, project websites, contributor docs), vendored code, and generated output. Tests are not development; read them. A path ending in `/` covers its directory. Files you read in full are recorded automatically.",
    snippet: "Set aside development, vendored, or generated files for the Feynman model",
    params: {
      paths: "Repository-relative files, or directories ending in `/`",
      outcome: "development: how the system is developed, built, or published. vendored: a copy of someone else's code. generated: output of a tool.",
      note: "What it is for or where it comes from, e.g. `publishes the npm packages`, `lockfile written by bun install`, `copy of xterm.js 5.3`",
    },
    outcomes: SKIP_OUTCOMES,
  },
  status: {
    name: "feynman_status",
    label: "Feynman: status",
    description: "Show where the Feynman extraction stands: phase, coverage, the current group or what the model lacks, and validation problems.",
    snippet: "Check Feynman model coverage and validity",
    params: { missing: "List every uncovered path instead" },
  },
} as const;
