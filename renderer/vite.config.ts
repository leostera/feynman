import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/** Inlines the model named by FEYNMAN_MODEL into index.html. */
function embedModel(): Plugin {
  return {
    name: "feynman-embed-model",
    transformIndexHtml(html) {
      const path = process.env.FEYNMAN_MODEL;
      if (!path) throw new Error("FEYNMAN_MODEL must name a model.json");
      const model = JSON.stringify(JSON.parse(readFileSync(path, "utf8")));
      // Keep the JSON from closing its <script> element early.
      return html.replace("__FEYNMAN_MODEL__", () => model.replaceAll("</", "<\\/"));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), embedModel(), viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 10_000 },
});
