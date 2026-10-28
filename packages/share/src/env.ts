/**
 * The bindings share needs from the Worker that mounts it. That Worker also exports
 * ShareBuilder (a Durable Object with shareContainer attached) and ShareOutbound from its main
 * module, which share reaches through ctx.exports: see config.ts and exports.ts.
 */
export interface ShareEnv {
  /** Built pages, one per repository and commit. */
  readonly SHARE_PAGES: R2Bucket;
}
