// What the site says about a published simulator; pure, so the page can use it too.
import type { Sim } from "./sims.ts";

/** Whether a simulator has a page: built and committed at a commit, or built on every deploy. */
export const published = (sim: Sim) => sim.commit !== null || sim.build === "deploy";

/** The git ref its spec links point at: the commit it was built from, or main for what deploys build. */
export const refOf = (sim: Sim) => sim.commit ?? "main";

/** The ref as a reader sees it: a short commit, or "main". */
export const refLabel = (sim: Sim) => (sim.commit ? sim.commit.slice(0, 7) : "main");
