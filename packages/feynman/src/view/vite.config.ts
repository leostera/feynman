import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The explorer is a static page, built to dist/view at the package root; `feynman build`
// inlines it with the specs into one HTML file, and `feynman dev` serves it with them.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/view",
    emptyOutDir: true,
    chunkSizeWarningLimit: 10_000,
    minify: true,
    cssMinify: true,
    sourcemap: false,
  },
});
