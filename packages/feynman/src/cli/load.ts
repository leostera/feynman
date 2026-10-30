// Loading spec files from any repository: `@leostera/feynman` and its subpaths resolve to
// this installation, so a repository needs nothing installed to have specs. Each file is
// bundled by Bun, the runtime that runs it, to a temporary module and imported from there,
// which also sees every edit; Feynman itself stays outside the bundle, imported from here. Playground files (`<name>.play.tsx`) load the same way. For the
// browser, Vite builds them (bundle-browser.ts) with the same import names, and leaves React,
// Kumo and the kit to the page, which hands its own copies over on a global (`sharedShim`).
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpecSource } from "../check/index.ts";
import type { Spec } from "../spec/index.ts";
import { CONFIG_FILE, type Config } from "./config.ts";
import { CONFIG_NAMES, exactly, PLAY_NAMES, SPEC_NAMES } from "./names.ts";

const PLAY = Bun.resolveSync("../play/index.ts", import.meta.dir);
const PLAY_DIR = dirname(PLAY);
const LIBRARIES = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "@cloudflare/kumo"] as const;

/** Import name → the file in this installation it stands for. */
export const ALIASES: Record<string, string> = {
  ...Object.fromEntries(SPEC_NAMES.map((n) => [n, Bun.resolveSync("../spec/index.ts", import.meta.dir)])),
  ...Object.fromEntries(CONFIG_NAMES.map((n) => [n, Bun.resolveSync("./index.ts", import.meta.dir)])),
  ...Object.fromEntries(PLAY_NAMES.map((n) => [n, PLAY])),
  ...Object.fromEntries(LIBRARIES.map((n) => [n, Bun.resolveSync(n, PLAY_DIR)])),
};

/** What the page shares with playground modules: the libraries, and the kit as `play`. */
export const SHARED = exactly([...LIBRARIES, ...PLAY_NAMES]);

/** A module that reads an import from the page's global, with every export the real one has. */
export async function sharedShim(name: string): Promise<string> {
  const real = name === "react/jsx-dev-runtime" ? "react/jsx-runtime" : name;
  const key = (PLAY_NAMES as readonly string[]).includes(real) ? "play" : real;
  const keys = Object.keys(await import(ALIASES[real])).filter((k) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k));
  const lines = [`const m = globalThis.__feynman.modules[${JSON.stringify(key)}];`, `export default m.default ?? m;`];
  if (keys.length) lines.push(`export const { ${keys.join(", ")} } = m;`);
  if (name === "react/jsx-dev-runtime") lines.push(`export const jsxDEV = m.jsx;`);
  return lines.join("\n");
}

let scratch: string | null = null;
let counter = 0;

/** A file and what it imports as one module for Bun to run here, in the CLI. */
async function bundle(path: string): Promise<string> {
  const result = await Bun.build({
    throw: false,
    entrypoints: [path],
    target: "bun",
    format: "esm",
    jsx: { runtime: "automatic", importSource: "react", development: false },
    plugins: [
      {
        name: "feynman-aliases",
        setup(build) {
          // External: the spec imports the very modules the CLI runs, not a copy of its own.
          build.onResolve({ filter: exactly(Object.keys(ALIASES)) }, (args) => ({ path: ALIASES[args.path], external: true }));
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
  return (await importBundled(path)).module;
}

/**
 * A fresh bundle of a module, imported; and where the bundle is, for worker threads to import
 * too. Each bundle gets a directory of its own: Bun's resolver can miss a file several threads
 * import at once from a directory that changed since it last looked (seen with Bun 1.3).
 */
async function importBundled(path: string): Promise<{ module: unknown; bundled: string }> {
  scratch ??= mkdtempSync(join(tmpdir(), "feynman-load-"));
  const bundled = join(mkdtempSync(join(scratch, `${++counter}-`)), "spec.mjs");
  writeFileSync(bundled, await bundle(path));
  return { module: await import(bundled), bundled };
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

/** A spec, and where worker threads can load it from (the checker shares big searches with them). */
export interface LoadedSpec {
  spec: Spec;
  source: SpecSource;
}

/** The spec a file exports by default. */
export async function loadSpec(path: string): Promise<LoadedSpec> {
  let module: { default?: unknown };
  let bundled: string;
  try {
    const loaded = await importBundled(path);
    module = loaded.module as { default?: unknown };
    bundled = loaded.bundled;
  } catch (error) {
    throw new SpecLoadError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const spec = module.default as Spec | undefined;
  if (!spec || typeof spec !== "object" || !Array.isArray((spec as Spec).actors)) {
    throw new SpecLoadError(`${path} does not export a spec by default: export default defineSpec(…)`);
  }
  return { spec, source: { module: bundled } };
}

/** The repository's feynman.config.ts, or nothing configured. */
export async function readConfig(root: string): Promise<Config> {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return {};
  const module = (await importFresh(path)) as { default?: Config };
  return module.default ?? {};
}
