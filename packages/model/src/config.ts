// .feynman/config.json: per-repository settings for modelling.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The config file belonging to a model directory (`.feynman/model` → `.feynman/config.json`). */
export interface Config {
  /** Git pathspecs that are not part of the modelled system. */
  exclude: string[];
}

export function configPath(modelDir: string): string {
  return join(dirname(modelDir), "config.json");
}

/** The repository's config, with defaults; `{ exclude: [] }` when there is none. */
export function readConfig(modelDir: string): Config {
  const path = configPath(modelDir);
  if (!existsSync(path)) return { exclude: [] };
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    return { exclude: [], ...config };
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

/** Git pathspecs for the whole repository except excluded paths (for diff, grep, …). */
export function excludePathspecs(exclude: string[]): string[] {
  return [":/", ...exclude.map((pattern) => `:(top,exclude)${pattern}`)];
}
