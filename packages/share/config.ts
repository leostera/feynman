// What a Worker that mounts share declares in its cloudflare.config.ts:
//
//   worker: {
//     env: { ...shareBindings() },
//     exports: { ...shareExports },
//   },
//   containers: [shareContainer],
//
// and its main module exports ShareBuilder and ShareOutbound from @feynman/share.
import { bindings, defineContainer, exports } from "cf/config";

// cf evaluates this file in Node. The host's Worker types, which load it to infer env, have no
// import.meta.url of their own.
declare global {
  interface ImportMeta {
    url: string;
  }
}

/** The sandbox each build runs in: Bun, git and the published Feynman (Dockerfile). */
export const shareContainer = defineContainer({
  name: "feynman-share-builder",
  schedulingPolicy: "durable-object",
  images: { builder: { dockerfile: decodeURIComponent(new URL("./Dockerfile", import.meta.url).pathname) } },
});

/** ShareBuilder, a Durable Object per build with the container attached, and ShareGate. */
export const shareExports = {
  ShareBuilder: exports.durableObject({ storage: "sqlite", container: shareContainer }),
  ShareGate: exports.durableObject({ storage: "sqlite" }),
};

/**
 * The bindings in ShareEnv: built pages, and per-IP limits on requests and on builds. ShareBuilder
 * and ShareGate have none: share reaches them through ctx.exports, as cf
 * refuses a container on a Durable Object the Worker binds to by its own name.
 */
export function shareBindings() {
  return {
    SHARE_PAGES: bindings.r2({ name: "feynman-share" }),
    // Rate limit namespaces are account-wide: these ids must not be used by another Worker.
    SHARE_REQUESTS: bindings.rateLimit({ namespace: "7101", simple: { limit: 60, period: 60 } }),
    SHARE_BUILDS: bindings.rateLimit({ namespace: "7102", simple: { limit: 2, period: 60 } }),
  };
}
