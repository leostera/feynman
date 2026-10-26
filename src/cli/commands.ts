// The commands: each takes the repository context and parsed flags, prints, and returns
// an exit status.
import { join } from "node:path";
import { check, type Bounds } from "../check/index.ts";
import { checkSources, git, repositoryAt, withWorktree, writeLock, type Repository } from "../code/index.ts";
import { diffRuns, runScenario, type RunDiff, type Spec } from "../spec/index.ts";
import type { Config } from "./config.ts";
import { discoverSpecs, playgroundFor, selectSpecs } from "./discover.ts";
import { bold, dim, formatDiff, formatEvents, formatReport, formatSources, red, yellow } from "./format.ts";
import { loadPlayground, loadSpec, readConfig } from "./load.ts";
import { scenarioSeeds, shapeWarnings, totalSteps, unbuilt } from "./shape.ts";
import { typecheck } from "./types.ts";

export interface Context {
  cwd: string;
  repository: Repository;
  config: Config;
  /** Repository-relative spec paths found. */
  found: string[];
}

export async function context(cwd: string): Promise<Context> {
  const repository = repositoryAt(cwd);
  if (!repository) throw new Error(`${cwd} is not inside a git repository`);
  const config = await readConfig(repository.root);
  return { cwd, repository, config, found: discoverSpecs(repository.root, config) };
}

/** Every source a spec names: steps and limits. */
export function specSources(spec: Spec): string[] {
  const steps = spec.actors.flatMap((actor) => [...Object.values(actor.actions), ...Object.values(actor.transitions)]);
  return [...new Set([...steps.flatMap((s) => s.sources), ...spec.limits.flatMap((l) => l.sources)])].sort();
}

export async function loadSelected(ctx: Context, named: string[]): Promise<{ path: string; spec: Spec }[]> {
  const paths = selectSpecs(ctx.repository.root, ctx.cwd, ctx.found, named);
  if (!paths.length) throw new Error("No specs found. Write one in specs/<name>.ts next to a package.json, or list them in feynman.config.ts.");
  const out = [];
  for (const path of paths) out.push({ path, spec: await loadSpec(join(ctx.repository.root, path)) });
  return out;
}

export async function list(ctx: Context): Promise<number> {
  if (!ctx.found.length) {
    console.log("No specs found.");
    return 0;
  }
  let status = 0;
  for (const path of ctx.found) {
    try {
      const spec = await loadSpec(join(ctx.repository.root, path));
      const counts = `${spec.actors.length} actors, ${Object.keys(spec.messages).length} messages, ${spec.invariants.length} invariants, ${spec.scenarios.length} scenarios`;
      console.log(`${path}  ${bold(spec.name)}  ${dim(counts)}`);
    } catch (error) {
      console.error(`${path}  ${red((error as Error).message)}`);
      status = 1;
    }
  }
  return status;
}

export async function checkCommand(ctx: Context, named: string[], bounds: Partial<Bounds>): Promise<number> {
  let status = 0;
  const selected = await loadSelected(ctx, named);
  const plays = selected.map((s) => playgroundFor(ctx.repository.root, s.path)).filter((p): p is string => p !== null);
  const typeErrors = typecheck(ctx.repository.root, [...selected.map((s) => s.path), ...plays]);
  for (const e of typeErrors) console.log(red(`${e.file}:${e.line}:${e.column} ${e.message}`));
  if (typeErrors.length) status = 1;
  for (const play of plays) {
    try {
      await loadPlayground(join(ctx.repository.root, play));
    } catch (error) {
      status = 1;
      console.log(red((error as Error).message));
    }
  }
  for (const { path, spec } of selected) {
    const merged = { ...ctx.config.check, ...bounds, instances: { ...ctx.config.check?.instances, ...bounds.instances } };
    console.log(dim(path));
    const scenarios = spec.scenarios.map((scenario) => ({ scenario, run: runScenario(spec, scenario) }));
    const brokenBy = new Map<string, string>();
    for (const { scenario, run } of scenarios) {
      const broken = run.error ?? run.events.find((e) => e.error)?.error ?? run.events.find((e) => e.violations.length)?.violations.join(", ");
      if (broken) {
        status = 1;
        console.log(red(`  ✗ scenario "${scenario.name}": ${broken}`));
        for (const invariant of spec.invariants) if (new RegExp(`\\b${invariant.id}\\b`).test(broken) && !brokenBy.has(invariant.id)) brokenBy.set(invariant.id, scenario.name);
      }
    }
    const report = check(spec, merged, scenarioSeeds(spec, scenarios));
    console.log(formatReport(spec, report, brokenBy));
    if (!report.exhaustive) console.log(dim(`  "~" is not a proof: raise the limits or lower the bounds until exploration finishes.`));
    if (report.properties.some((p) => p.holds && p.tested === 0)) console.log(dim(`  "?" was never tested: add a scenario that gets there, so exploration starts from its end.`));
    const statuses = checkSources(ctx.repository.root, specSources(spec));
    for (const line of formatSources(statuses)) console.log(line);
    for (const w of shapeWarnings(spec)) console.log(yellow(`  ! ${w.actor} ${w.step} ${w.message}`));
    const designed = unbuilt(spec);
    if (designed.length) {
      const all = designed.length === totalSteps(spec);
      const which = designed.length <= 6 ? `: ${designed.map((d) => `${d.actor} ${d.step}`).join(", ")}` : "";
      console.log(dim(all ? `  no step points at code yet; this spec is a design. Add sources as the code appears.` : `  ${designed.length} step(s) have no code yet${which}`));
    }
    if (report.properties.some((p) => !p.holds) || report.errors.length || statuses.some((s) => s.status === "missing")) status = 1;
  }
  return status;
}

