// feynman.config.ts: where specs live, and the checker's defaults.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Bounds } from "@feynman/check";
import { importFresh } from "./load.ts";

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

export async function readConfig(root: string): Promise<Config> {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return {};
  const module = (await importFresh(path)) as { default?: Config };
  return module.default ?? {};
}
