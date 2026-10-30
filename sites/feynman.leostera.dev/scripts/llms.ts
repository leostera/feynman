// /llms.txt: what Feynman is and where everything is, for agents (https://llmstxt.org).
const SITE = "https://feynman.leostera.dev";
const REPOSITORY = "https://github.com/leostera/feynman";

export function llmsTxt(): string {
  return `# Feynman

> Feynman is a TypeScript library and CLI (\`@leostera/feynman\` on npm). Its specs are
> executable TypeScript models of system behavior: actors and their state,
> messages, actions, timers, limits, and properties (safety and liveness). Steps can link to the code they model.
> From one spec, Feynman derives an interactive simulator, a bounded model checker, scenario
> flows, and comparisons of those flows between commits.

Install with \`bun add -d @leostera/feynman\` (Bun 1.3 or later). Specs import
\`@leostera/feynman\`; optional playground files import \`@leostera/feynman/play\`. The CLI:
\`feynman check\` (type-check, run scenarios, explore, judge every property), \`feynman run\`
(scenario traces as text), \`feynman dev\` (the simulator), \`feynman build\` (one
self-contained HTML file), \`feynman diff --base main\`.

In the simulator, a session's URL (\`#/playground/<spec>/<scenario>\`) carries its scenario,
timeline, and view, so a link reopens it; "Copy timeline" gives a JSON trace to turn into a
scenario. The Code view lists each event's inputs and messages and the code its step names, with
the functions that code reaches in the repository, each readable in place.

Checker verdicts: ✗ a trace violates the rule; ✓ the rule holds in every state explored within
configured bounds; ~ no violation was found before a search limit (states, time, memory)
stopped exploration (not a proof; it says how deep every path was explored, and what the states
differ in most); ? the explored states never reached a case where the rule could be judged.

What it finds are design bugs: orderings, not typos. A retry that does something twice (after a
lost answer, or a timer that fires first); a restart that forgets what it promised; a late
message that overwrites a newer one; check-then-act races; reads that go back in time; replicas
that never agree; a system that waits forever on a message nobody resends. Messages can be lost
silently (\`message\`), or be calls whose failure reaches the caller (\`call\`), as an RPC or a
\`fetch\` throws.

Rules: a spec can name the parts of its design that keep properties true
(\`defineRule\`, read as \`rule.on\`, claimed with \`needs: [rule]\` on properties).
\`feynman check\` also checks the design without each rule and fails if a property that needs it
still holds; \`--without RULE\` shows the design without it.

## Docs

- [Writing and checking specs](${SITE}/SKILL.md): the skill an agent follows to model a codebase, check the model, and report what it found
- [The package](https://www.npmjs.com/package/@leostera/feynman): @leostera/feynman on npm

## Explorers

The site builds the explorer (simulator, checker, flows) of any public git repository with a
\`feynman.config.ts\`, on demand, at \`${SITE}/s/<host>/<path>\`. Add \`?ref=<branch, tag or
commit>\` for another commit than the default branch's.

- [Feynman's examples](${SITE}/s/github.com/leostera/feynman/): 28 well-known systems (two-phase commit, Raft's vote, chain replication, payments, …), several with deliberate bugs; [their specs](${REPOSITORY}/tree/main/packages/feynman/examples)
- [Remote access in axo](${SITE}/s/github.com/leostera/axo/): a model of existing code, people reaching their Macs through Cloudflare Access and a relay
`;
}
