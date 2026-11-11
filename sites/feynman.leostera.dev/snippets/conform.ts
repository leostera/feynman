// Mark the spans that are steps of the spec…
const span = tracer.startSpan("POST /hold", {
  attributes: { "feynman.step": "hold" },
});

// …or map the spans the system already has (--map trace-map.ts).
import { defineTraceMapping } from "@leostera/feynman/config";

export default defineTraceMapping((span) => {
  if (span.attributes["http.route"] === "/hold") return { key: "hold" };
  if (span.name === "show held") return { key: "held" };
  return undefined; // the rest is the system's own detail
});
