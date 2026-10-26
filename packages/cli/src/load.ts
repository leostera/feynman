// Loading spec files from any repository: `@feynman/spec` and `@feynman/cli` resolve to
// this installation, so a repository needs nothing installed to have specs. Each file is
// bundled to a temporary module and imported from there, which also sees every edit.
// Playground files (`<name>.play.tsx`) are bundled the same way; for the browser, React,
// Kumo and the kit are left to the page, which hands its own copies over on a global.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Spec } from "@feynman/spec";

const PLAY_DIR = dirname(Bun.resolveSync("@feynman/play/package.json", import.meta.dir));

const ALIASES: Record<string, string> = {
  "@feynman/spec": Bun.resolveSync("@feynman/spec", import.meta.dir),
  "@feynman/cli": Bun.resolveSync("./index.ts", import.meta.dir),
  "@feynman/play": Bun.resolveSync("@feynman/play", import.meta.dir),
  react: Bun.resolveSync("react", PLAY_DIR),
  "react/jsx-runtime": Bun.resolveSync("react/jsx-runtime", PLAY_DIR),
  "react/jsx-dev-runtime": Bun.resolveSync("react/jsx-dev-runtime", PLAY_DIR),
  "@cloudflare/kumo": Bun.resolveSync("@cloudflare/kumo", PLAY_DIR),
};

/** What the page shares with playground modules, by import name. */
const SHARED = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "@cloudflare/kumo", "@feynman/play"] as const;

/** A module that reads an import from the page's global, with every export the real one has. */
async function sharedShim(name: (typeof SHARED)[number]): Promise<string> {
  const real = name === "react/jsx-dev-runtime" ? "react/jsx-runtime" : name;
  const keys = Object.keys(await import(ALIASES[real])).filter((k) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k));
  const lines = [`const m = globalThis.__feynman.modules[${JSON.stringify(real)}];`, `export default m.default ?? m;`];
  if (keys.length) lines.push(`export const { ${keys.join(", ")} } = m;`);
  if (name === "react/jsx-dev-runtime") lines.push(`export const jsxDEV = m.jsx;`);
  return lines.join("\n");
}

let scratch: string | null = null;
let counter = 0;

export async function bundle(path: string, target: "bun" | "browser"): Promise<string> {
  const shared = target === "browser";
  const result = await Bun.build({
    throw: false,
    entrypoints: [path],
    target,
    format: "esm",
    jsx: { runtime: "automatic", importSource: "react", development: false },
    plugins: [
      {
        name: "feynman-aliases",
        setup(build) {
          if (shared) {
            build.onResolve({ filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|@cloudflare\/kumo|@feynman\/play)$/ }, (args) => ({ path: args.path, namespace: "feynman-shared" }));
            build.onLoad({ filter: /.*/, namespace: "feynman-shared" }, async (args) => ({ contents: await sharedShim(args.path as (typeof SHARED)[number]), loader: "js" }));
          }
          build.onResolve({ filter: /^(@feynman\/(spec|cli|play)|react|react\/jsx-runtime|react\/jsx-dev-runtime|@cloudflare\/kumo)$/ }, (args) => ({ path: ALIASES[args.path] }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(describeLog).join("\n") || "the spec could not be bundled");
  return result.outputs[0].text();
}

/** A build message with where it happened: "specs/x.ts:12:4 Expected "}" but found ")"". */
function describeLog(log: { message: string; position?: { file: string; line: number; column: number } | null }): string {
  const at = log.position ? `${log.position.file}:${log.position.line}:${log.position.column} ` : "";
  return `${at}${log.message}`;
}

/** Import a TypeScript module through a fresh bundle, so edits are always seen. */
export async function importFresh(path: string): Promise<unknown> {
  scratch ??= mkdtempSync(join(tmpdir(), "feynman-load-"));
  const out = join(scratch, `${++counter}.mjs`);
  writeFileSync(out, await bundle(path, "bun"));
  return import(out);
}

export class SpecLoadError extends Error {}

/** The playground a file exports by default; loading it checks the actors it names. */
export async function loadPlayground(path: string): Promise<unknown> {
  let module: { default?: unknown };
  try {
    module = (await importFresh(path)) as { default?: unknown };
  } catch (error) {
    throw new SpecLoadError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = module.default as { kind?: string } | undefined;
  if (value?.kind !== "feynman.playground") throw new SpecLoadError(`${path} does not export a playground by default: export default definePlayground(spec, …)`);
  return value;
}

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
