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
self-contained HTML file), \`feynman diff --base main\`, \`feynman conform <spec> <log or trace>\`
(whether what a system did is a run of the spec).

In the simulator, a session's URL (\`#/playground/<spec>/<scenario>\`) carries its scenario,
timeline, and view, so a link reopens it; "Copy timeline" gives a JSON trace to turn into a
scenario. The Code view lists each event's inputs and messages and the code its step names, with
the functions that code reaches in the repository, each readable in place.

Checker verdicts: ✗ a trace violates the property; ✓ the property holds in every state the
spec can reach (the search has no depth bound by default); ~ no violation was found before a
search limit (states, time, memory) or \`--depth\` stopped exploration (not a proof; it says how
deep every path was explored, and what the states differ in most); ? the explored states never
reached a case where the property could be judged. \`reachable\` properties say what must be
possible: ✓ with the shortest way there, ✗ never reached when every state was explored.

Messages can be \`ordered: true\`: between one sender and one receiver they arrive in the
order sent, as on one TCP connection or WebSocket, and may still be lost.

Conformance: \`feynman conform <spec> <file>\` reads a JSON Lines log (one step per line, in the
spec's names) or a trace: OpenTelemetry OTLP JSON, Jaeger JSON, or Zipkin v2. A span is a step
when it has a \`feynman.step\` attribute, or when a \`--map\` module (\`defineTraceMapping\` from
\`@leostera/feynman/config\`) returns one for it; the instance is the span's service and the
sender is found up its parents or links. Clocks are not trusted: a trace is a partial order
(each instance's order, causes before effects), and it conforms when some order that keeps
both is a run of the spec, allowing up to \`--gap\` unlogged steps (faults) between logged ones.
It reports the run and the properties it breaks, or the span where the system left the spec
and what the spec could have done there.

What it finds are design bugs: orderings, not typos. A retry that does something twice (after a
lost answer, or a timer that fires first); a restart that forgets what it promised; a late
message that overwrites a newer one; check-then-act races; reads that go back in time; replicas
that never agree; a system that waits forever on a message nobody resends.

Faults are steps a spec declares, from the faults library in the package: \`lose(Message)\`,
\`duplicate(Message)\`, \`crash({ keeps })\`, each spending a budget (\`budget("faults", 1)\`,
raised with \`--set faults=2\`), and calls (\`defineCall\`) whose failure reaches the caller
(\`failed(Call)\`), as an RPC or a \`fetch\` throws. \`atMost(n)\` bounds an action. The library is
built on the core's own primitives, so a fault it lacks is a step the spec writes.

Rules: a spec can name the parts of its design that keep properties true
(\`defineRule\`, read as \`rule.on\`, claimed with \`needs: [rule]\` on properties).
\`feynman check\` also checks the design without each rule and fails if a property that needs it
still holds; \`--without RULE\` shows the design without it.

## Docs

- [Writing and checking specs](${SITE}/SKILL.md): the skill an agent follows to model a codebase, check the model, and report what it found
- [Writing specs with Feynman](${REPOSITORY}/blob/main/book/README.md): the book, building specs step by step, from a first race to two-phase commit, leases and CRDTs
- [The package](https://www.npmjs.com/package/@leostera/feynman): @leostera/feynman on npm

## Explorers

The site builds the explorer (simulator, checker, flows) of any public git repository with a
\`feynman.config.ts\`, on demand, at \`${SITE}/s/<host>/<path>\`. Add \`?ref=<branch, tag or
commit>\` for another commit than the default branch's.

- [Feynman's examples](${SITE}/s/github.com/leostera/feynman/): 28 well-known systems (two-phase commit, Raft's vote, chain replication, payments, …), several with deliberate bugs; [their specs](${REPOSITORY}/tree/main/packages/feynman/examples)
- [Remote access in axo](${SITE}/s/github.com/leostera/axo/): a model of existing code, people reaching their Macs through Cloudflare Access and a relay
`;
}
