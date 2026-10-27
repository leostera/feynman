// feynman <command> [specs…] [flags]
import { parseArgs } from "node:util";
import type { Bounds } from "../check/index.ts";
import { checkCommand, context, diffCommand, list, lockCommand, runCommand } from "./commands.ts";
import { buildCommand, devCommand } from "./serve.ts";
import { red } from "./format.ts";

export const USAGE = `feynman: executable specs of how a system behaves.

Usage: feynman <command> [spec…] [flags]

Specs are TypeScript files in specs/ next to any package.json (or listed in
feynman.config.ts). Name them by path or by file name; by default all of them.

Commands:
  list                     The specs in this repository.
  run [spec] [--scenario]  Run scenarios and print their traces.
  check [spec]             Explore every interleaving within bounds; check invariants,
                           scenarios, and that every source still resolves.
      --depth N --faults N --repeats N --max-states N --time-limit SECONDS
      --instances Actor=N,Actor=N
      --walks N --walk-depth N   random runs past the depth (0 to turn off)
      --no-symmetry              keep interchangeable instances apart
  lock                     Record the code each source stands for in feynman.lock.
  diff [spec] [--base REF] Compare every scenario's trace with REF (default: main).
  dev [--port N]           Serve the explorer on the first free port from N (default: 4321).
  build [--out FILE]       Write the explorer as one self-contained HTML file
                           (default: .feynman/index.html).
  open                     Build, then open that file.
`;

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
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
      instances: { type: "string" },
      base: { type: "string" },
      port: { type: "string" },
      out: { type: "string" },
    },
  });
  const ctx = await context(cwd);
  switch (command) {
    case "list":
      return list(ctx);
    case "run":
      return runCommand(ctx, positionals, values.scenario);
    case "check":
      return checkCommand(ctx, positionals, bounds(values));
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
