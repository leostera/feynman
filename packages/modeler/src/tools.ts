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
      "Record vendored or generated files for the Feynman model, so they need not be read: copies of third-party code, lockfiles, tool output. A directory ending in `/` covers everything under it. Everything else is recorded automatically once you have read it in full.",
    snippet: "Record vendored or generated files that need not be read for the Feynman model",
    params: {
      paths: "Repository-relative files, or directories ending in `/`",
      outcome: "vendored: a copy of someone else's code. generated: output of a tool in or outside this repository.",
      note: "Where it comes from, e.g. `lockfile written by bun install` or `copy of xterm.js 5.3`",
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
