/**
 * The bindings share needs from the Worker that mounts it. That Worker also exports
 * ShareBuilder (a Durable Object with shareContainer attached), ShareGate and ShareOutbound from its main
 * module, which share reaches through ctx.exports: see config.ts and exports.ts.
 */
export interface ShareEnv {
  /** Built pages, one per repository and commit. */
  readonly SHARE_PAGES: R2Bucket;
  /** Every request under the mount, per client IP. */
  readonly SHARE_REQUESTS: RateLimit;
  /** Requests that would start a build, per client IP. */
  readonly SHARE_BUILDS: RateLimit;
}
