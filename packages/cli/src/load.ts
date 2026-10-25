// Loading spec files from any repository: `@feynman/spec` and `@feynman/cli` resolve to
// this installation, so a repository needs nothing installed to have specs. Each file is
// bundled to a temporary module and imported from there, which also sees every edit.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Spec } from "@feynman/spec";

const ALIASES: Record<string, string> = {
  "@feynman/spec": Bun.resolveSync("@feynman/spec", import.meta.dir),
  "@feynman/cli": Bun.resolveSync("./index.ts", import.meta.dir),
};

let scratch: string | null = null;
let counter = 0;

export async function bundle(path: string, target: "bun" | "browser"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path],
    target,
    format: "esm",
    plugins: [
      {
        name: "feynman-aliases",
        setup(build) {
          build.onResolve({ filter: /^@feynman\/(spec|cli)$/ }, (args) => ({ path: ALIASES[args.path] }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map((l) => String(l)).join("\n"));
  return result.outputs[0].text();
}

/** Import a TypeScript module through a fresh bundle, so edits are always seen. */
export async function importFresh(path: string): Promise<unknown> {
  scratch ??= mkdtempSync(join(tmpdir(), "feynman-load-"));
  const out = join(scratch, `${++counter}.mjs`);
  writeFileSync(out, await bundle(path, "bun"));
  return import(out);
}

export class SpecLoadError extends Error {}

/** The spec a file exports by default. */
export async function loadSpec(path: string): Promise<Spec> {
  let module: { default?: unknown };
  try {
    module = (await importFresh(path)) as { default?: unknown };
  } catch (error) {
    throw new SpecLoadError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const spec = module.default as Spec | undefined;
  if (!spec || typeof spec !== "object" || !Array.isArray((spec as Spec).actors)) {
    throw new SpecLoadError(`${path} does not export a spec by default: export default defineSpec(…)`);
  }
  return spec;
}
