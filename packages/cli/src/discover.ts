// Finding specs: `specs/*.ts` next to any package.json (the repository root counts), or
// the globs in feynman.config.ts.
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tryGit } from "@feynman/code";
import type { Config } from "./config.ts";

export function discoverSpecs(root: string, config: Config): string[] {
  const files = (tryGit(root, "ls-files", "--cached", "--others", "--exclude-standard") ?? "").split("\n").filter(Boolean);
  if (config.specs?.length) {
    const globs = config.specs.map((glob) => new Bun.Glob(glob));
    return files.filter((file) => globs.some((glob) => glob.match(file))).sort();
  }
  return files
    .filter((file) => /(^|\/)specs\/[^/]+\.ts$/.test(file) && !file.endsWith(".d.ts"))
    .filter((file) => {
      const pkg = dirname(dirname(file));
      return pkg === "." || existsSync(join(root, pkg, "package.json"));
    })
    .sort();
}

/** Specs named on the command line (paths or names), or every spec found. */
export function selectSpecs(root: string, cwd: string, found: string[], named: string[]): string[] {
  if (!named.length) return found;
  return named.map((name) => {
    const asPath = relative(root, resolve(cwd, name));
    if (existsSync(join(root, asPath))) return asPath;
    const match = found.find((file) => file.endsWith(`/${name}.ts`) || file.endsWith(`/${name}`) || file === name);
    if (!match) throw new Error(`No spec named ${name}. Specs found: ${found.join(", ") || "none"}`);
    return match;
  });
}
