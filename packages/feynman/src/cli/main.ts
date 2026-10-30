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
  run [spec] [--scenario NAME | --all]
                           Run scenarios: one prints its trace; several, how each ended
                           (--all prints every trace).
  check [spec]             Explore every interleaving within bounds; check properties
                           (safety and liveness), that nothing gets stuck, scenarios,
                           and that every source still resolves.
      --depth N --faults N --repeats N --max-states N --time-limit SECONDS
      --memory-limit GB          stop, keeping the verdicts so far, past this much memory (50% of the machine's)
      --instances Actor=N,Actor=N
      --walks N --walk-depth N   random runs past the depth (0 to turn off)
      --no-symmetry              keep interchangeable instances apart
      --symmetry-checks N        merged twins to test a symmetry claim on (2000; 0 trusts it)
      --workers N                threads for the classic search (FEYNMAN_ENGINE=classic; default: cores - 1, up to 7)
      --only P,Q                 check and show only these properties
      --without R,S              the design without these rules (check and run; RFD0010)
      --set NAME=VALUE           start a model variable at another value, like a budget (check and run; RFD0012)
      --no-rules                 skip checking that each rule is needed
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
      all: { type: "boolean" },
      without: { type: "string" },
      set: { type: "string", multiple: true },
      "no-rules": { type: "boolean" },
      depth: { type: "string" },
      faults: { type: "string" },
      repeats: { type: "string" },
      "max-states": { type: "string" },
      "memory-limit": { type: "string" },
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
      return runCommand(ctx, positionals, values.scenario, values.all === true, ids(values.without), settings(values.set));
    case "check":
      return checkCommand(ctx, positionals, { bounds: bounds(values), only: ids(values.only), output: output(values), without: ids(values.without), set: settings(values.set), rules: values["no-rules"] !== true });
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

/** `--set faults=2 --set mode=fast`: each value as JSON when it is JSON (2, true, "x", [1]), else as text. */
function settings(raw: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of raw ?? []) {
    const at = item.indexOf("=");
    if (at <= 0) throw new Error(`--set takes name=value, like --set faults=2: not ${item}`);
    const text = item.slice(at + 1);
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Not JSON: the text itself.
    }
    out[item.slice(0, at)] = value;
  }
  return out;
}

function ids(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function output(values: { brief?: boolean; json?: boolean; "as-scenario"?: boolean }): CheckOptions["output"] {
  const chosen = (["brief", "json", "as-scenario"] as const).filter((flag) => values[flag]);
  if (chosen.length > 1) throw new Error(`--${chosen.join(" and --")} are different outputs: choose one`);
  return ({ brief: "brief", json: "json", "as-scenario": "scenario" } as const)[chosen[0]] ?? "text";
}

function bounds(values: Record<string, string | string[] | boolean | undefined>): Partial<Bounds> {
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
  if (values["memory-limit"] !== undefined) {
    const gb = Number(values["memory-limit"]);
    if (!(gb > 0)) throw new Error(`--memory-limit takes gigabytes, like --memory-limit 16: got ${values["memory-limit"]}`);
    out.memoryLimit = Math.floor(gb * 1024);
  }
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
