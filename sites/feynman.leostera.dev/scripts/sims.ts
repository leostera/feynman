// The published simulators, as sims.json lists them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Sim {
  /** `<host>/<owner>/<repo>`: the page is served at /s/<slug>/. */
  slug: string;
  title: string;
  summary: string;
  repository: string;
  /** The commit the committed page was built from, and the specs it holds then. */
  commit: string | null;
  specs: { path: string; title: string }[];
}

const FILE = join(import.meta.dirname, "..", "sims.json");
export const SITE = "https://feynman.leostera.dev";

export const readSims = (): Sim[] => JSON.parse(readFileSync(FILE, "utf8"));
export const writeSims = (sims: Sim[]) => writeFileSync(FILE, JSON.stringify(sims, null, 2) + "\n");
export const simUrl = (sim: Sim) => `${SITE}/s/${sim.slug}/`;
export const specUrl = (sim: Sim, path: string) => `${sim.repository}/blob/${sim.commit}/${path}`;
