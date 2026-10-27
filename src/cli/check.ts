// feynman check: type-check, run the scenarios, explore, and check sources. Each spec's
// outcome is gathered first (SpecCheck), then shown as text, briefly, as JSON, or as the
// scenario replaying one counterexample.
import { join } from "node:path";
import { check, faultsIn, withFewestFaults, type Bounds, type Report } from "../check/index.ts";
import { checkSources, type SourceStatus } from "../code/index.ts";
import { runScenario, type Event, type Spec, type World } from "../spec/index.ts";
import { specSources, loadSelected, type Context } from "./commands.ts";
import { playgroundFor } from "./discover.ts";
import { dim, formatReport, formatSources, red, yellow } from "./format.ts";
import { loadPlayground } from "./load.ts";
import { scenarioCode } from "./scenario-code.ts";
import { scenarioSeeds, shapeWarnings, totalSteps, unbuilt, type ShapeWarning } from "./shape.ts";
import { typecheck } from "./types.ts";
import { verdictOf } from "./verdict.ts";

export interface CheckOptions {
  bounds: Partial<Bounds>;
  /** Property ids to check and show; all when empty. */
  only: string[];
  output: "text" | "brief" | "json" | "scenario";
}

export interface ScenarioOutcome {
  name: string;
  /** What stopped it or what it broke; none when it ran cleanly. */
  broken?: string;
  /** It only breaks properties marked known. */
  known?: boolean;
}

export interface SpecCheck {
  path: string;
  spec: Spec;
  scenarios: ScenarioOutcome[];
  report: Report;
  /** Properties a scenario breaks, which count as broken whatever exploration found. */
  brokenBy: Map<string, string>;
  sources: SourceStatus[];
  shape: ShapeWarning[];
  unbuilt: { actor: string; step: string }[];
  steps: number;
}

/** Whether a spec's check fails: a broken property, a stale `known`, a spec error, a stuck world, a broken scenario or a missing source. */
export function fails(result: SpecCheck, focused: boolean): boolean {
  const verdicts = result.report.properties.map((p) => verdictOf(p, result));
  if (verdicts.some((v) => v === "broken" || v === "fixed") || result.report.errors.length) return true;
  if (result.report.stuck && !focused) return true;
  if (focused) return false;
  return result.scenarios.some((s) => s.broken && !s.known) || result.sources.some((s) => s.status === "missing");
}

export async function checkCommand(ctx: Context, named: string[], options: CheckOptions): Promise<number> {
  const out = (line = "") => options.output !== "json" && console.log(line);
  let status = 0;
  const selected = await loadSelected(ctx, named);
  if (options.only.length) {
    const known = new Set(selected.flatMap(({ spec }) => spec.properties.map((p) => p.id)));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`No property named ${unknown.join(", ")}; properties: ${[...known].join(", ") || "none"}`);
  }
  if (options.output === "scenario" && options.only.length !== 1) throw new Error("--as-scenario replays one counterexample: name its property with --only");

  const plays = selected.map((s) => playgroundFor(ctx.repository.root, s.path)).filter((p): p is string => p !== null);
  const typeErrors = typecheck(ctx.repository.root, [...selected.map((s) => s.path), ...plays]);
  for (const e of typeErrors) out(red(`${e.file}:${e.line}:${e.column} ${e.message}`));
  if (typeErrors.length) status = 1;
  for (const play of plays) {
    try {
      await loadPlayground(join(ctx.repository.root, play));
    } catch (error) {
      status = 1;
      out(red((error as Error).message));
    }
  }

  const results: SpecCheck[] = [];
  for (const { path, spec } of selected) {
    const focused = focus(spec, options.only);
    if (!focused) continue;
    const result = checkSpec(ctx, path, focused, options.bounds);
    results.push(result);
    if (fails(result, options.only.length > 0)) status = 1;
    if (options.output === "text" || options.output === "brief") out(formatCheck(result, { brief: options.output === "brief", focused: options.only.length > 0 }));
    if (options.output === "scenario") {
      const property = result.report.properties[0];
      if (property.holds) out(dim(`${property.id} holds within these bounds: there is no counterexample to replay.`));
      else out(scenarioCode(spec, property));
    }
  }
  if (options.output === "json") console.log(JSON.stringify({ ok: status === 0, typeErrors, specs: results.map(toJson) }, null, 2));
  return status;
}

/** The spec with only the named properties, or null if it has none of them. */
function focus(spec: Spec, only: string[]): Spec | null {
  if (!only.length) return spec;
  const properties = spec.properties.filter((p) => only.includes(p.id));
  return properties.length ? { ...spec, properties } : null;
}

