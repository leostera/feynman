// /llms.txt: what Feynman is and where everything is, for agents (https://llmstxt.org).
import { published, readSims, refLabel, SITE, simUrl, specUrl } from "./sims.ts";

export function llmsTxt(): string {
  const sims = readSims().filter(published);
  return `# Feynman

> Feynman specs are executable TypeScript models of system behavior: actors and their state,
> messages, actions, timers, limits, and invariants. Steps can link to the code they model.
> From one spec, Feynman derives an interactive simulator, a bounded model checker, scenario
> flows, and comparisons of those flows between commits.

Install with \`bun add -d @leostera/feynman\` (Bun 1.3 or later). Specs import
\`@leostera/feynman\`; optional playground files import \`@leostera/feynman/play\`. The CLI:
\`feynman check\` (type-check, run scenarios, explore, judge every invariant), \`feynman run\`
(scenario traces as text), \`feynman dev\` (the simulator), \`feynman build\` (one
self-contained HTML file), \`feynman diff --base main\`.

In the simulator, a session's URL (\`#/playground/<spec>/<scenario>\`) carries its scenario,
timeline, and view, so a link reopens it; "Copy timeline" gives a JSON trace to turn into a
scenario. The Code view lists each event's inputs and messages and the code its step names, with
the functions that code reaches in the repository, each readable in place.

Checker verdicts: ✗ a trace violates the rule; ✓ the rule holds in every state explored within
configured bounds; ~ no violation was found before a search limit stopped exploration (not a
proof); ? the explored states never reached a case where the rule could be judged.

## Docs

- [Writing and checking specs](${SITE}/SKILL.md): the skill an agent follows to model a codebase, check the model, and report what it found
- [The package](https://www.npmjs.com/package/@leostera/feynman): @leostera/feynman on npm

## Simulators

${sims
  .map((sim) =>
    [
      `- [${sim.title}](${simUrl(sim)}): ${sim.summary} Built from ${sim.repository} at ${refLabel(sim)}.`,
      `  - [Check report](${simUrl(sim)}check.txt): the verdicts \`feynman check\` gave there`,
      ...sim.specs.map((spec) => `  - [${spec.title}](${specUrl(sim, spec.path)}): the spec, ${spec.path}`),
    ].join("\n"),
  )
  .join("\n")}
`;
}
