// Comparing the checker with TLC, the TLA+ model checker, on the same systems.
//
// Each oracle in ../oracles is an independent TLA+ model of a spec in ../specs, following
// Feynman's semantics: the network is a bag, any message in it may go next, a fault loses one
// or restarts an instance, and each instance takes each action at most `repeats` times. TLC
// then gives the reachable states, which invariants break, and the shortest way there.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, pendingText, type Bounds, type Report } from "../../src/check/index.ts";
import type { Spec, World } from "../../src/spec/index.ts";
import { sortedJson } from "../../src/spec/json.ts";

const JAR_PLACES = [process.env.TLA_TOOLS_JAR, "/Applications/TLA+ Toolbox.app/Contents/Eclipse/tla2tools.jar", "/opt/homebrew/share/tla2tools.jar"];

/**
 * A Java that runs: JAVA_HOME's, Homebrew's (keg-only, so not on PATH), or the one the TLA+
 * Toolbox bundles. macOS's /usr/bin/java is a stub that only says no runtime is installed.
 */
const JAVA_PLACES = [
  process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin", "java"),
  "/opt/homebrew/opt/openjdk/bin/java",
  "/usr/local/opt/openjdk/bin/java",
  "/Applications/TLA+ Toolbox.app/Contents/Eclipse/plugins/org.lamport.openjdk.macosx.x86_64_14.0.1.7/Contents/Home/bin/java",
  "java",
];
const JAVA = JAVA_PLACES.find((p): p is string => !!p && spawnSync(p, ["-version"]).status === 0);

/** Where tla2tools.jar is, if anywhere (set TLA_TOOLS_JAR to point at it), and only when a Java can run it. */
export const TLA_JAR = JAVA ? JAR_PLACES.find((p): p is string => !!p && existsSync(p)) : undefined;

export interface TlcResult {
  distinct: number;
  /** The invariant TLC found broken, and the events of its counterexample (states minus the first). */
  violated?: { invariant: string; events: number };
}

/** Run TLC on an oracle with these constants, checking the given invariants (none: just count states). */
export function tlc(module: string, constants: Record<string, string | number | boolean>, invariants: string[] = [], options: { view?: string } = {}): TlcResult {
  const dir = mkdtempSync(join(tmpdir(), "feynman-tlc-"));
  try {
    copyFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", `${module}.tla`), join(dir, `${module}.tla`));
    const cfg = ["CONSTANTS", ...Object.entries(constants).map(([k, v]) => `  ${k} = ${typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v}`), "INIT Init", "NEXT Next", ...(options.view ? [`VIEW ${options.view}`] : []), ...(invariants.length ? ["INVARIANTS", ...invariants.map((i) => `  ${i}`)] : [])];
    writeFileSync(join(dir, `${module}.cfg`), cfg.join("\n") + "\n");
    let out: string;
    try {
      out = execFileSync(JAVA!, ["-XX:+UseParallelGC", "-cp", TLA_JAR!, "tlc2.TLC", "-workers", "1", "-deadlock", "-metadir", join(dir, "meta"), module], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // TLC exits non-zero when it finds a violation; its output is still the report.
      out = String((error as { stdout?: string }).stdout ?? "");
    }
    const distinct = Number(/([\d,]+) distinct states? found/.exec(out)?.[1].replace(/,/g, "") ?? NaN);
    const broken = /Invariant (\w+) is violated/.exec(out);
    // A violation is an answer; any other error (an invariant that fails to evaluate, a bad
    // model) is not, and must not pass for "no violation".
    const errors = out.split("\n").filter((line) => line.startsWith("Error:") && !/^Error: (Invariant \w+ is violated|The behavior up to this point is)/.test(line));
    if (errors.length || /Parsing or semantic analysis failed/.test(out) || Number.isNaN(distinct)) throw new Error(`TLC failed on ${module}:\n${out}`);
    const states = [...out.matchAll(/^State (\d+):/gm)].map((m) => Number(m[1]));
    return { distinct, ...(broken ? { violated: { invariant: broken[1], events: Math.max(...states) - 1 } } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A world as TLA+ sees it: states, what is in flight (as a bag, no times), counters, the budget spent, and what `never` properties remember. */
function projection(world: World, budget: { acts: Record<string, number>; faults: number; memory: string }): string {
  return [
    world.instances.map((i) => `${i.id}=${sortedJson(i.state)}`).sort().join("\n"),
    world.pending.map((p) => pendingText(p)).sort().join("\n"),
    sortedJson(world.fresh),
    sortedJson(budget.acts),
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
  return readFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", `${module}.tla`), "utf8");
}
