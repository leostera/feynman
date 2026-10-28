// feynman <command> [specs…] [flags]
import { parseArgs } from "node:util";
import type { Bounds } from "../check/index.ts";
import { checkCommand, type CheckOptions } from "./check.ts";
import { context, diffCommand, list, lockCommand, runCommand } from "./commands.ts";
import { buildCommand, devCommand } from "./serve.ts";
import { red } from "./format.ts";
import manifest from "../../package.json" with { type: "json" };

export const USAGE = `feynman: executable specs of how a system behaves.

Usage: feynman <command> [spec…] [flags]

Specs are TypeScript files in specs/ next to any package.json (or listed in
feynman.config.ts). Name them by path or by file name; by default all of them.

Commands:
  version                  The version of feynman (also --version, -v).
  list                     The specs in this repository.
  run [spec] [--scenario]  Run scenarios and print their traces.
  check [spec]             Explore every interleaving within bounds; check properties
                           (safety and liveness), that nothing gets stuck, scenarios,
                           and that every source still resolves.
      --depth N --faults N --repeats N --max-states N --time-limit SECONDS
      --instances Actor=N,Actor=N
      --walks N --walk-depth N   random runs past the depth (0 to turn off)
      --no-symmetry              keep interchangeable instances apart
      --symmetry-checks N        merged twins to test a symmetry claim on (2000; 0 trusts it)
      --workers N                threads to share big searches with (default: cores - 1, up to 7; 0 for one)
      --only P,Q                 check and show only these properties
      --brief                    verdicts and counterexample sizes, without traces
      --json                     the whole result as JSON, for scripts and agents
      --as-scenario              with --only P: P's counterexample as defineScenario code
  lock                     Record the code each source stands for in feynman.lock.
  diff [spec] [--base REF] Compare every scenario's trace with REF (default: main).
  dev [--port N]           Serve the explorer on the first free port from N (default: 4321).
  build [--out FILE|DIR/]  Write the explorer as one self-contained HTML file, with .gz
                           and .br next to it (default: .feynman/index.html; a directory
                           gets index.html).
  open                     Build, then open that file.
`;

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(manifest.version);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      scenario: { type: "string" },
      depth: { type: "string" },
      faults: { type: "string" },
      repeats: { type: "string" },
      "max-states": { type: "string" },
      "time-limit": { type: "string" },
      walks: { type: "string" },
      "walk-depth": { type: "string" },
      "no-symmetry": { type: "boolean" },
      "symmetry-checks": { type: "string" },
      workers: { type: "string" },
      instances: { type: "string" },
      base: { type: "string" },
      port: { type: "string" },
      out: { type: "string" },
      only: { type: "string" },
      brief: { type: "boolean" },
      json: { type: "boolean" },
      "as-scenario": { type: "boolean" },
    },
  });
  const ctx = await context(cwd);
  switch (command) {
    case "list":
      return list(ctx);
    case "run":
      return runCommand(ctx, positionals, values.scenario);
    case "check":
      return checkCommand(ctx, positionals, { bounds: bounds(values), only: ids(values.only), output: output(values) });
    case "lock":
      return lockCommand(ctx);
    case "diff":
      return diffCommand(ctx, positionals, values.base ?? "main");
    case "dev":
      return devCommand(ctx, { port: Number(values.port ?? 4321), base: values.base });
    case "build":
      return buildCommand(ctx, { out: values.out, base: values.base });
    case "open":
      return buildCommand(ctx, { out: values.out, base: values.base, open: true });
    default:
      console.error(red(`Unknown command ${command}.`));
      console.error(USAGE);
      return 2;
  }
}

function ids(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function output(values: { brief?: boolean; json?: boolean; "as-scenario"?: boolean }): CheckOptions["output"] {
  const chosen = (["brief", "json", "as-scenario"] as const).filter((flag) => values[flag]);
  if (chosen.length > 1) throw new Error(`--${chosen.join(" and --")} are different outputs: choose one`);
  return ({ brief: "brief", json: "json", "as-scenario": "scenario" } as const)[chosen[0]] ?? "text";
}

function bounds(values: Record<string, string | boolean | undefined>): Partial<Bounds> {
  const out: Partial<Bounds> = {};
  const int = (name: string) => {
    const raw = values[name];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} takes a whole number, not ${raw}`);
    return n;
  };
  if (int("depth") !== undefined) out.depth = int("depth");
  if (int("faults") !== undefined) out.faults = int("faults");
  if (int("repeats") !== undefined) out.repeats = int("repeats");
  if (int("max-states") !== undefined) out.maxStates = int("max-states");
  if (int("time-limit") !== undefined) out.timeLimit = int("time-limit")! * 1000;
  if (int("walks") !== undefined) out.walks = int("walks");
  if (int("walk-depth") !== undefined) out.walkDepth = int("walk-depth");
  if (values["no-symmetry"]) out.symmetry = false;
  if (int("symmetry-checks") !== undefined) out.symmetryChecks = int("symmetry-checks");
  if (int("workers") !== undefined) out.workers = int("workers");
  if (typeof values.instances === "string") {
    out.instances = Object.fromEntries(
      values.instances.split(",").map((pair) => {
        const [actor, n] = pair.split("=");
        if (!actor || !Number.isInteger(Number(n))) throw new Error(`--instances takes Actor=N pairs, not ${pair}`);
        return [actor.trim(), Number(n)];
      }),
    );
  }
  return out;
}
