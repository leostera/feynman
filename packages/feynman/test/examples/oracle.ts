// Comparing the checker with TLC, the TLA+ model checker, and with Alloy, on the same systems.
//
// Each oracle in examples/oracles is an independent TLA+ model of an example, following
// Feynman's semantics: the network is a bag, any message in it may go next, a fault (a step
// the spec declares, RFD0012) loses one or restarts an instance, and each instance takes each
// action at most twice (atMost(2)). TLC then gives the reachable states, which invariants break, and the shortest way there.
// The models in examples/oracles/alloy follow the same semantics for Alloy 6, which searches
// traces by SAT rather than states one by one: which invariants break, and the shortest way.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** Whether the temporal properties checked were violated. */
  temporal?: boolean;
}

export interface TlcOptions {
  view?: string;
  /** Where the module is: examples/oracles by default. */
  dir?: string;
  /** Check these temporal properties under this specification (with its fairness), not Init and Next. */
  temporal?: { specification: string; properties: string[] };
}

/** Run TLC on an oracle with these constants, checking the given invariants (none: just count states). */
export function tlc(module: string, constants: Record<string, string | number | boolean>, invariants: string[] = [], options: TlcOptions = {}): TlcResult {
  const dir = mkdtempSync(join(tmpdir(), "feynman-tlc-"));
  try {
    copyFileSync(join(options.dir ?? join(import.meta.dir, "..", "..", "examples", "oracles"), `${module}.tla`), join(dir, `${module}.tla`));
    const constantLines = Object.entries(constants).map(([k, v]) => `  ${k} = ${typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v}`);
    const behaviour = options.temporal ? [`SPECIFICATION ${options.temporal.specification}`, ...(options.temporal.properties.length ? ["PROPERTIES", ...options.temporal.properties.map((p) => `  ${p}`)] : [])] : ["INIT Init", "NEXT Next"];
    const cfg = [...(constantLines.length ? ["CONSTANTS", ...constantLines] : []), ...behaviour, ...(options.view ? [`VIEW ${options.view}`] : []), ...(invariants.length ? ["INVARIANTS", ...invariants.map((i) => `  ${i}`)] : [])];
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
    const errors = out.split("\n").filter((line) => line.startsWith("Error:") && !/^Error: (Invariant \w+ is violated|The behavior up to this point is|Temporal properties were violated|The following behavior constitutes a counter-example)/.test(line));
    if (errors.length || /Parsing or semantic analysis failed/.test(out) || Number.isNaN(distinct)) throw new Error(`TLC failed on ${module}:\n${out}`);
    const states = [...out.matchAll(/^State (\d+):/gm)].map((m) => Number(m[1]));
    const temporal = options.temporal ? { temporal: /Temporal properties were violated/.test(out) } : {};
    return { distinct, ...temporal, ...(broken ? { violated: { invariant: broken[1], events: Math.max(...states) - 1 } } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A world as TLA+ sees it: states with each instance's own variables (its action counters),
 * what is in flight (as a bag, no times), counters, the world's variables (the fault budget),
 * and what `never` properties remember.
 */
function projection(world: World, memory: string): string {
  return [
    world.instances.map((i) => `${i.id}=${sortedJson(i.state)}${i.variables ? `@${sortedJson(i.variables)}` : ""}`).sort().join("\n"),
    world.pending.map((p) => pendingText(p)).sort().join("\n"),
    sortedJson(world.fresh),
    sortedJson(world.variables ?? {}),
    memory,
  ].join("\n--\n");
}

/** The checker's exhaustive search, plain, and the distinct states it reached as TLA+ sees them. */
export async function feynman(spec: Spec, bounds: Partial<Bounds>): Promise<{ report: Report; distinct: number }> {
  const seen = new Set<string>();
  const report = await check(spec, { depth: 60, maxStates: 5_000_000, timeLimit: 300_000, walks: 0, symmetry: false, ...bounds }, [], { watch: { state: (w, memory) => seen.add(projection(w, memory)) } });
  return { report, distinct: seen.size };
}

/** Alloy 6's jar: ALLOY_JAR, or where Homebrew's alloy-analyzer puts it; only when a Java can run it. */
export const ALLOY_JAR = JAVA ? [process.env.ALLOY_JAR, ...alloyJars("/opt/homebrew/opt/alloy-analyzer/libexec")].find((p): p is string => !!p && existsSync(p)) : undefined;

/** The SAT solver Alloy uses: ALLOY_SOLVER, or SAT4J, its own, the fastest on these models. */
const ALLOY_SOLVER = process.env.ALLOY_SOLVER ?? "sat4j";

function alloyJars(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^org\.alloytools\.alloy\.dist.*\.jar$/.test(f)).map((f) => join(dir, f)) : [];
}

/**
 * Check `always <invariant>` on an Alloy model, examples/oracles/alloy/<module>.als, over
 * traces of up to `steps` states, with Buggy, Faults and Repeats set as given. Alloy tries
 * trace lengths from the shortest up, so the first counterexample is a shortest one: for each
 * invariant, the events on it (states minus the first), or undefined when none is that short.
 * Integers are 4 bits, which is fastest by far; a model's counts stay well under 8, and a
 * trace that overflows one is left out (-n) rather than wrapping around.
 */
export function alloy(module: string, constants: { Buggy: boolean; Faults: number; Repeats: number }, invariants: string[], steps: number): Record<string, number | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "feynman-alloy-"));
  try {
    const model = readFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", "alloy", `${module}.als`), "utf8");
    const config = [
      `pred Buggy { ${constants.Buggy ? "" : "some none"} }`,
      `fun Faults: one Int { ${constants.Faults} }`,
      `fun Repeats: one Int { ${constants.Repeats} }`,
      ...invariants.map((i) => `check ${i}_holds { always ${i} } for 4 Int, 1..${steps} steps`),
    ];
    writeFileSync(join(dir, `${module}.als`), `${model}\n${config.join("\n")}\n`);
    const run = spawnSync(JAVA!, ["--enable-native-access=ALL-UNNAMED", "-jar", ALLOY_JAR!, "exec", "-f", "-q", "-n", "-s", ALLOY_SOLVER, "-t", "json", "-o", join(dir, "out"), join(dir, `${module}.als`)], { encoding: "utf8" });
    const receipt = join(dir, "out", "receipt.json");
    if (run.status !== 0 || !existsSync(receipt)) throw new Error(`Alloy failed on ${module}:\n${run.stdout}\n${run.stderr}`);
    const commands = JSON.parse(readFileSync(receipt, "utf8")).commands as Record<string, { solution?: { instances: unknown[] }[] }>;
    return Object.fromEntries(
      invariants.map((i) => {
        const command = commands[`${i}_holds`];
        if (!command) throw new Error(`Alloy did not run ${i} on ${module}`);
        const found = command.solution?.[0];
        return [i, found ? found.instances.length - 1 : undefined];
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readOracle(module: string): string {
  return readFileSync(join(import.meta.dir, "..", "..", "examples", "oracles", `${module}.tla`), "utf8");
}
