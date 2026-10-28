// What share reaches through the host Worker's ctx.exports rather than through bindings: the
// ShareBuilder namespace and the ShareOutbound entrypoint, both exported from the host's main
// module. A Durable Object binding to the Worker's own class would carry its own script name,
// and cf refuses a container on a Durable Object bound that way.
import type { ShareBuilder } from "./builder.ts";

export interface OutboundProps {
  readonly host: string;
}

export interface ShareExports {
  readonly ShareBuilder: DurableObjectNamespace<ShareBuilder>;
  ShareOutbound(options: { props: OutboundProps }): Fetcher;
}

/** The host's exports, once they are known to hold ShareBuilder and ShareOutbound. */
export function shareExports(ctx: { readonly exports?: unknown }): ShareExports {
  const exports = ctx.exports as Partial<ShareExports> | undefined;
  if (!exports?.ShareBuilder || typeof exports.ShareOutbound !== "function") {
    throw new Error("the Worker's main module must export ShareBuilder and ShareOutbound from @feynman/share");
  }
  return exports as ShareExports;
}
