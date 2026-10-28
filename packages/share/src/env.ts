import type { ShareBuilder } from "./builder.ts";

/**
 * The bindings share needs from the Worker that mounts it. That Worker also exports
 * ShareBuilder (a Durable Object with shareContainer attached) and ShareOutbound from its main
 * module: see config.ts.
 */
export interface ShareEnv {
  /** Built pages, one per repository and commit. */
  readonly SHARE_PAGES: R2Bucket;
  /** The ShareBuilder Durable Object namespace. */
  readonly SHARE_BUILDER: DurableObjectNamespace<ShareBuilder>;
}
