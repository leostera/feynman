// Usage: bun run build <model-dir> <out.html>
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { build } from "vite";

const [modelArg, outArg] = process.argv.slice(2);
if (!modelArg || !outArg) {
  console.error("usage: build <model-dir> <out.html>");
  process.exit(2);
}
const caller = process.env.INIT_CWD ?? process.cwd();
process.env.FEYNMAN_MODEL = resolve(caller, modelArg);
const out = resolve(caller, outArg);

// Always a production build: development builds embed absolute source paths
// (React's dev JSX) and would leak the builder's machine layout into the artifact.
process.env.NODE_ENV = "production";
await build({ root: import.meta.dirname, logLevel: "warn", mode: "production" });
mkdirSync(dirname(out), { recursive: true });
copyFileSync(resolve(import.meta.dirname, "dist/index.html"), out);
console.log(`wrote ${out}`);
