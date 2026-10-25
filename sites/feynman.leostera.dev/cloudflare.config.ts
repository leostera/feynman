import { defineConfig } from "cf/config";

// A static site: the page and the published explainers, served as Worker assets.
export default defineConfig({
  worker: {
    name: "feynman-leostera-dev",
    compatibilityDate: "2026-10-06",
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
    domains: ["feynman.leostera.dev"],
  },
});
