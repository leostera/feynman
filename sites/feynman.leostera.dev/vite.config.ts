import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { highlightModule, QUERY } from "./scripts/highlight.ts";
import { llmsTxt } from "./scripts/llms.ts";

/** `import snippet from "../snippets/x.ts?highlight"`: the snippet, highlighted at build time. */
function highlight(): Plugin {
  return {
    name: "feynman-highlight",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.endsWith(QUERY) || !importer) return null;
      const resolved = await this.resolve(source.slice(0, -QUERY.length), importer, { skipSelf: true });
      // Ending in .js keeps plugins that claim files by extension (the Cloudflare one takes .txt as text) away.
      return resolved && `\0highlight:${resolved.id}.js`;
    },
    load(id) {
      return id.startsWith("\0highlight:") ? highlightModule(id.slice("\0highlight:".length, -".js".length)) : null;
    },
  };
}

/** The built index.html holds the page itself, rendered by scripts/render.tsx. */
function prerender(): Plugin {
  return {
    name: "feynman-prerender",
    apply: "build",
    transformIndexHtml(html) {
      const out = spawnSync("bun", ["scripts/render.tsx"], { cwd: import.meta.dirname, encoding: "utf8", maxBuffer: 1 << 26 });
      if (out.status !== 0) throw new Error(`the page did not render:\n${out.stderr}`);
      // React puts preloads for the images first; they belong in the head, not in the app it hydrates.
      const preloads = out.stdout.match(/^(<link [^>]*\/>)+/)?.[0] ?? "";
      const page = out.stdout.slice(preloads.length);
      return html.replace("</head>", () => `${preloads}</head>`).replace('<div id="root"></div>', () => `<div id="root">${page}</div>`);
    },
  };
}

/** What agents read: llms.txt, and the skill as it is in this repository. */
function forAgents(): Plugin {
  return {
    name: "feynman-for-agents",
    apply: "build",
    generateBundle() {
      if (this.environment.name !== "client") return;
      this.emitFile({ type: "asset", fileName: "llms.txt", source: llmsTxt() });
      this.emitFile({ type: "asset", fileName: "SKILL.md", source: readFileSync(resolve(import.meta.dirname, "../../skills/feynman/SKILL.md"), "utf8") });
    },
  };
}

export default defineConfig({
  plugins: [highlight(), react(), tailwindcss(), prerender(), forAgents(), cloudflare()],
});
