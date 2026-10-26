// /llms.txt: what Feynman is and where everything is, for agents (https://llmstxt.org).
import { readSims, SITE, simUrl, specUrl } from "./sims.ts";

export function llmsTxt(): string {
  const sims = readSims().filter((sim) => sim.commit);
  return `# Feynman

> Feynman specs are small, executable models of how a system behaves, written in TypeScript:
> actors and their state, the messages between them, the actions people take, timers and
> limits, and the invariants that must hold, with each step anchored to the code it stands
> for. From one spec, Feynman derives a simulator, a bounded model checker, the flows of
> every scenario and their diffs between commits.

Install with \`bun add -d @leostera/feynman\` (Bun 1.3 or later). Specs import
\`@leostera/feynman\`; optional playground files import \`@leostera/feynman/play\`. The CLI:
\`feynman check\` (type-check, run scenarios, explore, judge every invariant), \`feynman run\`
(scenario traces as text), \`feynman dev\` (the simulator), \`feynman build\` (one
self-contained HTML file), \`feynman diff --base main\`.

Checker verdicts: ✗ broken (with the trace), ✓ holds in every state within the bounds, ~ held
in the states explored before a limit (not a proof), ? never tested.

## Docs

- [Writing and checking specs](${SITE}/SKILL.md): the skill an agent follows to model a codebase, check the model, and report what it found
- [The package](https://www.npmjs.com/package/@leostera/feynman): @leostera/feynman on npm

## Simulators

${sims
  .map((sim) =>
    [
      `- [${sim.title}](${simUrl(sim)}): ${sim.summary} Built from ${sim.repository} at ${sim.commit!.slice(0, 7)}.`,
      `  - [Check report](${simUrl(sim)}check.txt): the verdicts \`feynman check\` gave at that commit`,
      ...sim.specs.map((spec) => `  - [${spec.title}](${specUrl(sim, spec.path)}): the spec, ${spec.path}`),
    ].join("\n"),
  )
  .join("\n")}
`;
}
