import { shareBindings, shareContainer, shareExports } from "@feynman/share/config";
import { defineConfig } from "cf/config";

const name = "feynman-leostera-dev";

// The page, served as Worker assets, and a Worker (worker/index.ts) for /s/*: the explorer of any
// public repository (@feynman/share), built on demand.
export default defineConfig({
  // The personal account that holds the leostera.dev zone.
  accountId: "0f436d2aabf1f872be90b8dd9d5715e6",
  worker: {
    name,
    compatibilityDate: "2026-10-23",
    // Files from @cloudflare/sandbox resolves Linux errno names through node:os.
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./worker/index.ts",
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page", runWorkerFirst: ["/s/*"] },
    domains: ["feynman.leostera.dev"],
    env: { ...shareBindings() },
    exports: { ...shareExports },
    observability: { enabled: true, traces: { enabled: true } },
  },
  containers: [shareContainer],
});
