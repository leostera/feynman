// Print the page as static HTML, for index.html: readers (and agents) get the whole page
// without running any script, and the browser hydrates it. Run by the Vite build.
import { dirname, resolve } from "node:path";
import { plugin } from "bun";
import { highlightModule, QUERY } from "./highlight.ts";

plugin({
  name: "highlight",
  setup(build) {
    build.onResolve({ filter: /\?highlight$/ }, (args) => ({ path: resolve(dirname(args.importer), args.path.slice(0, -QUERY.length)), namespace: "highlight" }));
    build.onLoad({ filter: /.*/, namespace: "highlight" }, async (args) => ({ contents: await highlightModule(args.path), loader: "js" }));
  },
});

const { renderToString } = await import("react-dom/server");
const { App } = await import("../src/App.tsx");
process.stdout.write(renderToString(<App />));