function checkSpec(ctx: Context, path: string, spec: Spec, bounds: Partial<Bounds>): SpecCheck {
  const merged = { ...ctx.config.check, ...bounds, instances: { ...ctx.config.check?.instances, ...bounds.instances } };
  const known = new Set(spec.properties.filter((p) => p.known !== undefined).map((p) => p.id));
  const runs = spec.scenarios.map((scenario) => ({ scenario, run: runScenario(spec, scenario) }));
  const brokenBy = new Map<string, string>();
  const scenarios = runs.map(({ scenario, run }): ScenarioOutcome => {
    const failure = run.error ?? run.events.find((e) => e.error)?.error;
    if (failure) return { name: scenario.name, broken: failure };
    const violated = [...new Set(run.events.flatMap((e) => e.violations))];
    for (const id of violated) if (!brokenBy.has(id)) brokenBy.set(id, scenario.name);
    if (!violated.length) return { name: scenario.name };
    return { name: scenario.name, broken: violated.join(", "), known: violated.every((id) => known.has(id)) };
  });
  const seeds = scenarioSeeds(spec, runs);
  const report = withFewestFaults(spec, check(spec, merged, seeds), seeds);
  return {
    path,
    spec,
    scenarios,
    report,
    brokenBy,
    sources: checkSources(ctx.repository.root, specSources(spec)),
    shape: shapeWarnings(spec),
    unbuilt: unbuilt(spec),
    steps: totalSteps(spec),
  };
}

function formatCheck(result: SpecCheck, how: { brief: boolean; focused: boolean }): string {
  const { spec, report } = result;
  const lines = [dim(result.path)];
  if (!how.focused)
    for (const s of result.scenarios.filter((s) => s.broken)) lines.push(s.known ? yellow(`  ✗ scenario "${s.name}": ${s.broken} (known bug)`) : red(`  ✗ scenario "${s.name}": ${s.broken}`));
  lines.push(formatReport(spec, report, { brokenBy: result.brokenBy, brief: how.brief, verdict: (p) => verdictOf(p, result), command: `feynman check ${result.path}` }));
  const verdicts = report.properties.map((p) => verdictOf(p, result));
  if (verdicts.includes("unfinished")) lines.push(dim(`  "~" is not a proof: raise the limits or lower the bounds until exploration finishes.`));
  if (verdicts.includes("untested")) lines.push(dim(`  "?" was never tested: add a scenario that gets there, so exploration starts from its end.`));
  if (how.focused) return lines.join("\n");
  lines.push(...formatSources(result.sources));
  for (const w of result.shape) lines.push(yellow(`  ! ${w.actor} ${w.step} ${w.message}`));
  if (result.unbuilt.length) {
    const all = result.unbuilt.length === result.steps;
    const which = result.unbuilt.length <= 6 ? `: ${result.unbuilt.map((d) => `${d.actor} ${d.step}`).join(", ")}` : "";
    lines.push(dim(all ? `  no step points at code yet; this spec is a design. Add sources as the code appears.` : `  ${result.unbuilt.length} step(s) have no code yet${which}`));
  }
  return lines.join("\n");
}

// JSON -----------------------------------------------------------------------------------------------

function toJson(result: SpecCheck) {
  const { spec, report } = result;
  return {
    path: result.path,
    spec: spec.name,
    ok: !fails(result, false),
    bounds: report.bounds,
    states: report.states,
    exhaustive: report.exhaustive,
    stoppedBy: report.stoppedBy ?? null,
    durationMs: report.durationMs,
    scenarios: result.scenarios,
    properties: report.properties.map((p) => ({
      id: p.id,
      kind: p.kind,
      description: p.description,
      verdict: verdictOf(p, result),
      ...(p.known !== undefined ? { known: p.known } : {}),
      ...(result.brokenBy.has(p.id) ? { brokenByScenario: result.brokenBy.get(p.id) } : {}),
      ...(p.counterexample
        ? {
            counterexample: {
              foundBy: p.foundBy,
              from: p.counterexample.from ?? null,
              faults: faultsIn(p.counterexample.events),
              ...(p.shorter ? { shorter: p.shorter } : {}),
              events: p.counterexample.events.map((e, i) => eventJson(e, p.counterexample!.worlds[i])),
              ...(p.loop ? { loop: p.loop.events.map((e, i) => eventJson(e, p.loop!.worlds[i])) } : {}),
            },
          }
        : {}),
    })),
    errors: report.errors.map((e) => ({ message: e.message, events: e.counterexample.events.map((ev, i) => eventJson(ev, e.counterexample.worlds[i])) })),
    ...(report.stuck ? { stuck: { foundBy: report.stuck.foundBy, events: report.stuck.counterexample.events.map((ev, i) => eventJson(ev, report.stuck!.counterexample.worlds[i])) } } : {}),
    neverRan: report.coverage.missed,
    sources: result.sources.map((s) => ({ source: s.source, status: s.status, ...(s.status === "missing" ? { reason: s.reason } : {}) })),
    warnings: result.shape,
    unbuilt: result.unbuilt,
  };
}

function eventJson(event: Event, world: World | undefined) {
  const label = (id: string) => world?.instances.find((i) => i.id === id)?.label ?? id;
  return {
    kind: event.kind,
    actor: event.actor,
    instance: label(event.instance),
    step: event.key,
    description: event.description,
    ...(event.inputs && Object.keys(event.inputs).length ? { inputs: event.inputs } : {}),
    ...(event.payload !== undefined && event.kind !== "spawn" ? { payload: event.payload } : {}),
    ...(event.from ? { from: label(event.from) } : {}),
    changes: event.changes.map((c) => ({ instance: label(c.instance), path: c.path, before: c.before, after: c.after })),
    sent: event.sent.map((s) => ({ to: label(s.to), message: s.message.replace(/^message:/, ""), payload: s.payload })),
    ...(event.error ? { error: event.error } : {}),
    ...(event.violations.length ? { violations: event.violations } : {}),
  };
}
