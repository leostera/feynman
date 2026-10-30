// Rules that are needed (RFD0010): a property that needs a rule should break in the design
// without it. Each claimed rule is checked on that variant, built again from the spec's
// definition, restricted to the properties that need it, until every one of them has broken.
import type { Spec } from "../spec/index.ts";
import { check, type Bounds, type CheckOptions } from "./explore.ts";
import { scenarioSeeds } from "./seeds.ts";

/** What became of one property that needs a rule, in the design without the rule. */
export interface NeededBy {
  property: string;
  /** "breaks": the claim holds. "holds": the rule was not needed (it fails the check). "unfinished": held, but the search stopped early. */
  verdict: "breaks" | "holds" | "unfinished";
  /** With "breaks": the events in its shortest counterexample. */
  events?: number;
}

export interface RuleVerdict {
  name: string;
  description: string;
  neededBy: NeededBy[];
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
    // The variant's own scenarios: one that relied on the rule ends broken, and is no seed.
    const report = await check(needing, { ...bounds, walks: 0 }, scenarioSeeds(variant), { ...options, watch: undefined, untilBroken: true });
    verdicts.push({
      name: rule.name,
      description: rule.description,
      neededBy: report.properties.map((p): NeededBy => {
        if (!p.holds) return { property: p.id, verdict: "breaks", events: p.counterexample.events.length + (p.loop?.events.length ?? 0) };
        return { property: p.id, verdict: report.exhaustive && !p.unfinished ? "holds" : "unfinished" };
      }),
    });
  }
  return verdicts;
}
