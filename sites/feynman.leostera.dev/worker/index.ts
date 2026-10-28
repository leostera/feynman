// The Worker behind feynman.leostera.dev. Static assets (the page) are served before it runs,
// except under assets.runWorkerFirst: /s/*, which it routes here.
import { share, type ShareEnv } from "@feynman/share";
import { Hono } from "hono";

// The Durable Objects and entrypoint share's builds run on are exported from the main module.
export { ShareBuilder, ShareGate, ShareOutbound } from "@feynman/share";

const app = new Hono<{ Bindings: ShareEnv }>();

// /s/<host>/<path> is the explorer of that public repository, built on demand (@feynman/share).
app.route("/s", share);

export default app;
