export * from "./session";
import { runScenario, type ScenarioInfo, type Spec } from "../spec/index.ts";
import { sessionFromRun, type Session } from "./session";

export function runScenarioSession(spec: Spec, scenario: ScenarioInfo): Session {
  return sessionFromRun(runScenario(spec, scenario), scenario.name);
}
