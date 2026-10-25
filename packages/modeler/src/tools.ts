// The agent-facing operations, described once so every runtime adapter exposes
// them the same way. Adapters translate these into their own tool definitions.
import { OUTCOMES } from "./extraction.ts";

export const TOOLS = {
  extract: {
    name: "feynman_extract",
    label: "Feynman: extract",
    description:
      "Start (or resume) extracting the Feynman model of the current repository at HEAD: a first snapshot when there is no model, or an update from the modelled commit. Returns what to do; afterwards, coverage is checked whenever you stop.",
    snippet: "Start or resume extracting the Feynman model of this repository",
  },
  reviewed: {
    name: "feynman_reviewed",
    label: "Feynman: reviewed",
    description:
      "Record repository files as reviewed for the Feynman model, with what each contributed. Only files you have read (or named in a command) in this session are accepted. A directory ending in `/` may be recorded whole only as `vendored` or `generated`.",
    snippet: "Record files as reviewed for the Feynman model",
    guideline:
      "While extracting a Feynman model, call feynman_reviewed for files once you have read them and reflected them in the model; batch several files per call.",
    params: {
      path: "Repository-relative path",
      outcome: "modelled: the model reflects it. no-behaviour: nothing to model. vendored or generated: say the origin in note.",
      summary: "What this session has covered so far, in a phrase",
    },
    outcomes: OUTCOMES,
  },
  status: {
    name: "feynman_status",
    label: "Feynman: status",
    description:
      "Show Feynman model coverage (files reviewed out of those required, unreviewed files by directory) and any model validation problems.",
    snippet: "Check Feynman model coverage and validity",
    params: { missing: "List every unreviewed path instead of a sample" },
  },
} as const;
