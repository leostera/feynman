// feynman.config.ts: where specs live, and the checker's defaults. This module is what a
// config imports (as @leostera/feynman/config), so it imports nothing that runs: reading a
// config is the loader's (readConfig in load.ts).
import type { Bounds } from "../check/index.ts";

export interface Config {
  /** Globs of spec files, relative to the repository root. By default `specs/*.ts` next to any package.json. */
  specs?: string[];
  /** Checker bounds; flags override them. */
  check?: Partial<Bounds>;
}

export const CONFIG_FILE = "feynman.config.ts";

export function defineConfig(config: Config): Config {
  return config;
}
