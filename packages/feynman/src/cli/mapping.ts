// A trace mapping (RFD0016): what the spans a system already has mean for a spec, for
// `feynman conform --map`. Imported as @leostera/feynman/config, so it imports nothing that runs.
import type { TraceMapping } from "../check/trace.ts";

export type { TraceMapping, TraceSpan } from "../check/trace.ts";

/**
 * What each span means: a log line (`{instance, key, inputs, payload, state, actor}`), or
 * undefined to skip it. Left out, the instance is the span's service, and a message's sender
 * is found up the span's parents.
 *
 *     export default defineTraceMapping((span) =>
 *       span.attributes["http.route"] === "/hold" ? { instance: "Box office", key: "hold" } : undefined);
 */
export function defineTraceMapping(map: TraceMapping): TraceMapping {
  return map;
}
