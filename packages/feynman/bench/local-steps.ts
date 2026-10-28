// How often the search repeats a local step: the same handler, on the same state of its own
// instance, with the same message or inputs. Each repeat is work a cache of local steps
// (LTSmin's --cache) would skip. Ignores what a handler reads through ctx (other instances,
// fresh ids, random numbers), which a real cache key would have to include.
//
//   bun bench/local-steps.ts <model>
import { check } from "../src/check/index.ts";
import { sortedJson } from "../src/spec/json.ts";
import { modelNamed } from "./models.ts";

const model = modelNamed(process.argv[2] ?? "or-set-fault");
const spec = (await import(`../examples/${model.file}.ts`))[model.export ?? "default"];
let calls = 0;
const seen = new Set<string>();
for (const actor of spec.actors)
  for (const steps of [actor.actions, actor.transitions])
    for (const step of Object.values(steps) as { key: string; run: (...a: unknown[]) => unknown }[]) {
      const run = step.run;
      step.run = (state: unknown, ...rest: unknown[]) => {
        calls++;
        // Actions and messages: (state, inputs|payload, ctx); timers and guards: (state, ctx).
        const arg = rest.length === 2 ? rest[0] : null;
        seen.add(`${actor.name}.${step.key}\u0000${sortedJson(state)}\u0000${sortedJson(arg)}`);
        return run(state, ...rest);
      };
    }
const report = await check(spec, { ...model.bounds, walks: 0, workers: 0 });
console.log(JSON.stringify({ model: model.name, states: report.states, handlerCalls: calls, distinctLocalSteps: seen.size, repeatShare: +(1 - seen.size / calls).toFixed(3) }));
