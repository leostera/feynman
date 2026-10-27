import { bindings, defineConfig, defineContainer, defineWorker, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The sandbox each build runs in: Bun, git and the published Feynman (Dockerfile). A Builder
// Durable Object starts one per build, as `images.builder`.
const builder = defineContainer({
  name: "feynman-share-builder",
  schedulingPolicy: "durable-object",
  images: { builder: { dockerfile: "./Dockerfile" } },
});

// This Worker as its own Builder binding names it: with its module and exports, so env.BUILDER is typed.
const self = defineWorker({
  name: "feynman-share",
  compatibilityDate: "2026-10-06",
  entrypoint,
  exports: {
    Builder: exports.durableObject({ storage: "sqlite", container: builder }),
  },
});

export default defineConfig({
  // The personal account that holds the leostera.dev zone, like sites/feynman.leostera.dev.
  accountId: "0f436d2aabf1f872be90b8dd9d5715e6",
  worker: {
    ...self,
    // Files from @cloudflare/sandbox resolves Linux errno names through node:os.
    compatibilityFlags: ["nodejs_compat"],
    // Only /s/* is ours: the rest of feynman.leostera.dev is the site's custom domain, and a
    // route takes precedence over a custom domain on the same hostname.
    triggers: [triggers.fetch({ pattern: "feynman.leostera.dev/s/*", zone: "leostera.dev" })],
    workersDev: false,
    env: {
      PAGES: bindings.r2({ name: "feynman-share" }),
      BUILDER: bindings.durableObject({ worker: self, exportName: "Builder" }),
    },
    observability: { enabled: true, traces: { enabled: true } },
  },
  containers: [builder],
});
