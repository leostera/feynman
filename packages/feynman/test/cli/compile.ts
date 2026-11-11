// Scenario code, as --as-scenario prints it, made into a scenario to run: what the tests use to
// show the code replays what it says.
import { actorVariable } from "../../src/cli/scenario-code.ts";
import type { ScenarioInfo, Script, Setup, Spec } from "../../src/spec/index.ts";

/** The scenario the code defines, its setup and run compiled with the spec's actors and messages in scope. */
export function compile(spec: Spec, name: string, code: string): ScenarioInfo {
  // The code is TypeScript (`find(…)!`): transpile it, with the spec's actors in scope.
  const scope = (body: string, param: string) => {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`const f = (${param}) => {${body}};`);
    // A call's failure (`Charge.failed`) is written failed(Charge), so it is not a name in scope.
    const messages = Object.values(spec.messages).filter((m) => !m.id.includes("."));
    const names = [...spec.actors.map((a) => actorVariable(a.name)), ...messages.map((m) => m.id), "failed"];
    const values = [...spec.actors.map((a) => ({ name: a.name })), ...messages.map((m) => ({ kind: "message", key: m.key })), (m: { key: string }) => ({ kind: "message", key: `${m.key}.failed` })];
    return new Function(...names, `${js}\nreturn f;`)(...values);
  };
  const run = code.slice(code.indexOf("run(s) {") + "run(s) {".length, code.lastIndexOf("},"));
  const setup = code.includes("setup(w) {") ? code.slice(code.indexOf("setup(w) {") + "setup(w) {".length, code.indexOf("\n  },\n  run(s) {")) : null;
  return { name, run: scope(run, "s") as (s: Script) => void, ...(setup ? { setup: scope(setup, "w") as (w: Setup) => void } : {}) };
}
