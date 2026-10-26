// The published simulators, as sims.json lists them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refOf } from "./published.ts";

export interface Sim {
  /** `<host>/<owner>/<repo>`: the page is served at /s/<slug>/. */
  slug: string;
  title: string;
  summary: string;
  repository: string;
  /**
   * "deploy": built from this repository as it is. Otherwise from a clone of `repository`
   * at `commit`. Either way scripts/pages.ts builds the page on every build; none is committed.
   */
  build?: "deploy";
  /** The commit the page is built from (null when built from this repository), and the specs it holds. */
  commit: string | null;
  specs: { path: string; title: string }[];
}

const FILE = join(import.meta.dirname, "..", "sims.json");
export const SITE = "https://feynman.leostera.dev";

export const readSims = (): Sim[] => JSON.parse(readFileSync(FILE, "utf8"));
export const writeSims = (sims: Sim[]) => writeFileSync(FILE, JSON.stringify(sims, null, 2) + "\n");
export const simUrl = (sim: Sim) => `${SITE}/s/${sim.slug}/`;
export const specUrl = (sim: Sim, path: string) => `${sim.repository}/blob/${refOf(sim)}/${path}`;
export { published, refLabel, refOf } from "./published.ts";
