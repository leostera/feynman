// @feynman/share: the Feynman explorer of any public git repository, built in a sandbox and kept
// in R2 by commit. A Worker mounts `share` (a Hono app) under a path, exports ShareBuilder,
// ShareGate and ShareOutbound from its main module, and declares what config.ts describes.
export { share } from "./app.ts";
export { ShareBuilder, ShareOutbound } from "./builder.ts";
export { ShareGate } from "./gate.ts";
export type { ShareEnv } from "./env.ts";
