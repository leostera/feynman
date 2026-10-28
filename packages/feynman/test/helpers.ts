// Helpers shared by the tests.
import type { PropertyBroken, PropertyResult, Report } from "../src/check/index.ts";

/** A property expected broken, as broken: it fails the test, saying so, if it held. */
export function broken(property: PropertyResult | undefined): PropertyBroken {
  if (!property) throw new Error("no such property");
  if (property.holds) throw new Error(`${property.id} holds; expected it broken`);
  return property;
}

/** The property of a report with this id, expected broken. */
export function brokenIn(report: Report, id: string): PropertyBroken {
  return broken(report.properties.find((p) => p.id === id));
}
