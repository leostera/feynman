import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { loadModel } from "@feynman/model";

/** Bundles the model directory named by FEYNMAN_MODEL and inlines it into index.html. */
function embedModel(): Plugin {
  return {
    name: "feynman-embed-model",
    transformIndexHtml(html) {
      const path = process.env.FEYNMAN_MODEL;
      if (!path) throw new Error("FEYNMAN_MODEL must name a model directory");
      const model = JSON.stringify(loadModel(path));
      // Keep the JSON from closing its <script> element early.
      return html.replace("__FEYNMAN_MODEL__", () => model.replaceAll("</", "<\\/"));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), embedModel(), viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 10_000 },
});
