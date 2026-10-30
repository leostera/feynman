// The commands: each takes the repository context and parsed flags, prints, and returns
// an exit status.
import { join } from "node:path";
import { checkSources, git, repositoryAt, withWorktree, writeLock, type Repository } from "../code/index.ts";
import { diffRuns, runScenario, type RunDiff, type Spec } from "../spec/index.ts";
import type { Config } from "./config.ts";
import { discoverSpecs, selectSpecs } from "./discover.ts";
import { bold, dim, formatDiff, formatEvents, formatSources, green, red } from "./format.ts";
import { loadSpec, readConfig, type LoadedSpec } from "./load.ts";

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

export async function loadSelected(ctx: Context, named: string[]): Promise<({ path: string } & LoadedSpec)[]> {
  const paths = selectSpecs(ctx.repository.root, ctx.cwd, ctx.found, named);
  if (!paths.length) throw new Error("No specs found. Write one in specs/<name>.ts next to a package.json, or list them in feynman.config.ts.");
  const out = [];
  for (const path of paths) out.push({ path, ...(await loadSpec(join(ctx.repository.root, path))) });
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
      const { spec } = await loadSpec(join(ctx.repository.root, path));
      const counts = `${spec.actors.length} actors, ${Object.keys(spec.messages).length} messages, ${spec.properties.length} properties, ${spec.scenarios.length} scenarios`;
      console.log(`${path}  ${bold(spec.name)}  ${dim(counts)}`);
    } catch (error) {
      console.error(`${path}  ${red((error as Error).message)}`);
      status = 1;
    }
  }
  return status;
}

export async function runCommand(ctx: Context, named: string[], scenarioName?: string, all = false, without: string[] = [], set: Record<string, unknown> = {}): Promise<number> {
  let status = 0;
  const variant = (spec: Spec) => {
    const values = Object.keys(set).length ? spec.setting(set) : spec;
    return without.length ? values.withoutRules(without) : values;
  };
  const selected = (await loadSelected(ctx, named)).map((s) => ({ ...s, spec: variant(s.spec) }));
  // Every trace of every scenario runs to tens of kilobytes: several scenarios get a line each.
  const traces = all || scenarioName !== undefined || selected.reduce((n, { spec }) => n + spec.scenarios.length, 0) <= 1;
  for (const { path, spec } of selected) {
    const scenarios = scenarioName ? spec.scenarios.filter((s) => s.name === scenarioName) : spec.scenarios;
    if (!scenarios.length) {
      console.log(red(`${path}: no scenario ${scenarioName ? `named "${scenarioName}"` : "defined"}; scenarios: ${spec.scenarios.map((s) => s.name).join(", ") || "none"}`));
      status = 1;
    }
    if (!traces && scenarios.length) {
      console.log(dim(path));
      for (const scenario of scenarios) {
        const run = runScenario(spec, scenario);
        if (run.error) status = 1;
        console.log(run.error ? red(`  ✗ ${scenario.name}  stopped after ${run.events.length} event(s): ${run.error}`) : `  ${green("✓")} ${scenario.name}  ${dim(`${run.events.length} event(s)`)}`);
      }
      continue;
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
  if (!traces) console.log(dim(`feynman run <spec> --scenario NAME prints one trace; --all prints every one.`));
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
      base = (await loadSpec(join(dir, path))).spec;
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