export async function runCommand(ctx: Context, named: string[], scenarioName?: string): Promise<number> {
  let status = 0;
  for (const { path, spec } of await loadSelected(ctx, named)) {
    const scenarios = scenarioName ? spec.scenarios.filter((s) => s.name === scenarioName) : spec.scenarios;
    if (!scenarios.length) {
      console.log(red(`${path}: no scenario ${scenarioName ? `named "${scenarioName}"` : "defined"}; scenarios: ${spec.scenarios.map((s) => s.name).join(", ") || "none"}`));
      status = 1;
    }
    for (const scenario of scenarios) {
      const run = runScenario(spec, scenario);
      console.log(`${bold(scenario.name)} ${dim(`(${path})`)}`);
      console.log(formatEvents(spec, run.events, run.worlds));
      if (run.error) {
        console.log(red(`  scenario stopped: ${run.error}`));
        status = 1;
      }
      console.log();
    }
  }
  return status;
}

export async function lockCommand(ctx: Context): Promise<number> {
  const sources = new Set<string>();
  for (const { spec } of await loadSelected(ctx, [])) specSources(spec).forEach((s) => sources.add(s));
  const statuses = checkSources(ctx.repository.root, [...sources]);
  const missing = statuses.filter((s) => s.status === "missing");
  for (const line of formatSources(missing)) console.log(line);
  writeLock(ctx.repository.root, statuses);
  console.log(`feynman.lock: ${statuses.length - missing.length} source(s) locked${missing.length ? red(`, ${missing.length} missing`) : ""}`);
  return missing.length ? 1 : 0;
}

export interface FlowDiffs {
  base: { ref: string; commit: string };
  flows: Record<string, RunDiff | "added" | "removed">;
}

/** Every scenario of a spec at `ref` and now, compared. */
export async function diffSpec(ctx: Context, path: string, spec: Spec, ref: string): Promise<FlowDiffs & { baseSpec: Spec | null }> {
  const commit = git(ctx.repository.root, "rev-parse", "--verify", `${ref}^{commit}`);
  return withWorktree(ctx.repository.root, ref, async (dir) => {
    let base: Spec | null = null;
    try {
      base = await loadSpec(join(dir, path));
    } catch {
      base = null;
    }
    const flows: FlowDiffs["flows"] = {};
    for (const scenario of spec.scenarios) {
      const before = base?.scenarios.find((s) => s.name === scenario.name);
      flows[scenario.name] = before ? diffRuns(runScenario(base!, before), runScenario(spec, scenario)) : "added";
    }
    for (const scenario of base?.scenarios ?? []) if (!spec.scenarios.some((s) => s.name === scenario.name)) flows[scenario.name] = "removed";
    return { base: { ref, commit }, flows, baseSpec: base };
  });
}

export async function diffCommand(ctx: Context, named: string[], ref: string): Promise<number> {
  for (const { path, spec } of await loadSelected(ctx, named)) {
    const diff = await diffSpec(ctx, path, spec, ref);
    console.log(`${bold(spec.name)}, ${ref} (${diff.base.commit.slice(0, 7)}) → ${ctx.repository.dirty ? "working tree" : ctx.repository.commit.slice(0, 7)}${diff.baseSpec ? "" : dim(" — the spec is new")}`);
    for (const [scenario, flow] of Object.entries(diff.flows)) console.log(formatDiff(spec, scenario, flow));
  }
  return 0;
}

