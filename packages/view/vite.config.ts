import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The explorer is a static page; the CLI puts feynman.json and spec modules next to it.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 10_000 },
});
