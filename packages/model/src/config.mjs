// .feynman/config.json: per-repository settings for modelling.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The config file belonging to a model directory (`.feynman/model` → `.feynman/config.json`). */
export function configPath(modelDir) {
  return join(dirname(modelDir), "config.json");
}

/** The repository's config, with defaults; `{ exclude: [] }` when there is none. */
export function readConfig(modelDir) {
  const path = configPath(modelDir);
  if (!existsSync(path)) return { exclude: [] };
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    return { exclude: [], ...config };
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

/** Git pathspecs for the whole repository except excluded paths (for diff, grep, …). */
export function excludePathspecs(exclude) {
  return [":/", ...exclude.map((pattern) => `:(top,exclude)${pattern}`)];
}
