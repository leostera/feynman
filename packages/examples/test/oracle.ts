// Comparing the checker with TLC, the TLA+ model checker, on the same systems.
//
// Each oracle in ../oracles is an independent TLA+ model of a spec in ../specs, following
// Feynman's semantics: the network is a bag, any message in it may go next, a fault loses one
// or restarts an instance, and each instance takes each action at most `repeats` times. TLC
// then gives the reachable states, which invariants break, and the shortest way there.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, pendingText, type Bounds, type Report } from "@feynman/check";
import type { Spec, World } from "@feynman/spec";

const JAR_PLACES = [process.env.TLA_TOOLS_JAR, "/Applications/TLA+ Toolbox.app/Contents/Eclipse/tla2tools.jar", "/opt/homebrew/share/tla2tools.jar"];

/** Where tla2tools.jar is, if anywhere: set TLA_TOOLS_JAR to point at it. */
export const TLA_JAR = JAR_PLACES.find((p): p is string => !!p && existsSync(p));

export interface TlcResult {
  distinct: number;
  /** The invariant TLC found broken, and the events of its counterexample (states minus the first). */
  violated?: { invariant: string; events: number };
}

/** Run TLC on an oracle with these constants, checking the given invariants (none: just count states). */
export function tlc(module: string, constants: Record<string, string | number | boolean>, invariants: string[] = [], options: { view?: string } = {}): TlcResult {
  const dir = mkdtempSync(join(tmpdir(), "feynman-tlc-"));
  try {
    copyFileSync(join(import.meta.dir, "..", "oracles", `${module}.tla`), join(dir, `${module}.tla`));
    const cfg = ["CONSTANTS", ...Object.entries(constants).map(([k, v]) => `  ${k} = ${typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v}`), "INIT Init", "NEXT Next", ...(options.view ? [`VIEW ${options.view}`] : []), ...(invariants.length ? ["INVARIANTS", ...invariants.map((i) => `  ${i}`)] : [])];
    writeFileSync(join(dir, `${module}.cfg`), cfg.join("\n") + "\n");
    let out: string;
    try {
      out = execFileSync("java", ["-XX:+UseParallelGC", "-cp", TLA_JAR!, "tlc2.TLC", "-workers", "1", "-deadlock", "-metadir", join(dir, "meta"), module], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // TLC exits non-zero when it finds a violation; its output is still the report.
      out = String((error as { stdout?: string }).stdout ?? "");
    }
    const distinct = Number(/([\d,]+) distinct states? found/.exec(out)?.[1].replace(/,/g, "") ?? NaN);
    const broken = /Invariant (\w+) is violated/.exec(out);
    if (/TLC threw an unexpected exception|Parsing or semantic analysis failed/.test(out)) throw new Error(`TLC failed on ${module}:\n${out}`);
    const states = [...out.matchAll(/^State (\d+):/gm)].map((m) => Number(m[1]));
    return { distinct, ...(broken ? { violated: { invariant: broken[1], events: Math.max(...states) - 1 } } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** JSON with object keys sorted: two states that differ only in the order fields were added are one. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** A world as TLA+ sees it: states, what is in flight (as a bag, no times), counters, the budget spent, and what `never` properties remember. */
function projection(world: World, budget: { acts: Record<string, number>; faults: number; memory: string }): string {
  return [
    world.instances.map((i) => `${i.id}=${stable(i.state)}`).sort().join("\n"),
    world.pending.map((p) => pendingText(p)).sort().join("\n"),
    stable(world.fresh),
    stable(budget.acts),
    budget.faults,
    budget.memory,
  ].join("\n--\n");
}

/** The checker's exhaustive search, plain, and the distinct states it reached as TLA+ sees them. */
export function feynman(spec: Spec, bounds: Partial<Bounds>): { report: Report; distinct: number } {
  const seen = new Set<string>();
  const report = check(spec, { depth: 60, maxStates: 5_000_000, timeLimit: 300_000, walks: 0, reduce: false, symmetry: false, ...bounds }, [], { state: (w, b) => seen.add(projection(w, b)) });
  return { report, distinct: seen.size };
}

export function readOracle(module: string): string {
  return readFileSync(join(import.meta.dir, "..", "oracles", `${module}.tla`), "utf8");
}
