// .feynman/config.json: per-repository settings for modelling.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { schemaProblems } from "./schema.ts";

export interface Config {
  /** Git pathspecs, relative to the repository root, that are not part of the modelled system. */
  exclude: string[];
}

/** The config file belonging to a model directory (`.feynman/model` → `.feynman/config.json`). */
export function configPath(modelDir: string): string {
  return join(dirname(modelDir), "config.json");
}

/** The repository's config, defaults filled in; throws when the file is not valid JSON or not a valid config. */
export function readConfig(modelDir: string): Config {
  const path = configPath(modelDir);
  if (!existsSync(path)) return { exclude: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  const problems = schemaProblems("config", value);
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return { exclude: [], ...(value as Partial<Config>) };
}
