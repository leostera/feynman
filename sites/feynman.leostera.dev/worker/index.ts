// The Worker behind feynman.leostera.dev. Static assets (the page, the published simulators)
// are served before it runs, except under assets.runWorkerFirst: /s/*, which it routes here.
import { share, type ShareEnv } from "@feynman/share";
import { Hono } from "hono";

// The Durable Object and entrypoint share's builds run on are exported from the main module.
export { ShareBuilder, ShareOutbound } from "@feynman/share";

type Bindings = ShareEnv & { readonly ASSETS: Fetcher };

const app = new Hono<{ Bindings: Bindings }>();

// /s/<slug>/ is a published simulator (sims.json) when there is one and no ?ref= asks for another
// commit: scripts/pages.ts builds those into the assets at the commit sims.json pins. Any other
// /s/<host>/<path> is the explorer of that public repository, built on demand (@feynman/share).
app.use("/s/*", async (c, next) => {
  if (c.req.query("ref") !== undefined) return next();
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) return asset;
  await asset.body?.cancel();
  return next();
});
app.route("/s", share);

export default app;
