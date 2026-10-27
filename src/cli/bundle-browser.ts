// Browser modules for the explorer (a spec, its playground, the spec at the base commit), built
// with Vite: one ES module per file, everything it imports inlined, nothing split off, so the
// page can load each from a single blob URL. Imports resolve as when the CLI runs a spec
// (load.ts): `@leostera/feynman` and its subpaths to this installation; React, Kumo and the kit
// to the page's own copies, read from a global, so there is one React and one stylesheet.
import { dirname } from "node:path";
import { build, type Plugin, type Rolldown } from "vite";
import { ALIASES, SHARED, sharedShim } from "./load.ts";

const SHARED_PREFIX = "\0feynman-shared:";

function feynmanImports(): Plugin {
  return {
    name: "feynman-imports",
    enforce: "pre",
    resolveId(source) {
      if (SHARED.test(source)) return `${SHARED_PREFIX}${source}`;
      return ALIASES[source] ?? null;
    },
    load(id) {
      return id.startsWith(SHARED_PREFIX) ? sharedShim(id.slice(SHARED_PREFIX.length)) : null;
    },
  };
}

/** One file and everything it imports as a single ES module for the page. */
export async function bundleBrowser(path: string): Promise<string> {
  let output: Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  try {
    output = (await build({
      configFile: false,
      root: dirname(path),
      logLevel: "silent",
      plugins: [feynmanImports()],
      oxc: { jsx: { runtime: "automatic", importSource: "react", development: false } },
      // Libraries specs import may check NODE_ENV; the page is a production build.
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        write: false,
        minify: false,
        sourcemap: false,
        reportCompressedSize: false,
        copyPublicDir: false,
        target: "es2022",
        lib: { entry: path, formats: ["es"], fileName: "module" },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  } catch (error) {
    throw new Error(describeBuildError(error));
  }
  const chunks = (Array.isArray(output) ? output : [output]).flatMap((o) => o.output).filter((o): o is Rolldown.OutputChunk => o.type === "chunk");
  const entry = chunks.find((chunk) => chunk.isEntry);
  if (!entry) throw new Error(`${path} produced no module`);
  return entry.code;
}

/** ANSI colour codes: Vite colours its messages for a terminal, and these are shown in the page too. */
const ANSI = /\u001b\[[0-9;]*m/g;

/** A build failure as plain text: where it happened, what is wrong, and the code around it. */
function describeBuildError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(ANSI, "").replace(/^Build failed with \d+ errors?:\s*/, "").trim();
}
