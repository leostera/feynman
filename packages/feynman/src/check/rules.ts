// Rules that are needed (RFD0010): a property that needs a rule should break in the design
// without it. Each claimed rule is checked on that variant, built again from the spec's
// definition, restricted to the properties that need it, until every one of them has broken.
import { runScenario, type Spec } from "../spec/index.ts";
import { check, type Bounds, type CheckOptions, type Report } from "./explore.ts";
import { scenarioSeeds } from "./seeds.ts";

/** What became of one property that needs a rule, in the design without the rule. */
export interface NeededBy {
  property: string;
  /** "breaks": the claim holds. "holds": the rule was not needed (it fails the check). "unfinished": held, but the search stopped early. */
  verdict: "breaks" | "holds" | "unfinished";
  /** With "breaks": the events in its shortest counterexample, or in the scenario up to the break. */
  events?: number;
  /** With "breaks", when the search did not get there: the scenario that breaks it without the rule. */
  scenario?: string;
}

export interface RuleVerdict {
  name: string;
  description: string;
  neededBy: NeededBy[];
}

/** A spec's check from its scenarios, and each rule some property needs: what the explorer's checks page shows. */
export async function checkWithRules(spec: Spec, bounds: Partial<Bounds>): Promise<Report> {
  const report = await check(spec, bounds, scenarioSeeds(spec));
  return spec.rules.some((r) => r.neededBy.length) ? { ...report, rules: await checkRules(spec, bounds) } : report;
}

/** Each rule some property needs, checked in the design without it. */
export async function checkRules(spec: Spec, bounds: Partial<Bounds>, options: CheckOptions = {}): Promise<RuleVerdict[]> {
  const verdicts: RuleVerdict[] = [];
  for (const rule of spec.rules) {
    // A rule already off (--without) has no variant left to check.
    if (spec.without.includes(rule.name)) continue;
    // Of the properties checked here (all, or those --only names).
    const ids = rule.neededBy.filter((id) => spec.properties.some((p) => p.id === id));
    if (!ids.length) continue;
    const variant = spec.withoutRules([rule.name]);
    const needing = { ...variant, properties: variant.properties.filter((p) => ids.includes(p.id)) };
    // The variant's own scenarios: one that relied on the rule ends broken, and is no seed. It
    // is evidence, though: a scenario that breaks a property without the rule shows it is needed,
    // wherever the search got to.
    const runs = variant.scenarios.map((scenario) => ({ scenario, run: runScenario(variant, scenario) }));
    const byScenario = new Map<string, { scenario: string; events: number }>();
    for (const { scenario, run } of runs) {
      const steps = run.events.filter((e) => e.kind !== "spawn");
      steps.forEach((event, i) => {
        for (const id of event.violations) if (ids.includes(id) && !byScenario.has(id)) byScenario.set(id, { scenario: scenario.name, events: i + 1 });
      });
    }
    const report = await check(needing, { ...bounds, walks: 0 }, scenarioSeeds(variant, runs), { ...options, watch: undefined, untilBroken: true });
    verdicts.push({
      name: rule.name,
      description: rule.description,
      neededBy: report.properties.map((p): NeededBy => {
        // Reachable properties need no rules (dsl.ts), so every one here has a counterexample when it breaks.
        if (!p.holds && !p.unreached) return { property: p.id, verdict: "breaks", events: p.counterexample.events.length + (p.loop?.events.length ?? 0) };
        const shown = byScenario.get(p.id);
        if (shown) return { property: p.id, verdict: "breaks", ...shown };
        // Held on every path there is: a search the depth bound cut off has not seen them all, and
        // "the rule is not needed" would be a claim about paths it never took.
        return { property: p.id, verdict: report.exhaustive && !report.cutAtDepth && !(p.holds && p.unfinished) && !report.chance?.length ? "holds" : "unfinished" };
      }),
    });
  }
  return verdicts;
}
